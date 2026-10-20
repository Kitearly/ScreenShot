/**
 * 入口。
 *
 * default 入口是网关：每次请求都会跑，负责白名单校验、目标规范化、
 * 计算 canonical key，然后把请求转交给被缓存的 Shot 入口。
 *
 * 这样拆分是必须的 —— Workers Cache 的缓存键不含 Referer / Origin，
 * 校验若放在被缓存的那一层，未授权的调用方能拿到缓存图，
 * 合法的 403 也会被缓存下来发给所有人。
 */

import { canonicalKey, isAllowedCaller, parseShot, type Env } from "./target";
import { Shot } from "./shot";
import { warm } from "./warm";

export { Shot };

export default {
	async fetch(request, env, ctx) {
		if (request.method !== "GET" && request.method !== "HEAD") {
			return new Response("method not allowed", {
				status: 405,
				headers: { allow: "GET, HEAD" },
			});
		}

		// 只有一个端点：Worker 挂在哪就调哪，路径本身不参与判断。
		// 挂在域名根是 "/"，挂在 example.com/api/* 路由上是 "/api/…"，都能直接用。

		if (!isAllowedCaller(request, env.ALLOWED_DOMAINS)) {
			return new Response("forbidden", { status: 403 });
		}

		const parsed = parseShot(request);
		if (!parsed.ok) {
			return new Response(parsed.message, { status: parsed.status });
		}
		const shot = parsed.shot;

		const key = await canonicalKey(shot);
		const inner = new URL("https://shot.internal/");
		inner.searchParams.set("k", key);
		inner.searchParams.set("t", shot.url);
		inner.searchParams.set("w", String(shot.width));
		inner.searchParams.set("h", String(shot.height));
		inner.searchParams.set("q", String(shot.quality));
		inner.searchParams.set("f", shot.fullPage ? "1" : "0");

		// 转交被缓存的入口：等价的目标地址会落到同一个缓存键上，
		// 同一缓存键的并发请求由 Workers Cache 合并成一次渲染。
		return ctx.exports.Shot.fetch(new Request(inner.toString(), request), {
			cf: { cacheKey: `/?k=${key}` },
		});
	},

	/**
	 * 预热。只在配置了 cron trigger 时才会被调用（见 wrangler.jsonc）。
	 *
	 * 每个 tick 只渲染一个目标，所以永远不会撞上「1 次 / 10 秒」的限流；
	 * 这是唯一能在页面加载之外把十几张图都备好的位置。
	 */
	async scheduled(_controller, env) {
		await warm(env);
	},
} satisfies ExportedHandler<Env>;
