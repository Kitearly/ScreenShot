/**
 * 配置常量、目标 URL 的解析 / 规范化 / 安全校验。
 *
 * 这里不碰网络，所有检查都是纯本地的字符串与数值运算，
 * 因此可以在网关入口（每次请求都会跑）里放心调用。
 */

/** Worker 运行时绑定与环境变量。 */
export interface Env {
	/** Browser Run 绑定（wrangler.jsonc 里的 "browser"）。 */
	BROWSER: BrowserRun;
	/** Workers KV 命名空间，持久化截图二进制与元数据。 */
	SHOTS: KVNamespace;
	/** 可选：允许调用方的域名白名单，逗号分隔；留空表示不限制。 */
	ALLOWED_DOMAINS?: string;
}

// ---------------------------------------------------------------------------
// 配置
// ---------------------------------------------------------------------------

/** 默认视口宽度。 */
export const DEFAULT_WIDTH = 1280;
/** 默认视口高度。 */
export const DEFAULT_HEIGHT = 720;
/** 默认 JPEG 质量。 */
export const DEFAULT_QUALITY = 80;

const WIDTH_MIN = 320;
const WIDTH_MAX = 1920;
const HEIGHT_MIN = 400;
const HEIGHT_MAX = 4000;
const QUALITY_MIN = 40;
const QUALITY_MAX = 95;

/** 一条截图请求的全部参数。 */
export interface ShotRequest {
	/** 规范化后的目标地址。 */
	url: string;
	width: number;
	height: number;
	quality: number;
	/** true = 整页长图。 */
	fullPage: boolean;
}

export type ParseResult =
	| { ok: true; shot: ShotRequest }
	| { ok: false; status: number; message: string };

/** 会被剥离的追踪参数：它们不影响页面内容，但会让同一页面产生多个缓存键。 */
const TRACKING_PARAMS = new Set([
	"fbclid",
	"gclid",
	"dclid",
	"msclkid",
	"yclid",
	"twclid",
	"igshid",
	"ttclid",
	"wbraid",
	"gbraid",
	"_ga",
	"_gl",
	"mc_cid",
	"mc_eid",
	"mkt_tok",
	"oly_anon_id",
	"oly_enc_id",
	"ref_src",
	"from_source",
	"from_spmid",
	"vd_source",
	"share_source",
	"share_medium",
	"share_plat",
	"share_tag",
	"share_session_id",
]);

/** 以这些后缀结尾的主机名一律拒绝（内网 / 保留域）。 */
const BLOCKED_HOST_SUFFIXES = [
	".localhost",
	".local",
	".internal",
	".home.arpa",
	".invalid",
];

/** 这些主机名一律拒绝。 */
const BLOCKED_HOSTS = new Set([
	"localhost",
	"metadata.google.internal",
	"metadata.goog",
	"instance-data",
]);

// ---------------------------------------------------------------------------
// 解析
// ---------------------------------------------------------------------------

/**
 * 解析并校验一次截图请求。`url` 放在查询串最后，其余参数均可省略。
 */
export function parseShot(request: Request): ParseResult {
	const params = new URL(request.url).searchParams;
	const raw = params.get("url");
	if (!raw) {
		return { ok: false, status: 400, message: "missing 'url' parameter" };
	}

	let target: URL;
	try {
		target = new URL(raw);
	} catch {
		return { ok: false, status: 400, message: "invalid 'url' parameter" };
	}

	const blocked = staticHostCheck(target);
	if (blocked) {
		return { ok: false, status: 400, message: `blocked target: ${blocked}` };
	}

	return {
		ok: true,
		shot: {
			url: normalizeTarget(target),
			width: clampInt(params.get("w"), DEFAULT_WIDTH, WIDTH_MIN, WIDTH_MAX),
			height: clampInt(params.get("h"), DEFAULT_HEIGHT, HEIGHT_MIN, HEIGHT_MAX),
			quality: clampInt(params.get("q"), DEFAULT_QUALITY, QUALITY_MIN, QUALITY_MAX),
			fullPage: params.get("full") === "1",
		},
	};
}

/** 读取整数查询参数，缺省或非法时取默认值，越界时收敛到区间内。 */
export function clampInt(
	raw: string | null,
	fallback: number,
	min: number,
	max: number,
): number {
	if (raw === null) return fallback;
	const value = Number(raw);
	if (!Number.isFinite(value)) return fallback;
	return Math.min(max, Math.max(min, Math.round(value)));
}

/**
 * 规范化目标地址：去掉 fragment、剥离追踪参数、排序查询参数。
 *
 * 规范化后拼写不同但内容相同的地址会落到同一个缓存键上，
 * 从而复用同一张截图、只消耗一次浏览器渲染。
 */
export function normalizeTarget(target: URL): string {
	const url = new URL(target.toString());
	url.hash = "";
	for (const key of [...url.searchParams.keys()]) {
		if (isTrackingParam(key)) {
			url.searchParams.delete(key);
		}
	}
	url.searchParams.sort();
	if (!url.pathname) {
		url.pathname = "/";
	}
	return url.toString();
}

function isTrackingParam(key: string): boolean {
	const lower = key.toLowerCase();
	if (lower.startsWith("utm_") || lower.startsWith("spm_")) return true;
	return TRACKING_PARAMS.has(lower);
}

// ---------------------------------------------------------------------------
// 安全校验
// ---------------------------------------------------------------------------

/**
 * 纯静态的主机检查：协议、URL 内嵌凭据、保留域名名、私网 IP 字面量。
 * 返回非空字符串表示拒绝，并带上原因。
 */
function staticHostCheck(url: URL): string | null {
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		return `unsupported scheme '${url.protocol}'`;
	}
	if (url.username || url.password) {
		return "url must not contain credentials";
	}

	const host = url.hostname.toLowerCase();
	if (BLOCKED_HOSTS.has(host)) {
		return `host '${host}' is not allowed`;
	}
	for (const suffix of BLOCKED_HOST_SUFFIXES) {
		if (host.endsWith(suffix)) {
			return `host '${host}' is not allowed`;
		}
	}
	if (isPrivateIPv4(host)) {
		return `host '${host}' is a private address`;
	}
	if (isPrivateIPv6(host)) {
		return `host '${host}' is a private address`;
	}
	return null;
}

/**
 * 解析 DNS 后再判断地址是否落在私网，挡住把域名指向内网的绕过手法。
 * DNS 查询本身失败时放行（宁可少拦一次，也不要让截图彻底不可用）。
 */
export async function assertPublicHost(
	target: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
	let host: string;
	try {
		host = new URL(target).hostname;
	} catch {
		return { ok: false, reason: "invalid url" };
	}
	// IP 字面量已在静态检查里处理。
	if (!host || host.includes(":")) {
		return { ok: true };
	}

	const [v4, v6] = await Promise.all([
		dnsLookup(host, "A").catch(() => [] as string[]),
		dnsLookup(host, "AAAA").catch(() => [] as string[]),
	]);
	for (const ip of [...v4, ...v6]) {
		if (isPrivateIPv4(ip) || isPrivateIPv6(ip)) {
			return { ok: false, reason: `resolves to private address ${ip}` };
		}
	}
	return { ok: true };
}

async function dnsLookup(host: string, type: "A" | "AAAA"): Promise<string[]> {
	const response = await fetch(
		`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(host)}&type=${type}`,
		{ headers: { accept: "application/dns-json" } },
	);
	if (!response.ok) return [];
	const body = (await response.json()) as {
		Answer?: { type?: number; data?: string }[];
	};
	const wanted = type === "A" ? 1 : 28;
	return (body.Answer ?? [])
		.filter((answer) => answer.type === wanted)
		.map((answer) => (answer.data ?? "").trim())
		.filter(Boolean);
}

/** 判断主机名是否属于允许调用本 API 的来源。 */
export function isAllowedCaller(
	request: Request,
	allowed: string | undefined,
): boolean {
	const domains = (allowed ?? "")
		.split(",")
		.map((domain) => domain.trim().toLowerCase())
		.filter(Boolean);
	if (domains.length === 0) {
		return true;
	}

	for (const header of [
		request.headers.get("origin"),
		request.headers.get("referer"),
	]) {
		if (!header) continue;
		let host: string;
		try {
			host = new URL(header).hostname.toLowerCase();
		} catch {
			continue;
		}
		if (!host) continue;
		for (const domain of domains) {
			if (host === domain) return true;
			// "*.example.com" 匹配任意子域。
			if (domain.startsWith("*.") && host.endsWith(domain.slice(1))) {
				return true;
			}
			// "example.com" 同时匹配其子域。
			if (host.endsWith(`.${domain}`)) return true;
		}
	}
	return false;
}

// ---------------------------------------------------------------------------
// IP 判定
// ---------------------------------------------------------------------------

/** IPv4 字面量是否落在私有 / 保留网段。 */
export function isPrivateIPv4(ip: string): boolean {
	const value = ipv4ToNumber(ip);
	if (value === null) return false;
	const inRange = (base: number, bits: number): boolean => {
		const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
		return ((value & mask) >>> 0) === ((base & mask) >>> 0);
	};
	return (
		inRange(0x00000000, 8) || // 0.0.0.0/8
		inRange(0x0a000000, 8) || // 10.0.0.0/8
		inRange(0x64400000, 10) || // 100.64.0.0/10
		inRange(0x7f000000, 8) || // 127.0.0.0/8
		inRange(0xa9fe0000, 16) || // 169.254.0.0/16（含云厂商元数据地址）
		inRange(0xac100000, 12) || // 172.16.0.0/12
		inRange(0xc0000000, 24) || // 192.0.0.0/24
		inRange(0xc0a80000, 16) || // 192.168.0.0/16
		inRange(0xc6120000, 15) || // 198.18.0.0/15
		inRange(0xe0000000, 4) || // 224.0.0.0/4 组播
		inRange(0xf0000000, 4) // 240.0.0.0/4 保留（含 255.255.255.255）
	);
}

function ipv4ToNumber(ip: string): number | null {
	const parts = ip.split(".");
	if (parts.length !== 4) return null;
	let value = 0;
	for (const part of parts) {
		if (!/^\d{1,3}$/.test(part)) return null;
		const octet = Number(part);
		if (octet > 255) return null;
		value = value * 256 + octet;
	}
	return value;
}

/** IPv6 字面量是否落在私有 / 保留网段。 */
export function isPrivateIPv6(ip: string): boolean {
	const groups = parseIPv6(ip);
	if (!groups) return false;

	// ::ffff:a.b.c.d 形式的 IPv4 映射地址。
	if (groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff) {
		const v4 = `${groups[6] >> 8}.${groups[6] & 0xff}.${groups[7] >> 8}.${groups[7] & 0xff}`;
		return isPrivateIPv4(v4);
	}

	const allZero = groups.every((g) => g === 0);
	const loopback = groups.slice(0, 7).every((g) => g === 0) && groups[7] === 1;
	const uniqueLocal = (groups[0] & 0xfe00) === 0xfc00; // fc00::/7
	const linkLocal = (groups[0] & 0xffc0) === 0xfe80; // fe80::/10
	const multicast = (groups[0] & 0xff00) === 0xff00; // ff00::/8

	return allZero || loopback || uniqueLocal || linkLocal || multicast;
}

function parseIPv6(host: string): number[] | null {
	let text = host.replace(/^\[/, "").replace(/\]$/, "").toLowerCase();
	if (!text.includes(":")) return null;

	// 尾部可能是 IPv4 形式，转成两个十六进制分组。
	const v4 = text.match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
	if (v4) {
		const value = ipv4ToNumber(v4[1]);
		if (value === null) return null;
		const high = ((value >>> 16) & 0xffff).toString(16);
		const low = (value & 0xffff).toString(16);
		text = text.slice(0, v4.index) + high + ":" + low;
	}

	const halves = text.split("::");
	if (halves.length > 2) return null;

	const head = halves[0] ? halves[0].split(":") : [];
	const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];

	let groups: string[];
	if (halves.length === 1) {
		if (head.length !== 8) return null;
		groups = head;
	} else {
		const fill = 8 - head.length - tail.length;
		if (fill < 0) return null;
		groups = [...head, ...Array<string>(fill).fill("0"), ...tail];
	}

	const parsed: number[] = [];
	for (const group of groups) {
		if (!/^[0-9a-f]{1,4}$/.test(group)) return null;
		parsed.push(parseInt(group, 16));
	}
	return parsed.length === 8 ? parsed : null;
}

// ---------------------------------------------------------------------------
// 缓存键
// ---------------------------------------------------------------------------

/**
 * 计算截图的规范键：所有会影响画面的参数参与哈希。
 * 键相同即视为同一张图，可以直接复用缓存、跳过渲染。
 */
/**
 * 缓存键：只用 host。
 *
 * 一个 host 一份图 —— 同一个站点的不同页面、不同尺寸共用一份。
 * 既省存储，也天然避免了「同一个站被当成 N 个目标」把配额打爆。
 */
export function cacheHost(url: string): string {
	return new URL(url).hostname.toLowerCase();
}
