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

export { Shot };

export default {
	async fetch(request, env, ctx) {
		if (request.method !== "GET" && request.method !== "HEAD") {
			return new Response("method not allowed", {
				status: 405,
				headers: { allow: "GET, HEAD" },
			});
		}

		const path = new URL(request.url).pathname;
		// 允许把 Worker 挂在子路径下（如 /api/shot）。
		if (path !== "/shot" && !path.endsWith("/shot")) {
			return new Response("not found", { status: 404 });
		}

		if (!isAllowedCaller(request, env.ALLOWED_DOMAINS)) {
			return new Response("forbidden", { status: 403 });
		}

		const parsed = parseShot(request);
		if (!parsed.ok) {
			return new Response(parsed.message, { status: parsed.status });
		}
		const shot = parsed.shot;

		const key = await canonicalKey(shot);
		const inner = new URL("https://shot.internal/shot");
		inner.searchParams.set("k", key);
		inner.searchParams.set("t", shot.url);
		inner.searchParams.set("w", String(shot.width));
		inner.searchParams.set("h", String(shot.height));
		inner.searchParams.set("q", String(shot.quality));
		inner.searchParams.set("f", shot.fullPage ? "1" : "0");

		// 转交被缓存的入口：等价的目标地址会落到同一个缓存键上，
		// 同一缓存键的并发请求由 Workers Cache 合并成一次渲染。
		return ctx.exports.Shot.fetch(new Request(inner.toString(), request), {
			cf: { cacheKey: `/shot?k=${key}` },
		});
	},
} satisfies ExportedHandler<Env>;
