/** Provider catalog, account info, and usage snapshot server fns. */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import type { ProviderUsageSnapshot } from "#/db";
import { dbJson } from "#/lib/dbClient";
import type { AccountInfo, ProviderInfo } from "#/lib/providerTypes";
import { withRefreshQuery } from "#/lib/serverFnSchemas";

const providerCatalogQuerySchema = z
	.object({
		refresh: z.boolean().optional(),
		includeHostCapabilities: z.boolean().optional(),
		preferCachedModels: z.boolean().optional(),
	})
	.optional();

const CACHED_PROVIDER_READ_BUDGET = {
	initialTimeoutMs: 750,
	retryTimeoutMs: 250,
} as const;

export function providerCatalogPath(
	data: z.infer<typeof providerCatalogQuerySchema>,
): string {
	const path = withRefreshQuery("/providers", data);
	const params = new URLSearchParams();
	if (data?.includeHostCapabilities) params.set("host_capabilities", "1");
	if (data?.preferCachedModels) params.set("cached_models", "1");
	if (params.size === 0) return path;
	return `${path}${path.includes("?") ? "&" : "?"}${params}`;
}

/** Returns the list of compiled-in providers with availability status. */
export const getProvidersFn = createServerFn({ method: "GET" })
	.validator((raw) => providerCatalogQuerySchema.parse(raw))
	.handler(({ data }) =>
		dbJson<{ providers: ProviderInfo[] }>(
			providerCatalogPath(data),
			{
				providers: [],
			},
			data?.refresh ? undefined : CACHED_PROVIDER_READ_BUDGET,
		).then((response) => response.providers),
	);

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
