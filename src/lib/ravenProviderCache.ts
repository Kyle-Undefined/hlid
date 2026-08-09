import { getDataRevisionSnapshot } from "#/hooks/wsDataRevisionStore";
import { getProvidersFn } from "#/lib/serverFns/providers";

type RavenProviders = Awaited<ReturnType<typeof getProvidersFn>>;

const RAVEN_PROVIDER_CACHE_TTL_MS = 60_000;
const RAVEN_PROVIDER_FAILURE_CACHE_TTL_MS = 10_000;

type RavenProviderCacheEntry = {
	revision: number;
	value: RavenProviders;
	expiresAt: number;
};

type RavenProviderRead = {
	revision: number;
	promise: Promise<RavenProviders>;
};

let catalogRead: RavenProviderRead | null = null;
let catalogCache: RavenProviderCacheEntry | null = null;

/**
 * Session navigation reruns the Raven loader. Share the provider inventory read
 * so a slow cold-start probe cannot leave one request behind for every chat
 * switch, then trigger a duplicate client retry from the fallback.
 */
export function loadRavenProviders(): Promise<RavenProviders> {
	const now = Date.now();
	const revision = getDataRevisionSnapshot().providers;
	if (
		catalogCache !== null &&
		catalogCache.revision === revision &&
		now < catalogCache.expiresAt
	) {
		return Promise.resolve(catalogCache.value);
	}
	if (catalogRead?.revision === revision) return catalogRead.promise;

	const entry = { revision } as RavenProviderRead;
	entry.promise = Promise.resolve(
		getProvidersFn({ data: { preferCachedModels: true } }),
	)
		.then(
			(value) => {
				if (getDataRevisionSnapshot().providers === revision) {
					catalogCache = {
						revision,
						value,
						expiresAt:
							Date.now() +
							(value.length > 0
								? RAVEN_PROVIDER_CACHE_TTL_MS
								: RAVEN_PROVIDER_FAILURE_CACHE_TTL_MS),
					};
				}
				return value;
			},
			(error) => {
				if (catalogCache?.revision === revision) catalogCache = null;
				throw error;
			},
		)
		.finally(() => {
			if (catalogRead === entry) catalogRead = null;
		});
	catalogRead = entry;
	return entry.promise;
}

/** @internal */
export function resetRavenProviderCacheForTesting(): void {
	catalogRead = null;
	catalogCache = null;
}
