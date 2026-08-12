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
import type {
	AgentProvider,
	ProviderForkCapability,
	ProviderModelInfo,
} from "./agentProvider";
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
	/** Retire this cache so an obsolete in-flight fetch cannot publish stale data. */
	dispose(): void;
};

const DEFAULT_TTL_MS = 6 * 3600_000;
const DEFAULT_FAILURE_TTL_MS = 60_000;
const PROVIDER_SNAPSHOT_TTL_MS = 60_000;
const PROVIDER_LIVE_DISCOVERY_TIMEOUT_MS = 12_000;
const MAX_PROVIDER_MODEL_WORKSPACES = 64;
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
	/** Skip persisted data when this cache represents a changed runtime identity. */
	allowPersistedFallback?: boolean;
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
	let disposed = false;

	async function readPersisted(): Promise<{ value: T; source: CatalogSource }> {
		if (opts.allowPersistedFallback === false) {
			return { value: opts.fallback, source: "fallback" };
		}
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
			if (disposed) return { value, source: "live" };
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
			if (!disposed) memory = { ...fallback, fetchedAt: Date.now() };
			return fallback;
		}
	}

	function getValue(
		refresh = false,
	): Promise<{ value: T; source: CatalogSource }> {
		const memoryTtl = memory?.source === "live" ? ttlMs : failureTtlMs;
		if (!refresh && memory && Date.now() - memory.fetchedAt < memoryTtl) {
			return Promise.resolve({ value: memory.value, source: "memory" });
		}
		if (inflight) return inflight;
		const pending = doFetch().finally(() => {
			inflight = null;
		});
		inflight = pending;
		return pending;
	}

	return {
		get(refresh = false) {
			return getValue(refresh);
		},
		getCached() {
			if (memory)
				return Promise.resolve({ value: memory.value, source: "memory" });
			return readPersisted();
		},
		dispose() {
			disposed = true;
			memory = null;
		},
	};
}

/** Static-shaped fallback entry for providers without a live listModels(). */
function staticModels(p: AgentProvider): ProviderModelInfo[] {
	return (p.models ?? []).map((m) => ({ value: m.value, label: m.label }));
}

function metadataIdentityHash(provider: AgentProvider): string | undefined {
	const identity = provider.metadataCacheIdentity?.trim();
	if (!identity) return undefined;
	return createHash("sha256").update(identity).digest("hex").slice(0, 16);
}

function workspaceHash(cwd: string): string {
	return createHash("sha256")
		.update(declaredPathKey(cwd))
		.digest("hex")
		.slice(0, 16);
}

function modelCatalogPersistKey(provider: AgentProvider, cwd: string): string {
	const identity = metadataIdentityHash(provider);
	const workspace =
		provider.modelCatalogScope === "workspace" ? workspaceHash(cwd) : undefined;
	if (!identity && !workspace) return `model_catalog:${provider.providerId}`;
	return [
		"model_catalog",
		encodeURIComponent(provider.providerId),
		identity ?? "default-runtime",
		...(workspace ? [workspace] : []),
	].join(":");
}

/**
 * Wraps `createCachedList` per-provider for `AgentProvider.listModels`,
 * keyed by `model_catalog:<providerId>` in the settings table.
 */
export function createModelCatalog(
	providers: Map<string, AgentProvider>,
	onChange?: (providerId: string) => void,
): {
	modelsFor(
		p: AgentProvider,
		refresh?: boolean,
		discoveryCwd?: string,
	): Promise<ProviderModelInfo[]>;
	/** Force one bounded fetch while preserving the source when fallback is used. */
	refreshModelsFor(
		p: AgentProvider,
		discoveryCwd?: string,
	): Promise<ProviderModelCatalogRead>;
	cachedModelsFor(
		p: AgentProvider,
		discoveryCwd?: string,
	): Promise<ProviderModelInfo[]>;
	register(p: AgentProvider, options?: { refreshIdentity?: boolean }): void;
	/** Fire-and-forget warm-up of every provider's cache; never rejects. */
	warm(): void;
} {
	type ModelCache = {
		providerId: string;
		cache: CachedList<ProviderModelInfo[]>;
	};
	const registered = new Map(providers);
	const caches = new Map<string, ModelCache>();
	const refreshedIdentities = new Set<string>();
	const cacheFor = (
		p: AgentProvider,
		discoveryCwd = process.cwd(),
	): CachedList<ProviderModelInfo[]> | undefined => {
		if (!p.listModels) return undefined;
		const cwd = discoveryCwd.trim() || process.cwd();
		const cacheKey =
			p.modelCatalogScope === "workspace"
				? `${p.providerId}\0${declaredPathKey(cwd)}`
				: p.providerId;
		const existing = caches.get(cacheKey);
		if (existing) return existing.cache;
		if (caches.size >= MAX_PROVIDER_MODEL_WORKSPACES) {
			const oldest = caches.keys().next().value;
			if (oldest !== undefined) {
				caches.get(oldest)?.cache.dispose();
				caches.delete(oldest);
			}
		}
		const listModels = p.listModels.bind(p);
		const cache = createCachedList<ProviderModelInfo[]>({
			persistKey: modelCatalogPersistKey(p, cwd),
			fetcher: () =>
				listModels(p.modelCatalogScope === "workspace" ? { cwd } : undefined),
			fallback: staticModels(p),
			fetchTimeoutMs: 12_000,
			allowPersistedFallback: !refreshedIdentities.has(p.providerId),
			onChange: () => onChange?.(p.providerId),
		});
		caches.set(cacheKey, { providerId: p.providerId, cache });
		return cache;
	};
	const register = (
		p: AgentProvider,
		options: { refreshIdentity?: boolean } = {},
	) => {
		registered.set(p.providerId, p);
		if (options.refreshIdentity) refreshedIdentities.add(p.providerId);
		else refreshedIdentities.delete(p.providerId);
		for (const [key, value] of caches) {
			if (value.providerId !== p.providerId) continue;
			value.cache.dispose();
			caches.delete(key);
		}
	};
	for (const p of providers.values()) register(p);
	const modelReadFor = async (
		p: AgentProvider,
		refresh = false,
		discoveryCwd?: string,
	): Promise<ProviderModelCatalogRead> => {
		const cache = cacheFor(p, discoveryCwd);
		if (!cache) return { models: staticModels(p), source: "live" };
		const { value, source } = await cache.get(refresh);
		return {
			models: value,
			source,
			...(source === "live"
				? {}
				: { reason: "Live model discovery did not return current options" }),
		};
	};

	return {
		register,
		async modelsFor(p, refresh, discoveryCwd) {
			return (await modelReadFor(p, refresh, discoveryCwd)).models;
		},
		refreshModelsFor(p, discoveryCwd) {
			return modelReadFor(p, true, discoveryCwd);
		},
		async cachedModelsFor(p, discoveryCwd) {
			const cache = cacheFor(p, discoveryCwd);
			if (!cache) return staticModels(p);
			const { value } = await cache.getCached();
			return value;
		},
		warm() {
			for (const provider of registered.values()) {
				const cache = cacheFor(provider);
				if (cache) void cache.get().catch(() => {});
			}
		},
	};
}

export type ProviderModelCatalogRead = {
	models: ProviderModelInfo[];
	source: CatalogSource;
	reason?: string;
};

export type ProviderCapabilityDiscoveryRead = {
	discovery: ProviderCapabilityDiscovery;
	source: CatalogSource;
};

/**
 * Cache provider-described capability evidence separately from the assembled
 * provider response. Normal route loaders receive last-good evidence without
 * starting provider work; explicit live reads perform bounded discovery.
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
	register(
		provider: AgentProvider,
		options?: { refreshIdentity?: boolean },
	): void;
	warm(): void;
} {
	type CapabilityCache = {
		providerId: string;
		cache: CachedList<ProviderCapabilityDiscovery>;
	};
	const registered = new Map(providers);
	const caches = new Map<string, CapabilityCache>();
	const refreshedIdentities = new Set<string>();
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
			if (oldest !== undefined) {
				caches.get(oldest)?.cache.dispose();
				caches.delete(oldest);
			}
		}
		const discover = provider.discoverCapabilities.bind(provider);
		const identity = metadataIdentityHash(provider);
		const persistenceKey = [
			"provider_capabilities",
			encodeURIComponent(provider.providerId),
			...(identity ? [identity] : []),
			workspaceHash(cwd),
		].join(":");
		const cache = createCachedList<ProviderCapabilityDiscovery>({
			persistKey: persistenceKey,
			fetcher: () => discover({ cwd }),
			fallback: {
				observedAt: 0,
				evidence: [],
				issues: ["No provider capability discovery snapshot is cached yet."],
			},
			fetchTimeoutMs: 12_000,
			ttlMs: 60_000,
			failureTtlMs: 15_000,
			allowPersistedFallback: !refreshedIdentities.has(provider.providerId),
			validate: isProviderCapabilityDiscovery,
			onChange: () => onChange?.(provider.providerId),
		});
		caches.set(key, { providerId: provider.providerId, cache });
		return cache;
	};
	const register = (
		provider: AgentProvider,
		options: { refreshIdentity?: boolean } = {},
	) => {
		registered.set(provider.providerId, provider);
		if (options.refreshIdentity) refreshedIdentities.add(provider.providerId);
		else refreshedIdentities.delete(provider.providerId);
		for (const [key, value] of caches) {
			if (value.providerId !== provider.providerId) continue;
			value.cache.dispose();
			caches.delete(key);
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
		discoveryCwd?: string,
	): Promise<ProviderModelInfo[]>;
	refreshModelsFor?(
		provider: AgentProvider,
		discoveryCwd?: string,
	): Promise<ProviderModelCatalogRead>;
	cachedModelsFor?(
		provider: AgentProvider,
		discoveryCwd?: string,
	): Promise<ProviderModelInfo[]>;
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

function modelRefreshState(
	read: ProviderModelCatalogRead,
): NonNullable<ProviderInfo["modelCatalogRefresh"]> {
	return {
		status:
			read.source === "live"
				? "current"
				: read.source === "fallback"
					? "unavailable"
					: "stale",
		source: read.source,
		...(read.reason ? { reason: read.reason } : {}),
	};
}

function boundedProviderDiscovery<T>(
	signature: string,
	label: string,
	operation: () => Promise<T> | T,
	fallback: T,
): Promise<T> {
	return observeCatalogStep(signature, label, () =>
		withTimeout(
			Promise.resolve().then(operation),
			PROVIDER_LIVE_DISCOVERY_TIMEOUT_MS,
		).catch(() => fallback),
	);
}

/**
 * Build the UI provider catalog. Ordinary reads are process-free and use only
 * static or persisted metadata. Explicit refreshes may call provider checks,
 * model discovery, or fork negotiation; an explicit uncached capability read
 * may call the availability check and provider capability probe.
 */
export async function loadProviderCatalog(
	providers: Iterable<AgentProvider>,
	catalog: ProviderCatalogSources,
	options: {
		refresh?: boolean;
		/** Limit explicit live discovery to one provider while returning the full catalog. */
		refreshProviderId?: string;
		includeHostCapabilities?: boolean;
		/** Await host-only readiness without refreshing models or provider capabilities. */
		awaitHostCapabilities?: boolean;
		includeProviderCapabilities?: boolean;
		preferCachedModels?: boolean;
		preferCachedProviderCapabilities?: boolean;
		/** Last accepted negotiated forks used to build coherent capability evidence. */
		providerCapabilityForkOverrides?: ReadonlyMap<
			string,
			ProviderForkCapability
		>;
		discoveryCwd?: string;
	} = {},
): Promise<ProviderInfo[]> {
	return Promise.all(
		[...providers].map(async (provider) => {
			const discoveryCwd = options.discoveryCwd ?? process.cwd();
			const refreshModelsFor = catalog.refreshModelsFor;
			const liveRefresh =
				options.refresh === true &&
				(!options.refreshProviderId ||
					options.refreshProviderId === provider.providerId);
			// `provider_capabilities_wait=1` is an explicit capability-only live
			// contract used by Hlid tooling. Route reads keep this preference cached.
			const liveProviderCapabilityRead =
				options.includeProviderCapabilities === true &&
				options.preferCachedProviderCapabilities === false &&
				(!options.refreshProviderId ||
					options.refreshProviderId === provider.providerId);
			const liveHostCapabilityRead =
				options.includeHostCapabilities === true &&
				options.awaitHostCapabilities === true;
			const cachedAvailability = provider.cachedAvailability?.();
			const declaredForkCapability =
				options.providerCapabilityForkOverrides?.get(provider.providerId) ??
				provider.forkCapability;
			const check: { available: boolean; reason?: string } | null =
				(liveRefresh || liveProviderCapabilityRead) && provider.check
					? await boundedProviderDiscovery(
							`check:${provider.providerId}`,
							`${provider.providerId} availability check`,
							() => provider.check?.() ?? { available: true },
							{ available: false, reason: "check failed" },
						)
					: (cachedAvailability ?? null);
			const providerAvailable = check?.available !== false;
			const [modelRead, hostCapabilities, forkCapability, capabilityDiscovery] =
				await Promise.all([
					liveRefresh && providerAvailable
						? refreshModelsFor
							? observeCatalogStep(
									`models:${provider.providerId}`,
									`${provider.providerId} model discovery`,
									() => refreshModelsFor(provider, discoveryCwd),
								)
							: boundedProviderDiscovery<ProviderModelCatalogRead>(
									`models:${provider.providerId}`,
									`${provider.providerId} model discovery`,
									async () => ({
										models: await catalog.modelsFor(
											provider,
											true,
											discoveryCwd,
										),
										source: "live",
									}),
									{
										models: staticModels(provider),
										source: "fallback",
										reason: "Model discovery failed or timed out",
									},
								)
						: catalog.cachedModelsFor
							? observeCatalogStep(
									`models:${provider.providerId}`,
									`${provider.providerId} cached model snapshot`,
									async () => ({
										models: await (catalog.cachedModelsFor?.(
											provider,
											discoveryCwd,
										) ?? []),
										source: "memory" as const,
									}),
								)
							: {
									models: staticModels(provider),
									source: "fallback" as const,
								},
					(liveRefresh || liveHostCapabilityRead) &&
					options.includeHostCapabilities &&
					provider.hostCapabilities &&
					providerAvailable
						? boundedProviderDiscovery(
								`capabilities:${provider.providerId}`,
								`${provider.providerId} host-capability discovery`,
								() => provider.hostCapabilities?.() ?? {},
								{},
							)
						: undefined,
					liveRefresh && provider.resolveForkCapability && providerAvailable
						? boundedProviderDiscovery(
								`fork:${provider.providerId}`,
								`${provider.providerId} fork-capability negotiation`,
								() => provider.resolveForkCapability?.(),
								declaredForkCapability,
							).then((resolved) => resolved ?? declaredForkCapability)
						: declaredForkCapability,
					options.includeProviderCapabilities && providerAvailable
						? observeCatalogStep(
								`provider-capabilities:${provider.providerId}`,
								`${provider.providerId} provider-capability snapshot`,
								async () => {
									if (!liveRefresh && !liveProviderCapabilityRead) {
										if (!catalog.cachedCapabilitiesFor) return undefined;
										return catalog.cachedCapabilitiesFor(
											provider,
											discoveryCwd,
										);
									}
									if (catalog.capabilitiesFor) {
										return boundedProviderDiscovery(
											`provider-capabilities-live:${provider.providerId}`,
											`${provider.providerId} provider-capability discovery`,
											() =>
												catalog.capabilitiesFor?.(provider, discoveryCwd, true),
											undefined,
										);
									}
									if (!provider.discoverCapabilities) return undefined;
									const discoverCapabilities =
										provider.discoverCapabilities.bind(provider);
									return boundedProviderDiscovery<ProviderCapabilityDiscoveryRead>(
										`provider-capabilities-live:${provider.providerId}`,
										`${provider.providerId} provider-capability discovery`,
										async () => ({
											discovery: await discoverCapabilities({
												cwd: discoveryCwd,
											}),
											source: "live" as const,
										}),
										{
											discovery: {
												observedAt: Date.now(),
												evidence: [],
												issues: ["Provider capability discovery failed"],
											},
											source: "fallback" as const,
										},
									);
								},
							)
						: undefined,
				]);
			const models = modelRead.models;
			const modelCatalogRefresh =
				liveRefresh && options.refreshProviderId
					? providerAvailable
						? modelRefreshState(modelRead)
						: {
								status: "unavailable" as const,
								source: "fallback" as const,
								reason: check?.reason ?? "Provider is unavailable",
							}
					: undefined;
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
			const permissionProfiles = options.includeProviderCapabilities
				? capabilityDiscovery?.discovery.permissionProfiles?.map((profile) => ({
						id: profile.id,
						label: profile.id,
						...(profile.description
							? { description: profile.description }
							: {}),
						allowed: profile.allowed,
					}))
				: undefined;
			return {
				id: provider.providerId,
				label: provider.label ?? provider.providerId,
				available: check?.available ?? true,
				unavailableReason:
					check?.available === false ? check.reason : undefined,
				models,
				...(modelCatalogRefresh ? { modelCatalogRefresh } : {}),
				effortLevels: provider.effortLevels
					? [...provider.effortLevels]
					: undefined,
				permissionModes: provider.permissionModes
					? [...provider.permissionModes]
					: undefined,
				sessionPermissionModes: provider.sessionPermissionModes
					? [...provider.sessionPermissionModes]
					: undefined,
				approvalReviewers: provider.approvalReviewers
					? [...provider.approvalReviewers]
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
				...(permissionProfiles ? { permissionProfiles } : {}),
			};
		}),
	);
}

type ProviderCatalogLoadOptions = NonNullable<
	Parameters<typeof loadProviderCatalog>[2]
>;

type ProviderCatalogVersion = {
	generation: number;
	metadataVersion: number | string | null;
	metadataExclusions?: string[];
	liveRefreshScopes?: string[];
	liveRefreshVersion?: string;
	acceptedLiveRefreshVersion?: string;
};

type VersionedProviderCatalogRead = {
	providers: ProviderInfo[];
	version: ProviderCatalogVersion;
};

function isLiveProviderCapabilityRead(
	loadOptions: ProviderCatalogLoadOptions,
): boolean {
	return (
		loadOptions.refresh !== true &&
		loadOptions.includeProviderCapabilities === true &&
		loadOptions.preferCachedProviderCapabilities === false
	);
}

export type ProviderCatalogSnapshot = {
	get(options?: ProviderCatalogLoadOptions): Promise<ProviderInfo[]>;
	/** Resolve against one runtime generation, retrying an invalidated read. */
	getVersioned(options?: ProviderCatalogLoadOptions): Promise<{
		providers: ProviderInfo[];
		version: ProviderCatalogVersion;
	}>;
	isCurrentVersion(version: ProviderCatalogVersion): boolean;
	/** Invalidate derived metadata without superseding the live read producing it. */
	invalidateMetadata(providerId?: string): void;
	invalidate(): void;
};

/**
 * Cache the fully assembled provider response, not just each provider's model
 * list. Normal UI reads become an in-memory snapshot while stale snapshots are
 * re-materialized from process-free cached sources in the background.
 */
export function createProviderCatalogSnapshot(
	providers: Iterable<AgentProvider> | (() => Iterable<AgentProvider>),
	catalog: Parameters<typeof loadProviderCatalog>[1],
	options: {
		ttlMs?: number;
		now?: () => number;
		load?: typeof loadProviderCatalog;
		discoveryCwd?: string | (() => string);
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
	const versionedCapabilityInflight = new Map<
		string,
		Promise<VersionedProviderCatalogRead>
	>();
	const versionedCapabilityTails = new Map<string, Promise<void>>();
	const supersededReads = new WeakSet<ProviderInfo[]>();
	let generation = 0;
	let metadataGeneration = 0;
	let unscopedMetadataGeneration = 0;
	const providerMetadataGenerations = new Map<string, number>();
	let nextLiveRefresh = 0;
	let nextCachedRefresh = 0;
	const latestLiveRefresh = new Map<string, number>();
	const latestCachedRefresh = new Map<string, number>();
	const activeLiveRefreshes = new Map<string, Set<number>>();
	const liveRefreshStarts = new Map<string, number>();
	const acceptedLiveRefreshes = new Map<string, number>();
	const lastKnownLiveFields = new Map<string, ProviderInfo[]>();
	const keyFor = (
		includeHostCapabilities: boolean,
		includeProviderCapabilities: boolean,
		discoveryCwd: string,
	) =>
		`${includeHostCapabilities ? "host" : "base"}:${
			includeProviderCapabilities ? "provider" : "static"
		}:${declaredPathKey(discoveryCwd)}`;
	const effectiveDiscoveryCwd = (loadOptions: ProviderCatalogLoadOptions) =>
		loadOptions.discoveryCwd ??
		(typeof options.discoveryCwd === "function"
			? options.discoveryCwd()
			: options.discoveryCwd) ??
		process.cwd();
	const metadataVersionExcept = (providerIds: ReadonlySet<string>): string =>
		JSON.stringify({
			unscoped: unscopedMetadataGeneration,
			providers: [...providerMetadataGenerations]
				.filter(([candidate]) => !providerIds.has(candidate))
				.sort(([a], [b]) => a.localeCompare(b)),
		});
	const liveRefreshScopeKey = (
		discoveryCwd: string,
		providerId: string | undefined,
	) => `${declaredPathKey(discoveryCwd)}:${providerId ?? "all-providers"}`;
	const liveRefreshDependencies = (
		loadOptions: ProviderCatalogLoadOptions,
	): string[] => {
		const discoveryCwd = effectiveDiscoveryCwd(loadOptions);
		const providerIds = loadOptions.refreshProviderId
			? [loadOptions.refreshProviderId]
			: providerList().map((provider) => provider.providerId);
		return [
			liveRefreshScopeKey(discoveryCwd, undefined),
			...providerIds.map((providerId) =>
				liveRefreshScopeKey(discoveryCwd, providerId),
			),
		].sort();
	};
	const liveRefreshVersionForScopes = (
		versions: ReadonlyMap<string, number>,
		scopes: readonly string[],
	): string =>
		JSON.stringify(scopes.map((key) => [key, versions.get(key) ?? 0]));
	const versionFor = (
		loadOptions: ProviderCatalogLoadOptions,
	): ProviderCatalogVersion => {
		const capabilityRead = isLiveProviderCapabilityRead(loadOptions);
		const metadataExclusions = capabilityRead
			? loadOptions.refreshProviderId
				? [loadOptions.refreshProviderId]
				: providerList().map((provider) => provider.providerId)
			: loadOptions.refresh && loadOptions.refreshProviderId
				? [loadOptions.refreshProviderId]
				: undefined;
		const liveRefreshScopes = capabilityRead
			? liveRefreshDependencies(loadOptions)
			: undefined;
		return {
			generation,
			metadataVersion: metadataExclusions
				? metadataVersionExcept(new Set(metadataExclusions))
				: loadOptions.refresh
					? null
					: metadataGeneration,
			...(metadataExclusions ? { metadataExclusions } : {}),
			...(capabilityRead
				? {
						liveRefreshScopes,
						liveRefreshVersion: liveRefreshVersionForScopes(
							liveRefreshStarts,
							liveRefreshScopes ?? [],
						),
						acceptedLiveRefreshVersion: liveRefreshVersionForScopes(
							acceptedLiveRefreshes,
							liveRefreshScopes ?? [],
						),
					}
				: {}),
		};
	};
	const versionIsCurrent = (version: ProviderCatalogVersion): boolean => {
		if (version.generation !== generation) return false;
		if (
			version.liveRefreshVersion !== undefined &&
			version.liveRefreshVersion !==
				liveRefreshVersionForScopes(
					liveRefreshStarts,
					version.liveRefreshScopes ?? [],
				)
		) {
			return false;
		}
		if (
			version.acceptedLiveRefreshVersion !== undefined &&
			version.acceptedLiveRefreshVersion !==
				liveRefreshVersionForScopes(
					acceptedLiveRefreshes,
					version.liveRefreshScopes ?? [],
				)
		) {
			return false;
		}
		if (version.metadataVersion === null) return true;
		return version.metadataExclusions
			? version.metadataVersion ===
					metadataVersionExcept(new Set(version.metadataExclusions))
			: version.metadataVersion === metadataGeneration;
	};

	function store(
		includeHostCapabilities: boolean,
		includeProviderCapabilities: boolean,
		discoveryCwd: string,
		value: ProviderInfo[],
		write: {
			liveRefresh?: number;
			cachedRefresh?: number;
			liveEpochsAtCachedStart?: Map<string, number>;
			liveActiveAtCachedStart?: Set<string>;
		} = {},
	): ProviderInfo[] {
		const refreshedAt = now();
		let requestedProjection = value;
		for (const withHost of [false, true]) {
			if (withHost && !includeHostCapabilities) continue;
			for (const withProvider of [false, true]) {
				if (withProvider && !includeProviderCapabilities) continue;
				const projected =
					withProvider &&
					withHost === includeHostCapabilities &&
					withProvider === includeProviderCapabilities
						? value
						: value.map((provider) => {
								const {
									hostCapabilities,
									capabilitySnapshot,
									permissionProfiles,
									...baseProvider
								} = provider;
								return {
									...baseProvider,
									...(withHost && hostCapabilities ? { hostCapabilities } : {}),
									...(withProvider && capabilitySnapshot
										? { capabilitySnapshot }
										: {}),
									...(withProvider && permissionProfiles
										? { permissionProfiles }
										: {}),
								};
							});
				const projectedKey = keyFor(withHost, withProvider, discoveryCwd);
				const requested =
					withHost === includeHostCapabilities &&
					withProvider === includeProviderCapabilities;
				const supersededByLive =
					write.liveRefresh !== undefined &&
					latestLiveRefresh.get(projectedKey) !== write.liveRefresh;
				let supersededByCached = false;
				if (write.cachedRefresh !== undefined) {
					const liveEpochAtStart =
						write.liveEpochsAtCachedStart?.get(projectedKey) ?? 0;
					supersededByCached =
						latestCachedRefresh.get(projectedKey) !== write.cachedRefresh ||
						write.liveActiveAtCachedStart?.has(projectedKey) ||
						(latestLiveRefresh.get(projectedKey) ?? 0) !== liveEpochAtStart;
				}
				if (supersededByLive || supersededByCached) {
					if (requested) {
						const currentProjection =
							snapshots.get(projectedKey)?.value ??
							lastKnownLiveFields.get(projectedKey);
						requestedProjection = [...(currentProjection ?? projected)];
						supersededReads.add(requestedProjection);
					}
					continue;
				}
				if (requested) {
					requestedProjection = projected;
				}
				snapshots.set(projectedKey, {
					value: projected,
					refreshedAt,
				});
				if (write.liveRefresh !== undefined) {
					lastKnownLiveFields.set(projectedKey, projected);
				}
			}
		}
		return requestedProjection;
	}

	function preserveLiveSnapshotFields(
		value: ProviderInfo[],
		previous: ProviderInfo[] | undefined,
		shouldPreserve: (provider: ProviderInfo) => boolean = () => true,
		preserveHostCapabilities = true,
	): ProviderInfo[] {
		if (!previous) return value;
		const previousById = new Map(
			previous.map((provider) => [provider.id, provider]),
		);
		return value.map((provider) => {
			if (!shouldPreserve(provider)) return provider;
			const prior = previousById.get(provider.id);
			if (!prior) return provider;
			const {
				available: _available,
				unavailableReason: _unavailableReason,
				modelCatalogRefresh: _modelCatalogRefresh,
				forkCapability: _forkCapability,
				hostCapabilities: _hostCapabilities,
				capabilitySnapshot: _capabilitySnapshot,
				permissionProfiles: _permissionProfiles,
				...cachedProvider
			} = provider;
			return {
				...cachedProvider,
				available: prior.available,
				...(prior.unavailableReason
					? { unavailableReason: prior.unavailableReason }
					: {}),
				...(prior.modelCatalogRefresh
					? { modelCatalogRefresh: prior.modelCatalogRefresh }
					: {}),
				...(prior.forkCapability
					? { forkCapability: prior.forkCapability }
					: provider.forkCapability
						? { forkCapability: provider.forkCapability }
						: {}),
				...(preserveHostCapabilities
					? prior.hostCapabilities
						? { hostCapabilities: prior.hostCapabilities }
						: {}
					: provider.hostCapabilities
						? { hostCapabilities: provider.hostCapabilities }
						: {}),
				...(prior.capabilitySnapshot
					? { capabilitySnapshot: prior.capabilitySnapshot }
					: {}),
				...(prior.permissionProfiles
					? { permissionProfiles: prior.permissionProfiles }
					: {}),
			};
		});
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
		const refreshGeneration = generation;
		const refreshMetadataGeneration = metadataGeneration;
		const previous =
			snapshots.get(snapshotKey)?.value ?? lastKnownLiveFields.get(snapshotKey);
		const flightKey = `${refreshGeneration}:${refreshMetadataGeneration}:${snapshotKey}:${
			loadOptions?.refresh ? "live" : "cached"
		}:${loadOptions.awaitHostCapabilities ? "await-host" : "cached-host"}:${
			loadOptions.preferCachedProviderCapabilities === false
				? "await-provider"
				: "cached-provider"
		}:${loadOptions.refreshProviderId ?? "all-providers"}`;
		const current = inflight.get(flightKey);
		if (current) return current;
		const destinationKeys: string[] = [];
		for (const withHost of [false, true]) {
			if (withHost && !includeHostCapabilities) continue;
			for (const withProvider of [false, true]) {
				if (withProvider && !includeProviderCapabilities) continue;
				destinationKeys.push(keyFor(withHost, withProvider, discoveryCwd));
			}
		}
		const liveRefresh = loadOptions.refresh ? ++nextLiveRefresh : null;
		const liveRefreshScope =
			liveRefresh === null
				? undefined
				: liveRefreshScopeKey(discoveryCwd, loadOptions.refreshProviderId);
		const cachedRefresh = liveRefresh === null ? ++nextCachedRefresh : null;
		const liveEpochsAtCachedStart =
			cachedRefresh === null
				? undefined
				: new Map(
						destinationKeys.map((key) => [
							key,
							latestLiveRefresh.get(key) ?? 0,
						]),
					);
		const liveActiveAtCachedStart =
			cachedRefresh === null
				? undefined
				: new Set(
						destinationKeys.filter(
							(key) => (activeLiveRefreshes.get(key)?.size ?? 0) > 0,
						),
					);
		if (liveRefresh !== null) {
			if (liveRefreshScope) {
				liveRefreshStarts.set(
					liveRefreshScope,
					(liveRefreshStarts.get(liveRefreshScope) ?? 0) + 1,
				);
			}
			for (const key of destinationKeys) {
				latestLiveRefresh.set(key, liveRefresh);
				const active = activeLiveRefreshes.get(key) ?? new Set<number>();
				active.add(liveRefresh);
				activeLiveRefreshes.set(key, active);
			}
		} else if (cachedRefresh !== null) {
			for (const key of destinationKeys) {
				latestCachedRefresh.set(key, cachedRefresh);
			}
		}
		const pending = load(providerList(), catalog, {
			...loadOptions,
			discoveryCwd,
		})
			.then((value) => {
				const runtimeIsCurrent = refreshGeneration === generation;
				const metadataIsCurrent =
					refreshMetadataGeneration === metadataGeneration;
				if (runtimeIsCurrent && (metadataIsCurrent || liveRefresh !== null)) {
					const stored = store(
						includeHostCapabilities,
						includeProviderCapabilities,
						discoveryCwd,
						loadOptions.refresh
							? loadOptions.refreshProviderId
								? preserveLiveSnapshotFields(
										value,
										previous,
										(provider) => provider.id !== loadOptions.refreshProviderId,
									)
								: value
							: preserveLiveSnapshotFields(
									value,
									previous,
									undefined,
									!loadOptions.awaitHostCapabilities,
								),
						{
							...(liveRefresh !== null ? { liveRefresh } : {}),
							...(cachedRefresh !== null ? { cachedRefresh } : {}),
							...(liveEpochsAtCachedStart ? { liveEpochsAtCachedStart } : {}),
							...(liveActiveAtCachedStart ? { liveActiveAtCachedStart } : {}),
						},
					);
					if (
						liveRefresh !== null &&
						liveRefreshScope &&
						!supersededReads.has(stored)
					) {
						acceptedLiveRefreshes.set(
							liveRefreshScope,
							(acceptedLiveRefreshes.get(liveRefreshScope) ?? 0) + 1,
						);
					}
					return stored;
				}
				return value;
			})
			.finally(() => {
				inflight.delete(flightKey);
				if (liveRefresh !== null) {
					for (const key of destinationKeys) {
						const active = activeLiveRefreshes.get(key);
						active?.delete(liveRefresh);
						if (active?.size === 0) activeLiveRefreshes.delete(key);
					}
				}
			});
		inflight.set(flightKey, pending);
		return pending;
	}

	/**
	 * Capability waits return their live evidence directly. The underlying
	 * capability cache publishes metadata invalidation, so persisting this
	 * process-free model projection here would only race the normal catalog
	 * rematerialization and explicit model refreshes.
	 */
	function readLiveProviderCapabilities(
		loadOptions: ProviderCatalogLoadOptions,
	): Promise<ProviderInfo[]> {
		const discoveryCwd = effectiveDiscoveryCwd(loadOptions);
		const version = versionFor(loadOptions);
		const directKey = `provider-capability:${generation}:${
			version.metadataVersion ?? "unversioned"
		}:${version.liveRefreshVersion ?? 0}:${
			version.acceptedLiveRefreshVersion ?? 0
		}:${keyFor(
			loadOptions.includeHostCapabilities === true,
			true,
			discoveryCwd,
		)}:${loadOptions.awaitHostCapabilities ? "await-host" : "cached-host"}:${
			loadOptions.refreshProviderId ?? "all-providers"
		}`;
		const current = inflight.get(directKey);
		if (current) return current;
		const baseKey = keyFor(false, false, discoveryCwd);
		const hostKey = keyFor(true, false, discoveryCwd);
		const lastAcceptedBase =
			snapshots.get(baseKey)?.value ?? lastKnownLiveFields.get(baseKey);
		const lastAcceptedHost = loadOptions.includeHostCapabilities
			? (snapshots.get(hostKey)?.value ?? lastKnownLiveFields.get(hostKey))
			: undefined;
		const providerCapabilityForkOverrides = new Map(
			(lastAcceptedBase ?? []).flatMap((provider) =>
				provider.forkCapability
					? ([[provider.id, provider.forkCapability]] as const)
					: [],
			),
		);
		const pending = load(providerList(), catalog, {
			...loadOptions,
			discoveryCwd,
			providerCapabilityForkOverrides,
		})
			.then((providers) => {
				if (!lastAcceptedHost) return providers;
				const hostById = new Map(
					lastAcceptedHost.map((provider) => [
						provider.id,
						provider.hostCapabilities,
					]),
				);
				return providers.map((provider) => ({
					...provider,
					...(!provider.hostCapabilities && hostById.get(provider.id)
						? { hostCapabilities: hostById.get(provider.id) }
						: {}),
				}));
			})
			.finally(() => inflight.delete(directKey));
		inflight.set(directKey, pending);
		return pending;
	}

	const getSnapshot = (
		loadOptions: ProviderCatalogLoadOptions = {},
	): Promise<ProviderInfo[]> => {
		if (isLiveProviderCapabilityRead(loadOptions)) {
			return readLiveProviderCapabilities(loadOptions);
		}
		if (loadOptions.refresh || loadOptions.awaitHostCapabilities) {
			return refresh(loadOptions);
		}
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
	};
	const getVersionedSnapshot = async (
		loadOptions: ProviderCatalogLoadOptions,
	): Promise<VersionedProviderCatalogRead> => {
		for (let attempt = 0; attempt < 3; attempt += 1) {
			const version = versionFor(loadOptions);
			const providers = await getSnapshot(loadOptions);
			if (!supersededReads.has(providers) && versionIsCurrent(version)) {
				return { providers, version: versionFor({}) };
			}
		}
		throw new Error("Provider catalog changed repeatedly during refresh");
	};
	const versionedCapabilityKey = (
		loadOptions: ProviderCatalogLoadOptions,
	): string =>
		JSON.stringify([
			declaredPathKey(effectiveDiscoveryCwd(loadOptions)),
			loadOptions.refreshProviderId ?? null,
			loadOptions.includeHostCapabilities === true,
			loadOptions.awaitHostCapabilities === true,
			loadOptions.preferCachedModels === true,
		]);
	const getVersionedCapabilitySnapshot = (
		loadOptions: ProviderCatalogLoadOptions,
	): Promise<VersionedProviderCatalogRead> => {
		const requestKey = versionedCapabilityKey(loadOptions);
		const current = versionedCapabilityInflight.get(requestKey);
		if (current) return current;

		// Each successful provider capability probe publishes provider-scoped
		// metadata. Let one versioned probe finish before another provider starts,
		// otherwise concurrent probes continuously invalidate each other's catalog
		// version and both exhaust the bounded retry loop. Identical reads still
		// share one probe through the request-keyed in-flight map. Serialize only
		// within one discovery workspace so a slow project cannot block unrelated
		// workspaces.
		const serializationKey = declaredPathKey(
			effectiveDiscoveryCwd(loadOptions),
		);
		const previousTail = versionedCapabilityTails.get(serializationKey);
		const run = () => getVersionedSnapshot(loadOptions);
		const started = previousTail ? previousTail.then(run, run) : run();
		let queued!: Promise<VersionedProviderCatalogRead>;
		queued = started.finally(() => {
			if (versionedCapabilityInflight.get(requestKey) === queued) {
				versionedCapabilityInflight.delete(requestKey);
			}
		});
		versionedCapabilityInflight.set(requestKey, queued);
		let tail!: Promise<void>;
		tail = queued.then(
			() => {
				if (versionedCapabilityTails.get(serializationKey) === tail) {
					versionedCapabilityTails.delete(serializationKey);
				}
			},
			() => {
				if (versionedCapabilityTails.get(serializationKey) === tail) {
					versionedCapabilityTails.delete(serializationKey);
				}
			},
		);
		versionedCapabilityTails.set(serializationKey, tail);
		return queued;
	};

	return {
		get: getSnapshot,
		getVersioned(loadOptions = {}) {
			return isLiveProviderCapabilityRead(loadOptions)
				? getVersionedCapabilitySnapshot(loadOptions)
				: getVersionedSnapshot(loadOptions);
		},
		isCurrentVersion(version) {
			return versionIsCurrent(version);
		},
		invalidateMetadata(providerId) {
			metadataGeneration += 1;
			if (providerId) {
				providerMetadataGenerations.set(
					providerId,
					(providerMetadataGenerations.get(providerId) ?? 0) + 1,
				);
			} else {
				unscopedMetadataGeneration += 1;
			}
			snapshots.clear();
		},
		invalidate() {
			generation += 1;
			metadataGeneration += 1;
			unscopedMetadataGeneration += 1;
			providerMetadataGenerations.clear();
			snapshots.clear();
			latestLiveRefresh.clear();
			latestCachedRefresh.clear();
			activeLiveRefreshes.clear();
			liveRefreshStarts.clear();
			acceptedLiveRefreshes.clear();
			lastKnownLiveFields.clear();
		},
	};
}

/**
 * Normal UI reads are stale-while-revalidate: return the server's last-good
 * snapshot immediately and re-materialize stale entries only from cached
 * metadata. Only an explicit refresh may perform live provider/CLI discovery.
 * The existing `provider_capabilities_wait=1` contract remains an explicit,
 * capability-only live read. This keeps every browser and PWA a view over the
 * same server-owned cache instead of letting route navigation start provider
 * processes of its own.
 */
export function providerCatalogRequestOptions(searchParams: URLSearchParams): {
	refresh: boolean;
	preferCachedModels: boolean;
	preferCachedProviderCapabilities: boolean;
	includeHostCapabilities: boolean;
	awaitHostCapabilities: boolean;
	includeProviderCapabilities: boolean;
	refreshProviderId?: string;
	discoveryCwd?: string;
} {
	const refresh = searchParams.get("refresh") === "1";
	const refreshProviderId = searchParams.get("provider_id")?.trim();
	const waitForProviderCapabilities =
		searchParams.get("provider_capabilities_wait") === "1";
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
		preferCachedProviderCapabilities: !waitForProviderCapabilities,
		includeHostCapabilities: searchParams.get("host_capabilities") === "1",
		awaitHostCapabilities: searchParams.get("host_capabilities_wait") === "1",
		includeProviderCapabilities:
			searchParams.get("provider_capabilities") === "1",
		...((refresh || waitForProviderCapabilities) && refreshProviderId
			? { refreshProviderId }
			: {}),
		...(discoveryCwd ? { discoveryCwd } : {}),
	};
}
