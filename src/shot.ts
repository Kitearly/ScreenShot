/**
 * 截图渲染与持久化。
 *
 * 这个入口是被缓存的那一层：网关把校验后的参数转交到这里，
 * 同一 host 的并发请求会被 Workers Cache 合并成一次渲染。
 *
 * 存储只有两条记录，都是纯图片字节：
 *
 * - `shot:now:<host>`  当前这一份，带一个**随机有效期**（3~7 天）。
 *   它的消失就是刷新触发器 —— 每次写入都重抽，所以一批 host 的到期时间
 *   会持续错开，永远不会一起过期、一起去抢那「1 次 / 10 秒」的额度。
 * - `shot:last:<host>` 最后一次成功渲染的图，**永不过期**。
 *   目标站挂掉时拿它兜底，页面不会开天窗。
 *
 * 另外两件事决定了这里的写法：
 *
 * 1. 账号级的硬限制是「Quick Action 1 次 / 10 秒」，
 *    所以**绝不让页面等渲染**：能拿到图就立刻返回。
 * 2. KV 里没有「过期」这一说，键在就在、不在就不在 —— 所以不存在
 *    「过期了但还能用」的状态，兜底只能靠上面那条永久记录。
 */

import { WorkerEntrypoint } from "cloudflare:workers";
import { assertPublicHost, type Env } from "./target";

// ---------------------------------------------------------------------------
// 配置
// ---------------------------------------------------------------------------

/** 视口宽度（固定）。 */
const WIDTH = 1280;
/** 视口高度（固定）。 */
const HEIGHT = 720;
/** JPEG 画质（固定）。 */
const QUALITY = 80;

/**
 * 随机有效期的下界（秒）。3 天。
 *
 * 网页截图不挑时效 —— 友链页面的封面几天换一次完全够用。
 */
const TTL_MIN = 259_200;
/**
 * 随机有效期的上界（秒）。7 天。
 *
 * 每次写入都重抽。真正决定「会不会撞车」的是这个窗口的**宽度**：
 * 11 个 host 均匀落在 4 天的窗口里，期望最小间隔约 47 分钟，
 * 远远大于限流的 10 秒。
 */
const TTL_MAX = 604_800;
/**
 * 渲染失败后的负缓存时长（秒）。
 *
 * 30 分钟。没有它的话，一个挂掉的目标每次访问都会重试渲染，
 * 一天 288 次就能把 10 分钟/天的额度烧光。
 */
const NEG_TTL = 1_800;
/**
 * 边缘缓存时长（秒）的范围，每次响应随机取一个。
 *
 * 必须**远小于**有效期窗口：边缘副本过期后才会回头问源站，
 * 如果这个值太大，边缘的再验证网格会把随机错开的到期时间
 * 重新量化到同一格上，一批 host 又会挤到同一刻刷新。
 * 10~60 分钟相对 4 天的窗口可以忽略，而且每次都随机，网格自己会漂。
 */
const EDGE_MIN = 600;
const EDGE_MAX = 3_600;
/** 边缘上源站报错时，继续用旧副本的窗口（秒）。 */
const STALE_IF_ERROR = 86_400;
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
// 键
// ---------------------------------------------------------------------------

/** 当前这一份，带随机有效期。 */
export const nowKey = (host: string) => `shot:now:${host}`;
/** 最后一次成功的截图，永不过期，失败时兜底。 */
export const lastKey = (host: string) => `shot:last:${host}`;
/** 负缓存。 */
export const failKey = (host: string) => `fail:${host}`;

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

export class Shot extends WorkerEntrypoint<Env> {
	async fetch(request: Request): Promise<Response> {
		const { env } = this;
		const params = new URL(request.url).searchParams;

		const host = params.get("host") ?? "";
		const target = params.get("t") ?? "";
		if (!host || !target) {
			return problem(400, "missing host or target");
		}

		// 1) 当前这一份还在（键没过期）就直接用 —— 不需要任何额外判断，
		//    「键存在」本身就等于「还新鲜」。
		const current = await env.SHOTS.get(nowKey(host), "arrayBuffer");
		if (current && current.byteLength > 0) {
			return image(host, current, "KV");
		}

		// 2) 没有当前份：要么重新渲染，要么回退到永久的那份。
		let reason = "not rendered yet";
		let rateLimited = false;

		const failure = await env.SHOTS.get(failKey(host), "text");
		if (failure) {
			// 刚失败过，别再烧配额了，直接走兜底。
			reason = failure;
		} else {
			// 目标主机的 DNS 结果在这里复核一次，挡住指向内网的域名。
			const guard = await assertPublicHost(target);
			if (!guard.ok) {
				return problem(403, `blocked target: ${guard.reason}`);
			}

			const result = await capture(env, target);
			if (result.ok) {
				// 写两份：当前份（随机有效期）+ 永久的兜底份。
				// 写失败不影响这次响应 —— 图已经渲染出来了。
				await persist(env, host, result.bytes);
				return image(host, result.bytes, "MISS", result.browserMs);
			}

			reason = result.reason;
			rateLimited = result.rateLimited;
			if (!rateLimited) {
				// 目标本身有问题（404 / 超时 / 证书错误），负缓存 30 分钟。
				// 限流不算目标有问题，不能锁。
				await env.SHOTS.put(failKey(host), reason, { expirationTtl: NEG_TTL });
			}
		}

		// 3) 兜底：最后一次成功的截图。
		const last = await env.SHOTS.get(lastKey(host), "arrayBuffer");
		if (last && last.byteLength > 0) {
			return image(host, last, "STALE", null, reason);
		}

		return rateLimited
			? problem(503, "browser rate limited, retry later", { "Retry-After": "10" })
			: problem(502, `screenshot failed (${reason})`);
	}
}

// ---------------------------------------------------------------------------
// 渲染
// ---------------------------------------------------------------------------

/** 渲染一次。失败不抛异常，交给调用方决定回退还是报错。 */
export async function capture(
	env: Env,
	url: string,
): Promise<
	| { ok: true; bytes: Uint8Array; browserMs: string | null }
	| { ok: false; reason: string; rateLimited: boolean }
> {
	let response: Response;
	try {
		response = await env.BROWSER.quickAction("screenshot", {
			url,
			viewport: { width: WIDTH, height: HEIGHT, deviceScaleFactor: 1 },
			gotoOptions: { waitUntil: WAIT_UNTIL, timeout: GOTO_TIMEOUT },
			actionTimeout: ACTION_TIMEOUT,
			screenshotOptions: {
				type: "jpeg",
				quality: QUALITY,
				fullPage: false,
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

/** 抽一个随机的有效期（秒）。每次写入都重抽。 */
export function randomTtl(): number {
	return TTL_MIN + Math.floor(Math.random() * (TTL_MAX - TTL_MIN));
}

/** 写入当前份（随机有效期）与永久的兜底份。 */
async function persist(
	env: Env,
	host: string,
	bytes: Uint8Array,
): Promise<void> {
	try {
		await Promise.all([
			env.SHOTS.put(nowKey(host), bytes, { expirationTtl: randomTtl() }),
			// 不传 expirationTtl → 永不过期。
			env.SHOTS.put(lastKey(host), bytes),
		]);
	} catch {
		// 写失败（比如 KV 自己的 1 次/秒写限制）不影响这次响应。
	}
}

// ---------------------------------------------------------------------------
// 响应
// ---------------------------------------------------------------------------

/** 一张图片。 */
function image(
	host: string,
	bytes: ArrayBuffer | Uint8Array,
	cache: string,
	browserMs?: string | null,
	reason?: string,
): Response {
	const headers = new Headers({
		"Content-Type": CONTENT_TYPE,
		"Cache-Control": `public, max-age=${edgeMaxAge()}, stale-if-error=${STALE_IF_ERROR}`,
		"Cache-Tag": `shot, shot:${host}`,
		"X-Cache": cache,
	});
	if (browserMs) {
		headers.set("X-Browser-Ms-Used", browserMs);
	}
	if (reason) {
		headers.set("X-Screenshot-Reason", reason.slice(0, 200));
	}
	return new Response(bytes, { headers });
}

/** 边缘缓存时长：每次响应随机取一个，让边缘的再验证网格自己漂移。 */
function edgeMaxAge(): number {
	return EDGE_MIN + Math.floor(Math.random() * (EDGE_MAX - EDGE_MIN));
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
