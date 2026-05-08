import * as db from "../db";
import { registerBunServer } from "../lib/lifecycle";
import { broadcast } from "./runState";

type WindowMark = { utilization: number; resetsAt: number | null };
const windowHighMark = new Map<string, WindowMark>();

export function getWindowMark(type: string): WindowMark | undefined {
	return windowHighMark.get(type);
}

function captureUtilizationHeaders(headers: Headers): void {
	function toUnix(s: string | null): number | null {
		if (!s) return null;
		const t = parseInt(s, 10);
		return Number.isFinite(t) ? t : null;
	}

	function maybeUpdate(
		dbKey: string,
		rateLimitType: string,
		utilization: number,
		resetsAt: number | null,
	): void {
		const current = windowHighMark.get(rateLimitType);
		const newWindow = !current || current.resetsAt !== resetsAt;
		if (!newWindow && utilization <= (current?.utilization ?? 0)) return;
		windowHighMark.set(rateLimitType, { utilization, resetsAt });
		void db.saveSetting(
			dbKey,
			JSON.stringify({ utilization, resetsAt, rateLimitType }),
		);
		broadcast({
			type: "rate_limit",
			status: "allowed",
			rateLimitType,
			utilization,
			resetsAt: resetsAt ?? undefined,
		});
	}

	const windows = [
		[
			"anthropic-ratelimit-unified-5h-utilization",
			"anthropic-ratelimit-unified-5h-reset",
			"rl_5hr",
			"five_hour",
		],
		[
			"anthropic-ratelimit-unified-7d-utilization",
			"anthropic-ratelimit-unified-7d-reset",
			"rl_weekly",
			"weekly",
		],
		[
			"anthropic-ratelimit-unified-7d_sonnet-utilization",
			"anthropic-ratelimit-unified-7d_sonnet-reset",
			"rl_weekly_sonnet",
			"weekly_sonnet",
		],
	] as const;
	for (const [utilHeader, resetHeader, dbKey, rateLimitType] of windows) {
		const h = headers.get(utilHeader);
		if (h === null) continue;
		const raw = parseFloat(h);
		if (Number.isFinite(raw))
			maybeUpdate(
				dbKey,
				rateLimitType,
				raw >= 1 ? raw / 100 : raw,
				toUnix(headers.get(resetHeader)),
			);
	}
}

// Seed from DB so cold-start page loads show usage windows without waiting for an API call
async function seedWindowHighMarks(): Promise<void> {
	const entries: [string, string][] = [
		["rl_5hr", "five_hour"],
		["rl_weekly", "weekly"],
		["rl_weekly_sonnet", "weekly_sonnet"],
	];
	for (const [dbKey, type] of entries) {
		const raw = await db.getSetting(dbKey);
		if (!raw) continue;
		try {
			const parsed = JSON.parse(raw) as {
				utilization: number | null;
				resetsAt: number | null;
			};
			if (parsed.utilization == null) continue;
			if (parsed.resetsAt != null && parsed.resetsAt < Date.now() / 1000)
				continue;
			windowHighMark.set(type, {
				utilization: parsed.utilization,
				resetsAt: parsed.resetsAt ?? null,
			});
		} catch {}
	}
}

export async function startAnthropicProxy(
	proxyPort: number,
	upstreamBase: string,
): Promise<void> {
	await seedWindowHighMarks();

	try {
		registerBunServer(
			Bun.serve({
				hostname: "127.0.0.1",
				port: proxyPort,
				// Long SSE streams from Anthropic can idle past 10s during tool calls.
				// 255s is Bun.serve's max, prevents premature socket close.
				idleTimeout: 255,
				async fetch(req) {
					const reqUrl = new URL(req.url);
					const targetUrl = `${upstreamBase}${reqUrl.pathname}${reqUrl.search}`;
					const forwardHeaders = new Headers(req.headers);
					forwardHeaders.delete("host");
					let upstream: Response;
					try {
						upstream = await fetch(targetUrl, {
							method: req.method,
							headers: forwardHeaders,
							body:
								req.method !== "GET" && req.method !== "HEAD"
									? req.body
									: undefined,
							signal: AbortSignal.timeout(300_000),
						});
					} catch {
						return new Response("upstream error", { status: 502 });
					}
					captureUtilizationHeaders(upstream.headers);
					const responseHeaders = new Headers(upstream.headers);
					responseHeaders.delete("content-encoding");
					responseHeaders.delete("content-length");
					responseHeaders.delete("transfer-encoding");
					return new Response(upstream.body, {
						status: upstream.status,
						headers: responseHeaders,
					});
				},
			}),
		);
		process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${proxyPort}`;
		console.log(`Anthropic proxy on :${proxyPort} → ${upstreamBase}`);
	} catch (e) {
		console.warn("[proxy] failed to start, utilization tracking disabled:", e);
		void db.appendLog(
			"warn",
			"proxy",
			"failed to start, utilization tracking disabled",
			{ error: String(e) },
		);
	}
}
