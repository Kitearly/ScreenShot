// Node 原生 ESM 解析不了 Workers 打包器允许的两种写法：
//   1. "cloudflare:workers" 这个运行时内置模块
//   2. 省略扩展名的相对路径（"./target"）
// 这里用 resolve 钩子把它们映射到本地实现，让测试直接跑源码。

const STUB = `data:text/javascript,${encodeURIComponent(`
export class WorkerEntrypoint {
	constructor(ctx, env) {
		this.ctx = ctx;
		this.env = env;
	}
}
`)}`;

export function resolve(specifier, context, nextResolve) {
	if (specifier === "cloudflare:workers") {
		return { url: STUB, shortCircuit: true, format: "module" };
	}
	if (
		(specifier.startsWith("./") || specifier.startsWith("../")) &&
		!/\.[cm]?[jt]s$/.test(specifier)
	) {
		return nextResolve(`${specifier}.ts`, context);
	}
	return nextResolve(specifier, context);
}
