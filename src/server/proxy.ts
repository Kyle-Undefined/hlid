import * as db from "../db";
import { registerBunServer } from "../lib/lifecycle";
import type { AgentProvider, ProviderWindowReading } from "./agentProvider";
import { broadcast } from "./runState";

type WindowMark = {
	utilization: number | null;
	remaining: number | null;
	resetsAt: number | null;
};

/** High-water marks keyed by `${providerId}:${windowId}`. */
const windowHighMark = new Map<string, WindowMark>();

function markKey(providerId: string, windowId: string): string {
	return `${providerId}:${windowId}`;
}

function dbSettingKey(providerId: string, windowId: string): string {
	return `rl_${providerId}_${windowId}`;
}

export function getWindowMark(
	providerId: string,
	windowId: string,
): WindowMark | undefined {
	return windowHighMark.get(markKey(providerId, windowId));
}

function applyReading(
	providerId: string,
	reading: ProviderWindowReading,
): void {
	const key = markKey(providerId, reading.windowId);
	const current = windowHighMark.get(key);
	const newWindow = !current || current.resetsAt !== reading.resetsAt;
	const isHigher =
		reading.utilization != null
			? reading.utilization > (current?.utilization ?? 0)
			: reading.remaining != null && current?.remaining != null
				? reading.remaining < current.remaining
				: true;

	if (!newWindow && !isHigher) return;

	windowHighMark.set(key, {
		utilization: reading.utilization,
		remaining: reading.remaining,
		resetsAt: reading.resetsAt,
	});

	void db.saveSetting(
		dbSettingKey(providerId, reading.windowId),
		JSON.stringify({
			utilization: reading.utilization,
			remaining: reading.remaining,
			limit: reading.limit,
			resetsAt: reading.resetsAt ?? null,
			windowId: reading.windowId,
			label: reading.label,
		}),
	);

	broadcast({
		type: "rate_limit",
		status: "allowed",
		rateLimitType: reading.windowId,
		utilization: reading.utilization ?? undefined,
		resetsAt: reading.resetsAt ?? undefined,
		providerId,
	});
}

/** Seed in-memory high-water marks from DB on cold start. */
async function seedWindowMarks(
	providerId: string,
	windowIds: string[],
): Promise<void> {
	for (const windowId of windowIds) {
		const raw = await db.getSetting(dbSettingKey(providerId, windowId));
		if (!raw) continue;
		try {
			const parsed = JSON.parse(raw) as {
				utilization?: number | null;
				remaining?: number | null;
				resetsAt?: number | null;
			};
			const resetsAt = parsed.resetsAt ?? null;
			if (resetsAt != null && resetsAt < Date.now() / 1000) continue;
			if (parsed.utilization == null && parsed.remaining == null) continue;
			windowHighMark.set(markKey(providerId, windowId), {
				utilization: parsed.utilization ?? null,
				remaining: parsed.remaining ?? null,
				resetsAt,
			});
		} catch {}
	}
}

export async function startProviderProxy(
	provider: AgentProvider,
	upstreamBase: string,
): Promise<void> {
	const { proxyConfig } = provider;
	if (!proxyConfig) return;

	await seedWindowMarks(provider.providerId, proxyConfig.windowIds);

	try {
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
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
				const readings = proxyConfig.parseHeaders(upstream.headers);
				for (const r of readings) applyReading(provider.providerId, r);
				const responseHeaders = new Headers(upstream.headers);
				responseHeaders.delete("content-encoding");
				responseHeaders.delete("content-length");
				responseHeaders.delete("transfer-encoding");
				return new Response(upstream.body, {
					status: upstream.status,
					headers: responseHeaders,
				});
			},
		});
		registerBunServer(server);
		process.env[proxyConfig.envVar] = `http://127.0.0.1:${server.port}`;
		console.log(
			`[proxy] ${provider.providerId} on :${server.port} → ${upstreamBase}`,
		);
	} catch (e) {
		console.warn(
			`[proxy] ${provider.providerId} failed to start, utilization tracking disabled:`,
			e,
		);
		void db.appendLog(
			"warn",
			"proxy",
			`${provider.providerId} proxy failed to start`,
			{ error: String(e) },
		);
	}
}
