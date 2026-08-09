import { getDataRevisionSnapshot } from "#/hooks/wsDataRevisionStore";
import { getProvidersFn } from "#/lib/serverFns/providers";

type RavenProviders = Awaited<ReturnType<typeof getProvidersFn>>;

const RAVEN_PROVIDER_CACHE_TTL_MS = 60_000;
const RAVEN_PROVIDER_FAILURE_CACHE_TTL_MS = 10_000;
const MAX_RAVEN_PROVIDER_WORKSPACES = 64;

type RavenProviderCacheEntry = {
	revision: number;
	value: RavenProviders;
	expiresAt: number;
};

type RavenProviderRead = {
	revision: number;
	promise: Promise<RavenProviders>;
};

const catalogReads = new Map<string, RavenProviderRead>();
const catalogCaches = new Map<string, RavenProviderCacheEntry>();

function workspaceKey(discoveryCwd: string | undefined): string {
	const cwd = discoveryCwd?.trim();
	if (!cwd) return "\0default-workspace";
	let normalized = cwd.replace(/\\/g, "/");
	const wsl = normalized.match(
		/^\/\/(?:wsl\$|wsl\.localhost)\/([^/]+)(\/.*)?$/i,
	);
	if (wsl) {
		const path = (wsl[2] || "/").replace(/\/+$/, "") || "/";
		return `wsl:${wsl[1].toLowerCase()}:${path}`;
	}
	if (/^[a-z]:\//i.test(normalized) || normalized.startsWith("//")) {
		normalized = normalized.toLowerCase();
	}
	return normalized.replace(/\/+$/, "") || "/";
}

function rememberBounded<T>(map: Map<string, T>, key: string, value: T): void {
	if (!map.has(key) && map.size >= MAX_RAVEN_PROVIDER_WORKSPACES) {
		const oldest = map.keys().next().value;
		if (oldest !== undefined) map.delete(oldest);
	}
	map.set(key, value);
}

/**
 * Session navigation reruns the Raven loader. Share the provider inventory read
 * so a slow cold-start probe cannot leave one request behind for every chat
 * switch, then trigger a duplicate client retry from the fallback.
 */
export function loadRavenProviders(
	discoveryCwd?: string,
): Promise<RavenProviders> {
	const now = Date.now();
	const revision = getDataRevisionSnapshot().providers;
	const key = workspaceKey(discoveryCwd);
	const catalogCache = catalogCaches.get(key);
	if (
		catalogCache !== undefined &&
		catalogCache.revision === revision &&
		now < catalogCache.expiresAt
	) {
		return Promise.resolve(catalogCache.value);
	}
	const catalogRead = catalogReads.get(key);
	if (catalogRead?.revision === revision) return catalogRead.promise;

	const entry = { revision } as RavenProviderRead;
	entry.promise = Promise.resolve(
		getProvidersFn({
			data: {
				preferCachedModels: true,
				...(discoveryCwd ? { discoveryCwd } : {}),
			},
		}),
	)
		.then(
			(value) => {
				if (getDataRevisionSnapshot().providers === revision) {
					rememberBounded(catalogCaches, key, {
						revision,
						value,
						expiresAt:
							Date.now() +
							(value.length > 0
								? RAVEN_PROVIDER_CACHE_TTL_MS
								: RAVEN_PROVIDER_FAILURE_CACHE_TTL_MS),
					});
				}
				return value;
			},
			(error) => {
				if (catalogCaches.get(key)?.revision === revision) {
					catalogCaches.delete(key);
				}
				throw error;
			},
		)
		.finally(() => {
			if (catalogReads.get(key) === entry) catalogReads.delete(key);
		});
	rememberBounded(catalogReads, key, entry);
	return entry.promise;
}

/** @internal */
export function resetRavenProviderCacheForTesting(): void {
	catalogReads.clear();
	catalogCaches.clear();
}
