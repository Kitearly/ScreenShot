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
import {
	Shot,
	decode,
	encode,
	makeHeader,
	randomUntil,
} from "../src/shot.ts";
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

await ok("缓存键就是 host", () => {
	assert.equal(cacheHost("https://Example.COM/blog?id=1"), "example.com");
	assert.equal(cacheHost("https://example.com:8443/x"), "example.com");
});

await ok("同一个 host 的不同页面共用一份图", () => {
	assert.equal(
		cacheHost("https://a.com/blog"),
		cacheHost("https://a.com/about"),
	);
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

const browserState = {
	down: false,
	rateLimit: false,
	renders: 0,
	lastOptions: null,
	lastUrl: null,
};
const kv = makeKV();
const env = { SHOTS: kv, BROWSER: makeBrowser(browserState) };
const testCtx = makeContext();
const shot = new Shot({ waitUntil: testCtx.waitUntil }, env);

const HOST = "a.com";
const TARGET = enc("https://a.com/");
const KEY = `shot:v1:${HOST}`;
const inner = (headers, host = HOST, target = TARGET) =>
	new Request(
		`https://shot.internal/?host=${host}&t=${target}&w=1280&h=720&q=80&f=0`,
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

/** 读出 KV 里存的头部。 */
const headerOf = (key = KEY) => {
	const entry = kv.store.get(key);
	if (!entry) return null;
	return decode(entry.bytes.buffer.slice(0)).header;
};

/** 把某条记录改成已过期 / 未到期。 */
const setExpiry = (seconds, key = KEY) => {
	const entry = kv.store.get(key);
	const stored = decode(entry.bytes.buffer.slice(0));
	const header = { ...stored.header, e: Math.floor(Date.now() / 1000) + seconds };
	entry.bytes = encode(header, stored.bytes);
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

await ok("键就是 host，一个 host 只有一条记录", () => {
	assert.ok(kv.store.has(KEY));
	assert.equal(kv.store.size, 1, "不应该有第二份");
});

await ok("头部和图片存在同一个 KV 值里", () => {
	const header = headerOf();
	assert.equal(header.u, "https://a.com/");
	assert.equal(header.w, 1280);
	assert.equal(header.h, 720);
	assert.equal(header.q, 80);
	assert.ok(
		Math.abs(header.t - Date.now() / 1000) < 5,
		`生成时间应该就是刚才，实际 ${header.t}`,
	);
});

await ok("KV 保留 30 天，和有效期解耦", () => {
	const entry = kv.store.get(KEY);
	const days = (entry.expiresAt - Date.now()) / 86400000;
	assert.ok(days > 29 && days <= 30, `实际 ${days} 天`);
});

await ok("有效期是随机的，落在 48~96 小时之间", () => {
	const now = Date.now();
	for (let i = 0; i < 200; i++) {
		const until = randomUntil(now);
		const hours = (until - now / 1000) / 3600;
		assert.ok(hours >= 48 && hours <= 96, `实际 ${hours} 小时`);
	}
});

await ok("同一个 host 连续刷新，到期时间会换位置", () => {
	const seen = new Set();
	for (let i = 0; i < 50; i++) {
		seen.add(randomUntil(Date.now()));
	}
	assert.ok(seen.size > 40, `应该有多个不同的到期时间，实际 ${seen.size}`);
});

await ok("第二次请求命中缓存，不再渲染", async () => {
	const result = await call();
	assert.equal(result.headers.get("X-Cache"), "KV");
	assert.equal(result.body, "JPEG#1");
	assert.equal(browserState.renders, 1);
});

await ok("同一个 host 用不同尺寸请求，共用同一张图", async () => {
	const result = await call(
		inner(undefined, HOST, TARGET).constructor === Request
			? new Request(
					`https://shot.internal/?host=${HOST}&t=${TARGET}&w=800&h=600&q=60&f=0`,
				)
			: inner(),
	);
	assert.equal(result.headers.get("X-Cache"), "KV");
	assert.equal(result.body, "JPEG#1");
	assert.equal(browserState.renders, 1, "不应该因为尺寸不同再渲染一次");
});

await ok("过期时先给旧图（不阻塞），刷新放到后台", async () => {
	setExpiry(-10);
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

await ok("后台刷新完成后，到期时间重新随机", async () => {
	const header = headerOf();
	const hours = (header.e - Date.now() / 1000) / 3600;
	assert.ok(hours >= 48 && hours <= 96, `实际 ${hours} 小时`);
	assert.equal(header.t, Math.floor(Date.now() / 1000));
});

await ok("后台刷新完成后，下一次请求拿到新图", async () => {
	const result = await call();
	assert.equal(result.headers.get("X-Cache"), "KV");
	assert.equal(result.body, "JPEG#2");
	assert.equal(browserState.renders, 2);
});

await ok("目标挂掉且图已过期时回退到最后一次成功的截图", async () => {
	browserState.down = true;
	setExpiry(-10);
	const before = browserState.renders;
	const result = await call();
	assert.equal(result.status, 200, "应该回退而不是 502");
	assert.equal(result.headers.get("X-Cache"), "STALE");
	assert.equal(result.body, "JPEG#2", "应该是最后一次成功的图");
	assert.equal(browserState.renders, before + 1, "后台尝试过刷新");
	assert.ok(kv.store.has(`fail:v1:${HOST}`), "真实失败要写负缓存");
});

await ok("负缓存生效：5 分钟内不再重试渲染", async () => {
	setExpiry(-10);
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
	kv.store.delete(`fail:v1:${HOST}`);
	setExpiry(-10);
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

	assert.equal(fresh.store.has(`fail:v1:${HOST}`), false, "限流不是目标故障");
	const pending = decode(fresh.store.get(KEY).bytes.buffer.slice(0));
	assert.equal(pending.header.t, 0, "记成 pending，等着 cron 去补");
	assert.equal(pending.bytes, null, "pending 记录里没有图");
	assert.equal(pending.header.u, "https://a.com/");
});

await ok("pending 记录不会当成旧图返回", async () => {
	const fresh = makeKV();
	const ctx = makeContext();
	const state = { rateLimit: false, renders: 0 };
	const instance = new Shot(
		{ waitUntil: ctx.waitUntil },
		{ SHOTS: fresh, BROWSER: makeBrowser(state) },
	);
	// 先放一条 pending
	await fresh.put(
		KEY,
		encode(
			{
				u: "https://a.com/",
				w: 1280,
				h: 720,
				q: 80,
				f: 0,
				t: 0,
				e: 0,
				n: 0,
				y: 0,
			},
			null,
		),
		{},
	);
	const res = await instance.fetch(inner());
	await ctx.flush();
	assert.equal(res.status, 200);
	assert.equal(res.headers.get("X-Cache"), "MISS");
	assert.equal(state.renders, 1);
});

await ok("有过期旧图时，限流不影响出图", async () => {
	const fresh = makeKV();
	const ctx = makeContext();
	const state = { rateLimit: true, renders: 0 };
	const limited = new Shot(
		{ waitUntil: ctx.waitUntil },
		{ SHOTS: fresh, BROWSER: makeBrowser(state) },
	);
	const header = {
		u: "https://a.com/",
		w: 1280,
		h: 720,
		q: 80,
		f: 0,
		t: Math.floor(Date.now() / 1000) - 3 * 86400,
		e: Math.floor(Date.now() / 1000) - 3600,
		n: 0,
		y: 0,
	};
	await fresh.put(KEY, encode(header, new TextEncoder().encode("JPEG#old")), {});

	const res = await limited.fetch(inner());
	assert.equal(res.status, 200);
	assert.equal(res.headers.get("X-Cache"), "STALE");
	assert.equal(new TextDecoder().decode(await res.arrayBuffer()), "JPEG#old");
	await ctx.flush();
	assert.equal(fresh.store.has(`fail:v1:${HOST}`), false);
});

section("shot.ts — 编解码");

await ok("头部与图片能原样往返", () => {
	const header = makeHeader(
		{ url: "https://a.com/", width: 1280, height: 720, quality: 80, fullPage: false },
		Date.now(),
	);
	const bytes = new Uint8Array([1, 2, 3, 250, 251, 252]);
	const stored = decode(encode(header, bytes).buffer.slice(0));
	assert.equal(stored.header.u, header.u);
	assert.equal(stored.header.e, header.e);
	assert.deepEqual([...new Uint8Array(stored.bytes)], [1, 2, 3, 250, 251, 252]);
});

await ok("没有图片时解码出 null", () => {
	const header = makeHeader(
		{ url: "https://a.com/", width: 1280, height: 720, quality: 80, fullPage: false },
		Date.now(),
	);
	const stored = decode(encode(header, null).buffer.slice(0));
	assert.equal(stored.bytes, null);
	assert.equal(stored.header.u, "https://a.com/");
});

// ---------------------------------------------------------------------------
// warm.ts
// ---------------------------------------------------------------------------

section("warm.ts — 后台刷新");

const dueHeader = (over = {}) => ({
	u: "https://a.com/",
	w: 1280,
	h: 720,
	q: 80,
	f: 0,
	t: Math.floor(Date.now() / 1000) - 3 * 86400,
	e: Math.floor(Date.now() / 1000) - 3600,
	n: 0,
	y: 0,
	...over,
});

await ok("补上 pending 记录", async () => {
	const fresh = makeKV();
	const state = { renders: 0 };
	await fresh.put(
		KEY,
		encode(dueHeader({ t: 0, e: 0 }), null),
		{},
	);
	await warm({ SHOTS: fresh, BROWSER: makeBrowser(state) });
	assert.equal(state.renders, 1);
	const stored = decode(fresh.store.get(KEY).bytes.buffer.slice(0));
	assert.ok(stored.bytes, "应该写出图了");
	assert.ok(stored.header.t > 0, "不再是 pending");
});

await ok("刷新到期的那一张", async () => {
	const fresh = makeKV();
	const state = { renders: 0 };
	const soon = Math.floor(Date.now() / 1000) - 10;
	await fresh.put(KEY, encode(dueHeader({ e: soon }), new Uint8Array([1])), {});
	await warm({ SHOTS: fresh, BROWSER: makeBrowser(state) });
	assert.equal(state.renders, 1);
	const stored = decode(fresh.store.get(KEY).bytes.buffer.slice(0));
	assert.ok(stored.header.e > Date.now() / 1000, "到期时间推到将来");
});

await ok("没到期的不动", async () => {
	const fresh = makeKV();
	const state = { renders: 0 };
	await fresh.put(
		KEY,
		encode(dueHeader({ e: Math.floor(Date.now() / 1000) + 60000 }), new Uint8Array([1])),
		{},
	);
	await warm({ SHOTS: fresh, BROWSER: makeBrowser(state) });
	assert.equal(state.renders, 0);
});

await ok("每个 tick 只渲染一个", async () => {
	const fresh = makeKV();
	const state = { renders: 0 };
	await fresh.put("shot:v1:a.com", encode(dueHeader(), new Uint8Array([1])), {});
	await fresh.put("shot:v1:b.com", encode(dueHeader(), new Uint8Array([1])), {});
	await fresh.put("shot:v1:c.com", encode(dueHeader(), new Uint8Array([1])), {});
	await warm({ SHOTS: fresh, BROWSER: makeBrowser(state) });
	assert.equal(state.renders, 1, "1 次/5 分钟，永远碰不到限流");
});

await ok("失败后退避，并保留旧图", async () => {
	const fresh = makeKV();
	const state = { down: true, renders: 0 };
	await fresh.put(
		KEY,
		encode(dueHeader(), new TextEncoder().encode("JPEG#old")),
		{},
	);
	await warm({ SHOTS: fresh, BROWSER: makeBrowser(state) });
	assert.equal(state.renders, 1);

	const stored = decode(fresh.store.get(KEY).bytes.buffer.slice(0));
	assert.ok(stored.bytes, "旧图不能丢");
	assert.equal(new TextDecoder().decode(stored.bytes), "JPEG#old");
	assert.equal(stored.header.y, 1, "记一次失败");
	const delay = stored.header.n - Date.now() / 1000;
	assert.ok(delay > 500 && delay <= 600, `应该退避约 10 分钟，实际 ${delay}s`);
	assert.ok(fresh.store.has(`fail:v1:a.com`), "顺手写负缓存");
});

await ok("退避期内不再重试", async () => {
	const fresh = makeKV();
	const state = { down: true, renders: 0 };
	await fresh.put(
		KEY,
		encode(
			dueHeader({ n: Math.floor(Date.now() / 1000) + 600, y: 1 }),
			new Uint8Array([1]),
		),
		{},
	);
	await warm({ SHOTS: fresh, BROWSER: makeBrowser(state) });
	assert.equal(state.renders, 0);
});

// ---------------------------------------------------------------------------

if (failures.length) {
	console.error(`\n${failures.length} 项失败：`);
	for (const failure of failures) console.error(`  ✗ ${failure}`);
	process.exit(1);
}
console.log(`\n全部通过：${pass} 项断言（渲染次数 ${browserState.renders}）`);
