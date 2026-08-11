import { posix, win32 } from "node:path";
import type { HlidConfig } from "../config";
import {
	PROVIDER_APP_CONTRACT_VERSION,
	type ProviderAppCatalogPage,
	type ProviderAppCatalogRequest,
} from "../lib/providerAppTypes";
import type { AgentProvider } from "./agentProvider";

const PROVIDER_APP_FAILURE_TTL_MS = 5_000;
const MAX_PROVIDER_APP_CACHE_ENTRIES = 100;
const PROVIDER_APP_REFRESH_FAILURE_ISSUE =
	"Provider app inventory refresh failed. Showing the most recently loaded data.";
const PROVIDER_APP_CACHE_BUSY =
	"Provider app inventory is busy. Try again shortly.";

type ProviderAppRouteDependencies = {
	getProvider: (providerId: string) => AgentProvider | undefined;
	loadConfig: () => HlidConfig;
	onAuthenticationStarted?: () => void;
};

type ProviderAppCacheEntry = {
	providerId: string;
	page?: ProviderAppCatalogPage;
	failure?: string;
	failedAt?: number;
	inFlight?: Promise<void>;
	inFlightRefresh?: boolean;
	forceRefreshQueued?: boolean;
};

type ProviderAppScope = {
	providerId: string;
	cwd: string;
	sessionId: string | null;
	cursor: string | null;
	limit: number;
};

function cacheKey(scope: ProviderAppScope): string {
	return JSON.stringify([
		scope.providerId,
		scope.cwd,
		scope.sessionId,
		scope.cursor,
		scope.limit,
	]);
}

function pendingCatalog(scope: ProviderAppScope): ProviderAppCatalogPage {
	return {
		contractVersion: PROVIDER_APP_CONTRACT_VERSION,
		providerId: scope.providerId,
		status: "partial",
		refreshing: true,
		observedAt: 0,
		scope: {
			providerId: scope.providerId,
			account: "active-provider-account",
			host: "current-hlid-host",
			workspace: scope.cwd,
			sessionId: scope.sessionId,
		},
		apps: [],
		connectors: [],
		installedCount: 0,
		usableCount: 0,
		missingAuthenticationCount: 0,
		returned: 0,
		nextCursor: null,
		truncated: false,
	};
}

function refreshingCatalog(
	page: ProviderAppCatalogPage,
): ProviderAppCatalogPage {
	return page.refreshing ? page : { ...page, refreshing: true };
}

function failedRefreshCatalog(
	page: ProviderAppCatalogPage,
): ProviderAppCatalogPage {
	const { refreshing: _refreshing, ...current } = page;
	return {
		...current,
		status: current.status === "unavailable" ? "unavailable" : "partial",
		issueSeverity: "warning",
		issues: [
			...new Set([
				...(current.issues ?? []),
				PROVIDER_APP_REFRESH_FAILURE_ISSUE,
			]),
		],
	};
}

class ProviderAppCatalogCache {
	private readonly entries = new Map<string, ProviderAppCacheEntry>();

	read(
		scope: ProviderAppScope,
		provider: AgentProvider & Required<Pick<AgentProvider, "listApps">>,
		refresh: boolean,
	): { page?: ProviderAppCatalogPage; failure?: string } {
		const key = cacheKey(scope);
		const now = Date.now();
		let entry = this.entries.get(key);
		if (!entry) {
			if (!this.makeRoom()) return { failure: PROVIDER_APP_CACHE_BUSY };
			entry = { providerId: scope.providerId };
			this.entries.set(key, entry);
		}
		if (entry.inFlight && refresh && !entry.inFlightRefresh) {
			entry.forceRefreshQueued = true;
		}

		const missingPage = entry.page === undefined;
		const failureExpired =
			entry.failedAt === undefined ||
			now - entry.failedAt >= PROVIDER_APP_FAILURE_TTL_MS;
		if (
			!entry.inFlight &&
			(refresh || missingPage) &&
			(!entry.failure || refresh || failureExpired)
		) {
			this.startLoad(key, entry, provider, scope, refresh);
		}

		if (entry.page) {
			return {
				page: entry.inFlight
					? refreshingCatalog(entry.page)
					: entry.failure
						? failedRefreshCatalog(entry.page)
						: entry.page,
			};
		}
		if (entry.inFlight) return { page: pendingCatalog(scope) };
		return {
			failure: entry.failure ?? "Provider app inventory is unavailable.",
		};
	}

	invalidate(providerId: string): void {
		for (const [key, entry] of this.entries) {
			if (entry.providerId !== providerId) continue;
			if (entry.inFlight) entry.forceRefreshQueued = true;
			else this.entries.delete(key);
		}
	}

	private startLoad(
		key: string,
		entry: ProviderAppCacheEntry,
		provider: AgentProvider & Required<Pick<AgentProvider, "listApps">>,
		scope: ProviderAppScope,
		refresh: boolean,
	): void {
		const request: ProviderAppCatalogRequest = {
			cwd: scope.cwd,
			...(scope.sessionId ? { sessionId: scope.sessionId } : {}),
			limit: scope.limit,
			...(scope.cursor ? { cursor: scope.cursor } : {}),
			...(refresh ? { refresh: true } : {}),
		};
		const pending = provider.listApps(request).then(
			(page) => {
				entry.page = page;
				entry.failure = undefined;
				entry.failedAt = undefined;
			},
			(error) => {
				entry.failure = errorMessage(error);
				entry.failedAt = Date.now();
			},
		);
		const settled = pending.finally(() => {
			if (entry.inFlight !== settled) return;
			entry.inFlight = undefined;
			entry.inFlightRefresh = undefined;
			if (entry.forceRefreshQueued) {
				entry.forceRefreshQueued = false;
				this.startLoad(key, entry, provider, scope, true);
			}
			if (!entry.page && !entry.failure) this.entries.delete(key);
		});
		entry.inFlight = settled;
		entry.inFlightRefresh = refresh;
	}

	private makeRoom(): boolean {
		if (this.entries.size < MAX_PROVIDER_APP_CACHE_ENTRIES) return true;
		for (const [key, entry] of this.entries) {
			if (!entry.inFlight) {
				this.entries.delete(key);
				return true;
			}
		}
		return false;
	}
}

function boundedId(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const clean = value.trim();
	if (!clean || clean.length > 240 || /[\0\r\n]/.test(clean)) return null;
	return clean;
}

function boundedCwd(value: string | null, fallback: string): string | null {
	const clean = (value ?? fallback).trim();
	if (
		!clean ||
		clean.length > 4_096 ||
		(!posix.isAbsolute(clean) && !win32.isAbsolute(clean))
	) {
		return null;
	}
	return clean;
}

function errorMessage(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	return message.slice(0, 300);
}

async function readProviderApps(
	url: URL,
	dependencies: ProviderAppRouteDependencies,
	cache: ProviderAppCatalogCache,
): Promise<Response> {
	const providerId = boundedId(url.searchParams.get("provider_id"));
	if (!providerId) {
		return Response.json({ error: "provider_id is required" }, { status: 400 });
	}
	const provider = dependencies.getProvider(providerId);
	if (!provider) {
		return Response.json({ error: "Provider was not found" }, { status: 404 });
	}
	if (!provider.listApps) {
		return Response.json(
			{ error: "This provider does not expose an Apps catalog through Hlid" },
			{ status: 409 },
		);
	}
	const config = dependencies.loadConfig();
	const cwd = boundedCwd(
		url.searchParams.get("cwd"),
		config.vault.path || process.cwd(),
	);
	if (!cwd) {
		return Response.json(
			{ error: "cwd must be an absolute path" },
			{ status: 400 },
		);
	}
	const rawLimit = Number(url.searchParams.get("limit") ?? "50");
	if (!Number.isInteger(rawLimit) || rawLimit < 1 || rawLimit > 100) {
		return Response.json(
			{ error: "limit must be an integer from 1 to 100" },
			{ status: 400 },
		);
	}
	const cursor = url.searchParams.get("cursor")?.trim();
	if (cursor && (cursor.length > 500 || /[\0\r\n]/.test(cursor))) {
		return Response.json({ error: "cursor is invalid" }, { status: 400 });
	}
	const sessionId = boundedId(url.searchParams.get("session_id"));
	if (url.searchParams.has("session_id") && !sessionId) {
		return Response.json({ error: "session_id is invalid" }, { status: 400 });
	}
	const result = cache.read(
		{
			providerId,
			cwd,
			sessionId,
			cursor: cursor || null,
			limit: rawLimit,
		},
		provider as AgentProvider & Required<Pick<AgentProvider, "listApps">>,
		url.searchParams.get("refresh") === "1",
	);
	return result.page
		? Response.json(result.page)
		: Response.json({ error: result.failure }, { status: 409 });
}

async function authenticateProviderApp(
	request: Request,
	dependencies: ProviderAppRouteDependencies,
	onCatalogChanged?: (providerId: string) => void,
): Promise<Response> {
	const body = (await request.json().catch(() => null)) as {
		providerId?: unknown;
		cwd?: unknown;
		kind?: unknown;
		id?: unknown;
	} | null;
	const providerId = boundedId(body?.providerId);
	const id = boundedId(body?.id);
	if (!providerId || !id || (body?.kind !== "app" && body?.kind !== "mcp")) {
		return Response.json(
			{ error: "providerId, kind, and id are required" },
			{ status: 400 },
		);
	}
	const provider = dependencies.getProvider(providerId);
	if (!provider) {
		return Response.json({ error: "Provider was not found" }, { status: 404 });
	}
	if (!provider.startAppAuthentication) {
		return Response.json(
			{
				error: "This provider does not expose app authentication through Hlid",
			},
			{ status: 409 },
		);
	}
	const config = dependencies.loadConfig();
	const cwd = boundedCwd(
		typeof body.cwd === "string" ? body.cwd : null,
		config.vault.path || process.cwd(),
	);
	if (!cwd) {
		return Response.json(
			{ error: "cwd must be an absolute path" },
			{ status: 400 },
		);
	}
	try {
		const result = await provider.startAppAuthentication({
			cwd,
			target: { kind: body.kind, id },
		});
		onCatalogChanged?.(providerId);
		dependencies.onAuthenticationStarted?.();
		return Response.json({ ok: result.opened });
	} catch (error) {
		return Response.json({ error: errorMessage(error) }, { status: 409 });
	}
}

export function createProviderAppRouteHandler(
	dependencies: ProviderAppRouteDependencies,
) {
	const cache = new ProviderAppCatalogCache();
	return async (url: URL, request: Request): Promise<Response | null> => {
		if (url.pathname === "/provider-apps" && request.method === "GET") {
			return readProviderApps(url, dependencies, cache);
		}
		if (
			url.pathname === "/provider-apps/authenticate" &&
			request.method === "POST"
		) {
			return authenticateProviderApp(request, dependencies, (providerId) =>
				cache.invalidate(providerId),
			);
		}
		return null;
	};
}
