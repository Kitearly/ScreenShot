/**
 * 预热：让友链页面要的那批截图一直是热的。
 *
 * 为什么要单独用一个后台任务：账号级限制是「Quick Action 1 次 / 10 秒」，
 * 而一次页面加载会并发请求十几张图 —— 请求路径上无论如何都不可能在 110 秒内
 * 把它们渲染完。真正能解决这件事的位置只有后台：每个 tick 只渲染**一个**
 * 最该刷新的目标，就永远不会撞到限流。
 *
 * 队列不需要配置：任何一次请求（渲染成功、或者撞上限流）都会把目标登记进
 * `warm:v1:*`，此后它就一直被这里保持新鲜。不再需要的目标要手动删掉，否则会一直被刷新。
 */

import {
	WARM_PREFIX,
	capture,
	noteFailure,
	register,
	store,
	type WarmRecord,
} from "./shot";
import { assertPublicHost, type Env } from "./target";

/** 失败后的基础退避（毫秒）。 */
const RETRY_MS = 600_000;
/** 退避上限（毫秒），避免一个永久挂掉的目标把额度吃光。 */
const RETRY_MAX_MS = 21_600_000;
/** 一次 list 最多看多少条。十几张图远远够用。 */
const LIMIT = 100;

export async function warm(env: Env): Promise<void> {
	const list = await env.SHOTS.list({ prefix: WARM_PREFIX, limit: LIMIT });
	if (list.keys.length === 0) {
		return;
	}

	const now = Date.now();
	const entries = await Promise.all(
		list.keys.map(async ({ name }) => {
			const record = await env.SHOTS.get<WarmRecord>(name, "json");
			return record ? { key: name.slice(WARM_PREFIX.length), record } : null;
		}),
	);

	// 一次只处理一个 —— 这就是不超限的全部秘诀。
	const next = entries
		.filter(
			(entry): entry is { key: string; record: WarmRecord } =>
				entry !== null && entry.record.due <= now,
		)
		.sort((a, b) => a.record.due - b.record.due)[0];

	if (!next) {
		return; // 没有到期的，这一轮什么都不做
	}

	const { key, record } = next;

	const guard = await assertPublicHost(record.url);
	if (!guard.ok) {
		return retry(env, key, record, now);
	}

	const result = await capture(env, record);
	if (!result.ok) {
		if (!result.rateLimited) {
			await noteFailure(env, key, result.reason);
		}
		return retry(env, key, record, now);
	}

	// store() 会顺手把预热记录刷新到下一个 due，并把失败次数清零。
	await store(env, key, record, result.bytes, now);
}

/** 失败退避：10 分钟起，逐次翻倍，最长 6 小时。 */
async function retry(
	env: Env,
	key: string,
	record: WarmRecord,
	now: number,
): Promise<void> {
	const tries = (record.tries ?? 0) + 1;
	const backoff = Math.min(RETRY_MAX_MS, RETRY_MS * 2 ** (tries - 1));
	await register(env, key, record, now + backoff, tries);
}
