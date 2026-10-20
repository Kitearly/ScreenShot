/**
 * 截图渲染与持久化。
 *
 * 这个入口是被缓存的那一层：网关把校验后的参数转交到这里，
 * 同一 canonical key 的并发请求会被 Workers Cache 合并成一次渲染。
 */

import { WorkerEntrypoint } from "cloudflare:workers";
import {
	DEFAULT_HEIGHT,
	DEFAULT_QUALITY,
	DEFAULT_WIDTH,
	assertPublicHost,
	clampInt,
	type Env,
} from "./target";

// ---------------------------------------------------------------------------
// 配置
// ---------------------------------------------------------------------------

/** 截图有效期（秒）。同时作为边缘缓存 max-age 与「新鲜度」的判定依据。 */
const TTL = 86_400;
/**
 * 截图在 KV 里的保留时长（秒，KV 上限 30 天）。
 *
 * 与 TTL 解耦：TTL 决定「这份截图算不算新鲜」，KEEP_TTL 决定「这份截图留多久」。
 * 留得久是为了在目标站挂掉时，仍能回退到**最后一次成功的截图** ——
 * 哪怕那份截图已经是 20 天前生成的。
 */
const KEEP_TTL = 2_592_000;
/** stale-while-revalidate 窗口：过期后先返回旧图，后台刷新。 */
const SWR = 86_400;
/** stale-if-error 窗口：刷新失败时继续提供旧图。 */
const SIE = 604_800;
/** 渲染失败后的负缓存时长（秒），避免对同一个坏目标反复消耗配额。 */
const NEG_TTL = 300;
/** 兜底旧图的边缘缓存时长（秒），短一些，好让目标恢复后尽快重试。 */
const STALE_MAX_AGE = 60;
/** 页面加载完成的判定条件。 */
const WAIT_UNTIL = "networkidle2";
/** 页面加载超时（毫秒）。 */
const GOTO_TIMEOUT = 20_000;
/** 截图动作超时（毫秒）。 */
const ACTION_TIMEOUT = 10_000;
/**
 * Cloudflare 侧浏览器缓存时长（秒）。
 * 设为 0 关闭：它的缓存键是否包含视口 / 质量等参数并无公开说明，
 * 开着有拿到错误尺寸图片的风险，收益也仅限"本地缓存被清空"这一种情况。
 */
const BROWSER_CACHE_TTL = 0;

const CONTENT_TYPE = "image/jpeg";

/** 截图元数据，和二进制分开存放，避免 base64 带来的体积与 CPU 开销。 */
interface ShotMeta {
	/** 生成时间（毫秒时间戳）。 */
	t: number;
	/** 规范化后的目标地址。 */
	u: string;
	w: number;
	h: number;
	q: number;
	/** 1 = 整页截图。 */
	f: 0 | 1;
}

/** 一张已存好的截图。 */
interface Stored {
	bytes: ArrayBuffer;
	generatedAt: number;
	age: number;
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

export class Shot extends WorkerEntrypoint<Env> {
	async fetch(request: Request): Promise<Response> {
		const { env, ctx } = this;
		const params = new URL(request.url).searchParams;

		const key = params.get("k") ?? "";
		const target = params.get("t") ?? "";
		if (!key || !target) {
			return problem(400, "missing cache key or target");
		}

		const width = clampInt(params.get("w"), DEFAULT_WIDTH, 320, 1920);
		const height = clampInt(params.get("h"), DEFAULT_HEIGHT, 400, 4000);
		const quality = clampInt(params.get("q"), DEFAULT_QUALITY, 40, 95);
		const fullPage = params.get("f") === "1";

		const metaKey = `meta:v1:${key}`;
		const shotKey = `shot:v1:${key}`;
		const failKey = `fail:v1:${key}`;

		// 1) 取已存的截图。新鲜的直接返回；过期的留作兜底。
		const stored = await loadStored(env, metaKey, shotKey);
		if (stored && stored.age < TTL) {
			return image(request, stored, key, "KV");
		}

		// 2) 负缓存：刚失败过的目标不再触发渲染。
		const failure = await env.SHOTS.get(failKey, "text");
		if (failure) {
			return staleOrFail(request, stored, key, failure);
		}

		// 3) 渲染。目标主机的 DNS 结果在这里复核一次，挡住指向内网的域名。
		const guard = await assertPublicHost(target);
		if (!guard.ok) {
			return problem(403, `blocked target: ${guard.reason}`);
		}

		const response = await env.BROWSER.quickAction("screenshot", {
			url: target,
			viewport: { width, height, deviceScaleFactor: 1 },
			gotoOptions: { waitUntil: WAIT_UNTIL, timeout: GOTO_TIMEOUT },
			actionTimeout: ACTION_TIMEOUT,
			screenshotOptions: {
				type: "jpeg",
				quality,
				fullPage,
				optimizeForSpeed: true,
			},
			// 视频 / 音频对封面图没有意义，屏蔽掉能明显缩短渲染时间。
			rejectResourceTypes: ["media"],
			cacheTTL: BROWSER_CACHE_TTL,
		});

		if (!response.ok) {
			const detail = (await response.text()).slice(0, 300);
			// 渲染失败不计入浏览器时长，但仍要挡住后续请求，别把配额耗光。
			await env.SHOTS.put(failKey, detail || `HTTP ${response.status}`, {
				expirationTtl: NEG_TTL,
			});
			return staleOrFail(request, stored, key, `HTTP ${response.status}`);
		}

		const bytes = new Uint8Array(await response.arrayBuffer());
		const now = Date.now();
		const browserMs = response.headers.get("X-Browser-Ms-Used");

		ctx.waitUntil(
			Promise.all([
				env.SHOTS.put(shotKey, bytes, { expirationTtl: KEEP_TTL }),
				env.SHOTS.put(
					metaKey,
					JSON.stringify({
						t: now,
						u: target,
						w: width,
						h: height,
						q: quality,
						f: fullPage ? 1 : 0,
					} satisfies ShotMeta),
					{ expirationTtl: KEEP_TTL },
				),
			]),
		);

		return image(
			request,
			{ bytes: bytes.buffer as ArrayBuffer, generatedAt: now, age: 0 },
			key,
			"MISS",
			browserMs,
		);
	}
}

// ---------------------------------------------------------------------------
// 存取
// ---------------------------------------------------------------------------

async function loadStored(
	env: Env,
	metaKey: string,
	shotKey: string,
): Promise<Stored | null> {
	const meta = await env.SHOTS.get<ShotMeta>(metaKey, "json");
	if (!meta) return null;
	const bytes = await env.SHOTS.get(shotKey, "arrayBuffer");
	if (!bytes || bytes.byteLength === 0) return null;
	return {
		bytes,
		generatedAt: meta.t,
		age: Math.max(0, Math.floor((Date.now() - meta.t) / 1000)),
	};
}

// ---------------------------------------------------------------------------
// 响应
// ---------------------------------------------------------------------------

/** 新鲜截图。 */
function image(
	request: Request,
	stored: Stored,
	key: string,
	cache: string,
	browserMs?: string | null,
): Response {
	const etag = `"${key}-${stored.generatedAt}"`;
	const headers = new Headers({
		"Content-Type": CONTENT_TYPE,
		"Cache-Control": `public, max-age=${TTL}, stale-while-revalidate=${SWR}, stale-if-error=${SIE}`,
		ETag: etag,
		"Cache-Tag": `shot, shot:${key}`,
		"X-Cache": cache,
		"X-Screenshot-Age": String(stored.age),
	});
	if (browserMs) {
		headers.set("X-Browser-Ms-Used", browserMs);
	}
	if (matchesEtag(request, etag)) {
		return new Response(null, { status: 304, headers });
	}
	return new Response(stored.bytes, { headers });
}

/** 兜底：能用旧图就用旧图，否则报错。 */
function staleOrFail(
	request: Request,
	stored: Stored | null,
	key: string,
	reason: string,
): Response {
	if (!stored) {
		return problem(502, `screenshot failed (${reason})`);
	}
	const etag = `"${key}-${stored.generatedAt}"`;
	const headers = new Headers({
		"Content-Type": CONTENT_TYPE,
		// 旧图只短暂缓存，好让目标恢复后尽快重试。
		"Cache-Control": `public, max-age=${STALE_MAX_AGE}, stale-while-revalidate=60, stale-if-error=${SIE}`,
		ETag: etag,
		"Cache-Tag": `shot, shot:${key}`,
		"X-Cache": "STALE",
		"X-Screenshot-Age": String(stored.age),
		"X-Screenshot-Reason": reason.slice(0, 200),
	});
	if (matchesEtag(request, etag)) {
		return new Response(null, { status: 304, headers });
	}
	return new Response(stored.bytes, { headers });
}

function matchesEtag(request: Request, etag: string): boolean {
	const header = request.headers.get("if-none-match");
	if (!header) return false;
	return header
		.split(",")
		.map((value) => value.trim())
		.some((value) => value === etag || value === "*");
}

function problem(status: number, message: string): Response {
	return new Response(message, {
		status,
		headers: {
			"Content-Type": "text/plain; charset=utf-8",
			// 错误不进入边缘缓存，负缓存由 KV 负责。
			"Cache-Control": "no-store",
		},
	});
}
