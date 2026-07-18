import { getProvidersFn } from "#/lib/serverFns/providers";

type RavenProviders = Awaited<ReturnType<typeof getProvidersFn>>;

const RAVEN_PROVIDER_CACHE_TTL_MS = 60_000;
const RAVEN_PROVIDER_FAILURE_CACHE_TTL_MS = 10_000;

let catalogRead: Promise<RavenProviders> | null = null;
let catalogValue: RavenProviders | null = null;
let catalogExpiresAt = 0;

/**
 * Session navigation reruns the Raven loader. Share the provider inventory read
 * so a slow cold-start probe cannot leave one request behind for every chat
 * switch, then trigger a duplicate client retry from the fallback.
 */
export function loadRavenProviders(): Promise<RavenProviders> {
	const now = Date.now();
	if (catalogValue !== null && now < catalogExpiresAt) {
		return Promise.resolve(catalogValue);
	}
	if (catalogRead) return catalogRead;

	const read = Promise.resolve(
		getProvidersFn({ data: { preferCachedModels: true } }),
	).then(
		(value) => {
			catalogValue = value;
			catalogExpiresAt =
				Date.now() +
				(value.length > 0
					? RAVEN_PROVIDER_CACHE_TTL_MS
					: RAVEN_PROVIDER_FAILURE_CACHE_TTL_MS);
			return value;
		},
		(error) => {
			catalogValue = null;
			catalogExpiresAt = 0;
			throw error;
		},
	);
	catalogRead = read.finally(() => {
		catalogRead = null;
	});
	return catalogRead;
}

/** @internal */
export function resetRavenProviderCacheForTesting(): void {
	catalogRead = null;
	catalogValue = null;
	catalogExpiresAt = 0;
}
