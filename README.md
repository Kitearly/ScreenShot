# ScreenShot

部署在 Cloudflare Workers 上的网页截图 API。基于 [Browser Run](https://developers.cloudflare.com/browser-run/) 的 `/screenshot` 能力，**不需要 API Token，也不需要 Account ID**。

```
GET https://你的域名/?url=https%3A%2F%2Fexample.com
→ image/jpeg
```

---

## 特点

- **零 secret**：用 `browser` 绑定直接调 `env.BROWSER.quickAction("screenshot", …)`，鉴权由绑定自己处理。
- **只有一个参数**：API 只收 `url`，视口固定 1280×720。
- **一个 host 一份图**：缓存键只用 host，同一个站点的不同页面共用一份。
- **随机有效期**：每次写入都重抽一个 3~7 天的到期时间，**永远不会有一批图同时过期**。
- **永不开天窗**：每次渲染成功都留一份永不过期的兜底图，目标站挂掉时照样能显示。
- **并发合并**：同一个 host 的并发请求只渲染一次，其余请求等结果。
- **负缓存**：渲染失败的目标 30 分钟内不再重试，不会把配额打光。
- **SSRF 防护**：拦内网 / 元数据地址 / 非 HTTP(S) 协议 / URL 内嵌凭据。

---

## 架构

```
  GET /?url=…
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
                  │
                  ▼
  ┌───────────────────────────────┐
  │ Workers KV                     │
  │  shot:now:<host>  随机 3~7 天  │  当前这一份（消失即触发刷新）
  │  shot:last:<host> 永不过期     │  最后一次成功的图（兜底）
  │  fail:<host>      30 分钟      │  负缓存（护配额）
  └───────────────┬───────────────┘
                  │  没有当前份时
                  ▼
            ┌──────────────┐
            │ Browser Run  │  Chromium 渲染 → image/jpeg
            └──────────────┘
```

**KV 里存的就是图片本身**，没有头部、没有元数据 —— 一次 KV 读拿到的就是可以发出去的字节。

**为什么网关和出图要拆成两个入口？**

Workers Cache 的缓存键只由「路径 + 查询串 + 入口 + Worker 版本」决定，**不含 Referer / Origin**。如果把白名单校验放在被缓存的那一层：

- 未授权的调用方能直接拿到缓存图；
- 某次合法的 403 会被缓存下来，之后所有人收到 403。

所以网关不缓存（每次请求都跑），只把校验过的请求转交给被缓存的 `Shot` 入口。

---

## 限流与并发

免费版的硬限制是 **Quick Action 1 次 / 10 秒**（账号级，官方文档里的 `Total requests (Quick Actions only)`）。11 张图最少要 110 秒 —— 所以「会不会撞限流」完全取决于**刷新时刻错没错开**。

### 核心：随机有效期

问题的根源是「一批图同时过期 → 同时去渲染 → 同时撞限流」。解法很直接：

> **每次写入都重新抽一个随机的到期时间，同一批图就会持续错开，永远不会一起到期。**

```
shot:now:<host> 的 expirationTtl = rand(3 天, 7 天)     // 每次写入重抽
```

11 个 host 均匀落在 4 天的窗口里，期望最小间隔约 **47 分钟** —— 远远大于限流的 10 秒。

> 用 hash 代替随机数也能错开，但偏移是**固定**的：每次刷新都落在同一个相对位置，
> 长期看还是有节奏。随机数没有这个尾巴。

### 边缘那层的 max-age 要小

Workers Cache 的副本有自己的寿命，它过期后才会回头问源站。如果 `max-age` 太大（比如 24 小时），
边缘的再验证网格会把**随机错开的到期时间重新量化到同一格上** —— 11 个 host 又会挤到同一刻刷新。

所以边缘的 `max-age` 每次响应随机取 **10~60 分钟**：相对 4 天的窗口可以忽略，
而且每次都随机，网格自己会漂。

### 目标挂掉时

`shot:now` 过期就没了，但 `shot:last` 永远在 —— 渲染失败时直接拿它兜底，页面不会开天窗。

### 429 不是「目标坏了」

撞上限流时**绝不写负缓存**（那会把图自己锁死），有兜底图就返回兜底图，
没有才返回 `503` + `Retry-After: 10`。目标是真有问题（404、超时、证书错误）才写负缓存。

### 冷启动怎么办

空 KV 上 11 张图不可能一次渲染完，这是物理限制。部署完之后有两种办法：

```bash
# a) 什么都不做：之后每次页面加载补 1 个
# b) 立刻备好：自己按 11 秒间隔打一遍
for u in "https://a.com" "https://b.com" ...; do
  curl -s -o /dev/null "https://你的域名/?url=$(printf %s "$u" | jq -sRr @uri)"
  sleep 11
done
```

### 代价

- 每个 host 存两份图（当前份 + 永久兜底份），11 个 host 约 3 MB（Free 档 1 GB）
- 没有 cron，没有后台任务 —— 刷新完全由「请求时发现键没了」驱动

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

| 参数 | 必填 | 说明 |
| --- | --- | --- |
| `url` | 是 | 目标地址，必须 URL 编码 |

视口固定 **1280×720**，JPEG 画质 80，不截整页 —— 不给参数留口子，
免得同一个 host 因为尺寸组合不同而多存几份图。

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

> **缓存键只用 host** —— 同一个站点的不同页面拿到的是同一张图。
> 这对友链页面正好合适：每个站点一张封面。

### 响应头

| 头 | 含义 |
| --- | --- |
| `Cf-Cache-Status` | Cloudflare 边缘缓存状态（`HIT` / `MISS` / `UPDATING` / `STALE`） |
| `X-Cache` | `KV`（命中当前份）/ `MISS`（刚渲染出来的）/ `STALE`（用的兜底旧图） |
| `X-Browser-Ms-Used` | 本次渲染实际消耗的浏览器时长（毫秒），仅 `MISS` 时出现 |
| `X-Screenshot-Reason` | 仅 `STALE` 时出现，说明为什么用了旧图 |
| `Cache-Tag` | `shot` 与 `shot:<host>`，可用于按标签清缓存 |

### 错误

| 状态码 | 含义 |
| --- | --- |
| `400` | 缺 `url`、URL 非法、目标是内网地址 |
| `403` | 来源不在白名单，或目标解析到内网地址 |
| `405` | 方法不是 GET / HEAD |
| `502` | 渲染失败（且没有兜底图） |
| `503` | 撞上 Browser Run 的限流（`Retry-After: 10`），且没有兜底图 |

---

## 配置

**绑定**（`wrangler.jsonc`）

| 名称 | 类型 | 说明 |
| --- | --- | --- |
| `BROWSER` | Browser Run | 必需。无 Token，绑定自带鉴权 |
| `SHOTS` | Workers KV | 必需。存截图二进制 |

**环境变量**

| 名称 | 说明 |
| --- | --- |
| `ALLOWED_DOMAINS` | 可选。允许调用方的域名白名单，逗号分隔。留空 = 不限制 |

**代码常量**（改这些不用动结构）

| 位置 | 常量 | 默认 | 作用 |
| --- | --- | --- | --- |
| `src/shot.ts` | `WIDTH` / `HEIGHT` | 1280 / 720 | 固定视口 |
| `src/shot.ts` | `QUALITY` | 80 | 固定 JPEG 画质 |
| `src/shot.ts` | `TTL_MIN` / `TTL_MAX` | 259200 / 604800 | **随机有效期**的窗口（秒，即 3~7 天）。每次写入重抽，这是「不会同时过期」的全部机制 |
| `src/shot.ts` | `NEG_TTL` | 1800 | 渲染失败后的负缓存时长（秒） |
| `src/shot.ts` | `EDGE_MIN` / `EDGE_MAX` | 600 / 3600 | 边缘 `max-age` 的范围（秒），每次响应随机取一个 |
| `src/shot.ts` | `WAIT_UNTIL` | `networkidle2` | 页面加载完成的判定 |
| `src/shot.ts` | `GOTO_TIMEOUT` / `ACTION_TIMEOUT` | 20000 / 10000 | 加载与截图的超时（毫秒） |
| `src/shot.ts` | `BROWSER_CACHE_TTL` | 0 | Cloudflare 侧浏览器缓存，见下方说明 |

> `BROWSER_CACHE_TTL` 默认关掉了。它能省下「本地缓存被清空」那一次渲染，
> 但官方没有公开它的缓存键是否包含视口 / 质量等参数，
> 万一不含就可能拿到尺寸不对的图。确认过行为后可以调大（最大 86400）。

> 想让图更新得更勤，把 `TTL_MIN` / `TTL_MAX` 调小就行 —— 随机错开的机制不受影响，
> 只是平均每天每个 host 的渲染次数会变多。

---

## 目标站挂掉时的行为

| 场景 | 返回 | `X-Cache` |
| --- | --- | --- |
| 边缘缓存命中 | 边缘副本 | —（`Cf-Cache-Status: HIT`） |
| KV 里当前份还在 | KV 副本 | `KV` |
| 当前份过期了，渲染成功 | 新图 | `MISS` |
| 当前份过期了，渲染失败，但有兜底份 | **兜底旧图** | `STALE` |
| 渲染失败，连兜底份都没有 | `502` / `503` | — |

渲染失败会写一条 30 分钟的负缓存，期间不再重试渲染 —— **但限流（429）不算失败**，
它只说明这一刻额度被占满了。兜底图的存在意味着页面在任何情况下都不会开天窗。

> `shot:last` 永不过期，所以 KV 里会一直躺着每个 host 的最后一张图。
> 目标越多占用越大（一张 1280×720 的 JPEG 约 80–200 KB），
> Free 档 1 GB 够放几千张。

### 手动干预

```bash
# 让某个站点重新出一张图（下次访问时渲染）
npx wrangler kv key delete --binding SHOTS "shot:now:<host>"

# 连兜底份一起清掉，省存储
npx wrangler kv key delete --binding SHOTS "shot:last:<host>"
```

---

## 配额

Browser Run 的计费单位是**浏览器时长**。

| 计划 | 额度 | 限流 |
| --- | --- | --- |
| Workers Free | 10 分钟 / 天 | Quick Action **1 次 / 10 秒** |
| Workers Paid | 10 小时 / 月，超出 $0.09 / 小时 | Quick Action 30 次 / 秒 |

一次 1280×720 的截图大约消耗 2 秒浏览器时长，于是：

- Free 档的硬上限约 **300 次 / 天**；
- 有效期 3~7 天 + 11 个 host ⇒ 约 **2.2 次 / 天**，与访问量完全无关；
- 失败、超时的调用不计入浏览器时长，但仍会占用限流名额。

> **并发才是真正的瓶颈，不是总量。** 1 次 / 10 秒意味着 1 分钟最多 6 次，
> 而一个友链页面一次就要 11 张。所以随机到期时间才是让「访问量无关」真正成立的东西 ——
> 没有它，第一次加载必然有 10 张撞 429。

**降低消耗的几种做法**

1. 调大 `TTL_MIN` / `TTL_MAX`（代价是内容更新变慢）；
2. 白名单收紧，别让接口被公开刷；
3. 负缓存别调太短，否则坏目标每次访问都烧一次渲染配额。

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

---

## 目录

```
src/
  index.ts   网关入口（白名单 → 规范化 → 按 host 转交）
  target.ts  目标 URL 的解析 / 规范化 / 安全校验、缓存键（host）
  shot.ts    渲染、存取、随机有效期、限流与兜底
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
npm test            # 39 项断言：URL 规范化、SSRF、参数、缓存键、白名单、渲染与存取、限流与兜底、有效期随机性
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
  思路来源，也是「一个站点一张图」的做法；
  区别在于它按天分桶存两份，而这里用一个随机有效期代替。
