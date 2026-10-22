/**
 * 单元测试：直接跑 src/ 下的源码，不打包。
 *
 *   node --experimental-strip-types --import ./test/register.mjs test/shot.test.mjs
 */

import assert from "node:assert/strict";
import {
	cacheHost,
	isAllowedCaller,
	isPrivateIPv4,
	isPrivateIPv6,
	normalizeTarget,
	parseShot,
} from "../src/target.ts";
import { Shot, nowKey, failKey, lastKey, randomTtl } from "../src/shot.ts";
import worker from "../src/index.ts";

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

await ok("url 非法返回 400", () => {
	assert.equal(parse(`url=${enc("not a url")}`).ok, false);
});

await ok("API 只认 url，多余参数被忽略", () => {
	const result = parse(`url=${enc("https://a.com/")}&w=9999&h=1&q=1&full=1`);
	assert.ok(result.ok);
	assert.deepEqual(Object.keys(result.shot).sort(), ["host", "url"]);
	assert.equal(result.shot.url, "https://a.com/");
	assert.equal(result.shot.host, "a.com");
});

section("target.ts — 缓存键");

await ok("缓存键就是 host", () => {
	assert.equal(cacheHost("https://Example.COM/blog?id=1"), "example.com");
	assert.equal(cacheHost("https://example.com:8443/x"), "example.com");
});

await ok("同一个 host 的不同页面共用一份图", () => {
	assert.equal(cacheHost("https://a.com/blog"), cacheHost("https://a.com/about"));
});

await ok("不同 host 得到不同的键", () => {
	assert.notEqual(cacheHost("https://a.com/"), cacheHost("https://b.com/"));
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

section("shot.ts — 渲染与存取");

function makeKV() {
	const store = new Map();
	return {
		store,
		async get(key, type) {
			const hit = store.get(key);
			if (hit === undefined) return null;
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
			entry.ttl = options?.expirationTtl ?? null;
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
			state.lastUrl = options.url;
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

const browserState = {
	down: false,
	rateLimit: false,
	renders: 0,
	lastOptions: null,
	lastUrl: null,
};
const kv = makeKV();
const env = { SHOTS: kv, BROWSER: makeBrowser(browserState) };
const shot = new Shot({ waitUntil: () => {} }, env);

const HOST = "a.com";
const TARGET = enc("https://a.com/");
const inner = (headers, host = HOST) =>
	new Request(
		`https://shot.internal/?host=${host}&t=${TARGET}`,
		headers ? { headers } : undefined,
	);

const call = async (req = inner(), instance = shot) => {
	const res = await instance.fetch(req);
	const body =
		res.status === 304
			? null
			: new TextDecoder().decode(await res.clone().arrayBuffer());
	return { status: res.status, headers: res.headers, body };
};

await ok("首次请求触发渲染并返回新图", async () => {
	const result = await call();
	assert.equal(result.status, 200);
	assert.equal(result.headers.get("content-type"), "image/jpeg");
	assert.equal(result.headers.get("X-Cache"), "MISS");
	assert.equal(result.body, "JPEG#1");
	assert.equal(browserState.renders, 1);
});

await ok("尺寸固定 1280x720，jpeg 画质 80，不截整页", () => {
	const options = browserState.lastOptions;
	assert.equal(options.viewport.width, 1280);
	assert.equal(options.viewport.height, 720);
	assert.equal(options.viewport.deviceScaleFactor, 1);
	assert.equal(options.screenshotOptions.type, "jpeg");
	assert.equal(options.screenshotOptions.quality, 80);
	assert.equal(options.screenshotOptions.fullPage, false);
	assert.equal(options.gotoOptions.waitUntil, "networkidle2");
	assert.deepEqual(options.rejectResourceTypes, ["media"]);
});

await ok("值里就是图片本身，没有头部", async () => {
	const entry = kv.store.get(nowKey(HOST));
	assert.equal(entry.bytes.length, "JPEG#1".length);
	assert.equal(new TextDecoder().decode(entry.bytes), "JPEG#1");
});

await ok("当前份带一个 3~7 天的随机有效期", () => {
	const entry = kv.store.get(nowKey(HOST));
	const days = (entry.expiresAt - Date.now()) / 86400000;
	assert.ok(days >= 3 && days <= 7, `实际 ${days} 天`);
});

await ok("兜底份永不过期", () => {
	const entry = kv.store.get(lastKey(HOST));
	assert.ok(entry, "应该写了一条 shot:last");
	assert.equal(entry.ttl, null, "不传 expirationTtl 就是永久");
	assert.equal(entry.expiresAt, Infinity);
});

await ok("第二次请求命中当前份，不再渲染", async () => {
	const result = await call();
	assert.equal(result.headers.get("X-Cache"), "KV");
	assert.equal(result.body, "JPEG#1");
	assert.equal(browserState.renders, 1);
});

await ok("边缘 max-age 在 10~60 分钟之间随机", async () => {
	const seen = new Set();
	for (let i = 0; i < 30; i++) {
		const result = await call();
		const maxAge = Number(
			/max-age=(\d+)/.exec(result.headers.get("cache-control"))[1],
		);
		assert.ok(maxAge >= 600 && maxAge <= 3600, `实际 ${maxAge}`);
		assert.match(
			result.headers.get("cache-control"),
			/stale-while-revalidate=60/,
			"过期时应先给旧图、后台再验证",
		);
		seen.add(maxAge);
	}
	assert.ok(seen.size > 5, `应该每次都不同，实际 ${seen.size} 种`);
});

await ok("同一个 host 用不同 URL 请求，共用同一张图", async () => {
	const result = await call(
		new Request("https://shot.internal/?host=a.com&t=https%3A%2F%2Fa.com%2Fblog"),
	);
	assert.equal(result.headers.get("X-Cache"), "KV");
	assert.equal(result.body, "JPEG#1");
	assert.equal(browserState.renders, 1, "不应该因为路径不同再渲染一次");
});

await ok("Cache-Tag 里带 host，方便按站点清缓存", async () => {
	const result = await call();
	assert.equal(result.headers.get("cache-tag"), "shot, shot:a.com");
});

section("shot.ts — 限流与兜底");

await ok("撞上限流：503 + Retry-After，不写负缓存", async () => {
	const fresh = makeKV();
	const limited = new Shot(
		{ waitUntil: () => {} },
		{ SHOTS: fresh, BROWSER: makeBrowser({ rateLimit: true, renders: 0 }) },
	);
	const res = await limited.fetch(inner());
	assert.equal(res.status, 503);
	assert.equal(res.headers.get("retry-after"), "10");
	assert.equal(fresh.store.has(failKey(HOST)), false, "限流不是目标故障");
});

await ok("撞上限流但有兜底份：返回旧图而不是 503", async () => {
	const fresh = makeKV();
	const limited = new Shot(
		{ waitUntil: () => {} },
		{ SHOTS: fresh, BROWSER: makeBrowser({ rateLimit: true, renders: 0 }) },
	);
	await fresh.put(lastKey(HOST), new TextEncoder().encode("JPEG#old"), {});
	const res = await limited.fetch(inner());
	assert.equal(res.status, 200);
	assert.equal(res.headers.get("X-Cache"), "STALE");
	assert.equal(new TextDecoder().decode(await res.arrayBuffer()), "JPEG#old");
	assert.ok(res.headers.get("X-Screenshot-Reason"), "应带上原因");
});

await ok("真实失败：写负缓存并返回 502", async () => {
	const fresh = makeKV();
	const failing = new Shot(
		{ waitUntil: () => {} },
		{ SHOTS: fresh, BROWSER: makeBrowser({ down: true, renders: 0 }) },
	);
	const res = await failing.fetch(inner());
	assert.equal(res.status, 502);
	const entry = fresh.store.get(failKey(HOST));
	assert.ok(entry, "应该写负缓存");
	const minutes = (entry.expiresAt - Date.now()) / 60000;
	assert.ok(minutes > 29 && minutes <= 30, `实际 ${minutes} 分钟`);
});

await ok("负缓存期内不再渲染，但仍能拿到兜底图", async () => {
	const fresh = makeKV();
	const state = { down: true, renders: 0 };
	const failing = new Shot(
		{ waitUntil: () => {} },
		{ SHOTS: fresh, BROWSER: makeBrowser(state) },
	);
	await failing.fetch(inner());
	assert.equal(state.renders, 1);

	await fresh.put(lastKey(HOST), new TextEncoder().encode("JPEG#old"), {});
	const res = await failing.fetch(inner());
	assert.equal(res.status, 200);
	assert.equal(res.headers.get("X-Cache"), "STALE");
	assert.equal(state.renders, 1, "负缓存期内不该再渲染");
});

await ok("目标恢复后重新出图，并刷新两份记录", async () => {
	const fresh = makeKV();
	const state = { down: false, renders: 0 };
	const instance = new Shot(
		{ waitUntil: () => {} },
		{ SHOTS: fresh, BROWSER: makeBrowser(state) },
	);
	await fresh.put(lastKey(HOST), new TextEncoder().encode("JPEG#old"), {});
	const res = await instance.fetch(inner());
	assert.equal(res.status, 200);
	assert.equal(res.headers.get("X-Cache"), "MISS");
	assert.equal(state.renders, 1);
	assert.equal(new TextDecoder().decode(fresh.store.get(nowKey(HOST)).bytes), "JPEG#1");
	assert.equal(new TextDecoder().decode(fresh.store.get(lastKey(HOST)).bytes), "JPEG#1");
});

await ok("当前份过期（键消失）后重新渲染", async () => {
	const fresh = makeKV();
	const state = { renders: 0 };
	const instance = new Shot(
		{ waitUntil: () => {} },
		{ SHOTS: fresh, BROWSER: makeBrowser(state) },
	);
	await instance.fetch(inner());
	assert.equal(state.renders, 1);
	// 模拟 KV 到了有效期，键被删掉
	fresh.store.delete(nowKey(HOST));
	const res = await instance.fetch(inner());
	assert.equal(res.headers.get("X-Cache"), "MISS");
	assert.equal(state.renders, 2);
});

section("shot.ts — 有效期随机性");

await ok("randomTtl 落在 3~7 天之间", () => {
	for (let i = 0; i < 300; i++) {
		const days = randomTtl() / 86400;
		assert.ok(days >= 3 && days <= 7, `实际 ${days} 天`);
	}
});

await ok("连续抽到的到期时间互不相同，不会挤在一起", () => {
	const seen = new Set();
	for (let i = 0; i < 200; i++) {
		seen.add(randomTtl());
	}
	assert.ok(seen.size > 150, `实际 ${seen.size} 种`);
});

// ---------------------------------------------------------------------------
// index.ts（网关）
// ---------------------------------------------------------------------------

section("index.ts — 网关");

const gateway = (qs = `url=${enc("https://a.com/")}`, init) =>
	new Request(`https://api.example.com/?${qs}`, init);

function makeCtx() {
	const calls = [];
	return {
		calls,
		ctx: {
			exports: {
				Shot: {
					async fetch(req, opts) {
						calls.push({ url: req.url, opts });
						return new Response("JPEG#gw", {
							headers: { "content-type": "image/jpeg", "X-Cache": "MISS" },
						});
					},
				},
			},
		},
	};
}

await ok("GET 转交给 Shot：内部 URL 带 host 与目标，缓存键按 host", async () => {
	const { ctx, calls } = makeCtx();
	const res = await worker.fetch(gateway(), {}, ctx);
	assert.equal(res.status, 200);
	assert.equal(res.headers.get("content-type"), "image/jpeg");
	assert.equal(calls.length, 1);
	const inner = new URL(calls[0].url);
	assert.equal(inner.hostname, "shot.internal");
	assert.equal(inner.searchParams.get("host"), "a.com");
	assert.equal(inner.searchParams.get("t"), "https://a.com/");
	assert.deepEqual(calls[0].opts, { cf: { cacheKey: "/?host=a.com" } });
});

await ok("非 GET 一律 405，HEAD 也不放行，且不转交", async () => {
	for (const method of ["POST", "PUT", "HEAD", "DELETE"]) {
		const { ctx, calls } = makeCtx();
		const res = await worker.fetch(gateway(undefined, { method }), {}, ctx);
		assert.equal(res.status, 405, method);
		assert.equal(res.headers.get("allow"), "GET", method);
		assert.equal(res.headers.get("cache-control"), "no-store", method);
		assert.equal(calls.length, 0, `${method} 不该转交到 Shot`);
	}
});

await ok("来源不在白名单：403 且不缓存、不转交", async () => {
	const { ctx, calls } = makeCtx();
	const req = new Request(
		`https://api.example.com/?url=${enc("https://a.com/")}`,
		{ headers: { origin: "https://evil.com" } },
	);
	const res = await worker.fetch(req, { ALLOWED_DOMAINS: "example.com" }, ctx);
	assert.equal(res.status, 403);
	assert.equal(res.headers.get("cache-control"), "no-store");
	assert.equal(calls.length, 0);
});

await ok("白名单内来源正常转交", async () => {
	const { ctx, calls } = makeCtx();
	const req = new Request(
		`https://api.example.com/?url=${enc("https://a.com/")}`,
		{ headers: { referer: "https://blog.example.com/post" } },
	);
	const res = await worker.fetch(req, { ALLOWED_DOMAINS: "example.com" }, ctx);
	assert.equal(res.status, 200);
	assert.equal(calls.length, 1);
});

await ok("缺 url / 非法 url / 内网目标都在网关拦下 400", async () => {
	for (const qs of ["", `url=${enc("not a url")}`, `url=${enc("http://127.0.0.1/")}`]) {
		const { ctx, calls } = makeCtx();
		const res = await worker.fetch(gateway(qs), {}, ctx);
		assert.equal(res.status, 400, qs);
		assert.equal(res.headers.get("cache-control"), "no-store", qs);
		assert.equal(calls.length, 0, qs);
	}
});

// ---------------------------------------------------------------------------

if (failures.length) {
	console.error(`\n${failures.length} 项失败：`);
	for (const failure of failures) console.error(`  ✗ ${failure}`);
	process.exit(1);
}
console.log(`\n全部通过：${pass} 项断言（渲染次数 ${browserState.renders}）`);
