/** Provider catalog, account info, and usage snapshot server fns. */
import { createServerFn } from "@tanstack/react-start";
import type { ProviderUsageSnapshot } from "#/db";
import { dbJson } from "#/lib/dbClient";
import type { AccountInfo, ProviderInfo } from "#/lib/providerTypes";
import { optionalRefreshSchema, withRefreshQuery } from "#/lib/serverFnSchemas";

/** Returns the list of compiled-in providers with availability status. */
export const getProvidersFn = createServerFn({ method: "GET" })
	.validator((raw) => optionalRefreshSchema.parse(raw))
	.handler(({ data }) =>
		dbJson<{ providers: ProviderInfo[] }>(
			withRefreshQuery("/providers", data),
			{
				providers: [],
			},
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

function providerUsageIds(providers: ProviderInfo[]): string[] {
	const ids = providers.map((provider) => provider.id);
	return ids.length > 0 ? ids : ["claude"];
}

export function loadProviderUsages(providers?: ProviderInfo[]) {
	if (providers) {
		return getProviderUsagesFn({ data: providerUsageIds(providers) });
	}
	return getProvidersFn().then((loaded) =>
		getProviderUsagesFn({ data: providerUsageIds(loaded) }),
	);
}
