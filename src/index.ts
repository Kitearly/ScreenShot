/**
 * 入口。
 *
 * default 入口是网关：每次请求都会跑，负责白名单校验、目标规范化、
 * 把请求转交给被缓存的 Shot 入口。
 *
 * 这样拆分是必须的 —— Workers Cache 的缓存键不含 Referer / Origin，
 * 校验若放在被缓存的那一层，未授权的调用方能拿到缓存图，
 * 合法的 403 也会被缓存下来发给所有人。
 */

import { isAllowedCaller, parseShot, type Env } from "./target";
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

		// 只有一个端点：Worker 挂在哪就调哪，路径本身不参与判断。
		// 挂在域名根是 "/"，挂在 example.com/api/* 路由上是 "/api/…"，都能直接用。

		if (!isAllowedCaller(request, env.ALLOWED_DOMAINS)) {
			return new Response("forbidden", { status: 403 });
		}

		const parsed = parseShot(request);
		if (!parsed.ok) {
			return new Response(parsed.message, { status: parsed.status });
		}
		const { url, host } = parsed.shot;

		const inner = new URL("https://shot.internal/");
		inner.searchParams.set("host", host);
		inner.searchParams.set("t", url);

		// 转交被缓存的入口：同一个 host 的并发请求会落到同一个缓存键上，
		// 由 Workers Cache 合并成一次渲染。
		return ctx.exports.Shot.fetch(new Request(inner.toString(), request), {
			cf: { cacheKey: `/?host=${host}` },
		});
	},
} satisfies ExportedHandler<Env>;
