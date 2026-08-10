/** Provider catalog, account info, and usage snapshot server fns. */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import type { ProviderUsageSnapshot } from "#/db";
import { dbFetch, dbJson, requireDbOk } from "#/lib/dbClient";
import type { AccountInfo, ProviderInfo } from "#/lib/providerTypes";
import { withRefreshQuery } from "#/lib/serverFnSchemas";

const providerCatalogQuerySchema = z
	.object({
		refresh: z.boolean().optional(),
		includeHostCapabilities: z.boolean().optional(),
		includeProviderCapabilities: z.boolean().optional(),
		preferCachedModels: z.boolean().optional(),
		refreshProviderId: z.string().min(1).optional(),
		discoveryCwd: z.string().min(1).max(4_096).optional(),
	})
	.optional();

const CACHED_PROVIDER_READ_BUDGET = {
	initialTimeoutMs: 1_250,
	retryTimeoutMs: false,
} as const;
const LIVE_PROVIDER_READ_BUDGET = {
	// Explicit refresh may negotiate bounded ACP startup stages (12s server-side).
	// Give that user-requested work enough time to return instead of masking it
	// as a successful empty catalog while discovery keeps running in the server.
	initialTimeoutMs: 15_000,
	retryTimeoutMs: false,
} as const;

export function withProviderCatalogRevision(
	providers: ProviderInfo[],
	providerId: string | undefined,
	revisionHeader: string | null,
): ProviderInfo[] {
	const revision = Number.parseInt(revisionHeader ?? "", 10);
	if (!providerId || !Number.isSafeInteger(revision) || revision < 0) {
		return providers;
	}
	return providers.map((provider) =>
		provider.id === providerId && provider.modelCatalogRefresh
			? {
					...provider,
					modelCatalogRefresh: {
						...provider.modelCatalogRefresh,
						revision,
					},
				}
			: provider,
	);
}

export function providerCatalogPath(
	data: z.infer<typeof providerCatalogQuerySchema>,
): string {
	const path = withRefreshQuery("/providers", data);
	const params = new URLSearchParams();
	if (data?.includeHostCapabilities) params.set("host_capabilities", "1");
	if (data?.includeProviderCapabilities)
		params.set("provider_capabilities", "1");
	if (data?.preferCachedModels) params.set("cached_models", "1");
	if (data?.refresh && data.refreshProviderId) {
		params.set("provider_id", data.refreshProviderId);
	}
	if (data?.discoveryCwd) params.set("capability_cwd", data.discoveryCwd);
	if (params.size === 0) return path;
	return `${path}${path.includes("?") ? "&" : "?"}${params}`;
}

/** Returns the list of compiled-in providers with availability status. */
export const getProvidersFn = createServerFn({ method: "GET" })
	.validator((raw) => providerCatalogQuerySchema.parse(raw))
	.handler(async ({ data }) => {
		const path = providerCatalogPath(data);
		if (data?.refresh) {
			const response = await requireDbOk(
				await dbFetch(path, {
					signal: AbortSignal.timeout(
						LIVE_PROVIDER_READ_BUDGET.initialTimeoutMs,
					),
				}),
				"refresh provider catalog",
			);
			const payload = (await response.json()) as { providers?: unknown };
			if (!Array.isArray(payload.providers)) {
				throw new Error(
					"refresh provider catalog returned an invalid response",
				);
			}
			return withProviderCatalogRevision(
				payload.providers as ProviderInfo[],
				data.refreshProviderId,
				response.headers.get("x-hlid-providers-revision"),
			);
		}
		return dbJson<{ providers: ProviderInfo[] }>(
			path,
			{ providers: [] },
			CACHED_PROVIDER_READ_BUDGET,
		).then((response) => response.providers);
	});

/**
 * Returns account info (email/org/subscription) for the first live session
 * whose provider exposes it, or null if none is running. Never spawns a
 * session — see GET /account in server/index.ts.
 */
export const getAccountInfoFn = createServerFn({ method: "GET" }).handler(() =>
	dbJson<AccountInfo | null>("/account", null),
);

/** Returns provider-aware usage snapshots for the given provider IDs. */
export const getProviderUsagesFn = createServerFn({ method: "GET" })
	.validator((raw) => {
		const ids = Array.isArray(raw) ? (raw as string[]) : ["claude"];
		return ids.filter((id): id is string => typeof id === "string");
	})
	.handler((ctx) => {
		const providers = ctx.data.join(",");
		return dbJson<ProviderUsageSnapshot[]>(
			`/db/provider-usage?providers=${encodeURIComponent(providers)}`,
			[],
		);
	});

const BUILT_IN_USAGE_PROVIDER_IDS = ["claude", "codex"];

export function providerUsageIds(providers: ProviderInfo[]): string[] {
	const ids = providers.map((provider) => provider.id);
	// Provider catalog reads use a deliberately short cached-read budget. If
	// that discovery times out, still hydrate the two built-in providers instead
	// of returning a valid-but-empty usage strip.
	return ids.length > 0 ? ids : BUILT_IN_USAGE_PROVIDER_IDS;
}

export function loadProviderUsages(providers?: ProviderInfo[]) {
	if (providers) {
		return getProviderUsagesFn({ data: providerUsageIds(providers) });
	}
	return getProvidersFn().then((loaded) =>
		getProviderUsagesFn({ data: providerUsageIds(loaded) }),
	);
}
