/**
 * Generic single-flight, TTL-bounded cache with DB-persisted last-good value
 * and a static fallback. Domain-agnostic on purpose — a later voice feature
 * reuses `createCachedList` for its own catalog, so nothing here may assume
 * "model" or "provider" semantics. The provider-specific wrapper lives below
 * as `createModelCatalog`.
 */
import * as db from "../db";
import type { ProviderInfo } from "../lib/providerTypes";
import type { AgentProvider, ProviderModelInfo } from "./agentProvider";
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

/**
 * Build the UI provider catalog without probing host-only capabilities unless
 * the requesting surface explicitly needs them. Capability probes can involve
 * live provider RPCs and must not block unrelated route loaders.
 */
export async function loadProviderCatalog(
	providers: Iterable<AgentProvider>,
	modelCatalog: {
		modelsFor(
			provider: AgentProvider,
			refresh?: boolean,
		): Promise<ProviderModelInfo[]>;
		cachedModelsFor?(provider: AgentProvider): Promise<ProviderModelInfo[]>;
	},
	options: {
		refresh?: boolean;
		includeHostCapabilities?: boolean;
		preferCachedModels?: boolean;
	} = {},
): Promise<ProviderInfo[]> {
	return Promise.all(
		[...providers].map(async (provider) => {
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
			const [models, hostCapabilities, forkCapability] = await Promise.all([
				observeCatalogStep(
					`models:${provider.providerId}`,
					`${provider.providerId} model snapshot`,
					() =>
						options.preferCachedModels && modelCatalog.cachedModelsFor
							? modelCatalog.cachedModelsFor(provider)
							: modelCatalog.modelsFor(provider, providerRefresh),
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
			]);
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
				forkCapability,
				hostCapabilities,
			};
		}),
	);
}

type ProviderCatalogLoadOptions = Parameters<typeof loadProviderCatalog>[2];

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
	modelCatalog: Parameters<typeof loadProviderCatalog>[1],
	options: {
		ttlMs?: number;
		now?: () => number;
		load?: typeof loadProviderCatalog;
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
	const keyFor = (includeHostCapabilities: boolean) =>
		includeHostCapabilities ? "with-capabilities" : "base";

	function store(
		includeHostCapabilities: boolean,
		value: ProviderInfo[],
	): ProviderInfo[] {
		const refreshedAt = now();
		snapshots.set(keyFor(includeHostCapabilities), { value, refreshedAt });
		if (includeHostCapabilities) {
			snapshots.set(keyFor(false), {
				value: value.map(
					({ hostCapabilities: _ignored, ...provider }) => provider,
				),
				refreshedAt,
			});
		}
		return value;
	}

	function refresh(
		loadOptions: ProviderCatalogLoadOptions,
	): Promise<ProviderInfo[]> {
		const includeHostCapabilities =
			loadOptions?.includeHostCapabilities === true;
		const snapshotKey = keyFor(includeHostCapabilities);
		const flightKey = `${snapshotKey}:${loadOptions?.refresh ? "live" : "cached"}`;
		const current = inflight.get(flightKey);
		if (current) return current;
		const pending = load(providerList(), modelCatalog, loadOptions)
			.then((value) => store(includeHostCapabilities, value))
			.finally(() => inflight.delete(flightKey));
		inflight.set(flightKey, pending);
		return pending;
	}

	return {
		get(loadOptions = {}) {
			if (loadOptions.refresh) return refresh(loadOptions);
			const includeHostCapabilities =
				loadOptions.includeHostCapabilities === true;
			const snapshot = snapshots.get(keyFor(includeHostCapabilities));
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
	includeHostCapabilities: boolean;
} {
	const refresh = searchParams.get("refresh") === "1";
	return {
		refresh,
		preferCachedModels: !refresh,
		includeHostCapabilities: searchParams.get("host_capabilities") === "1",
	};
}
