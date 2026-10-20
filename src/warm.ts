/**
 * 后台刷新。
 *
 * 请求路径上能做的已经做完了：过期图先给旧图、刷新放后台。
 * 这个定时任务负责剩下的两件事：
 *
 * 1. 补 pending —— 第一次并发加载时撞了限流、只写下了头部没写出图的那些目标，
 *    由这里逐个补上，不用等下一次有人访问。
 * 2. 刷新到期的图 —— 到期时间（`header.e`）是随机的，所以每个 host 过期的时间
 *    都不同，这里每次只处理一个，永远不会撞上「1 次 / 10 秒」。
 *
 * 每个 tick 只渲染一个目标，节奏就是 1 次 / 5 分钟。
 */

import {
	capture,
	makeHeader,
	noteFailure,
	readStored,
	store,
	touch,
	type ShotHeader,
} from "./shot";
import { assertPublicHost, type Env } from "./target";

/** 失败后的基础退避（秒）。 */
const RETRY_SECONDS = 600;
/** 退避上限（秒），避免一个永久挂掉的目标把额度吃光。 */
const RETRY_MAX_SECONDS = 21_600;
/** 一次最多看多少条记录。 */
const LIMIT = 200;

export async function warm(env: Env): Promise<void> {
	const list = await env.SHOTS.list({ prefix: "shot:v1:", limit: LIMIT });
	if (list.keys.length === 0) {
		return;
	}

	const now = Math.floor(Date.now() / 1000);
	const due: Array<{ key: string; header: ShotHeader }> = [];

	for (const { name } of list.keys) {
		const stored = await readStored(env, name);
		if (!stored) continue;
		// 没到期，或者还在退避期里，都不动。
		if (stored.header.e > now || stored.header.n > now) continue;
		if (!stored.header.u) continue;
		due.push({ key: name, header: stored.header });
	}

	if (due.length === 0) {
		return;
	}

	// pending（还没出过图）优先，其次是最早到期的。
	due.sort((a, b) => {
		if (a.header.t === 0) return b.header.t === 0 ? 0 : -1;
		if (b.header.t === 0) return 1;
		return a.header.e - b.header.e;
	});

	const next = due[0];
	const spec = {
		url: next.header.u,
		width: next.header.w,
		height: next.header.h,
		quality: next.header.q,
		fullPage: next.header.f === 1,
	};

	const guard = await assertPublicHost(spec.url);
	if (!guard.ok) {
		return backoff(env, next.key, next.header);
	}

	const result = await capture(env, spec);
	if (!result.ok) {
		if (!result.rateLimited) {
			await noteFailure(env, next.key, result.reason);
		}
		return backoff(env, next.key, next.header);
	}

	await store(env, next.key, makeHeader(spec, Date.now()), result.bytes);
}

/** 失败后退避：10 分钟起步，逐次翻倍，最长 6 小时。 */
async function backoff(
	env: Env,
	key: string,
	header: ShotHeader,
): Promise<void> {
	const tries = header.y + 1;
	const delay = Math.min(RETRY_MAX_SECONDS, RETRY_SECONDS * 2 ** (tries - 1));
	const stored = await readStored(env, key);
	await touch(
		env,
		key,
		{
			...header,
			n: Math.floor(Date.now() / 1000) + delay,
			y: tries,
		},
		stored?.bytes ?? null,
	);
}
