/**
 * providerCatalog unit tests — createCachedList single-flight/TTL/persistence
 * semantics, and the createModelCatalog provider wrapper.
 * DB is mocked; only the cache/catalog logic under test is real.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// ── mocks ─────────────────────────────────────────────────────────────────────

const { mockGetSetting, mockSaveSetting } = vi.hoisted(() => ({
	mockGetSetting: vi.fn(),
	mockSaveSetting: vi.fn(),
}));

vi.mock("../db", () => ({
	getSetting: mockGetSetting,
	saveSetting: mockSaveSetting,
}));

// ── import after mocks ────────────────────────────────────────────────────────

import type { AgentProvider, ProviderModelInfo } from "./agentProvider";
import {
	createCachedList,
	createModelCatalog,
	createProviderCatalogSnapshot,
	loadProviderCatalog,
	providerCatalogRequestOptions,
} from "./providerCatalog";

beforeEach(() => {
	vi.clearAllMocks();
	mockGetSetting.mockResolvedValue(null);
	mockSaveSetting.mockResolvedValue(undefined);
});

// ── createCachedList ──────────────────────────────────────────────────────────

describe("createCachedList", () => {
	it("fresh fetch returns live and persists", async () => {
		const fetcher = vi.fn().mockResolvedValue(["a", "b"]);
		const cache = createCachedList<string[]>({
			persistKey: "k:test",
			fetcher,
			fallback: [],
		});

		const result = await cache.get();

		expect(result).toEqual({ value: ["a", "b"], source: "live" });
		expect(fetcher).toHaveBeenCalledTimes(1);
		expect(mockSaveSetting).toHaveBeenCalledWith(
			"k:test",
			JSON.stringify(["a", "b"]),
		);
	});

	it("within TTL returns memory and does not refetch", async () => {
		const fetcher = vi.fn().mockResolvedValue(["a"]);
		const cache = createCachedList<string[]>({
			persistKey: "k:ttl",
			fetcher,
			fallback: [],
		});

		await cache.get();
		const second = await cache.get();

		expect(second).toEqual({ value: ["a"], source: "memory" });
		expect(fetcher).toHaveBeenCalledTimes(1);
	});

	it("refresh=true bypasses TTL and refetches", async () => {
		vi.useFakeTimers();
		try {
			const fetcher = vi
				.fn()
				.mockResolvedValueOnce(["a"])
				.mockResolvedValueOnce(["b"]);
			const cache = createCachedList<string[]>({
				persistKey: "k:refresh",
				fetcher,
				fallback: [],
			});

			await cache.get();
			// Still well within the (default 6h) TTL.
			const refreshed = await cache.get(true);

			expect(refreshed).toEqual({ value: ["b"], source: "live" });
			expect(fetcher).toHaveBeenCalledTimes(2);
		} finally {
			vi.useRealTimers();
		}
	});

	it("TTL expiry triggers a refetch on a plain get()", async () => {
		vi.useFakeTimers();
		try {
			const fetcher = vi
				.fn()
				.mockResolvedValueOnce(["a"])
				.mockResolvedValueOnce(["b"]);
			const cache = createCachedList<string[]>({
				persistKey: "k:expiry",
				ttlMs: 1000,
				fetcher,
				fallback: [],
			});

			await cache.get();
			vi.advanceTimersByTime(1001);
			const result = await cache.get();

			expect(result).toEqual({ value: ["b"], source: "live" });
			expect(fetcher).toHaveBeenCalledTimes(2);
		} finally {
			vi.useRealTimers();
		}
	});

	it("single-flights concurrent gets into one fetcher call", async () => {
		let resolveFetch!: (v: string[]) => void;
		const fetcher = vi.fn().mockReturnValue(
			new Promise<string[]>((resolve) => {
				resolveFetch = resolve;
			}),
		);
		const cache = createCachedList<string[]>({
			persistKey: "k:flight",
			fetcher,
			fallback: [],
		});

		const p1 = cache.get();
		const p2 = cache.get();
		resolveFetch(["x"]);
		const [r1, r2] = await Promise.all([p1, p2]);

		expect(fetcher).toHaveBeenCalledTimes(1);
		expect(r1).toEqual({ value: ["x"], source: "live" });
		expect(r2).toEqual({ value: ["x"], source: "live" });
	});

	it("bounds a stuck fetch and briefly reuses the safe fallback", async () => {
		vi.useFakeTimers();
		try {
			const fetcher = vi.fn(() => new Promise<string[]>(() => {}));
			const cache = createCachedList<string[]>({
				persistKey: "k:timeout",
				fetcher,
				fallback: ["safe"],
				fetchTimeoutMs: 100,
				failureTtlMs: 1000,
			});

			const first = cache.get();
			await vi.advanceTimersByTimeAsync(101);
			expect(await first).toEqual({ value: ["safe"], source: "fallback" });
			expect(await cache.get()).toEqual({
				value: ["safe"],
				source: "memory",
			});
			expect(fetcher).toHaveBeenCalledTimes(1);
		} finally {
			vi.useRealTimers();
		}
	});

	it("fetcher rejects with stale memory falls back to memory", async () => {
		const fetcher = vi
			.fn()
			.mockResolvedValueOnce(["a"])
			.mockRejectedValueOnce(new Error("boom"));
		const cache = createCachedList<string[]>({
			persistKey: "k:stale",
			fetcher,
			fallback: [],
		});

		await cache.get();
		const result = await cache.get(true);

		expect(result).toEqual({ value: ["a"], source: "memory" });
	});

	it("fetcher rejects, no memory, valid persisted JSON returns persisted", async () => {
		mockGetSetting.mockResolvedValue(JSON.stringify(["p1", "p2"]));
		const fetcher = vi.fn().mockRejectedValue(new Error("boom"));
		const cache = createCachedList<string[]>({
			persistKey: "k:persisted",
			fetcher,
			fallback: [],
		});

		const result = await cache.get();

		expect(result).toEqual({ value: ["p1", "p2"], source: "persisted" });
	});

	it("fetcher rejects, corrupt persisted JSON falls back", async () => {
		mockGetSetting.mockResolvedValue("not-valid-json{{");
		const fetcher = vi.fn().mockRejectedValue(new Error("boom"));
		const cache = createCachedList<string[]>({
			persistKey: "k:corrupt",
			fetcher,
			fallback: ["fallback"],
		});

		const result = await cache.get();

		expect(result).toEqual({ value: ["fallback"], source: "fallback" });
	});

	it("fetcher rejects, persisted value fails validate falls back", async () => {
		mockGetSetting.mockResolvedValue(JSON.stringify({ not: "an array" }));
		const fetcher = vi.fn().mockRejectedValue(new Error("boom"));
		const cache = createCachedList<string[]>({
			persistKey: "k:invalid",
			fetcher,
			fallback: ["fallback"],
			validate: (v): v is string[] => Array.isArray(v),
		});

		const result = await cache.get();

		expect(result).toEqual({ value: ["fallback"], source: "fallback" });
	});

	it("fetcher rejects, nothing persisted falls back", async () => {
		mockGetSetting.mockResolvedValue(null);
		const fetcher = vi.fn().mockRejectedValue(new Error("boom"));
		const cache = createCachedList<string[]>({
			persistKey: "k:nothing",
			fetcher,
			fallback: ["fallback"],
		});

		const result = await cache.get();

		expect(result).toEqual({ value: ["fallback"], source: "fallback" });
	});

	it("never throws even when fetcher rejects and persisted read rejects", async () => {
		mockGetSetting.mockRejectedValue(new Error("db down"));
		const fetcher = vi.fn().mockRejectedValue(new Error("boom"));
		const cache = createCachedList<string[]>({
			persistKey: "k:dbfail",
			fetcher,
			fallback: ["fallback"],
		});

		await expect(cache.get()).resolves.toEqual({
			value: ["fallback"],
			source: "fallback",
		});
	});
});

// ── createModelCatalog ────────────────────────────────────────────────────────

function makeProvider(
	overrides: Partial<AgentProvider> & { providerId: string },
): AgentProvider {
	return {
		models: [{ value: "m1", label: "Model 1" }],
		query: vi.fn() as unknown as AgentProvider["query"],
		...overrides,
	};
}

describe("createModelCatalog", () => {
	it("notifies when live discovery refreshes the server snapshot", async () => {
		const onChange = vi.fn();
		const provider = makeProvider({
			providerId: "notify",
			listModels: vi.fn().mockResolvedValue([{ value: "new", label: "New" }]),
		});
		const catalog = createModelCatalog(
			new Map([[provider.providerId, provider]]),
			onChange,
		);

		await catalog.modelsFor(provider, true);
		await catalog.modelsFor(provider, true);

		expect(onChange).toHaveBeenCalledTimes(2);
		expect(onChange).toHaveBeenCalledWith("notify");
	});

	it("modelsFor a provider without listModels returns static models", async () => {
		const provider = makeProvider({ providerId: "static-only" });
		const providers = new Map([["static-only", provider]]);
		const catalog = createModelCatalog(providers);

		const models = await catalog.modelsFor(provider);

		expect(models).toEqual([{ value: "m1", label: "Model 1" }]);
	});

	it("modelsFor a provider with listModels uses the live catalog", async () => {
		const live: ProviderModelInfo[] = [
			{ value: "live-1", label: "Live One", isDefault: true },
		];
		const provider = makeProvider({
			providerId: "live",
			listModels: vi.fn().mockResolvedValue(live),
		});
		const providers = new Map([["live", provider]]);
		const catalog = createModelCatalog(providers);

		const models = await catalog.modelsFor(provider);

		expect(models).toEqual(live);
	});

	it("warm() never rejects even when a provider's listModels rejects", async () => {
		const provider = makeProvider({
			providerId: "broken",
			listModels: vi.fn().mockRejectedValue(new Error("nope")),
		});
		const providers = new Map([["broken", provider]]);
		const catalog = createModelCatalog(providers);

		expect(() => catalog.warm()).not.toThrow();
		// Give the fire-and-forget promise a tick to settle.
		await new Promise((r) => setTimeout(r, 0));
	});

	it("warm() falls back to static models after a rejecting fetch", async () => {
		const provider = makeProvider({
			providerId: "broken2",
			listModels: vi.fn().mockRejectedValue(new Error("nope")),
			models: [{ value: "fallback-1", label: "Fallback" }],
		});
		const providers = new Map([["broken2", provider]]);
		const catalog = createModelCatalog(providers);

		catalog.warm();
		await new Promise((r) => setTimeout(r, 0));
		const models = await catalog.modelsFor(provider);

		expect(models).toEqual([{ value: "fallback-1", label: "Fallback" }]);
	});
});

describe("loadProviderCatalog", () => {
	it("publishes exact fork capabilities to Raven and Ledger", async () => {
		const provider = makeProvider({
			providerId: "codex",
			forkCapability: {
				kind: "exact",
				cutoff: "turn",
				wholeSession: true,
				throughMessage: true,
			},
		});

		const result = await loadProviderCatalog([provider], {
			modelsFor: vi.fn().mockResolvedValue([]),
		});

		expect(result[0]?.forkCapability).toEqual({
			kind: "exact",
			cutoff: "turn",
			wholeSession: true,
			throughMessage: true,
		});
	});

	it("uses cached models for navigation-sensitive loaders", async () => {
		const provider = makeProvider({ providerId: "codex" });
		const modelsFor = vi.fn(() => new Promise<ProviderModelInfo[]>(() => {}));
		const cachedModelsFor = vi
			.fn()
			.mockResolvedValue([{ value: "cached", label: "Cached" }]);

		const result = await loadProviderCatalog(
			[provider],
			{ modelsFor, cachedModelsFor },
			{ preferCachedModels: true },
		);

		expect(result[0]?.models).toEqual([{ value: "cached", label: "Cached" }]);
		expect(cachedModelsFor).toHaveBeenCalledOnce();
		expect(modelsFor).not.toHaveBeenCalled();
	});

	it("does not run host capability probes for normal route loaders", async () => {
		const hostCapabilities = vi.fn(
			() => new Promise<Record<string, never>>(() => {}),
		);
		const provider = makeProvider({
			providerId: "codex",
			hostCapabilities,
		});
		const modelsFor = vi
			.fn()
			.mockResolvedValue([{ value: "m1", label: "Model 1" }]);

		const result = await loadProviderCatalog([provider], { modelsFor });

		expect(result[0]?.models).toEqual([{ value: "m1", label: "Model 1" }]);
		expect(hostCapabilities).not.toHaveBeenCalled();
	});

	it("runs host capability probes only when explicitly requested", async () => {
		const hostCapabilities = vi.fn().mockResolvedValue({
			windowsComputerUse: { label: "Windows Computer Use", available: true },
		});
		const provider = makeProvider({
			providerId: "codex",
			hostCapabilities,
		});
		const modelsFor = vi.fn().mockResolvedValue([]);

		const result = await loadProviderCatalog(
			[provider],
			{ modelsFor },
			{ includeHostCapabilities: true },
		);

		expect(hostCapabilities).toHaveBeenCalledOnce();
		expect(result[0]?.hostCapabilities).toEqual({
			windowsComputerUse: { label: "Windows Computer Use", available: true },
		});
	});
});

describe("createProviderCatalogSnapshot", () => {
	it("reuses one materialized response for capability and base reads", async () => {
		const check = vi.fn().mockResolvedValue({ available: true });
		const hostCapabilities = vi.fn().mockResolvedValue({
			windowsComputerUse: { label: "Windows Computer Use", available: true },
		});
		const provider = makeProvider({
			providerId: "codex",
			check,
			hostCapabilities,
		});
		const cachedModelsFor = vi
			.fn()
			.mockResolvedValue([{ value: "cached", label: "Cached" }]);
		const snapshot = createProviderCatalogSnapshot([provider], {
			modelsFor: vi.fn(),
			cachedModelsFor,
		});

		const withCapabilities = await snapshot.get({
			includeHostCapabilities: true,
		});
		const repeated = await snapshot.get({ includeHostCapabilities: true });
		const base = await snapshot.get();

		expect(repeated).toBe(withCapabilities);
		expect(base[0]?.hostCapabilities).toBeUndefined();
		expect(check).toHaveBeenCalledOnce();
		expect(cachedModelsFor).toHaveBeenCalledOnce();
		expect(hostCapabilities).toHaveBeenCalledOnce();
	});

	it("returns stale data immediately and revalidates it in the background", async () => {
		let now = 0;
		const check = vi
			.fn()
			.mockResolvedValueOnce({ available: true })
			.mockResolvedValueOnce({ available: false, reason: "missing" });
		const provider = makeProvider({ providerId: "codex", check });
		const snapshot = createProviderCatalogSnapshot(
			[provider],
			{
				modelsFor: vi.fn(),
				cachedModelsFor: vi.fn().mockResolvedValue([]),
			},
			{ ttlMs: 100, now: () => now },
		);

		expect((await snapshot.get())[0]?.available).toBe(true);
		now = 101;
		expect((await snapshot.get())[0]?.available).toBe(true);
		await vi.waitFor(() => expect(check).toHaveBeenCalledTimes(2));
		await vi.waitFor(async () =>
			expect((await snapshot.get())[0]?.available).toBe(false),
		);
	});

	it("recomputes after explicit invalidation", async () => {
		const check = vi.fn().mockResolvedValue({ available: true });
		const provider = makeProvider({ providerId: "codex", check });
		const snapshot = createProviderCatalogSnapshot([provider], {
			modelsFor: vi.fn(),
			cachedModelsFor: vi.fn().mockResolvedValue([]),
		});

		await snapshot.get();
		snapshot.invalidate();
		await snapshot.get();

		expect(check).toHaveBeenCalledTimes(2);
	});

	it("reads a live provider collection after an integration is registered", async () => {
		const providers = [makeProvider({ providerId: "codex" })];
		const snapshot = createProviderCatalogSnapshot(() => providers, {
			modelsFor: vi.fn(),
			cachedModelsFor: vi.fn().mockResolvedValue([]),
		});

		expect((await snapshot.get()).map((provider) => provider.id)).toEqual([
			"codex",
		]);
		providers.push(makeProvider({ providerId: "cliproxy-codex" }));
		snapshot.invalidate();
		expect((await snapshot.get()).map((provider) => provider.id)).toEqual([
			"codex",
			"cliproxy-codex",
		]);
	});
});

describe("providerCatalogRequestOptions", () => {
	it("serves normal UI reads from the server-owned cache", () => {
		expect(providerCatalogRequestOptions(new URLSearchParams())).toEqual({
			refresh: false,
			preferCachedModels: true,
			includeHostCapabilities: false,
		});
	});

	it("uses live discovery only for an explicit refresh", () => {
		expect(
			providerCatalogRequestOptions(
				new URLSearchParams("refresh=1&host_capabilities=1"),
			),
		).toEqual({
			refresh: true,
			preferCachedModels: false,
			includeHostCapabilities: true,
		});
	});
});
