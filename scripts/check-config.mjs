/**
 * 部署前检查：确认 KV 命名空间已经填上真实 id。
 *
 * 目的只有一个 —— 别再让占位符一路走到 Cloudflare 构建里才炸，
 * 那时候只能看到一句 "KV namespace 'REPLACE_WITH_...' is not valid"。
 *
 * 由 package.json 的 predeploy 钩子自动调用。
 */

import { readFileSync } from "node:fs";

const CONFIG = "wrangler.jsonc";
// Workers KV 的 namespace id 是 32 位十六进制字符串。
const NAMESPACE_ID = /^[0-9a-f]{32}$/i;

const config = readFileSync(CONFIG, "utf8");

const ids = [...config.matchAll(/"id"\s*:\s*"([^"]*)"/g)].map((match) => match[1]);
const placeholders = ids.filter((id) => !NAMESPACE_ID.test(id));

if (placeholders.length > 0) {
	console.error(`
✘ ${CONFIG} 里的 KV namespace id 还没填。

  找到：${placeholders.map((id) => `"${id}"`).join(", ")}

  修复（一条命令，会自动把真实 id 写回 ${CONFIG}）：

    npx wrangler kv namespace create SHOTS --binding SHOTS --update-config

  然后 git commit + push。
  namespace id 不是密钥，可以直接进仓库。

  已经有命名空间了？用这个 id 替换掉上面的占位符即可：

    npx wrangler kv namespace list
`);
	process.exit(1);
}

console.log("✓ 配置检查通过");
