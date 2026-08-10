import { getDataRevisionSnapshot } from "#/hooks/wsDataRevisionStore";
import { getProvidersFn } from "#/lib/serverFns/providers";

type RavenProviders = Awaited<ReturnType<typeof getProvidersFn>>;

const RAVEN_PROVIDER_CACHE_TTL_MS = 60_000;
const RAVEN_PROVIDER_FAILURE_CACHE_TTL_MS = 10_000;
const MAX_RAVEN_PROVIDER_WORKSPACES = 64;

type RavenProviderCacheEntry = {
	revision: number;
	generation: number;
	value: RavenProviders;
	expiresAt: number;
};

type RavenProviderRead = {
	revision: number;
	generation: number;
	promise: Promise<RavenProviders>;
};

type RavenProviderRefresh = RavenProviderRead & {
	providerId: string;
};

type RavenSessionRefresh = {
	revision: number;
	settled: boolean;
	promise: Promise<RavenProviders>;
};

const catalogReads = new Map<string, RavenProviderRead>();
const navigationReads = new Map<string, RavenProviderRead>();
const catalogRefreshes = new Map<string, RavenProviderRefresh>();
const catalogCaches = new Map<string, RavenProviderCacheEntry>();
const catalogGenerations = new Map<string, number>();
const sessionRefreshes = new Map<string, RavenSessionRefresh>();

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

function cacheLifetime(value: RavenProviders): number {
	return value.length > 0
		? RAVEN_PROVIDER_CACHE_TTL_MS
		: RAVEN_PROVIDER_FAILURE_CACHE_TTL_MS;
}

function currentGeneration(key: string): number {
	return catalogGenerations.get(key) ?? 0;
}

function providerRefreshStatus(
	value: RavenProviders,
	providerId: string,
): RavenProviders[number]["modelCatalogRefresh"] | undefined {
	return value.find((provider) => provider.id === providerId)
		?.modelCatalogRefresh;
}

function staleProviderRefresh(
	value: RavenProviders,
	providerId: string,
	reason = "Live refresh failed; using cached provider metadata.",
	source: "memory" | "fallback" = "memory",
): RavenProviders {
	return value.map((provider) =>
		provider.id === providerId
			? {
					...provider,
					modelCatalogRefresh: {
						status: "stale",
						source,
						reason,
					},
				}
			: provider,
	);
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
	const generation = currentGeneration(key);
	const catalogRefresh = catalogRefreshes.get(key);
	if (catalogRefresh?.generation === generation) {
		return catalogRefresh.promise;
	}
	const catalogCache = catalogCaches.get(key);
	if (
		catalogCache !== undefined &&
		catalogCache.revision >= revision &&
		catalogCache.generation === generation &&
		now < catalogCache.expiresAt
	) {
		return Promise.resolve(catalogCache.value);
	}
	const catalogRead = catalogReads.get(key);
	if (
		catalogRead?.revision === revision &&
		catalogRead.generation === generation
	) {
		return catalogRead.promise;
	}

	const entry = { revision, generation } as RavenProviderRead;
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
				if (
					getDataRevisionSnapshot().providers === revision &&
					currentGeneration(key) === generation &&
					catalogReads.get(key) === entry
				) {
					rememberBounded(catalogCaches, key, {
						revision,
						generation,
						value,
						expiresAt: Date.now() + cacheLifetime(value),
					});
				}
				return value;
			},
			(error) => {
				const currentCache = catalogCaches.get(key);
				if (
					catalogReads.get(key) === entry &&
					currentGeneration(key) === generation &&
					currentCache?.revision === revision &&
					currentCache.generation === generation
				) {
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

/**
 * Read the process-free provider snapshot for route navigation without joining
 * an in-flight live refresh. Agent selection can start ACP discovery before the
 * next route loader reaches its provider read; joining that promise would put
 * the transient provider process back on Raven's pending-navigation path.
 *
 * A still-valid prior snapshot is safe to return immediately. When no prior
 * snapshot is available, share a separate cached-model read that never writes
 * into the live-refresh cache, so a late navigation response cannot overwrite
 * newer live metadata.
 */
export function loadRavenProvidersForNavigation(
	discoveryCwd?: string,
): Promise<RavenProviders> {
	const now = Date.now();
	const revision = getDataRevisionSnapshot().providers;
	const key = workspaceKey(discoveryCwd);
	const generation = currentGeneration(key);
	const catalogRefresh = catalogRefreshes.get(key);
	if (catalogRefresh?.generation !== generation) {
		return loadRavenProviders(discoveryCwd);
	}

	const prior = catalogCaches.get(key);
	if (
		prior !== undefined &&
		prior.revision >= revision &&
		now < prior.expiresAt
	) {
		return Promise.resolve(prior.value);
	}

	const existing = navigationReads.get(key);
	if (existing?.revision === revision && existing.generation === generation) {
		return existing.promise;
	}

	const entry = { revision, generation } as RavenProviderRead;
	entry.promise = Promise.resolve(
		getProvidersFn({
			data: {
				preferCachedModels: true,
				...(discoveryCwd ? { discoveryCwd } : {}),
			},
		}),
	).finally(() => {
		if (navigationReads.get(key) === entry) navigationReads.delete(key);
	});
	rememberBounded(navigationReads, key, entry);
	return entry.promise;
}

/**
 * Force one provider's workspace-scoped catalog to be rediscovered. New Raven
 * sessions use this for ACP providers so an external agent config or executable
 * update cannot remain hidden behind the navigation cache. Older cached reads
 * are generation-guarded and cannot overwrite the refresh result.
 */
export function refreshRavenProvider(
	providerId: string,
	discoveryCwd?: string,
): Promise<RavenProviders> {
	const revision = getDataRevisionSnapshot().providers;
	const key = workspaceKey(discoveryCwd);
	const existing = catalogRefreshes.get(key);
	if (existing?.providerId === providerId) {
		return existing.promise;
	}

	const generation = currentGeneration(key) + 1;
	rememberBounded(catalogGenerations, key, generation);
	const previous = catalogCaches.get(key);
	const entry = { revision, generation, providerId } as RavenProviderRefresh;
	entry.promise = Promise.resolve(
		getProvidersFn({
			data: {
				refresh: true,
				refreshProviderId: providerId,
				...(discoveryCwd ? { discoveryCwd } : {}),
			},
		}),
	)
		.then(
			(value) => {
				const refresh = providerRefreshStatus(value, providerId);
				const refreshStatus = refresh?.status;
				const responseRevision = refresh?.revision;
				const currentRevision = getDataRevisionSnapshot().providers;
				const resultCoversCurrentRevision =
					responseRevision !== undefined
						? currentRevision <= responseRevision
						: currentRevision === revision;
				const effectiveValue = resultCoversCurrentRevision
					? value
					: staleProviderRefresh(
							value,
							providerId,
							"Provider configuration changed during live refresh; retry for current metadata.",
							"fallback",
						);
				if (
					resultCoversCurrentRevision &&
					currentGeneration(key) === generation &&
					catalogRefreshes.get(key) === entry
				) {
					rememberBounded(catalogCaches, key, {
						revision: responseRevision ?? revision,
						generation,
						value: effectiveValue,
						expiresAt:
							Date.now() +
							(refreshStatus === "stale" || refreshStatus === "unavailable"
								? RAVEN_PROVIDER_FAILURE_CACHE_TTL_MS
								: cacheLifetime(value)),
					});
				}
				return effectiveValue;
			},
			(error) => {
				if (
					previous !== undefined &&
					previous.revision >= revision &&
					currentGeneration(key) === generation &&
					catalogRefreshes.get(key) === entry
				) {
					const fallbackValue = staleProviderRefresh(
						previous.value,
						providerId,
					);
					rememberBounded(catalogCaches, key, {
						...previous,
						generation,
						value: fallbackValue,
						expiresAt: Date.now() + RAVEN_PROVIDER_FAILURE_CACHE_TTL_MS,
					});
					return fallbackValue;
				}
				throw error;
			},
		)
		.finally(() => {
			if (catalogRefreshes.get(key) === entry) {
				catalogRefreshes.delete(key);
			}
		});
	rememberBounded(catalogRefreshes, key, entry);
	return entry.promise;
}

/**
 * Refresh an ACP catalog at most once for one Raven session, provider, and
 * workspace revision. Mounted composers share this promise across rerenders so
 * new-session links, agent changes, restored chats, and client-generated
 * sessions all converge on the same live inspection.
 */
export function refreshRavenProviderForSession(
	sessionId: string,
	providerId: string,
	discoveryCwd?: string,
): Promise<RavenProviders> {
	const workspace = workspaceKey(discoveryCwd);
	const key = `${workspace}\0${providerId}\0${sessionId}`;
	const revision = getDataRevisionSnapshot().providers;
	const existing = sessionRefreshes.get(key);
	if (existing && (!existing.settled || existing.revision >= revision)) {
		return existing.promise;
	}
	if (existing) sessionRefreshes.delete(key);

	const refresh = refreshRavenProvider(providerId, discoveryCwd);
	const entry: RavenSessionRefresh = {
		revision,
		settled: false,
		promise: refresh,
	};
	rememberBounded(sessionRefreshes, key, entry);
	void refresh.then(
		(value) => {
			entry.settled = true;
			if (sessionRefreshes.get(key) !== entry) return;
			const refreshStatus = providerRefreshStatus(value, providerId);
			if (refreshStatus?.status !== "current") {
				sessionRefreshes.delete(key);
				return;
			}
			const currentRevision = getDataRevisionSnapshot().providers;
			if (refreshStatus.revision === undefined) {
				// Older servers cannot distinguish their own discovery bump from an
				// external runtime change. Fail safe and retry when the client moved.
				if (currentRevision !== entry.revision) sessionRefreshes.delete(key);
				return;
			}
			if (currentRevision > refreshStatus.revision) {
				sessionRefreshes.delete(key);
				return;
			}
			entry.revision = refreshStatus.revision;
		},
		() => {
			entry.settled = true;
			if (sessionRefreshes.get(key) === entry) sessionRefreshes.delete(key);
		},
	);
	return refresh;
}

/** @internal */
export function resetRavenProviderCacheForTesting(): void {
	catalogReads.clear();
	navigationReads.clear();
	catalogRefreshes.clear();
	catalogCaches.clear();
	catalogGenerations.clear();
	sessionRefreshes.clear();
}
