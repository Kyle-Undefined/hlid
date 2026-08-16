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

/**
 * Update the in-memory mark from a CLI rate_limit event.
 * Called by session.ts handleRateLimit so /db/provider-usage reflects
 * live values even when the SDK reports rate-limit info directly (not via
 * proxy response headers). Always reflects the latest reading — external
 * Anthropic resets can lower utilization within the same window period
 * (same resetsAt) without emitting a new window. Only skips when no useful
 * data arrives for an already-tracked window.
 */
export function updateWindowMark(
	providerId: string,
	windowId: string,
	utilization: number | null,
	resetsAt: number | null,
): void {
	const key = markKey(providerId, windowId);
	const current = windowHighMark.get(key);
	const newWindow = !current || current.resetsAt !== resetsAt;
	if (!newWindow && utilization == null) return;
	windowHighMark.set(key, {
		utilization,
		remaining: newWindow ? null : (current?.remaining ?? null),
		resetsAt,
	});
}

export function applyReading(
	providerId: string,
	reading: ProviderWindowReading,
): Promise<void> {
	const key = markKey(providerId, reading.windowId);
	const current = windowHighMark.get(key);
	const newWindow = !current || current.resetsAt !== reading.resetsAt;

	// Skip pure no-data events within an unchanged window.
	if (!newWindow && reading.utilization == null && reading.remaining == null)
		return Promise.resolve();

	const next: WindowMark = {
		utilization: reading.utilization,
		remaining: reading.remaining,
		resetsAt: reading.resetsAt,
	};
	windowHighMark.set(key, next);

	// DB write fires on every valid reading — single INSERT OR REPLACE on a
	// fixed settings row; negligible overhead relative to a proxy round-trip.
	const persisted = persistDisplayUsageReading(providerId, reading);

	// Only broadcast when something changed to avoid WS noise under heavy load.
	const changed =
		!current ||
		current.utilization !== next.utilization ||
		current.remaining !== next.remaining ||
		current.resetsAt !== next.resetsAt;
	if (!changed) return persisted;

	broadcast({
		type: "rate_limit",
		status: "allowed",
		rateLimitType: reading.windowId,
		utilization: reading.utilization ?? undefined,
		remaining: reading.remaining ?? undefined,
		limit: reading.limit ?? undefined,
		resetsAt: reading.resetsAt ?? undefined,
		providerId,
	});
	return persisted;
}

/**
 * Persist display-only account telemetry without updating the auto-sleep marks
 * or broadcasting a rate-limit event. Use this for quotas that do not govern
 * every session of the Hlid provider identity.
 */
export function persistDisplayUsageReading(
	providerId: string,
	reading: ProviderWindowReading,
): Promise<void> {
	return db.saveSetting(
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
}

/** Seed in-memory high-water marks from DB on cold start. */
export async function seedWindowMarks(
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

/** Seed only windows that are allowed to participate in usage gating. */
export function seedProviderWindowMarks(
	provider: Pick<AgentProvider, "providerId" | "usageWindows">,
): Promise<void> {
	return seedWindowMarks(
		provider.providerId,
		(provider.usageWindows ?? [])
			.filter((window) => !window.displayOnly)
			.map((window) => window.windowId),
	);
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
				for (const r of readings) void applyReading(provider.providerId, r);
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
