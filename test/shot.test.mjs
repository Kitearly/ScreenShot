/**
 * 单元测试：直接跑 src/ 下的源码，不打包。
 *
 *   node --experimental-strip-types --import ./test/register.mjs test/shot.test.mjs
 */

import assert from "node:assert/strict";
import {
	canonicalKey,
	isAllowedCaller,
	isPrivateIPv4,
	isPrivateIPv6,
	normalizeTarget,
	parseShot,
} from "../src/target.ts";
import { Shot, ttlFor } from "../src/shot.ts";
import { warm } from "../src/warm.ts";

// ---------------------------------------------------------------------------
// 迷你测试框架
// ---------------------------------------------------------------------------

let pass = 0;
const failures = [];

async function ok(name, fn) {
	try {
		await fn();
		pass++;
	} catch (error) {
		failures.push(`${name}\n      ${error.message}`);
	}
}

function section(title) {
	console.log(`\n${title}`);
}

// ---------------------------------------------------------------------------
// target.ts
// ---------------------------------------------------------------------------

const enc = encodeURIComponent;
const request = (qs) => new Request(`https://api.example.com/?${qs}`);
const parse = (qs) => parseShot(request(qs));

section("target.ts — URL 规范化");

await ok("剥离追踪参数与 fragment", () => {
	const url = new URL(
		"https://Example.COM:443/blog?utm_source=weibo&fbclid=abc&id=7#frag",
	);
	assert.equal(normalizeTarget(url), "https://example.com/blog?id=7");
});

await ok("查询参数排序", () => {
	assert.equal(
		normalizeTarget(new URL("https://a.com/p?b=2&a=1")),
		"https://a.com/p?a=1&b=2",
	);
});

await ok("空路径归一为 /", () => {
	assert.equal(normalizeTarget(new URL("https://a.com")), "https://a.com/");
});

await ok("保留有意义的查询参数", () => {
	assert.equal(
		normalizeTarget(new URL("https://a.com/p?page=2&q=hello")),
		"https://a.com/p?page=2&q=hello",
	);
});

section("target.ts — SSRF 防护");

await ok("拒绝非 HTTP(S) 协议", () => {
	assert.equal(parse("url=file:///etc/passwd").ok, false);
	assert.equal(parse("url=javascript:alert(1)").ok, false);
});

await ok("拒绝 URL 内嵌凭据", () => {
	assert.equal(parse(`url=${enc("http://user:pass@a.com/")}`).ok, false);
});

await ok("拒绝保留域名", () => {
	for (const url of [
		"http://localhost/",
		"http://redis.internal/",
		"http://metadata.google.internal/",
	]) {
		assert.equal(parse(`url=${enc(url)}`).ok, false, url);
	}
});

await ok("拒绝私网 IP 字面量", () => {
	for (const ip of [
		"127.0.0.1",
		"10.1.2.3",
		"172.16.0.1",
		"192.168.1.1",
		"169.254.169.254",
		"0.0.0.0",
		"100.64.0.1",
	]) {
		assert.equal(parse(`url=${enc(`http://${ip}/`)}`).ok, false, ip);
	}
});

await ok("允许公网 IP 字面量", () => {
	assert.equal(parse(`url=${enc("http://93.184.216.34/")}`).ok, true);
});

await ok("IPv4 网段判定", () => {
	assert.equal(isPrivateIPv4("8.8.8.8"), false);
	assert.equal(isPrivateIPv4("172.32.0.1"), false);
	assert.equal(isPrivateIPv4("172.31.255.255"), true);
});

await ok("IPv6 网段判定", () => {
	assert.equal(isPrivateIPv6("::1"), true);
	assert.equal(isPrivateIPv6("::"), true);
	assert.equal(isPrivateIPv6("fd00::1"), true);
	assert.equal(isPrivateIPv6("fe80::1"), true);
	assert.equal(isPrivateIPv6("::ffff:127.0.0.1"), true);
	assert.equal(isPrivateIPv6("2606:4700::1111"), false);
});

section("target.ts — 参数");

await ok("缺 url 返回 400", () => {
	const result = parse("w=100");
	assert.equal(result.ok, false);
	assert.equal(result.status, 400);
});

await ok("参数越界收敛", () => {
	const result = parse(`url=${enc("https://a.com/")}&w=99999&h=1&q=999`);
	assert.ok(result.ok);
	assert.equal(result.shot.width, 1920);
	assert.equal(result.shot.height, 400);
	assert.equal(result.shot.quality, 95);
});

await ok("参数缺省取默认值", () => {
	const result = parse(`url=${enc("https://a.com/")}`);
	assert.ok(result.ok);
	assert.equal(result.shot.width, 1280);
	assert.equal(result.shot.height, 720);
	assert.equal(result.shot.quality, 80);
	assert.equal(result.shot.fullPage, false);
});

section("target.ts — 缓存键");

await ok("等价 URL 得到同一个键", async () => {
	const a = parse(`url=${enc("https://a.com/?utm_source=x&id=1")}`);
	const b = parse(`url=${enc("https://a.com/?id=1")}`);
	assert.ok(a.ok && b.ok);
	assert.equal(a.shot.url, b.shot.url);
	assert.equal(await canonicalKey(a.shot), await canonicalKey(b.shot));
});

await ok("不同尺寸 / 整页得到不同的键", async () => {
	const base = parse(`url=${enc("https://a.com/")}`);
	const small = parse(`url=${enc("https://a.com/")}&w=800`);
	const full = parse(`url=${enc("https://a.com/")}&full=1`);
	assert.ok(base.ok && small.ok && full.ok);
	assert.notEqual(await canonicalKey(base.shot), await canonicalKey(small.shot));
	assert.notEqual(await canonicalKey(base.shot), await canonicalKey(full.shot));
});

section("target.ts — 来源白名单");

const caller = (origin, referer) =>
	new Request(`https://api.example.com/?url=${enc("https://a.com/")}`, {
		headers: { origin: origin ?? "", referer: referer ?? "" },
	});

await ok("留空 = 不限制", () => {
	assert.equal(isAllowedCaller(caller("https://evil.com"), undefined), true);
});

await ok("精确 / 子域 / 通配符匹配", () => {
	assert.equal(isAllowedCaller(caller("https://blog.example.com"), "example.com"), true);
	assert.equal(isAllowedCaller(caller("https://a.b.example.com"), "*.example.com"), true);
});

await ok("拒绝无关来源", () => {
	assert.equal(isAllowedCaller(caller("https://evil.com"), "example.com"), false);
});

await ok("拒绝 includes 绕过", () => {
	assert.equal(
		isAllowedCaller(caller("https://evil.com/?x=example.com"), "example.com"),
		false,
	);
	assert.equal(
		isAllowedCaller(caller("https://notexample.com"), "example.com"),
		false,
	);
});

await ok("referer 也能通过", () => {
	assert.equal(
		isAllowedCaller(caller(null, "https://blog.example.com/x"), "example.com"),
		true,
	);
});


// ---------------------------------------------------------------------------
// shot.ts
// ---------------------------------------------------------------------------

section("shot.ts — 渲染与回退");

function makeKV() {
	const store = new Map();
	return {
		store,
		async get(key, type) {
			const hit = store.get(key);
			if (hit === undefined) return null;
			if (type === "json") return JSON.parse(hit.text);
			if (type === "arrayBuffer") {
				return hit.bytes.buffer.slice(
					hit.bytes.byteOffset,
					hit.bytes.byteOffset + hit.bytes.byteLength,
				);
			}
			return hit.text;
		},
		async put(key, value, options) {
			const entry =
				typeof value === "string"
					? { text: value }
					: { bytes: new Uint8Array(value) };
			entry.expiresAt = options?.expirationTtl
				? Date.now() + options.expirationTtl * 1000
				: Infinity;
			store.set(key, entry);
		},
		async delete(key) {
			store.delete(key);
		},
		async list({ prefix = "", limit = 1000 } = {}) {
			const keys = [...store.keys()]
				.filter((name) => name.startsWith(prefix))
				.sort()
				.slice(0, limit)
				.map((name) => ({ name }));
			return { keys, list_complete: true, cursor: undefined };
		},
	};
}

function makeBrowser(state) {
	return {
		async quickAction(action, options) {
			assert.equal(action, "screenshot");
			state.renders++;
			state.lastOptions = options;
			if (state.rateLimit) {
				return new Response("rate limited", { status: 429 });
			}
			if (state.down) {
				return new Response("target unreachable", { status: 500 });
			}
			return new Response(new TextEncoder().encode(`JPEG#${state.renders}`), {
				status: 200,
				headers: {
					"content-type": "image/jpeg",
					"X-Browser-Ms-Used": "2000",
				},
			});
		},
	};
}

/** 收集 waitUntil，让「后台刷新」在测试里可以被等待。 */
function makeContext() {
	const pending = [];
	return {
		waitUntil: (promise) => {
			pending.push(Promise.resolve(promise).catch(() => {}));
		},
		async flush() {
			while (pending.length) {
				await Promise.allSettled(pending.splice(0));
			}
		},
	};
}

const browserState = { down: false, rateLimit: false, renders: 0, lastOptions: null };
const kv = makeKV();
const env = { SHOTS: kv, BROWSER: makeBrowser(browserState) };
const testCtx = makeContext();
const shot = new Shot({ waitUntil: testCtx.waitUntil }, env);

const KEY = "k1";
const TARGET = enc("https://a.com/");
const inner = (headers, key = KEY) =>
	new Request(
		`https://shot.internal/?k=${key}&t=${TARGET}&w=1280&h=720&q=80&f=0`,
		headers ? { headers } : undefined,
	);

const call = async (req = inner(), instance = shot) => {
	const res = await instance.fetch(req);
	const body =
		res.status === 304
			? null
			: new TextDecoder().decode(await res.clone().arrayBuffer());
	await testCtx.flush();
	return { status: res.status, headers: res.headers, body };
};

const ageMeta = (days, target = `meta:v1:${KEY}`) => {
	const entry = kv.store.get(target);
	entry.text = JSON.stringify({
		...JSON.parse(entry.text),
		t: Date.now() - days * 86400000,
	});
};

await ok("首次请求触发渲染并返回新图", async () => {
	const result = await call();
	assert.equal(result.status, 200);
	assert.equal(result.headers.get("content-type"), "image/jpeg");
	assert.equal(result.headers.get("X-Cache"), "MISS");
	assert.equal(result.body, "JPEG#1");
	assert.equal(browserState.renders, 1);
});

await ok("渲染参数正确（jpeg + 视口 + networkidle2 + 屏蔽媒体）", () => {
	const options = browserState.lastOptions;
	assert.equal(options.screenshotOptions.type, "jpeg");
	assert.equal(options.screenshotOptions.quality, 80);
	assert.equal(options.viewport.width, 1280);
	assert.equal(options.viewport.height, 720);
	assert.equal(options.gotoOptions.waitUntil, "networkidle2");
	assert.deepEqual(options.rejectResourceTypes, ["media"]);
});

await ok("图片、元数据、预热记录都写进 KV", () => {
	assert.ok(kv.store.has(`shot:v1:${KEY}`));
	assert.ok(kv.store.has(`meta:v1:${KEY}`));
	assert.ok(kv.store.has(`warm:v1:${KEY}`));
});

await ok("KV 保留 30 天，与 24 小时的新鲜期解耦", () => {
	const entry = kv.store.get(`shot:v1:${KEY}`);
	const days = (entry.expiresAt - Date.now()) / 86400000;
	assert.ok(days > 29 && days <= 30, `实际 ${days} 天`);
});

await ok("预热记录提前 30 分钟到期，早于边缘缓存失效", () => {
	const record = JSON.parse(kv.store.get(`warm:v1:${KEY}`).text);
	const lead = (record.due - Date.now()) / 1000;
	const ttl = ttlFor(KEY);
	assert.ok(
		Math.abs(lead - (ttl - 1800)) < 5,
		`due 应落在 ttl-1800，实际 ${lead}s`,
	);
});

await ok("第二次请求命中 KV，不再渲染", async () => {
	const result = await call();
	assert.equal(result.headers.get("X-Cache"), "KV");
	assert.equal(result.body, "JPEG#1");
	assert.equal(browserState.renders, 1);
});

await ok("过期时先给旧图（不阻塞），刷新放到后台", async () => {
	ageMeta(1.1);
	const before = browserState.renders;
	const result = await call();
	assert.equal(result.status, 200);
	assert.equal(result.headers.get("X-Cache"), "STALE");
	assert.equal(result.headers.get("X-Screenshot-Reason"), "expired");
	assert.equal(result.body, "JPEG#1", "这一次拿到的还是旧图");
	assert.equal(
		result.headers.get("cache-control"),
		"public, max-age=60, stale-while-revalidate=60, stale-if-error=604800",
		"旧图只短暂缓存，好让刷新尽快生效",
	);
	assert.equal(browserState.renders, before + 1, "后台确实刷新了一次");
});

await ok("后台刷新完成后，下一次请求拿到新图", async () => {
	const result = await call();
	assert.equal(result.headers.get("X-Cache"), "KV");
	assert.equal(result.body, "JPEG#2");
	assert.equal(browserState.renders, 2);
});

await ok("目标挂掉且图已过期时回退到最后一次成功的截图", async () => {
	browserState.down = true;
	ageMeta(3);
	const before = browserState.renders;
	const result = await call();
	assert.equal(result.status, 200, "应该回退而不是 502");
	assert.equal(result.headers.get("X-Cache"), "STALE");
	assert.equal(result.body, "JPEG#2", "应该是最后一次成功的图");
	assert.equal(browserState.renders, before + 1, "后台尝试过刷新");
	assert.ok(
		Number(result.headers.get("X-Screenshot-Age")) > 2 * 86400,
		"图龄应该是 3 天左右",
	);
	assert.ok(kv.store.has(`fail:v1:${KEY}`), "真实失败要写负缓存");
});

await ok("负缓存生效：5 分钟内不再重试渲染", async () => {
	ageMeta(3);
	const before = browserState.renders;
	const result = await call();
	assert.equal(result.headers.get("X-Cache"), "STALE");
	assert.equal(browserState.renders, before, "负缓存期内不应再渲染");
});

await ok("目标挂掉且从没有成功截图时返回 502", async () => {
	const fresh = makeKV();
	const failing = new Shot(
		{ waitUntil: () => {} },
		{ SHOTS: fresh, BROWSER: makeBrowser({ down: true, renders: 0 }) },
	);
	const res = await failing.fetch(inner());
	assert.equal(res.status, 502);
});

await ok("目标恢复后，后台刷新把图换新", async () => {
	browserState.down = false;
	kv.store.delete(`fail:v1:${KEY}`);
	ageMeta(3);
	const before = browserState.renders;
	const staleResult = await call();
	assert.equal(staleResult.headers.get("X-Cache"), "STALE");
	assert.equal(browserState.renders, before + 1);

	const result = await call();
	assert.equal(result.headers.get("X-Cache"), "KV");
	assert.equal(result.body, `JPEG#${before + 1}`);
});

await ok("If-None-Match 命中时返回 304", async () => {
	const first = await call();
	const etag = first.headers.get("etag");
	const result = await call(inner({ "if-none-match": etag }));
	assert.equal(result.status, 304);
});

section("shot.ts — 限流");

await ok("撞上限流时返回 503 + Retry-After，且不写负缓存", async () => {
	const fresh = makeKV();
	const ctx = makeContext();
	const limited = new Shot(
		{ waitUntil: ctx.waitUntil },
		{ SHOTS: fresh, BROWSER: makeBrowser({ rateLimit: true, renders: 0 }) },
	);
	const res = await limited.fetch(inner());
	assert.equal(res.status, 503);
	assert.equal(res.headers.get("retry-after"), "10");
	await ctx.flush();

	assert.equal(fresh.store.has(`fail:v1:${KEY}`), false, "限流不是目标故障");
	const warm = JSON.parse(fresh.store.get(`warm:v1:${KEY}`).text);
	assert.ok(warm.due <= Date.now() + 1000, "应该立刻进预热队列");
});

await ok("有过期旧图时，限流不影响出图", async () => {
	const fresh = makeKV();
	const ctx = makeContext();
	const state = { rateLimit: true, renders: 0 };
	const limited = new Shot(
		{ waitUntil: ctx.waitUntil },
		{ SHOTS: fresh, BROWSER: makeBrowser(state) },
	);
	// 先放一张 3 天前的旧图
	const now = Date.now();
	await fresh.put(`shot:v1:${KEY}`, new TextEncoder().encode("JPEG#old"), {});
	await fresh.put(
		`meta:v1:${KEY}`,
		JSON.stringify({ t: now - 3 * 86400000, u: "https://a.com/", w: 1280, h: 720, q: 80, f: 0 }),
		{},
	);

	const res = await limited.fetch(inner());
	assert.equal(res.status, 200);
	assert.equal(res.headers.get("X-Cache"), "STALE");
	assert.equal(new TextDecoder().decode(await res.arrayBuffer()), "JPEG#old");
	await ctx.flush();
	assert.equal(fresh.store.has(`fail:v1:${KEY}`), false);
});

section("shot.ts — 有效期抖动");

await ok("不同 key 的有效期错开，不会同时到期", () => {
	const keys = ["a1b2c3", "d4e5f6", "deadbeef", "0f0f0f", "cafebabe"];
	const ttls = keys.map(ttlFor);
	assert.equal(new Set(ttls).size > 1, true, "应该有不同值");
	for (const ttl of ttls) {
		assert.ok(ttl >= 86400 && ttl < 86400 + 21600, `实际 ${ttl}`);
	}
});

await ok("同一个 key 永远算出同一个有效期", () => {
	assert.equal(ttlFor("same"), ttlFor("same"));
});

await ok("边缘 max-age 只到真正过期为止", async () => {
	const fresh = makeKV();
	const ctx = makeContext();
	const instance = new Shot(
		{ waitUntil: ctx.waitUntil },
		{ SHOTS: fresh, BROWSER: makeBrowser({ renders: 0 }) },
	);
	await instance.fetch(inner());
	await ctx.flush();

	// 手动把图龄改成 6 小时
	const meta = JSON.parse(fresh.store.get(`meta:v1:${KEY}`).text);
	meta.t = Date.now() - 6 * 3600000;
	fresh.store.get(`meta:v1:${KEY}`).text = JSON.stringify(meta);

	const res = await instance.fetch(inner());
	const maxAge = Number(
		/(\d+)/.exec(res.headers.get("cache-control").split("max-age=")[1])[1],
	);
	assert.ok(
		Math.abs(maxAge - (ttlFor(KEY) - 6 * 3600)) < 5,
		`max-age 应该扣掉已过的 6 小时，实际 ${maxAge}`,
	);
	await ctx.flush();
});

// ---------------------------------------------------------------------------
// warm.ts
// ---------------------------------------------------------------------------

section("warm.ts — 后台预热");

const dueWarm = (key, due, extra = {}) =>
	JSON.stringify({
		url: "https://a.com/",
		width: 1280,
		height: 720,
		quality: 80,
		fullPage: false,
		due,
		...extra,
	});

await ok("每个 tick 只渲染一个最该刷新的目标", async () => {
	const fresh = makeKV();
	const state = { renders: 0 };
	const now = Date.now();
	await fresh.put(`warm:v1:first`, dueWarm("first", now - 3000), {});
	await fresh.put(`warm:v1:second`, dueWarm("second", now - 2000), {});
	await fresh.put(`warm:v1:third`, dueWarm("third", now - 1000), {});

	await warm({ SHOTS: fresh, BROWSER: makeBrowser(state) });
	assert.equal(state.renders, 1, "一次只渲染一个，才碰不到 1 次/10 秒的限制");

	// 最早的那个被刷新了，due 推到未来
	const first = JSON.parse(fresh.store.get(`warm:v1:first`).text);
	assert.ok(first.due > now, "刷新后 due 应该在将来");
	const second = JSON.parse(fresh.store.get(`warm:v1:second`).text);
	assert.equal(second.due, now - 2000, "其余的不动");
});

await ok("没有到期的就什么都不做", async () => {
	const fresh = makeKV();
	const state = { renders: 0 };
	await fresh.put(`warm:v1:later`, dueWarm("later", Date.now() + 60000), {});
	await warm({ SHOTS: fresh, BROWSER: makeBrowser(state) });
	assert.equal(state.renders, 0);
});

await ok("失败后按 10 分钟起步退避，并记失败次数", async () => {
	const fresh = makeKV();
	const state = { down: true, renders: 0 };
	const now = Date.now();
	await fresh.put(`warm:v1:broken`, dueWarm("broken", now - 1000), {});

	await warm({ SHOTS: fresh, BROWSER: makeBrowser(state) });
	assert.equal(state.renders, 1);

	const record = JSON.parse(fresh.store.get(`warm:v1:broken`).text);
	assert.equal(record.tries, 1);
	const delay = (record.due - Date.now()) / 1000;
	assert.ok(delay > 580 && delay <= 600, `应该退避约 10 分钟，实际 ${delay}s`);
	assert.ok(fresh.store.has(`fail:v1:broken`), "顺手写负缓存");
});

await ok("成功一次就把失败次数清零", async () => {
	const fresh = makeKV();
	const state = { renders: 0 };
	await fresh.put(
		`warm:v1:recover`,
		dueWarm("recover", Date.now() - 1000, { tries: 3 }),
		{},
	);
	await warm({ SHOTS: fresh, BROWSER: makeBrowser(state) });
	const record = JSON.parse(fresh.store.get(`warm:v1:recover`).text);
	assert.equal(record.tries, undefined, "成功后不再带 tries");
	assert.ok(record.due > Date.now());
});

// ---------------------------------------------------------------------------

if (failures.length) {
	console.error(`\n${failures.length} 项失败：`);
	for (const failure of failures) console.error(`  ✗ ${failure}`);
	process.exit(1);
}
console.log(`\n全部通过：${pass} 项断言（渲染次数 ${browserState.renders}）`);
