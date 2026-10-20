export {};

declare global {
	namespace Cloudflare {
		// 让 ctx.exports.Shot 拥有完整类型（见 src/index.ts）。
		interface GlobalProps {
			mainModule: typeof import("../src/index");
		}
	}
}
