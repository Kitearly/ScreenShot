# ScreenShot

部署在 Cloudflare Workers 上的网页截图 API。基于 [Browser Run](https://developers.cloudflare.com/browser-run/) 的 `/screenshot` 能力，**不需要 API Token，也不需要 Account ID**。

```
GET https://你的域名/?w=1280&h=720&q=80&full=0&url=https%3A%2F%2Fexample.com
→ image/jpeg
```

---

## 特点

- **零 secret**：用 `browser` 绑定直接调 `env.BROWSER.quickAction("screenshot", …)`，鉴权由绑定自己处理。
- **并发合并**：同一个 host 的并发请求只渲染一次，其余请求等结果。
- **分层缓存**：Workers Cache（边缘，分层 + 合并 + SWR）→ Workers KV（持久，跨机房、跨驱逐）。
- **一个 host 一份图**：缓存键只用 host，同一个站点的不同页面、不同尺寸共用一份。
- **随机有效期**：每次写入都重抽一个 48~96 小时的到期时间，**永远不会有一批图同时过期**。
- **不撞限流**：免费版 Quick Action 只有 **1 次 / 10 秒**，所以过期图先给旧图、刷新放后台，cron 每次只刷一个。
- **负缓存**：渲染失败的目标 5 分钟内不再重试，不会把配额打光。
- **SSRF 防护**：拦内网 / 元数据地址 / 非 HTTP(S) 协议 / URL 内嵌凭据。

---

## 架构

```
  GET /?w=…&h=…&url=…
        │
        ▼
  ┌───────────────────────────────┐
  │ default 入口（网关，不缓存）    │  白名单校验 → 目标规范化 → 取 host
  └───────────────┬───────────────┘
                  │  ctx.exports.Shot.fetch(…, { cf: { cacheKey: "/?host=…" } })
                  ▼
  ┌───────────────────────────────┐
  │ Shot 入口（缓存开启）           │  同一 host 的并发请求在这里被合并
  └───────────────┬───────────────┘
                  │  未命中
        ┌─────────┴─────────┐
        ▼                   ▼
  ┌───────────┐       ┌──────────────┐
  │ Workers KV│       │ Browser Run  │  Chromium 渲染 → image/jpeg
  │ shot:v1:  │       └──────────────┘
  │ <host>    │
  │ 头部+JPEG │  ← 一个 host 只有这一条
  └───────────┘
        ▲                   ▲
        │  每 5 分钟一次      │  每次只渲染 1 个
  ┌─────┴───────────────────┴─────┐
  │ scheduled（warm.ts）            │  补 pending / 刷新到期的那一个
  └───────────────────────────────┘
```

**KV 里存的是什么**

一条记录 = 一个 host 的全部信息，头部和图片拼在同一个值里：

```
[4 字节大端：头部长度][头部 JSON][JPEG 字节]
```

```jsonc
{
  "u": "https://a.com/",   // 这张图渲染自哪个地址
  "w": 1280, "h": 720, "q": 80, "f": 0,
  "t": 1792500426,         // 生成时间（秒）
  "e": 1792664826,         // 到期时间（秒）← 每次写入随机重抽
  "n": 0,                  // 下次允许重试的时间（失败退避用）
  "y": 0                   // 连续失败次数
}
```

一次 KV 读就能拿到全部信息，图片本身零损耗（**不做 base64**，否则体积要涨 33%）。

**为什么网关和出图要拆成两个入口？**

Workers Cache 的缓存键只由「路径 + 查询串 + 入口 + Worker 版本」决定，**不含 Referer / Origin**。如果把白名单校验放在被缓存的那一层：

- 未授权的调用方能直接拿到缓存图；
- 某次合法的 403 会被缓存下来，之后所有人收到 403。

所以网关不缓存（每次请求都跑），只把校验过的请求转交给被缓存的 `Shot` 入口。

---

## 限流与并发

免费版的硬限制是 **Quick Action 1 次 / 10 秒**（账号级，官方文档里的 `Total requests (Quick Actions only)`）。这意味着 **11 张图最少要 110 秒**，请求路径上无论如何都来不及。

### 核心：随机有效期

问题的根源是「一批图同时过期 → 同时去渲染 → 同时撞限流」。解法很直接：

> **每次写入都重新抽一个随机的到期时间，同一批图就会持续错开，永远不会一起到期。**

```
到期时间 = now + rand(48h, 96h)      // randomUntil()，每次写入重新抽
```

同一批渲染出来的 11 张图，到期时间会散在 4 小时的窗口里；每张图被刷新时又会抽一个新的，
所以到期时间持续随机游走 —— **不是周期性的同步刷新，而是一次也不会同步**。

> 用 hash 代替随机数也能错开，但偏移是**固定**的：每次刷新都落在同一个相对位置，
> 长期看还是有节奏。随机数没有这个尾巴。

### 三层配合

| 问题 | 解法 | 位置 |
| --- | --- | --- |
| 11 个请求同时到达 | 有旧图就先给旧图，刷新扔后台；没有旧图才同步渲染 | `shot.ts` |
| 11 张图同时过期 | 每次写入重抽随机到期时间 | `shot.ts` |
| 冷启动 / 长期保持热 | cron 每 5 分钟只渲染**一个**到期的目标 | `warm.ts` |

**1. 过期不再阻塞请求**

```
图龄 < 到期时间   → 直接返回（X-Cache: KV）
图龄 ≥ 到期时间   → 立刻返回旧图（X-Cache: STALE，边缘只缓存 60 秒）
                    同时 ctx.waitUntil 在后台重新渲染
从没有过图        → 只能同步渲染（唯一可能撞限流的路径）
```

页面永远不会为了等一次渲染而卡住；后台刷新成功后，下一次请求（60 秒后）就是新图。

**2. 后台刷新（cron）**

请求路径上能做的都做完了，剩下的两件事交给 cron：

- **补 pending** —— 第一次并发加载时撞了限流、只写下了头部没写出图的那些目标，
  由 cron 逐个补上，不用等下一次有人访问；
- **刷新到期的图** —— 到期时间是随机的，所以每个 host 过期的时间都不同，
  cron 每次只处理一个，永远不会撞限流。

节奏是 1 次 / 5 分钟，远低于 1 次 / 10 秒。失败按 10 分钟起步退避、逐次翻倍、
最长 6 小时，坏掉的目标不会吃光额度。

**3. 429 不是「目标坏了」**

撞上限流时**绝不写负缓存**（那会把图自己锁死 5 分钟），而是返回
`503` + `Retry-After: 10`，并把目标记成 pending（只有头部、没有图），
交给 cron 在限流之外补上。目标是真有问题（404、超时、证书错误）才写 5 分钟负缓存。

### 冷启动怎么办

空 KV 上 11 张图不可能一次渲染完，这是物理限制。部署完之后有两种办法：

```bash
# a) 什么都不做：cron 会在几十分钟内把 pending 的目标逐个补上
# b) 立刻备好：自己按 11 秒间隔打一遍
for u in "https://a.com" "https://b.com" ...; do
  curl -s -o /dev/null "https://你的域名/?url=$(printf %s "$u" | jq -sRr @uri)"
  sleep 11
done
```

之后页面加载就永远是缓存命中了 —— 包括每天刷新的时候，因为到期时间是随机错开的。

### 代价

- 每天 144 次 cron 调用 + 约 3.5k 次 KV 读（免费额度 10 万读 / 天）+ 每个目标约 0.4 次渲染/天
- 不想用就把 `triggers.crons` 改成 `[]` —— 前两层仍然生效，只是冷启动会慢一些
- cron 每次最多看 200 条记录；超过这个数量得自己分批处理

---

## 部署

### 1. 准备

```bash
npm install
```

### 2. 建 KV 命名空间

**一条命令搞定**，它会创建命名空间并把真实的 namespace id 自动写回 `wrangler.jsonc`：

```bash
npx wrangler kv namespace create SHOTS --binding SHOTS --update-config
```

> namespace id **不是密钥**，可以安全地提交进仓库。
> 已经有了的话用 `npx wrangler kv namespace list` 查到 id，手动替换 `wrangler.jsonc` 里的占位符即可。

改完检查一下：

```bash
npm run predeploy   # 有占位符会直接报错并给出上面的命令
```

### 3.（可选）限制调用来源

```bash
npx wrangler secret put ALLOWED_DOMAINS
# 例：example.com,*.example.com
```

留空表示不做限制，任何人都能调用 —— **公开的截图接口很容易被刷额度，建议配置**。

### 4. 部署

```bash
npm run deploy
```

用 `npm run deploy` 而不是 `npx wrangler deploy`，是为了让 `predeploy` 检查先跑一遍，
避免占位符走到 Cloudflare 构建里才失败。

### 5. 绑定自定义域名（可选）

在 Cloudflare 控制台给这个 Worker 绑一个域名，或在 `wrangler.jsonc` 里加 `routes`。
不绑的话默认走 `*.workers.dev`，也能直接用。

### 用 Git 仓库部署（Cloudflare Workers Builds）

在 Cloudflare 控制台连接这个 Git 仓库后，构建配置这样填：

| 项 | 值 |
| --- | --- |
| Build command | `npm install`（或留空用默认的 `npm clean-install`） |
| **Deploy command** | **`npm run deploy`** |
| Root directory | 仓库根目录 |

⚠️ **必须先把 `wrangler.jsonc` 里的 KV id 换成真的并提交**，否则构建会失败：

```
✘ [ERROR] KV namespace 'REPLACE_WITH_YOUR_KV_NAMESPACE_ID' is not valid. [code: 10042]
```

所以流程是：**建命名空间 → commit（带上真实 id）→ push → 构建自动部署**。

---

## API

只有一个端点，挂在哪就调哪 —— 路径不参与判断，只有 `url` 参数决定成不成立。

### `GET /`

| 参数 | 默认 | 范围 | 说明 |
| --- | --- | --- | --- |
| `w` | `1280` | 320–1920 | 视口宽度 |
| `h` | `720` | 400–4000 | 视口高度 |
| `q` | `80` | 40–95 | JPEG 质量 |
| `full` | `0` | `0` / `1` | `1` = 整页长图 |
| `url` | **必填** | — | 目标地址（**放在最后**） |

`url` 必须做 URL 编码：

```bash
curl -o shot.jpg "https://你的域名/?url=https%3A%2F%2Fexample.com"
```

Worker 挂在不同位置时的实际路径：

| 绑定方式 | 请求地址 | Worker 收到的 path |
| --- | --- | --- |
| 自定义域名 | `https://api.example.com/?url=…` | `/` |
| 子域名 | `https://api.example.com/?url=…` | `/` |
| 路由 `example.com/api/*` | `https://example.com/api/?url=…` | `/api/` |
| workers.dev | `https://screenshot.workers.dev/?url=…` | `/` |

> **缓存键只用 host —— 一个 host 只有一张图。**
>
> 同一个站点的不同页面、不同尺寸、不同画质请求，拿到的是同一张图
> （谁先到谁说了算，之后按它渲染时用的参数）。
> 这对友链页面正好合适：每个站点一张封面，11 个站点就是 11 条 KV 记录、11 次渲染。
>
> 好处是**调用量只跟站点数有关，跟尺寸组合无关** —— 不需要再自己固定一组参数来防发散。

### 响应头

| 头 | 含义 |
| --- | --- |
| `Cf-Cache-Status` | Cloudflare 边缘缓存状态（`HIT` / `MISS` / `UPDATING` / `STALE`） |
| `X-Cache` | 本层缓存状态：`KV`（命中持久层，新鲜）/ `MISS`（刚渲染出来的）/ `STALE`（过期或刷新失败，用的旧图） |
| `X-Screenshot-Age` | 这张图是多久之前生成的（秒） |
| `X-Browser-Ms-Used` | 本次渲染实际消耗的浏览器时长（毫秒） |
| `X-Screenshot-Reason` | 仅 `STALE` 时出现：`expired`（过期，已在后台刷新）或失败原因 |
| `ETag` | 内容指纹，配合 `If-None-Match` 可返回 304 |
| `Cache-Tag` | `shot` 与 `shot:<key>`，可用于按标签清缓存 |

### 错误

| 状态码 | 含义 |
| --- | --- |
| `400` | 缺 `url`、URL 非法、目标是内网地址 |
| `403` | 来源不在白名单，或目标解析到内网地址 |
| `405` | 方法不是 GET / HEAD |
| `502` | 渲染失败（且没有可用的旧图） |
| `503` | 撞上 Browser Run 的限流（`Retry-After: 10`），目标已记成 pending，交给 cron 补 |

---

## 配置

**绑定**（`wrangler.jsonc`）

| 名称 | 类型 | 说明 |
| --- | --- | --- |
| `BROWSER` | Browser Run | 必需。无 Token，绑定自带鉴权 |
| `SHOTS` | Workers KV | 必需。存截图二进制与元数据 |

**环境变量**

| 名称 | 说明 |
| --- | --- |
| `ALLOWED_DOMAINS` | 可选。允许调用方的域名白名单，逗号分隔。留空 = 不限制 |

**代码常量**（改这些不用动结构）

| 位置 | 常量 | 默认 | 作用 |
| --- | --- | --- | --- |
| `src/target.ts` | `DEFAULT_WIDTH` / `DEFAULT_HEIGHT` / `DEFAULT_QUALITY` | 1280 / 720 / 80 | 默认视口与画质 |
| `src/shot.ts` | `TTL_MIN` / `TTL_MAX` | 172800 / 345600 | **随机有效期**的窗口（秒，即 48h~96h）。每次写入重抽，这是「不会同时过期」的全部机制 |
| `src/shot.ts` | `KEEP_TTL` | 2592000 | 截图在 KV 里的保留时长（30 天，KV 上限）。与有效期解耦，保证目标挂掉时还能回退到最后一次成功的截图 |
| `src/shot.ts` | `SWR` | 86400 | 过期后先返回旧图、后台刷新的窗口 |
| `src/shot.ts` | `SIE` | 604800 | 刷新失败时继续提供旧图的窗口 |
| `src/shot.ts` | `NEG_TTL` | 300 | 渲染失败后的负缓存时长 |
| `src/shot.ts` | `STALE_MAX_AGE` | 60 | 旧图在边缘停留多久，越短刷新生效越快 |
| `src/shot.ts` | `WAIT_UNTIL` | `networkidle2` | 页面加载完成的判定 |
| `src/shot.ts` | `GOTO_TIMEOUT` / `ACTION_TIMEOUT` | 20000 / 10000 | 加载与截图的超时（毫秒） |
| `src/shot.ts` | `BROWSER_CACHE_TTL` | 0 | Cloudflare 侧浏览器缓存，见下方说明 |
| `src/warm.ts` | `RETRY_SECONDS` / `RETRY_MAX_SECONDS` | 600 / 21600 | 后台刷新失败后的退避起点与上限（秒） |
| `wrangler.jsonc` | `triggers.crons` | `*/5 * * * *` | 后台刷新频率。想关掉就改成 `[]` |

> `BROWSER_CACHE_TTL` 默认关掉了。它能省下「本地缓存被清空」那一次渲染，
> 但官方没有公开它的缓存键是否包含视口 / 质量等参数，
> 万一不含就可能拿到尺寸不对的图。确认过行为后可以调大（最大 86400）。

> 想让图更新得更勤，把 `TTL_MIN` / `TTL_MAX` 调小（比如 `86400` / `129600`，
> 也就是 1~1.5 天）就行 —— 随机错开的机制不受影响，
> 只是平均每天每个 host 的渲染次数会变多。

---

## 目标站挂掉时的行为

截图在 KV 里保留 **30 天**（`KEEP_TTL`），但「新鲜度」只看 `meta.t` 距今多久（`TTL`）。
这两者解耦，就是为了让**最后一次成功的截图**活得比新鲜期长得多。

| 场景 | 返回 | `X-Cache` |
| --- | --- | --- |
| 边缘缓存命中 | 边缘副本 | —（`Cf-Cache-Status: HIT`） |
| 边缘未命中，但 KV 里的图还新鲜（< 有效期） | KV 副本 | `KV` |
| 图已过期，**后台刷新成功** | 本次仍是旧图，60 秒后是新图 | `STALE`（`X-Screenshot-Reason: expired`） |
| 图已过期，后台刷新失败，但目标能连上 | 旧图 | `STALE` |
| 目标挂掉，但 KV 里还留着旧图 | **回退到旧图**（`X-Screenshot-Age` 告诉你它有多旧） | `STALE` |
| 从没有过成功的截图，且渲染失败 | `502` | — |
| 从没有过成功的截图，且撞上限流 | `503` + `Retry-After: 10` | — |

失败会写一条 5 分钟的负缓存（`NEG_TTL`），期间不再重试渲染 —— **但限流（429）不算失败**，
它只说明这一刻额度被占满了，不会写负缓存，目标会记成 pending 等 cron 补。
旧图的边缘 `max-age` 只有 60 秒，目标恢复后很快就会重新出图。

> 保留期 30 天意味着 KV 里会一直躺着每个 host 的最后一张图。
> 一个 host 就一条记录（含头部，几十字节）。
> 目标越多占用越大（一张 1280×720 的 JPEG 约 80–200 KB），
> Free 档 1 GB 够放几千张。

---

## 配额

Browser Run 的计费单位是**浏览器时长**。

| 计划 | 额度 | 限流 |
| --- | --- | --- |
| Workers Free | 10 分钟 / 天 | Quick Action **1 次 / 10 秒** |
| Workers Paid | 10 小时 / 月，超出 $0.09 / 小时 | Quick Action 30 次 / 秒 |

一次 1280×720 的截图大约消耗 2 秒浏览器时长，于是：

- Free 档的硬上限约 **300 次 / 天**；
- 有效期 48~96 小时 + 11 个 host ⇒ 约 **4 次 / 天**，与访问量完全无关；
- 失败、超时的调用不计入浏览器时长，但仍会占用限流名额。

> **并发才是真正的瓶颈，不是总量。** 1 次 / 10 秒意味着 1 分钟最多 6 次，
> 而一个友链页面一次就会要 11 张。所以随机到期时间 + 后台刷新
> 才是让「访问量无关」真正成立的东西 —— 没有它们，第一次加载必然有 10 张撞 429。

**降低消耗的几种做法**

1. 固定一组 `w` / `h` / `q` —— 缓存键只看 host，但**首次**渲染用的是当时的参数，
   尺寸换来换去不会各存一份，只会浪费一次渲染；
2. 调大 `TTL_MIN` / `TTL_MAX`（代价是内容更新变慢）；
3. 白名单收紧，别让接口被公开刷；
4. 某个 host 不再需要了，直接删掉它的记录：
   `npx wrangler kv key delete --binding SHOTS "shot:v1:<host>"`。

---

## 安全

- **来源限制**：按 `Origin` / `Referer` 的**主机名**匹配白名单，支持 `example.com`（含子域）与 `*.example.com`。
  比字符串 `includes` 严格，`https://evil.com/?x=example.com` 不会通过。
  仍然可以伪造请求头，只适合个人 / 小站点自用。
- **SSRF**：
  - 只允许 `http:` / `https:`，拒绝 URL 内嵌凭据；
  - 拒绝 `localhost` / `*.local` / `*.internal` / `metadata.google.internal` 等保留域名；
  - 拒绝私网与保留网段的 IP 字面量（`127/8`、`10/8`、`172.16/12`、`192.168/16`、`169.254/16`、`::1`、`fc00::/7` …）；
  - 渲染前通过 DoH 解析一次域名，解析到私网地址则拒绝。
    这一步挡不住 DNS 重绑定（浏览器会重新解析），属于尽力而为。

---

## 本地开发

```bash
npx wrangler dev
```

`quickAction()` 在本地模式下不可用，需要在 `wrangler.jsonc` 里给 browser 绑定加上 `remote`：

```jsonc
"browser": {
	"binding": "BROWSER",
	"remote": true
}
```

然后用 `npx wrangler dev --remote` 运行。

想手动触发一次后台刷新（不用等 cron）：

```bash
npx wrangler dev --remote --test-scheduled
curl "http://localhost:8787/__scheduled?cron=*/5+*+*+*+*"
```

---

## 目录

```
src/
  index.ts   网关入口 + scheduled 入口
  target.ts  配置常量、目标 URL 的解析 / 规范化 / 安全校验、缓存键（host）
  shot.ts    渲染、存取（头部+JPEG 合成一条）、随机有效期、限流与回退
  warm.ts    后台刷新（cron 每次只处理一个目标）
scripts/
  check-config.mjs  部署前检查：KV namespace id 不能还是占位符
test/
  shot.test.mjs  单元测试（直接跑源码，不打包）
types/
  global.d.ts  让 ctx.exports.Shot 拥有完整类型
```

## 校验

```bash
npm run typecheck   # tsc --noEmit
npm test            # 50 项断言：URL 规范化、SSRF、参数、缓存键、白名单、渲染与回退、限流、随机有效期、后台刷新
```

测试用 Node 原生的类型剥离直接跑 `src/` 源码，不经过打包，
所以断言的就是线上要跑的那份代码。

---

## 参考

- [Browser Run / Quick Actions](https://developers.cloudflare.com/browser-run/quick-actions/)
- [Browser Run 限制与计费](https://developers.cloudflare.com/browser-run/limits/) · [计费](https://developers.cloudflare.com/browser-run/pricing/)
- [Workers Cache](https://developers.cloudflare.com/workers/cache/)
- [Workers KV 限制](https://developers.cloudflare.com/kv/platform/limits/)
- [原文：使用 CloudFlare Workers 搭建网页截图 API](https://careful.fyi/archives/187982.html) ——
  思路来源，也是「一个站点一张图」的做法；区别在于它按天分桶存两份，
  而这里用一个随机到期时间代替。
