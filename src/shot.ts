/**
 * 截图渲染与持久化。
 *
 * 这个入口是被缓存的那一层：网关把校验后的参数转交到这里，
 * 同一 host 的并发请求会被 Workers Cache 合并成一次渲染。
 *
 * 两件事决定了这里的写法：
 *
 * 1. 账号级的硬限制是「Quick Action 1 次 / 10 秒」，
 *    所以**绝不让页面等渲染**：有旧图就先给旧图，刷新放后台。
 * 2. 每次写入都重新抽一个随机的到期时间，
 *    这样同一批渲染出来的图会持续错开，永远不会一起到期、一起抢额度。
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

/**
 * 随机有效期的下界（秒）。48 小时。
 *
 * 网页截图不挑时效 —— 友链页面的封面两天换一次完全够用。
 */
const TTL_MIN = 172_800;
/**
 * 随机有效期的上界（秒）。96 小时。
 *
 * 每次写入都重抽，11 个 host 的到期时间会在这 4 小时的窗口里持续随机游走，
 * 不会像「固定 TTL + 固定偏移」那样出现周期性的同步刷新。
 */
const TTL_MAX = 345_600;
/**
 * 截图在 KV 里的保留时长（秒，KV 上限 30 天）。
 *
 * 和「有效期」是**两回事**：
 * - 有效期（随机，48~96h）决定这张图什么时候该重新渲染；
 * - 保留时长（30 天）决定这张图在 KV 里躺多久。
 *
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

/**
 * 存在 KV 里的头部，和图片拼在同一个值里。
 *
 * 一次 KV 读就能拿到全部信息，图片本身零损耗（不 base64）。
 */
export interface ShotHeader {
	/** 这张图渲染自哪个地址。 */
	u: string;
	w: number;
	h: number;
	q: number;
	/** 1 = 整页截图。 */
	f: 0 | 1;
	/** 生成时间（秒）。0 = 还没渲染出来（pending）。 */
	t: number;
	/** 到期时间（秒）。到期后该重新渲染了。 */
	e: number;
	/** 下次允许尝试的时间（秒）。失败后的退避用，0 = 不限。 */
	n: number;
	/** 连续失败次数，用来做指数退避；成功一次就归零。 */
	y: number;
}

/** 一条 KV 记录。 */
export interface Stored {
	header: ShotHeader;
	/** 图片字节；pending 记录没有图片，是 null。 */
	bytes: ArrayBuffer | null;
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

export class Shot extends WorkerEntrypoint<Env> {
	async fetch(request: Request): Promise<Response> {
		const { env, ctx } = this;
		const params = new URL(request.url).searchParams;

		const host = params.get("host") ?? "";
		const target = params.get("t") ?? "";
		if (!host || !target) {
			return problem(400, "missing host or target");
		}

		const spec: ShotSpec = {
			url: target,
			width: clampInt(params.get("w"), DEFAULT_WIDTH, 320, 1920),
			height: clampInt(params.get("h"), DEFAULT_HEIGHT, 400, 4000),
			quality: clampInt(params.get("q"), DEFAULT_QUALITY, 40, 95),
			fullPage: params.get("f") === "1",
		};

		const key = shotKey(host);
		const stored = await readStored(env, key);
		const now = Date.now();
		// 头部里的时间一律用秒。
		const nowSec = Math.floor(now / 1000);

		// 1) 新鲜：直接给。
		if (stored?.bytes && stored.header.e > nowSec) {
			return image(request, stored, key, "KV");
		}

		// 2) 过期但有旧图：先给旧图，后台刷新。
		//    这一步是整套限流策略的核心 —— 页面永远不会为了一次刷新而等待。
		if (stored?.bytes) {
			ctx.waitUntil(refresh(env, key, spec));
			return stale(request, stored, key, "expired");
		}

		// 3) 没有图（第一次，或者上次撞了限流）：只能同步渲染，
		//    也就只有这里可能撞得上「1 次 / 10 秒」。
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
				// 撞上限流：目标本身没问题，绝不能写负缓存，
				// 否则这张图会被自己锁死 5 分钟。
				// 记一条 pending（只有头部、没有图），交给 cron 去补。
				ctx.waitUntil(markPending(env, key, spec));
				return problem(503, "browser rate limited, retry later", {
					"Retry-After": "10",
				});
			}
			await noteFailure(env, key, result.reason);
			return problem(502, `screenshot failed (${result.reason})`);
		}

		const header = makeHeader(spec, now);
		ctx.waitUntil(store(env, key, header, result.bytes));

		return image(
			request,
			{ header, bytes: result.bytes.buffer as ArrayBuffer },
			key,
			"MISS",
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
	await store(env, key, makeHeader(spec, Date.now()), result.bytes);
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

export const shotKey = (host: string) => `shot:v1:${host}`;
export const failKey = (key: string) => `fail:v1:${key.replace(/^shot:v1:/, "")}`;

/**
 * 抽一个随机的到期时间（秒）。
 *
 * 每次写入都重抽 —— 这是「不会同时到期」的全部秘密。
 * 同一个 host 每次刷新都会落在窗口里的不同位置，
 * 11 个 host 之间也不会挤在同一个点上。
 */
export function randomUntil(now: number): number {
	const span = TTL_MAX - TTL_MIN;
	return Math.floor(now / 1000) + TTL_MIN + Math.floor(Math.random() * span);
}

/** 造一个头部。 */
export function makeHeader(spec: ShotSpec, now: number): ShotHeader {
	return {
		u: spec.url,
		w: spec.width,
		h: spec.height,
		q: spec.quality,
		f: spec.fullPage ? 1 : 0,
		t: Math.floor(now / 1000),
		e: randomUntil(now),
		n: 0,
		y: 0,
	};
}

/**
 * 编码成一个 KV 值：头部 + 图片，拼在同一个值里。
 *
 * 格式：`[4 字节大端 header 长度][header JSON][JPEG 字节]`
 */
export function encode(
	header: ShotHeader,
	bytes: ArrayBuffer | Uint8Array | null,
): Uint8Array {
	const head = new TextEncoder().encode(JSON.stringify(header));
	const body = bytes
		? bytes instanceof Uint8Array
			? bytes
			: new Uint8Array(bytes)
		: null;
	const out = new Uint8Array(4 + head.length + (body?.length ?? 0));
	new DataView(out.buffer).setUint32(0, head.length);
	out.set(head, 4);
	if (body) {
		out.set(body, 4 + head.length);
	}
	return out;
}

/** 解码 KV 值。 */
export function decode(raw: ArrayBuffer): Stored | null {
	if (raw.byteLength < 4) return null;
	const length = new DataView(raw).getUint32(0);
	if (raw.byteLength < 4 + length) return null;
	try {
		const header = JSON.parse(
			new TextDecoder().decode(new Uint8Array(raw, 4, length)),
		) as ShotHeader;
		const body = raw.byteLength > 4 + length ? raw.slice(4 + length) : null;
		return { header, bytes: body && body.byteLength > 0 ? body : null };
	} catch {
		return null;
	}
}

/** 写入一张截图。 */
export async function store(
	env: Env,
	key: string,
	header: ShotHeader,
	bytes: Uint8Array,
): Promise<void> {
	await env.SHOTS.put(key, encode(header, bytes), {
		expirationTtl: KEEP_TTL,
	});
}

/** 记一条 pending：只有头部没有图，等着 cron（或下一次请求）去渲染。 */
export async function markPending(
	env: Env,
	key: string,
	spec: ShotSpec,
): Promise<void> {
	const header: ShotHeader = {
		u: spec.url,
		w: spec.width,
		h: spec.height,
		q: spec.quality,
		f: spec.fullPage ? 1 : 0,
		t: 0, // 还没渲染出来
		e: 0, // 立刻就该渲染
		n: 0,
		y: 0,
	};
	await env.SHOTS.put(key, encode(header, null), { expirationTtl: KEEP_TTL });
}

/** 只更新头部（比如失败后退避），图片原样保留。 */
export async function touch(
	env: Env,
	key: string,
	header: ShotHeader,
	bytes: ArrayBuffer | null,
): Promise<void> {
	await env.SHOTS.put(key, encode(header, bytes), { expirationTtl: KEEP_TTL });
}

/** 记一次渲染失败，短时间内部再碰这个目标。 */
export async function noteFailure(
	env: Env,
	key: string,
	reason: string,
): Promise<void> {
	await env.SHOTS.put(failKey(key), reason, { expirationTtl: NEG_TTL });
}

export async function readStored(
	env: Env,
	key: string,
): Promise<Stored | null> {
	const raw = await env.SHOTS.get(key, "arrayBuffer");
	if (!raw || raw.byteLength === 0) return null;
	return decode(raw);
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
	browserMs?: string | null,
): Response {
	const etag = `"${key}-${stored.header.t}"`;
	const now = Math.floor(Date.now() / 1000);
	const headers = new Headers({
		"Content-Type": CONTENT_TYPE,
		// 只能缓存到真正到期为止。
		"Cache-Control": `public, max-age=${Math.max(STALE_MAX_AGE, stored.header.e - now)}, stale-while-revalidate=${SWR}, stale-if-error=${SIE}`,
		ETag: etag,
		"Cache-Tag": `shot, shot:${key.replace(/^shot:v1:/, "")}`,
		"X-Cache": cache,
		"X-Screenshot-Age": String(Math.max(0, now - stored.header.t)),
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
	const etag = `"${key}-${stored.header.t}"`;
	const now = Math.floor(Date.now() / 1000);
	const headers = new Headers({
		"Content-Type": CONTENT_TYPE,
		"Cache-Control": `public, max-age=${STALE_MAX_AGE}, stale-while-revalidate=60, stale-if-error=${SIE}`,
		ETag: etag,
		"Cache-Tag": `shot, shot:${key.replace(/^shot:v1:/, "")}`,
		"X-Cache": "STALE",
		"X-Screenshot-Age": String(Math.max(0, now - stored.header.t)),
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
