/**
 * Generic single-flight, TTL-bounded cache with DB-persisted last-good value
 * and a static fallback. Domain-agnostic on purpose — a later voice feature
 * reuses `createCachedList` for its own catalog, so nothing here may assume
 * "model" or "provider" semantics. The provider-specific wrapper lives below
 * as `createModelCatalog`.
 */
import { createHash } from "node:crypto";
import { posix, win32 } from "node:path";
import * as db from "../db";
import { declaredPathKey } from "../lib/paths";
import type { ProviderCapabilityDiscovery } from "../lib/providerCapabilityTypes";
import type { ProviderInfo } from "../lib/providerTypes";
import type { AgentProvider, ProviderModelInfo } from "./agentProvider";
import {
	buildProviderCapabilitySnapshot,
	isProviderCapabilityDiscovery,
} from "./providerCapabilities";
import { createSlowOperationObserver } from "./requestDiagnostics";

/** Where a `CachedList.get()` result came from. */
export type CatalogSource = "live" | "memory" | "persisted" | "fallback";

export type CachedList<T> = {
	/**
	 * Resolve the cached value. `refresh=true` bypasses the TTL and forces a
	 * fresh fetch attempt (still single-flighted with any in-flight fetch).
	 * Never throws — on total failure resolves with the static fallback.
	 */
	get(refresh?: boolean): Promise<{ value: T; source: CatalogSource }>;
	/** Return memory/persisted/fallback immediately without awaiting discovery. */
	getCached(): Promise<{ value: T; source: CatalogSource }>;
};

const DEFAULT_TTL_MS = 6 * 3600_000;
const DEFAULT_FAILURE_TTL_MS = 60_000;
const PROVIDER_SNAPSHOT_TTL_MS = 60_000;
const MAX_PROVIDER_CAPABILITY_WORKSPACES = 64;
const observeCatalogStep = createSlowOperationObserver({
	scope: "provider catalog",
});

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	return Promise.race([
		promise,
		new Promise<never>((_, reject) => {
			timer = setTimeout(
				() => reject(new Error(`catalog fetch timed out after ${timeoutMs}ms`)),
				timeoutMs,
			);
		}),
	]).finally(() => {
		if (timer !== undefined) clearTimeout(timer);
	});
}

export function createCachedList<T>(opts: {
	/** DB settings key the last-good fetched value is persisted under. */
	persistKey: string;
	/** Time-to-live for the in-memory value. Defaults to 6 hours. */
	ttlMs?: number;
	/** Bound external CLI/network discovery so UI route loaders cannot hang. */
	fetchTimeoutMs?: number;
	/** How long to reuse persisted/fallback data before retrying a failed fetch. */
	failureTtlMs?: number;
	fetcher: () => Promise<T>;
	fallback: T;
	/** Called after a successful live fetch refreshes the in-memory snapshot. */
	onChange?: (value: T) => void;
	/** Guards persisted JSON on read; corrupt/invalid persisted data is ignored. */
	validate?: (v: unknown) => v is T;
}): CachedList<T> {
	const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
	const fetchTimeoutMs = opts.fetchTimeoutMs;
	const failureTtlMs = opts.failureTtlMs ?? DEFAULT_FAILURE_TTL_MS;
	let memory: {
		value: T;
		fetchedAt: number;
		source: CatalogSource;
	} | null = null;
	let inflight: Promise<{ value: T; source: CatalogSource }> | null = null;

	async function readPersisted(): Promise<{ value: T; source: CatalogSource }> {
		try {
			const raw = await db.getSetting(opts.persistKey);
			if (raw != null) {
				const parsed = JSON.parse(raw) as unknown;
				if (!opts.validate || opts.validate(parsed)) {
					return { value: parsed as T, source: "persisted" };
				}
			}
		} catch {
			// Corrupt persisted JSON — ignore and fall through to fallback.
		}
		return { value: opts.fallback, source: "fallback" };
	}

	async function doFetch(): Promise<{ value: T; source: CatalogSource }> {
		try {
			const fetch = opts.fetcher();
			const value = fetchTimeoutMs
				? await withTimeout(fetch, fetchTimeoutMs)
				: await fetch;
			memory = { value, fetchedAt: Date.now(), source: "live" };
			void db
				.saveSetting(opts.persistKey, JSON.stringify(value))
				.catch((e) =>
					console.error(
						`[providerCatalog] saveSetting ${opts.persistKey} failed:`,
						e,
					),
				);
			opts.onChange?.(value);
			return { value, source: "live" };
		} catch {
			if (memory) return { value: memory.value, source: "memory" };
			const fallback = await readPersisted();
			// A failed warm-up used to leave the cache empty, so every Raven loader
			// immediately spawned another inspection process and concurrent tabs all
			// waited on it. Reuse the safe value briefly before a later retry.
			memory = { ...fallback, fetchedAt: Date.now() };
			return fallback;
		}
	}

	return {
		get(refresh = false) {
			const memoryTtl = memory?.source === "live" ? ttlMs : failureTtlMs;
			if (!refresh && memory && Date.now() - memory.fetchedAt < memoryTtl) {
				return Promise.resolve({ value: memory.value, source: "memory" });
			}
			if (inflight) return inflight;
			const p = doFetch().finally(() => {
				inflight = null;
			});
			inflight = p;
			return p;
		},
		getCached() {
			if (memory)
				return Promise.resolve({ value: memory.value, source: "memory" });
			return readPersisted();
		},
	};
}

/** Static-shaped fallback entry for providers without a live listModels(). */
function staticModels(p: AgentProvider): ProviderModelInfo[] {
	return (p.models ?? []).map((m) => ({ value: m.value, label: m.label }));
}

/**
 * Wraps `createCachedList` per-provider for `AgentProvider.listModels`,
 * keyed by `model_catalog:<providerId>` in the settings table.
 */
export function createModelCatalog(
	providers: Map<string, AgentProvider>,
	onChange?: (providerId: string) => void,
): {
	modelsFor(p: AgentProvider, refresh?: boolean): Promise<ProviderModelInfo[]>;
	cachedModelsFor(p: AgentProvider): Promise<ProviderModelInfo[]>;
	register(p: AgentProvider): void;
	/** Fire-and-forget warm-up of every provider's cache; never rejects. */
	warm(): void;
} {
	const caches = new Map<string, CachedList<ProviderModelInfo[]>>();
	const register = (p: AgentProvider) => {
		if (!p.listModels) return;
		const listModels = p.listModels.bind(p);
		caches.set(
			p.providerId,
			createCachedList<ProviderModelInfo[]>({
				persistKey: `model_catalog:${p.providerId}`,
				fetcher: () => listModels(),
				fallback: staticModels(p),
				fetchTimeoutMs: 12_000,
				onChange: () => onChange?.(p.providerId),
			}),
		);
	};
	for (const p of providers.values()) register(p);

	return {
		register,
		async modelsFor(p, refresh) {
			const cache = caches.get(p.providerId);
			if (!cache) return staticModels(p);
			const { value } = await cache.get(refresh);
			return value;
		},
		async cachedModelsFor(p) {
			const cache = caches.get(p.providerId);
			if (!cache) return staticModels(p);
			const { value } = await cache.getCached();
			// Refresh stale/missing discovery in the background. Navigation gets the
			// last safe value instead of waiting on an external CLI inspection.
			void cache.get().catch(() => {});
			return value;
		},
		warm() {
			for (const cache of caches.values()) {
				void cache.get().catch(() => {});
			}
		},
	};
}

export type ProviderCapabilityDiscoveryRead = {
	discovery: ProviderCapabilityDiscovery;
	source: CatalogSource;
};

/**
 * Cache provider-described capability evidence separately from the assembled
 * provider response. Normal route loaders receive last-good evidence and start
 * revalidation in the background; explicit refreshes perform bounded live
 * discovery.
 */
export function createProviderCapabilityCatalog(
	providers: Map<string, AgentProvider>,
	defaultDiscoveryCwd: string,
	onChange?: (providerId: string) => void,
): {
	capabilitiesFor(
		provider: AgentProvider,
		discoveryCwd?: string,
		refresh?: boolean,
	): Promise<ProviderCapabilityDiscoveryRead | undefined>;
	cachedCapabilitiesFor(
		provider: AgentProvider,
		discoveryCwd?: string,
	): Promise<ProviderCapabilityDiscoveryRead | undefined>;
	register(provider: AgentProvider): void;
	warm(): void;
} {
	type CapabilityCache = {
		providerId: string;
		cache: CachedList<ProviderCapabilityDiscovery>;
	};
	const registered = new Map(providers);
	const caches = new Map<string, CapabilityCache>();
	const workspaceKey = (providerId: string, cwd: string) =>
		`${providerId}\0${declaredPathKey(cwd)}`;
	const cacheFor = (
		provider: AgentProvider,
		discoveryCwd = defaultDiscoveryCwd,
	): CachedList<ProviderCapabilityDiscovery> | undefined => {
		if (!provider.discoverCapabilities) return undefined;
		const cwd = discoveryCwd.trim() || defaultDiscoveryCwd;
		const key = workspaceKey(provider.providerId, cwd);
		const existing = caches.get(key);
		if (existing) return existing.cache;
		if (caches.size >= MAX_PROVIDER_CAPABILITY_WORKSPACES) {
			const oldest = caches.keys().next().value;
			if (oldest !== undefined) caches.delete(oldest);
		}
		const discover = provider.discoverCapabilities.bind(provider);
		const workspaceHash = createHash("sha256")
			.update(declaredPathKey(cwd))
			.digest("hex")
			.slice(0, 16);
		const cache = createCachedList<ProviderCapabilityDiscovery>({
			persistKey: `provider_capabilities:${encodeURIComponent(provider.providerId)}:${workspaceHash}`,
			fetcher: () => discover({ cwd }),
			fallback: {
				observedAt: 0,
				evidence: [],
				issues: ["No provider capability discovery snapshot is cached yet."],
			},
			fetchTimeoutMs: 12_000,
			ttlMs: 60_000,
			failureTtlMs: 15_000,
			validate: isProviderCapabilityDiscovery,
			onChange: () => onChange?.(provider.providerId),
		});
		caches.set(key, { providerId: provider.providerId, cache });
		return cache;
	};
	const register = (provider: AgentProvider) => {
		registered.set(provider.providerId, provider);
		for (const [key, value] of caches) {
			if (value.providerId === provider.providerId) caches.delete(key);
		}
	};

	return {
		register,
		async capabilitiesFor(provider, discoveryCwd, refresh) {
			const cache = cacheFor(provider, discoveryCwd);
			if (!cache) return undefined;
			const result = await cache.get(refresh);
			return { discovery: result.value, source: result.source };
		},
		async cachedCapabilitiesFor(provider, discoveryCwd) {
			const cache = cacheFor(provider, discoveryCwd);
			if (!cache) return undefined;
			const result = await cache.getCached();
			void cache.get().catch(() => {});
			return { discovery: result.value, source: result.source };
		},
		warm() {
			for (const provider of registered.values()) {
				const cache = cacheFor(provider, defaultDiscoveryCwd);
				if (cache) void cache.get().catch(() => {});
			}
		},
	};
}

type ProviderCatalogSources = {
	modelsFor(
		provider: AgentProvider,
		refresh?: boolean,
	): Promise<ProviderModelInfo[]>;
	cachedModelsFor?(provider: AgentProvider): Promise<ProviderModelInfo[]>;
	capabilitiesFor?(
		provider: AgentProvider,
		discoveryCwd: string,
		refresh?: boolean,
	): Promise<ProviderCapabilityDiscoveryRead | undefined>;
	cachedCapabilitiesFor?(
		provider: AgentProvider,
		discoveryCwd: string,
	): Promise<ProviderCapabilityDiscoveryRead | undefined>;
};

/**
 * Build the UI provider catalog without probing host-only capabilities unless
 * the requesting surface explicitly needs them. Capability probes can involve
 * live provider RPCs and must not block unrelated route loaders.
 */
export async function loadProviderCatalog(
	providers: Iterable<AgentProvider>,
	catalog: ProviderCatalogSources,
	options: {
		refresh?: boolean;
		includeHostCapabilities?: boolean;
		includeProviderCapabilities?: boolean;
		preferCachedModels?: boolean;
		preferCachedProviderCapabilities?: boolean;
		discoveryCwd?: string;
	} = {},
): Promise<ProviderInfo[]> {
	return Promise.all(
		[...providers].map(async (provider) => {
			const discoveryCwd = options.discoveryCwd ?? process.cwd();
			const check = provider.check
				? await observeCatalogStep(
						`check:${provider.providerId}`,
						`${provider.providerId} availability check`,
						() =>
							provider
								.check?.()
								.catch(() => ({ available: false, reason: "check failed" })),
					)
				: null;
			const providerRefresh =
				options.refresh === true && check?.available !== false;
			const [models, hostCapabilities, forkCapability, capabilityDiscovery] =
				await Promise.all([
					observeCatalogStep(
						`models:${provider.providerId}`,
						`${provider.providerId} model snapshot`,
						() =>
							options.preferCachedModels && catalog.cachedModelsFor
								? catalog.cachedModelsFor(provider)
								: catalog.modelsFor(provider, providerRefresh),
					),
					options.includeHostCapabilities && provider.hostCapabilities
						? observeCatalogStep(
								`capabilities:${provider.providerId}`,
								`${provider.providerId} host-capability snapshot`,
								() => provider.hostCapabilities?.().catch(() => ({})),
							)
						: undefined,
					provider.resolveForkCapability && check?.available !== false
						? observeCatalogStep(
								`fork:${provider.providerId}`,
								`${provider.providerId} fork-capability negotiation`,
								() => provider.resolveForkCapability?.().catch(() => undefined),
							)
						: provider.forkCapability,
					options.includeProviderCapabilities && check?.available !== false
						? observeCatalogStep(
								`provider-capabilities:${provider.providerId}`,
								`${provider.providerId} provider-capability snapshot`,
								async () => {
									if (
										!options.refresh &&
										options.preferCachedProviderCapabilities !== false &&
										catalog.cachedCapabilitiesFor
									) {
										return catalog.cachedCapabilitiesFor(
											provider,
											discoveryCwd,
										);
									}
									if (catalog.capabilitiesFor) {
										return catalog.capabilitiesFor(
											provider,
											discoveryCwd,
											options.refresh,
										);
									}
									if (!provider.discoverCapabilities) return undefined;
									try {
										return {
											discovery: await provider.discoverCapabilities({
												cwd: discoveryCwd,
											}),
											source: "live" as const,
										};
									} catch (error) {
										return {
											discovery: {
												observedAt: Date.now(),
												evidence: [],
												issues: [
													`Provider capability discovery failed: ${
														error instanceof Error
															? error.message
															: String(error)
													}`,
												],
											},
											source: "fallback" as const,
										};
									}
								},
							)
						: undefined,
				]);
			const capabilitySnapshot = options.includeProviderCapabilities
				? buildProviderCapabilitySnapshot({
						providerId: provider.providerId,
						providerAvailable: check?.available ?? true,
						providerUnavailableReason:
							check?.available === false ? check.reason : undefined,
						capabilities: provider.capabilities,
						forkCapability,
						models,
						permissionModes: provider.permissionModes,
						discovery: capabilityDiscovery?.discovery,
						discoverySource: capabilityDiscovery?.source,
						discoveryCwd,
					})
				: undefined;
			return {
				id: provider.providerId,
				label: provider.label ?? provider.providerId,
				available: check?.available ?? true,
				unavailableReason:
					check?.available === false ? check.reason : undefined,
				models,
				effortLevels: provider.effortLevels
					? [...provider.effortLevels]
					: undefined,
				permissionModes: provider.permissionModes
					? [...provider.permissionModes]
					: undefined,
				...(provider.capabilities
					? {
							capabilities: {
								...provider.capabilities,
								structuredActivities:
									provider.capabilities.structuredActivities?.slice(),
							},
						}
					: {}),
				forkCapability,
				hostCapabilities,
				...(capabilitySnapshot ? { capabilitySnapshot } : {}),
			};
		}),
	);
}

type ProviderCatalogLoadOptions = NonNullable<
	Parameters<typeof loadProviderCatalog>[2]
>;

export type ProviderCatalogSnapshot = {
	get(options?: ProviderCatalogLoadOptions): Promise<ProviderInfo[]>;
	invalidate(): void;
};

/**
 * Cache the fully assembled provider response, not just each provider's model
 * list. Normal UI reads become an in-memory snapshot while stale availability,
 * model, and host-capability data revalidates in the background.
 */
export function createProviderCatalogSnapshot(
	providers: Iterable<AgentProvider> | (() => Iterable<AgentProvider>),
	catalog: Parameters<typeof loadProviderCatalog>[1],
	options: {
		ttlMs?: number;
		now?: () => number;
		load?: typeof loadProviderCatalog;
		discoveryCwd?: string;
	} = {},
): ProviderCatalogSnapshot {
	const providerList = () => [
		...(typeof providers === "function" ? providers() : providers),
	];
	const ttlMs = options.ttlMs ?? PROVIDER_SNAPSHOT_TTL_MS;
	const now = options.now ?? Date.now;
	const load = options.load ?? loadProviderCatalog;
	const snapshots = new Map<
		string,
		{ value: ProviderInfo[]; refreshedAt: number }
	>();
	const inflight = new Map<string, Promise<ProviderInfo[]>>();
	let generation = 0;
	const keyFor = (
		includeHostCapabilities: boolean,
		includeProviderCapabilities: boolean,
		discoveryCwd: string,
	) =>
		`${includeHostCapabilities ? "host" : "base"}:${
			includeProviderCapabilities ? "provider" : "static"
		}${includeProviderCapabilities ? `:${declaredPathKey(discoveryCwd)}` : ""}`;
	const effectiveDiscoveryCwd = (loadOptions: ProviderCatalogLoadOptions) =>
		loadOptions.discoveryCwd ?? options.discoveryCwd ?? process.cwd();

	function store(
		includeHostCapabilities: boolean,
		includeProviderCapabilities: boolean,
		discoveryCwd: string,
		value: ProviderInfo[],
	): ProviderInfo[] {
		const refreshedAt = now();
		for (const withHost of [false, true]) {
			if (withHost && !includeHostCapabilities) continue;
			for (const withProvider of [false, true]) {
				if (withProvider && !includeProviderCapabilities) continue;
				const projected =
					withHost === includeHostCapabilities &&
					withProvider === includeProviderCapabilities
						? value
						: value.map((provider) => {
								const {
									hostCapabilities,
									capabilitySnapshot,
									...baseProvider
								} = provider;
								return {
									...baseProvider,
									...(withHost && hostCapabilities ? { hostCapabilities } : {}),
									...(withProvider && capabilitySnapshot
										? { capabilitySnapshot }
										: {}),
								};
							});
				snapshots.set(keyFor(withHost, withProvider, discoveryCwd), {
					value: projected,
					refreshedAt,
				});
			}
		}
		return value;
	}

	function refresh(
		loadOptions: ProviderCatalogLoadOptions,
	): Promise<ProviderInfo[]> {
		const includeHostCapabilities =
			loadOptions?.includeHostCapabilities === true;
		const includeProviderCapabilities =
			loadOptions?.includeProviderCapabilities === true;
		const discoveryCwd = effectiveDiscoveryCwd(loadOptions);
		const snapshotKey = keyFor(
			includeHostCapabilities,
			includeProviderCapabilities,
			discoveryCwd,
		);
		const flightKey = `${snapshotKey}:${loadOptions?.refresh ? "live" : "cached"}:${
			loadOptions.preferCachedProviderCapabilities === false
				? "await-provider"
				: "cached-provider"
		}`;
		const current = inflight.get(flightKey);
		if (current) return current;
		const refreshGeneration = generation;
		const pending = load(providerList(), catalog, {
			...loadOptions,
			discoveryCwd,
		})
			.then((value) =>
				refreshGeneration === generation
					? store(
							includeHostCapabilities,
							includeProviderCapabilities,
							discoveryCwd,
							value,
						)
					: value,
			)
			.finally(() => inflight.delete(flightKey));
		inflight.set(flightKey, pending);
		return pending;
	}

	return {
		get(loadOptions = {}) {
			if (loadOptions.refresh) return refresh(loadOptions);
			const includeHostCapabilities =
				loadOptions.includeHostCapabilities === true;
			const includeProviderCapabilities =
				loadOptions.includeProviderCapabilities === true;
			const discoveryCwd = effectiveDiscoveryCwd(loadOptions);
			const snapshot = snapshots.get(
				keyFor(
					includeHostCapabilities,
					includeProviderCapabilities,
					discoveryCwd,
				),
			);
			const cachedOptions = {
				...loadOptions,
				refresh: false,
				preferCachedModels: true,
			};
			if (!snapshot) return refresh(cachedOptions);
			if (now() - snapshot.refreshedAt >= ttlMs) {
				void refresh(cachedOptions).catch(() => {});
			}
			return Promise.resolve(snapshot.value);
		},
		invalidate() {
			generation += 1;
			snapshots.clear();
		},
	};
}

/**
 * Normal UI reads are stale-while-revalidate: return the server's last-good
 * model snapshot immediately and let `cachedModelsFor()` refresh stale data in
 * the background. Only an explicit refresh may block on live provider/CLI
 * discovery. This keeps every browser and PWA a view over the same server-owned
 * cache instead of letting route navigation start host probes of its own.
 */
export function providerCatalogRequestOptions(searchParams: URLSearchParams): {
	refresh: boolean;
	preferCachedModels: boolean;
	preferCachedProviderCapabilities: boolean;
	includeHostCapabilities: boolean;
	includeProviderCapabilities: boolean;
	discoveryCwd?: string;
} {
	const refresh = searchParams.get("refresh") === "1";
	const rawDiscoveryCwd = searchParams.get("capability_cwd");
	const discoveryCwd = rawDiscoveryCwd?.trim();
	if (
		rawDiscoveryCwd !== null &&
		(!discoveryCwd ||
			discoveryCwd.length > 4_096 ||
			(!posix.isAbsolute(discoveryCwd) && !win32.isAbsolute(discoveryCwd)))
	) {
		throw new Error(
			"capability_cwd must be an absolute path up to 4096 characters",
		);
	}
	return {
		refresh,
		preferCachedModels: !refresh,
		preferCachedProviderCapabilities:
			searchParams.get("provider_capabilities_wait") !== "1",
		includeHostCapabilities: searchParams.get("host_capabilities") === "1",
		includeProviderCapabilities:
			searchParams.get("provider_capabilities") === "1",
		...(discoveryCwd ? { discoveryCwd } : {}),
	};
}
