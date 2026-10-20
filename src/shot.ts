/**
 * 截图渲染与持久化。
 *
 * 这个入口是被缓存的那一层：网关把校验后的参数转交到这里，
 * 同一 canonical key 的并发请求会被 Workers Cache 合并成一次渲染。
 *
 * 账号级的硬限制是「Quick Action 1 次 / 10 秒」，所以这里的第一原则是
 * **绝不让页面等渲染**：手上还有旧图就先给旧图，刷新放到后台。
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

/** 截图有效期（秒）。 */
const TTL = 86_400;
/**
 * 有效期抖动窗口（秒）。
 *
 * 每个 key 的实际有效期是 `TTL + hash(key) % JITTER`。同一个页面并发渲染出来的
 * 十几张截图，会因此在几小时内错开陆续到期，而不是 24 小时后同时过期、
 * 同时去抢那「1 次 / 10 秒」的额度。
 */
const JITTER = 21_600;
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
/** 兜底旧图的边缘缓存时长（秒），短一些，好让后台刷新完成后尽快生效。 */
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

/** 预热记录的键前缀。 */
export const WARM_PREFIX = "warm:v1:";
/** 提前多久刷新（秒），保证边缘缓存到期前 KV 里已经是新图。 */
const WARM_LEAD = 1_800;

const CONTENT_TYPE = "image/jpeg";

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

/** 一次截图的全部参数。 */
export interface ShotSpec {
	/** 规范化后的目标地址。 */
	url: string;
	width: number;
	height: number;
	quality: number;
	fullPage: boolean;
}

/** 截图元数据，和二进制分开存放，避免 base64 带来的体积与 CPU 开销。 */
interface ShotMeta {
	/** 生成时间（毫秒时间戳）。 */
	t: number;
	u: string;
	w: number;
	h: number;
	q: number;
	/** 1 = 整页截图。 */
	f: 0 | 1;
}

/** 预热队列里的一条记录。 */
export interface WarmRecord extends ShotSpec {
	/** 下次应该刷新的时间（毫秒时间戳）。 */
	due: number;
	/** 连续失败次数，用来做退避；成功一次就归零。 */
	tries?: number;
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

		const spec: ShotSpec = {
			url: target,
			width: clampInt(params.get("w"), DEFAULT_WIDTH, 320, 1920),
			height: clampInt(params.get("h"), DEFAULT_HEIGHT, 400, 4000),
			quality: clampInt(params.get("q"), DEFAULT_QUALITY, 40, 95),
			fullPage: params.get("f") === "1",
		};

		const ttl = ttlFor(key);
		const stored = await loadStored(env, key);

		// 1) 新鲜：直接给。
		if (stored && stored.age < ttl) {
			return image(request, stored, key, "KV", ttl);
		}

		// 2) 过期但有旧图：先给旧图，后台刷新。
		//    这一步是整套限流策略的核心 —— 页面永远不会为了一次刷新而等待。
		if (stored) {
			ctx.waitUntil(refresh(env, key, spec));
			return stale(request, stored, key, "expired");
		}

		// 3) 从没成功过：只能同步渲染，也就只有这里可能撞上限流。
		const failure = await env.SHOTS.get(failKey(key), "text");
		if (failure) {
			return problem(502, `screenshot failed (${failure})`);
		}

		// 目标主机的 DNS 结果在这里复核一次，挡住指向内网的域名。
		const guard = await assertPublicHost(target);
		if (!guard.ok) {
			return problem(403, `blocked target: ${guard.reason}`);
		}

		const result = await capture(env, spec);
		if (!result.ok) {
			if (result.rateLimited) {
				// 撞上「1 次 / 10 秒」的账号级限制：目标本身没问题，
				// 绝不能写负缓存，否则这张图会被自己锁死 5 分钟。
				// 登记进预热队列，交给 cron 在限流之外补上。
				ctx.waitUntil(register(env, key, spec, Date.now()));
				return problem(503, "browser rate limited, retry later", {
					"Retry-After": "10",
				});
			}
			await noteFailure(env, key, result.reason);
			return problem(502, `screenshot failed (${result.reason})`);
		}

		const now = Date.now();
		ctx.waitUntil(store(env, key, spec, result.bytes, now));

		return image(
			request,
			{ bytes: result.bytes.buffer as ArrayBuffer, generatedAt: now, age: 0 },
			key,
			"MISS",
			ttl,
			result.browserMs,
		);
	}
}

// ---------------------------------------------------------------------------
// 渲染
// ---------------------------------------------------------------------------

/** 后台刷新：失败了也不吭声，旧图继续用就是了。 */
async function refresh(env: Env, key: string, spec: ShotSpec): Promise<void> {
	// 刚失败过的目标先别碰，避免每 60 秒重试一次把它刷成重试风暴。
	if (await env.SHOTS.get(failKey(key), "text")) {
		return;
	}
	const guard = await assertPublicHost(spec.url);
	if (!guard.ok) {
		return;
	}

	const result = await capture(env, spec);
	if (!result.ok) {
		if (!result.rateLimited) {
			await noteFailure(env, key, result.reason);
		}
		return;
	}
	await store(env, key, spec, result.bytes, Date.now());
}

/** 渲染一次。失败不抛异常，交给调用方决定回退还是报错。 */
export async function capture(
	env: Env,
	spec: ShotSpec,
): Promise<
	| { ok: true; bytes: Uint8Array; browserMs: string | null }
	| { ok: false; reason: string; rateLimited: boolean }
> {
	let response: Response;
	try {
		response = await env.BROWSER.quickAction("screenshot", {
			url: spec.url,
			viewport: {
				width: spec.width,
				height: spec.height,
				deviceScaleFactor: 1,
			},
			gotoOptions: { waitUntil: WAIT_UNTIL, timeout: GOTO_TIMEOUT },
			actionTimeout: ACTION_TIMEOUT,
			screenshotOptions: {
				type: "jpeg",
				quality: spec.quality,
				fullPage: spec.fullPage,
				optimizeForSpeed: true,
			},
			// 视频 / 音频对封面图没有意义，屏蔽掉能明显缩短渲染时间。
			rejectResourceTypes: ["media"],
			cacheTTL: BROWSER_CACHE_TTL,
		});
	} catch (error) {
		return {
			ok: false,
			reason: error instanceof Error ? error.message : String(error),
			rateLimited: false,
		};
	}

	if (!response.ok) {
		const detail = (await response.text()).slice(0, 200);
		return {
			ok: false,
			reason: `HTTP ${response.status}${detail ? `: ${detail}` : ""}`,
			// 429 = 撞上「1 次 / 10 秒」的账号级限制，说明目标没问题。
			rateLimited: response.status === 429,
		};
	}

	return {
		ok: true,
		bytes: new Uint8Array(await response.arrayBuffer()),
		browserMs: response.headers.get("X-Browser-Ms-Used"),
	};
}

// ---------------------------------------------------------------------------
// 存取
// ---------------------------------------------------------------------------

const metaKey = (key: string) => `meta:v1:${key}`;
const shotKey = (key: string) => `shot:v1:${key}`;
const failKey = (key: string) => `fail:v1:${key}`;

/**
 * 这个 key 的有效期（秒）。
 *
 * 用 hash 而不是随机数：同一个 key 每次算出同一个值，
 * 边缘缓存的 max-age 和 KV 里的新鲜度判定才不会互相打架。
 */
export function ttlFor(key: string): number {
	let hash = 0;
	for (let i = 0; i < key.length; i++) {
		hash = (hash * 31 + key.charCodeAt(i)) | 0;
	}
	return TTL + (Math.abs(hash) % JITTER);
}

/** 写入一张截图（含元数据与预热记录）。 */
export async function store(
	env: Env,
	key: string,
	spec: ShotSpec,
	bytes: Uint8Array,
	now: number,
): Promise<void> {
	const meta: ShotMeta = {
		t: now,
		u: spec.url,
		w: spec.width,
		h: spec.height,
		q: spec.quality,
		f: spec.fullPage ? 1 : 0,
	};
	// 注意这里逐字段拷贝：spec 可能是一条带 tries 的预热记录，
	// 成功之后必须把失败次数清掉。
	const warm: WarmRecord = {
		url: spec.url,
		width: spec.width,
		height: spec.height,
		quality: spec.quality,
		fullPage: spec.fullPage,
		due: now + (ttlFor(key) - WARM_LEAD) * 1000,
	};
	await Promise.all([
		env.SHOTS.put(shotKey(key), bytes, { expirationTtl: KEEP_TTL }),
		env.SHOTS.put(metaKey(key), JSON.stringify(meta), {
			expirationTtl: KEEP_TTL,
		}),
		env.SHOTS.put(WARM_PREFIX + key, JSON.stringify(warm), {
			expirationTtl: KEEP_TTL,
		}),
	]);
}

/** 登记到预热队列。`due` 决定 cron 什么时候来刷它。 */
export async function register(
	env: Env,
	key: string,
	spec: ShotSpec,
	due: number,
	tries?: number,
): Promise<void> {
	const record: WarmRecord = {
		url: spec.url,
		width: spec.width,
		height: spec.height,
		quality: spec.quality,
		fullPage: spec.fullPage,
		due,
	};
	if (tries) {
		record.tries = tries;
	}
	await env.SHOTS.put(WARM_PREFIX + key, JSON.stringify(record), {
		expirationTtl: KEEP_TTL,
	});
}

/** 记一次渲染失败，短时间内部再碰这个目标。 */
export async function noteFailure(
	env: Env,
	key: string,
	reason: string,
): Promise<void> {
	await env.SHOTS.put(failKey(key), reason, { expirationTtl: NEG_TTL });
}

async function loadStored(env: Env, key: string): Promise<Stored | null> {
	const meta = await env.SHOTS.get<ShotMeta>(metaKey(key), "json");
	if (!meta) return null;
	const bytes = await env.SHOTS.get(shotKey(key), "arrayBuffer");
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

/** 新鲜截图，可以长时间边缘缓存。 */
function image(
	request: Request,
	stored: Stored,
	key: string,
	cache: string,
	ttl: number,
	browserMs?: string | null,
): Response {
	const etag = `"${key}-${stored.generatedAt}"`;
	const headers = new Headers({
		"Content-Type": CONTENT_TYPE,
		// 只能缓存到真正过期为止，不能每次都重新给满 ttl。
		"Cache-Control": `public, max-age=${Math.max(STALE_MAX_AGE, ttl - stored.age)}, stale-while-revalidate=${SWR}, stale-if-error=${SIE}`,
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

/** 旧图。边缘上只留一分钟，好让后台刷新完成后尽快生效。 */
function stale(
	request: Request,
	stored: Stored,
	key: string,
	reason: string,
): Response {
	const etag = `"${key}-${stored.generatedAt}"`;
	const headers = new Headers({
		"Content-Type": CONTENT_TYPE,
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

function problem(
	status: number,
	message: string,
	extra?: Record<string, string>,
): Response {
	return new Response(message, {
		status,
		headers: {
			"Content-Type": "text/plain; charset=utf-8",
			// 错误不进入边缘缓存，负缓存由 KV 负责。
			"Cache-Control": "no-store",
			...extra,
		},
	});
}
