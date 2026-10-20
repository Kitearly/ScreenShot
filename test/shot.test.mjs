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
import { Shot } from "../src/shot.ts";

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
const request = (qs) => new Request(`https://api.example.com/shot?${qs}`);
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
	new Request(`https://api.example.com/shot?url=${enc("https://a.com/")}`, {
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
	};
}

function makeBrowser(state) {
	return {
		async quickAction(action, options) {
			assert.equal(action, "screenshot");
			state.renders++;
			state.lastOptions = options;
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

const browserState = { down: false, renders: 0, lastOptions: null };
const kv = makeKV();
const env = { SHOTS: kv, BROWSER: makeBrowser(browserState) };
const shot = new Shot({ waitUntil: (p) => p.catch(() => {}) }, env);

const KEY = "k1";
const TARGET = enc("https://a.com/");
const inner = (headers) =>
	new Request(
		`https://shot.internal/shot?k=${KEY}&t=${TARGET}&w=1280&h=720&q=80&f=0`,
		headers ? { headers } : undefined,
	);

const call = async (req = inner()) => {
	const res = await shot.fetch(req);
	const buf = res.status === 304 ? null : await res.clone().arrayBuffer();
	return {
		status: res.status,
		headers: res.headers,
		body: buf ? new TextDecoder().decode(buf) : null,
	};
};

const ageMeta = (days) => {
	const entry = kv.store.get(`meta:v1:${KEY}`);
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

await ok("图片与元数据都写进 KV", () => {
	assert.ok(kv.store.has(`shot:v1:${KEY}`));
	assert.ok(kv.store.has(`meta:v1:${KEY}`));
});

await ok("KV 保留 30 天，与 24 小时的新鲜期解耦", () => {
	const entry = kv.store.get(`shot:v1:${KEY}`);
	const days = (entry.expiresAt - Date.now()) / 86400000;
	assert.ok(days > 29 && days <= 30, `实际 ${days} 天`);
});

await ok("第二次请求命中 KV，不再渲染", async () => {
	const result = await call();
	assert.equal(result.headers.get("X-Cache"), "KV");
	assert.equal(result.body, "JPEG#1");
	assert.equal(browserState.renders, 1);
});

await ok("目标挂掉时回退到最后一次成功的截图", async () => {
	browserState.down = true;
	ageMeta(3);
	const result = await call();
	assert.equal(result.status, 200, "应该回退而不是 502");
	assert.equal(result.headers.get("X-Cache"), "STALE");
	assert.equal(result.body, "JPEG#1", "应该是最后一次成功的图");
	assert.equal(browserState.renders, 2, "应该尝试渲染一次");
	assert.ok(
		Number(result.headers.get("X-Screenshot-Age")) > 2 * 86400,
		"图龄应该是 3 天左右",
	);
	assert.ok(result.headers.get("X-Screenshot-Reason"), "应带上失败原因");
});

await ok("负缓存生效：5 分钟内不再渲染", async () => {
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
	const res = await failing.fetch(
		new Request(`https://shot.internal/shot?k=brandnew&t=${TARGET}&w=1280&h=720&q=80&f=0`),
	);
	assert.equal(res.status, 502);
});

await ok("目标恢复后重新出图", async () => {
	browserState.down = false;
	kv.store.delete(`fail:v1:${KEY}`);
	const result = await call();
	assert.equal(result.headers.get("X-Cache"), "MISS");
	assert.equal(result.body, "JPEG#3");
	assert.equal(browserState.renders, 3);
});

await ok("If-None-Match 命中时返回 304", async () => {
	const first = await call();
	const etag = first.headers.get("etag");
	const result = await call(inner({ "if-none-match": etag }));
	assert.equal(result.status, 304);
});

// ---------------------------------------------------------------------------

if (failures.length) {
	console.error(`\n${failures.length} 项失败：`);
	for (const failure of failures) console.error(`  ✗ ${failure}`);
	process.exit(1);
}
console.log(`\n全部通过：${pass} 项断言（渲染次数 ${browserState.renders}）`);
