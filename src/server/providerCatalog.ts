/**
 * Generic single-flight, TTL-bounded cache with DB-persisted last-good value
 * and a static fallback. Domain-agnostic on purpose — a later voice feature
 * reuses `createCachedList` for its own catalog, so nothing here may assume
 * "model" or "provider" semantics. The provider-specific wrapper lives below
 * as `createModelCatalog`.
 */
import * as db from "../db";
import type { AgentProvider, ProviderModelInfo } from "./agentProvider";

/** Where a `CachedList.get()` result came from. */
export type CatalogSource = "live" | "memory" | "persisted" | "fallback";

export type CachedList<T> = {
	/**
	 * Resolve the cached value. `refresh=true` bypasses the TTL and forces a
	 * fresh fetch attempt (still single-flighted with any in-flight fetch).
	 * Never throws — on total failure resolves with the static fallback.
	 */
	get(refresh?: boolean): Promise<{ value: T; source: CatalogSource }>;
};

const DEFAULT_TTL_MS = 6 * 3600_000;
const DEFAULT_FAILURE_TTL_MS = 60_000;

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
export function createModelCatalog(providers: Map<string, AgentProvider>): {
	modelsFor(p: AgentProvider, refresh?: boolean): Promise<ProviderModelInfo[]>;
	/** Fire-and-forget warm-up of every provider's cache; never rejects. */
	warm(): void;
} {
	const caches = new Map<string, CachedList<ProviderModelInfo[]>>();
	for (const p of providers.values()) {
		if (!p.listModels) continue;
		const listModels = p.listModels.bind(p);
		caches.set(
			p.providerId,
			createCachedList<ProviderModelInfo[]>({
				persistKey: `model_catalog:${p.providerId}`,
				fetcher: () => listModels(),
				fallback: staticModels(p),
				fetchTimeoutMs: 12_000,
			}),
		);
	}

	return {
		async modelsFor(p, refresh) {
			const cache = caches.get(p.providerId);
			if (!cache) return staticModels(p);
			const { value } = await cache.get(refresh);
			return value;
		},
		warm() {
			for (const cache of caches.values()) {
				void cache.get().catch(() => {});
			}
		},
	};
}
