/**
 * providerCatalog unit tests — createCachedList single-flight/TTL/persistence
 * semantics, and the createModelCatalog provider wrapper.
 * DB is mocked; only the cache/catalog logic under test is real.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderCapabilityDiscovery } from "../lib/providerCapabilityTypes";
import type { ProviderInfo } from "../lib/providerTypes";

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
	createProviderCapabilityCatalog,
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

	it("does not publish an in-flight result after the cache is disposed", async () => {
		let resolveFetch: (value: string[]) => void = () => {};
		const fetcher = vi.fn(
			() =>
				new Promise<string[]>((resolve) => {
					resolveFetch = resolve;
				}),
		);
		const onChange = vi.fn();
		const cache = createCachedList<string[]>({
			persistKey: "k:disposed",
			fetcher,
			fallback: [],
			onChange,
		});

		const pending = cache.get();
		cache.dispose();
		resolveFetch(["obsolete"]);

		await expect(pending).resolves.toEqual({
			value: ["obsolete"],
			source: "live",
		});
		expect(mockSaveSetting).not.toHaveBeenCalled();
		expect(onChange).not.toHaveBeenCalled();
	});

	it("returns the static fallback without fetching after an identity change", async () => {
		mockGetSetting.mockResolvedValue(JSON.stringify(["obsolete"]));
		const fetcher = vi.fn().mockResolvedValue(["current"]);
		const cache = createCachedList<string[]>({
			persistKey: "k:identity-change",
			fetcher,
			fallback: ["safe"],
			allowPersistedFallback: false,
		});

		await expect(cache.getCached()).resolves.toEqual({
			value: ["safe"],
			source: "fallback",
		});
		expect(fetcher).not.toHaveBeenCalled();
		expect(mockGetSetting).not.toHaveBeenCalled();
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
	it("treats a live empty refresh as authoritative and removes cached models", async () => {
		const provider = makeProvider({
			providerId: "acp:opencode",
			listModels: vi
				.fn()
				.mockResolvedValueOnce([{ value: "old", label: "Old" }])
				.mockResolvedValueOnce([]),
		});
		const catalog = createModelCatalog(
			new Map([[provider.providerId, provider]]),
		);

		expect(await catalog.refreshModelsFor(provider)).toMatchObject({
			models: [{ value: "old", label: "Old" }],
			source: "live",
		});
		expect(await catalog.refreshModelsFor(provider)).toEqual({
			models: [],
			source: "live",
		});
		expect(mockSaveSetting).toHaveBeenLastCalledWith(
			"model_catalog:acp:opencode",
			"[]",
		);
	});

	it("reports stale memory when an explicit model refresh fails", async () => {
		const provider = makeProvider({
			providerId: "acp:opencode",
			listModels: vi
				.fn()
				.mockResolvedValueOnce([{ value: "cached", label: "Cached" }])
				.mockRejectedValueOnce(new Error("agent stopped")),
		});
		const catalog = createModelCatalog(
			new Map([[provider.providerId, provider]]),
		);
		await catalog.refreshModelsFor(provider);

		expect(await catalog.refreshModelsFor(provider)).toEqual({
			models: [{ value: "cached", label: "Cached" }],
			source: "memory",
			reason: "Live model discovery did not return current options",
		});
	});

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

	it("cachedModelsFor never starts live discovery in the background", async () => {
		mockGetSetting.mockResolvedValue(
			JSON.stringify([{ value: "persisted", label: "Persisted" }]),
		);
		const listModels = vi
			.fn()
			.mockResolvedValue([{ value: "live", label: "Live" }]);
		const provider = makeProvider({
			providerId: "cached-only",
			listModels,
		});
		const catalog = createModelCatalog(
			new Map([[provider.providerId, provider]]),
		);

		await expect(catalog.cachedModelsFor(provider)).resolves.toEqual([
			{ value: "persisted", label: "Persisted" },
		]);
		await Promise.resolve();

		expect(listModels).not.toHaveBeenCalled();
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

	it("does not persist model discovery from a provider cache replaced in flight", async () => {
		let resolveOld: (value: ProviderModelInfo[]) => void = () => {};
		const oldProvider = makeProvider({
			providerId: "codex",
			listModels: vi.fn(
				() =>
					new Promise<ProviderModelInfo[]>((resolve) => {
						resolveOld = resolve;
					}),
			),
		});
		const newModels = [{ value: "new", label: "New" }];
		const newProvider = makeProvider({
			providerId: "codex",
			listModels: vi.fn().mockResolvedValue(newModels),
		});
		const catalog = createModelCatalog(new Map([["codex", oldProvider]]));

		const oldRead = catalog.modelsFor(oldProvider);
		catalog.register(newProvider);
		expect(await catalog.modelsFor(newProvider)).toEqual(newModels);
		resolveOld([{ value: "old", label: "Old" }]);
		await oldRead;

		expect(mockSaveSetting).toHaveBeenCalledOnce();
		expect(mockSaveSetting).toHaveBeenCalledWith(
			"model_catalog:codex",
			JSON.stringify(newModels),
		);
	});

	it("isolates workspace-scoped model discovery and persistence", async () => {
		const listModels = vi.fn(({ cwd }: { cwd: string }) =>
			Promise.resolve([{ value: cwd, label: cwd }]),
		);
		const provider = makeProvider({
			providerId: "acp:opencode",
			metadataCacheIdentity: "opencode-runtime-one",
			modelCatalogScope: "workspace",
			listModels,
		});
		const catalog = createModelCatalog(
			new Map([[provider.providerId, provider]]),
		);

		await expect(
			catalog.refreshModelsFor(provider, "/work/one"),
		).resolves.toMatchObject({
			models: [{ value: "/work/one", label: "/work/one" }],
			source: "live",
		});
		await expect(
			catalog.refreshModelsFor(provider, "/work/two"),
		).resolves.toMatchObject({
			models: [{ value: "/work/two", label: "/work/two" }],
			source: "live",
		});
		expect(listModels).toHaveBeenNthCalledWith(1, { cwd: "/work/one" });
		expect(listModels).toHaveBeenNthCalledWith(2, { cwd: "/work/two" });
		expect(mockSaveSetting.mock.calls[0]?.[0]).not.toBe(
			mockSaveSetting.mock.calls[1]?.[0],
		);
		expect(mockSaveSetting.mock.calls[0]?.[0]).toMatch(
			/^model_catalog:acp%3Aopencode:[0-9a-f]{16}:[0-9a-f]{16}$/,
		);
	});

	it("does not fall back to a global metadata identity for an unresolved workspace", async () => {
		const metadataCacheIdentityFor = vi.fn().mockReturnValue(undefined);
		const provider = makeProvider({
			providerId: "acp:opencode",
			metadataCacheIdentity: "selected-forge-target",
			metadataCacheIdentityFor,
			modelCatalogScope: "workspace",
			listModels: vi
				.fn()
				.mockResolvedValue([{ value: "current", label: "Current" }]),
		});
		const catalog = createModelCatalog(
			new Map([[provider.providerId, provider]]),
		);

		await catalog.refreshModelsFor(provider, "/work/unresolved");

		expect(metadataCacheIdentityFor).toHaveBeenCalledWith("/work/unresolved");
		expect(mockSaveSetting).toHaveBeenCalledWith(
			expect.stringMatching(
				/^model_catalog:acp%3Aopencode:default-runtime:[0-9a-f]{16}$/,
			),
			expect.any(String),
		);
	});

	it("treats an unavailable workspace metadata identity as a cache miss", async () => {
		const provider = makeProvider({
			providerId: "acp:opencode",
			models: [{ value: "fallback", label: "Fallback" }],
			metadataCacheIdentityFor: vi.fn(() => {
				throw new Error("no WSL runtime configured");
			}),
			modelCatalogScope: "workspace",
			listModels: vi.fn(),
		});
		const catalog = createModelCatalog(
			new Map([[provider.providerId, provider]]),
		);

		await expect(
			catalog.cachedModelsFor(provider, "/home/kyle/project"),
		).resolves.toEqual([{ value: "fallback", label: "Fallback" }]);
		expect(mockGetSetting).not.toHaveBeenCalled();
	});

	it("does not reuse a previous runtime's persisted models after restart", async () => {
		let previousKey: string | undefined;
		mockGetSetting.mockImplementation((key: string) => {
			if (!previousKey) {
				previousKey = key;
				return Promise.resolve(
					JSON.stringify([{ value: "old", label: "Old runtime" }]),
				);
			}
			return Promise.resolve(
				key === previousKey
					? JSON.stringify([{ value: "old", label: "Old runtime" }])
					: null,
			);
		});
		const oldProvider = makeProvider({
			providerId: "acp:opencode",
			metadataCacheIdentity: "old-runtime",
			modelCatalogScope: "workspace",
			listModels: vi.fn(),
		});
		const oldCatalog = createModelCatalog(
			new Map([[oldProvider.providerId, oldProvider]]),
		);
		await expect(
			oldCatalog.cachedModelsFor(oldProvider, "/work/project"),
		).resolves.toEqual([{ value: "old", label: "Old runtime" }]);

		const newProvider = makeProvider({
			providerId: "acp:opencode",
			metadataCacheIdentity: "new-runtime",
			modelCatalogScope: "workspace",
			listModels: vi.fn(),
		});
		const restartedCatalog = createModelCatalog(
			new Map([[newProvider.providerId, newProvider]]),
		);
		await expect(
			restartedCatalog.cachedModelsFor(newProvider, "/work/project"),
		).resolves.toEqual([{ value: "m1", label: "Model 1" }]);
		expect(mockGetSetting.mock.calls[0]?.[0]).not.toBe(
			mockGetSetting.mock.calls[1]?.[0],
		);
	});
});

describe("createProviderCapabilityCatalog", () => {
	it("caches bounded live discovery and notifies the provider snapshot", async () => {
		const onChange = vi.fn();
		const discoverCapabilities = vi.fn().mockResolvedValue({
			observedAt: 1,
			evidence: [],
		});
		const provider = makeProvider({
			providerId: "codex",
			discoverCapabilities,
		});
		const catalog = createProviderCapabilityCatalog(
			new Map([[provider.providerId, provider]]),
			"/work/project",
			onChange,
		);

		expect(await catalog.capabilitiesFor(provider)).toMatchObject({
			source: "live",
			discovery: { observedAt: 1 },
		});
		expect(await catalog.capabilitiesFor(provider)).toMatchObject({
			source: "memory",
		});
		expect(discoverCapabilities).toHaveBeenCalledOnce();
		expect(discoverCapabilities).toHaveBeenCalledWith({ cwd: "/work/project" });
		expect(onChange).toHaveBeenCalledWith("codex");
		expect(mockSaveSetting).toHaveBeenCalledWith(
			expect.stringMatching(/^provider_capabilities:codex:[0-9a-f]{16}$/),
			expect.any(String),
		);
	});

	it("isolates provider evidence by normalized workspace", async () => {
		const discoverCapabilities = vi.fn().mockImplementation(({ cwd }) =>
			Promise.resolve({
				observedAt: 1,
				context: { cwd },
				evidence: [],
			}),
		);
		const provider = makeProvider({
			providerId: "codex",
			discoverCapabilities,
		});
		const catalog = createProviderCapabilityCatalog(
			new Map([[provider.providerId, provider]]),
			"/work/default",
		);

		expect(
			(await catalog.capabilitiesFor(provider, "/work/one"))?.discovery.context,
		).toEqual({ cwd: "/work/one" });
		expect((await catalog.capabilitiesFor(provider, "/work/one"))?.source).toBe(
			"memory",
		);
		expect(
			(await catalog.capabilitiesFor(provider, "/work/two"))?.discovery.context,
		).toEqual({ cwd: "/work/two" });
		expect(discoverCapabilities).toHaveBeenCalledTimes(2);
		expect(mockSaveSetting.mock.calls[0]?.[0]).not.toBe(
			mockSaveSetting.mock.calls[1]?.[0],
		);
	});

	it("cached capability reads never start live discovery in the background", async () => {
		mockGetSetting.mockResolvedValue(
			JSON.stringify({ observedAt: 7, evidence: [] }),
		);
		const discoverCapabilities = vi.fn().mockResolvedValue({
			observedAt: 8,
			evidence: [],
		});
		const provider = makeProvider({
			providerId: "codex",
			discoverCapabilities,
		});
		const catalog = createProviderCapabilityCatalog(
			new Map([[provider.providerId, provider]]),
			"/work/project",
		);

		await expect(
			catalog.cachedCapabilitiesFor(provider),
		).resolves.toMatchObject({
			source: "persisted",
			discovery: { observedAt: 7 },
		});
		await Promise.resolve();

		expect(discoverCapabilities).not.toHaveBeenCalled();
	});

	it("rediscovers realtime capability evidence after the provider is registered again", async () => {
		let realtimeEnabled = false;
		const discoverCapabilities = vi.fn().mockImplementation(() =>
			Promise.resolve({
				observedAt: realtimeEnabled ? 2 : 1,
				evidence: [
					{
						id: "codex:experimental-feature:realtime_conversation",
						label: "Realtime conversation",
						scope: "provider" as const,
						support: realtimeEnabled
							? ("advertised" as const)
							: ("not-advertised" as const),
						integration: "integrated" as const,
						readiness: realtimeEnabled
							? ("ready" as const)
							: ("unavailable" as const),
						source: "provider-runtime" as const,
					},
				],
			}),
		);
		const provider = makeProvider({
			providerId: "codex",
			discoverCapabilities,
		});
		const catalog = createProviderCapabilityCatalog(
			new Map([[provider.providerId, provider]]),
			"/work/project",
		);
		const loadSnapshot = async () =>
			(
				await loadProviderCatalog(
					[provider],
					{
						modelsFor: vi.fn().mockResolvedValue([]),
						capabilitiesFor: catalog.capabilitiesFor,
					},
					{
						refresh: true,
						includeProviderCapabilities: true,
						discoveryCwd: "/work/project",
					},
				)
			)[0]?.capabilitySnapshot;

		expect(
			(await loadSnapshot())?.capabilities.find(
				(capability) =>
					capability.id === "codex:experimental-feature:realtime_conversation",
			)?.availability,
		).toBe("unavailable");

		realtimeEnabled = true;
		catalog.register(provider);

		expect(
			(await loadSnapshot())?.capabilities.find(
				(capability) =>
					capability.id === "codex:experimental-feature:realtime_conversation",
			)?.availability,
		).toBe("available");
		expect(discoverCapabilities).toHaveBeenCalledTimes(2);
	});

	it("does not persist capability evidence from a provider cache replaced in flight", async () => {
		let resolveOld: (value: ProviderCapabilityDiscovery) => void = () => {};
		const oldProvider = makeProvider({
			providerId: "codex",
			discoverCapabilities: vi.fn(
				() =>
					new Promise<ProviderCapabilityDiscovery>((resolve) => {
						resolveOld = resolve;
					}),
			),
		});
		const currentDiscovery = { observedAt: 2, evidence: [] };
		const newProvider = makeProvider({
			providerId: "codex",
			discoverCapabilities: vi.fn().mockResolvedValue(currentDiscovery),
		});
		const catalog = createProviderCapabilityCatalog(
			new Map([["codex", oldProvider]]),
			"/work/project",
		);

		const oldRead = catalog.capabilitiesFor(oldProvider);
		catalog.register(newProvider);
		expect((await catalog.capabilitiesFor(newProvider))?.discovery).toEqual(
			currentDiscovery,
		);
		resolveOld({ observedAt: 1, evidence: [] });
		await oldRead;

		expect(mockSaveSetting).toHaveBeenCalledOnce();
		expect(mockSaveSetting).toHaveBeenCalledWith(
			expect.stringMatching(/^provider_capabilities:codex:[0-9a-f]{16}$/),
			JSON.stringify(currentDiscovery),
		);
	});

	it("does not reuse persisted capability evidence after runtime replacement", async () => {
		mockGetSetting.mockResolvedValue(
			JSON.stringify({
				observedAt: 1,
				evidence: [
					{
						id: "acp:opencode:old-runtime",
						label: "Old runtime capability",
						scope: "provider",
						support: "advertised",
						integration: "integrated",
						readiness: "ready",
						source: "provider-runtime",
					},
				],
			}),
		);
		const provider = makeProvider({
			providerId: "acp:opencode",
			discoverCapabilities: vi.fn().mockResolvedValue({
				observedAt: 2,
				evidence: [],
			}),
		});
		const catalog = createProviderCapabilityCatalog(
			new Map([[provider.providerId, provider]]),
			"/work/project",
		);

		catalog.register(provider, { refreshIdentity: true });
		const cached = await catalog.cachedCapabilitiesFor(
			provider,
			"/work/project",
		);

		expect(cached).toMatchObject({
			source: "fallback",
			discovery: { observedAt: 0, evidence: [] },
		});
		expect(mockGetSetting).not.toHaveBeenCalled();
		expect(provider.discoverCapabilities).not.toHaveBeenCalled();
	});

	it("isolates persisted capability evidence across runtime identities", async () => {
		let previousKey: string | undefined;
		mockGetSetting.mockImplementation((key: string) => {
			if (!previousKey) {
				previousKey = key;
				return Promise.resolve(JSON.stringify({ observedAt: 1, evidence: [] }));
			}
			return Promise.resolve(
				key === previousKey
					? JSON.stringify({ observedAt: 1, evidence: [] })
					: null,
			);
		});
		const oldProvider = makeProvider({
			providerId: "acp:opencode",
			metadataCacheIdentity: "old-runtime",
			discoverCapabilities: vi.fn(),
		});
		const oldCatalog = createProviderCapabilityCatalog(
			new Map([[oldProvider.providerId, oldProvider]]),
			"/work/project",
		);
		await expect(
			oldCatalog.cachedCapabilitiesFor(oldProvider, "/work/project"),
		).resolves.toMatchObject({
			source: "persisted",
			discovery: { observedAt: 1 },
		});

		const newProvider = makeProvider({
			providerId: "acp:opencode",
			metadataCacheIdentity: "new-runtime",
			discoverCapabilities: vi.fn(),
		});
		const restartedCatalog = createProviderCapabilityCatalog(
			new Map([[newProvider.providerId, newProvider]]),
			"/work/project",
		);
		await expect(
			restartedCatalog.cachedCapabilitiesFor(newProvider, "/work/project"),
		).resolves.toMatchObject({
			source: "fallback",
			discovery: { observedAt: 0 },
		});
		expect(mockGetSetting.mock.calls[0]?.[0]).not.toBe(
			mockGetSetting.mock.calls[1]?.[0],
		);
	});
});

describe("loadProviderCatalog", () => {
	it("keeps a targeted live read isolated from an unrelated unavailable workspace cache", async () => {
		const codex = makeProvider({ providerId: "codex" });
		const openCode = makeProvider({
			providerId: "acp:opencode",
			models: [],
			modelCatalogScope: "workspace",
			metadataCacheIdentityFor: vi.fn(() => {
				throw new Error("bare POSIX path on Windows");
			}),
			cachedAvailability: vi.fn(() => ({
				available: false,
				reason: "OpenCode has no WSL runtime configured",
			})),
			listModels: vi.fn(),
		});
		const providers = new Map([
			[codex.providerId, codex],
			[openCode.providerId, openCode],
		]);
		const models = createModelCatalog(providers);

		const result = await loadProviderCatalog(
			providers.values(),
			{
				modelsFor: models.modelsFor,
				cachedModelsFor: models.cachedModelsFor,
			},
			{
				includeProviderCapabilities: true,
				preferCachedProviderCapabilities: false,
				refreshProviderId: "codex",
				discoveryCwd: "/home/kyle/development/repos/hlid",
			},
		);

		expect(result.find((provider) => provider.id === "codex")).toMatchObject({
			available: true,
		});
		expect(
			result.find((provider) => provider.id === "acp:opencode"),
		).toMatchObject({
			available: false,
			unavailableReason: "OpenCode has no WSL runtime configured",
			models: [],
		});
		expect(openCode.listModels).not.toHaveBeenCalled();
	});

	it("preserves model-scoped effort semantics in the provider catalog", async () => {
		const provider = makeProvider({
			providerId: "acp:opencode",
			effortScope: "model",
			effortLevels: [{ value: "medium", label: "Medium" }],
		});

		const result = await loadProviderCatalog([provider], {
			modelsFor: vi
				.fn()
				.mockResolvedValue([{ value: "deepseek", label: "DeepSeek" }]),
		});

		expect(result[0]).toMatchObject({
			id: "acp:opencode",
			effortScope: "model",
			effortLevels: [{ value: "medium", label: "Medium" }],
		});
	});

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

	it("negotiates dynamic fork capability only for an explicit refresh", async () => {
		const provider = makeProvider({
			providerId: "acp:test",
			resolveForkCapability: vi.fn().mockResolvedValue({
				kind: "exact",
				wholeSession: true,
				throughMessage: false,
			}),
		});

		const catalog = {
			modelsFor: vi.fn().mockResolvedValue([]),
		};

		const cached = await loadProviderCatalog([provider], catalog);
		expect(cached[0]?.forkCapability).toBeUndefined();
		expect(provider.resolveForkCapability).not.toHaveBeenCalled();

		const result = await loadProviderCatalog([provider], catalog, {
			refresh: true,
		});

		expect(result[0]?.forkCapability).toEqual({
			kind: "exact",
			wholeSession: true,
			throughMessage: false,
		});
		expect(provider.resolveForkCapability).toHaveBeenCalledOnce();
		expect(provider.resolveForkCapability).toHaveBeenCalledWith({
			cwd: process.cwd(),
		});
	});

	it("reuses ready cached availability while exact-workspace metadata validates an ACP refresh", async () => {
		const check = vi.fn().mockResolvedValue({ available: true });
		const listModels = vi.fn();
		const resolveForkCapability = vi.fn().mockResolvedValue({
			kind: "exact" as const,
			wholeSession: true,
			throughMessage: false,
		});
		const provider = makeProvider({
			providerId: "acp:opencode",
			check,
			cachedAvailability: () => ({ available: true }),
			liveModelDiscoveryValidatesAvailability: true,
			listModels,
			resolveForkCapability,
		});
		const refreshModelsFor = vi.fn().mockResolvedValue({
			models: [{ value: "opencode/default", label: "Default" }],
			source: "live" as const,
		});

		const result = await loadProviderCatalog(
			[provider],
			{ modelsFor: vi.fn(), refreshModelsFor },
			{
				refresh: true,
				refreshProviderId: provider.providerId,
				discoveryCwd: "/work/exact-project",
			},
		);

		expect(result[0]).toMatchObject({
			available: true,
			models: [{ value: "opencode/default", label: "Default" }],
			modelCatalogRefresh: { status: "current", source: "live" },
		});
		expect(check).not.toHaveBeenCalled();
		expect(refreshModelsFor).toHaveBeenCalledWith(
			provider,
			"/work/exact-project",
		);
		expect(resolveForkCapability).toHaveBeenCalledWith({
			cwd: "/work/exact-project",
		});
	});

	it("reports a failed validating model inspection without hiding runtime disappearance", async () => {
		const check = vi.fn().mockResolvedValue({ available: true });
		const provider = makeProvider({
			providerId: "acp:opencode",
			check,
			cachedAvailability: () => ({ available: true }),
			liveModelDiscoveryValidatesAvailability: true,
			listModels: vi.fn(),
		});

		const result = await loadProviderCatalog(
			[provider],
			{
				modelsFor: vi.fn(),
				refreshModelsFor: vi.fn().mockResolvedValue({
					models: [{ value: "cached", label: "Cached" }],
					source: "memory" as const,
					reason: "Live model discovery did not return current options",
				}),
			},
			{
				refresh: true,
				refreshProviderId: provider.providerId,
			},
		);

		expect(result[0]).toMatchObject({
			available: false,
			unavailableReason: "Live model discovery did not return current options",
			models: [{ value: "cached", label: "Cached" }],
			modelCatalogRefresh: {
				status: "unavailable",
				source: "fallback",
				reason: "Live model discovery did not return current options",
			},
		});
		expect(check).not.toHaveBeenCalled();
	});

	it("runs the availability check when the cached ACP state needs recovery", async () => {
		const check = vi.fn().mockResolvedValue({ available: true });
		const provider = makeProvider({
			providerId: "acp:opencode",
			check,
			cachedAvailability: () => ({
				available: false,
				reason: "opencode is not installed",
			}),
			liveModelDiscoveryValidatesAvailability: true,
			listModels: vi.fn(),
		});

		const result = await loadProviderCatalog(
			[provider],
			{
				modelsFor: vi.fn(),
				refreshModelsFor: vi.fn().mockResolvedValue({
					models: [],
					source: "live" as const,
				}),
			},
			{ refresh: true, refreshProviderId: provider.providerId },
		);

		expect(check).toHaveBeenCalledOnce();
		expect(result[0]).toMatchObject({ available: true });
	});

	it("lets an explicit refresh populate an empty ACP cache", async () => {
		const listModels = vi
			.fn()
			.mockResolvedValue([{ value: "opencode/default", label: "Default" }]);
		const resolveForkCapability = vi.fn().mockResolvedValue({
			kind: "exact" as const,
			wholeSession: true,
			throughMessage: false,
		});
		const provider = makeProvider({
			providerId: "acp:opencode",
			models: [],
			listModels,
			resolveForkCapability,
		});
		const models = createModelCatalog(
			new Map([[provider.providerId, provider]]),
		);
		const sources = {
			modelsFor: models.modelsFor,
			refreshModelsFor: models.refreshModelsFor,
			cachedModelsFor: models.cachedModelsFor,
		};

		expect((await loadProviderCatalog([provider], sources))[0]?.models).toEqual(
			[],
		);
		expect(listModels).not.toHaveBeenCalled();
		expect(resolveForkCapability).not.toHaveBeenCalled();

		const refreshed = await loadProviderCatalog([provider], sources, {
			refresh: true,
			refreshProviderId: "acp:opencode",
		});

		expect(refreshed[0]?.models).toEqual([
			{ value: "opencode/default", label: "Default" },
		]);
		expect(refreshed[0]?.forkCapability).toMatchObject({
			kind: "exact",
			wholeSession: true,
		});
		expect(refreshed[0]?.modelCatalogRefresh).toEqual({
			status: "current",
			source: "live",
		});
		expect(listModels).toHaveBeenCalledOnce();
		expect(resolveForkCapability).toHaveBeenCalledOnce();
	});

	it("labels cached fallback from a provider-scoped refresh as stale", async () => {
		const provider = makeProvider({
			providerId: "acp:opencode",
			label: "OpenCode",
			check: vi.fn().mockResolvedValue({ available: true }),
		});
		const result = await loadProviderCatalog(
			[provider],
			{
				modelsFor: vi.fn(),
				refreshModelsFor: vi.fn().mockResolvedValue({
					models: [{ value: "cached", label: "Cached" }],
					source: "memory",
					reason: "Live model discovery did not return current options",
				}),
			},
			{ refresh: true, refreshProviderId: "acp:opencode" },
		);

		expect(result[0]).toMatchObject({
			models: [{ value: "cached", label: "Cached" }],
			modelCatalogRefresh: {
				status: "stale",
				source: "memory",
				reason: "Live model discovery did not return current options",
			},
		});
	});

	it("labels a failed provider check as unavailable without dropping cached models", async () => {
		const provider = makeProvider({
			providerId: "acp:opencode",
			label: "OpenCode",
			check: vi.fn().mockResolvedValue({
				available: false,
				reason: "ACP initialize failed",
			}),
		});
		const result = await loadProviderCatalog(
			[provider],
			{
				modelsFor: vi.fn(),
				refreshModelsFor: vi.fn(),
				cachedModelsFor: vi
					.fn()
					.mockResolvedValue([{ value: "cached", label: "Cached" }]),
			},
			{ refresh: true, refreshProviderId: "acp:opencode" },
		);

		expect(result[0]).toMatchObject({
			available: false,
			models: [{ value: "cached", label: "Cached" }],
			modelCatalogRefresh: {
				status: "unavailable",
				source: "fallback",
				reason: "ACP initialize failed",
			},
		});
	});

	it("limits a provider-scoped refresh to that ACP runtime", async () => {
		const openCode = makeProvider({
			providerId: "acp:opencode",
			check: vi.fn().mockResolvedValue({ available: true }),
			resolveForkCapability: vi.fn().mockResolvedValue(undefined),
		});
		const pi = makeProvider({
			providerId: "acp:pi-acp",
			check: vi.fn().mockResolvedValue({ available: true }),
			resolveForkCapability: vi.fn().mockResolvedValue(undefined),
		});
		const modelsFor = vi.fn().mockResolvedValue([]);
		const cachedModelsFor = vi.fn().mockResolvedValue([]);

		await loadProviderCatalog(
			[openCode, pi],
			{ modelsFor, cachedModelsFor },
			{ refresh: true, refreshProviderId: "acp:opencode" },
		);

		expect(openCode.check).toHaveBeenCalledOnce();
		expect(openCode.resolveForkCapability).toHaveBeenCalledOnce();
		expect(pi.check).not.toHaveBeenCalled();
		expect(pi.resolveForkCapability).not.toHaveBeenCalled();
		expect(modelsFor).toHaveBeenCalledOnce();
		expect(modelsFor).toHaveBeenCalledWith(openCode, true, process.cwd());
		expect(cachedModelsFor).toHaveBeenCalledWith(pi, process.cwd());
	});

	it("preserves a native fork capability when refresh negotiation is empty", async () => {
		const forkCapability = {
			kind: "exact",
			wholeSession: true,
			throughMessage: true,
		} as const;
		const provider = makeProvider({
			providerId: "native",
			forkCapability,
			resolveForkCapability: vi.fn().mockResolvedValue(undefined),
		});

		const result = await loadProviderCatalog(
			[provider],
			{ modelsFor: vi.fn().mockResolvedValue([]) },
			{ refresh: true },
		);

		expect(result[0]?.forkCapability).toEqual(forkCapability);
		expect(provider.resolveForkCapability).toHaveBeenCalledOnce();
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

	it("ordinary reads make no live provider calls", async () => {
		const check = vi.fn().mockResolvedValue({ available: true });
		const resolveForkCapability = vi.fn().mockResolvedValue({
			kind: "exact" as const,
			wholeSession: true,
			throughMessage: false,
		});
		const hostCapabilities = vi.fn(
			() => new Promise<Record<string, never>>(() => {}),
		);
		const discoverCapabilities = vi.fn().mockResolvedValue({
			observedAt: 1,
			evidence: [],
		});
		const provider = makeProvider({
			providerId: "acp:test",
			check,
			resolveForkCapability,
			hostCapabilities,
			discoverCapabilities,
		});
		const modelsFor = vi
			.fn()
			.mockResolvedValue([{ value: "live", label: "Live" }]);
		const cachedModelsFor = vi
			.fn()
			.mockResolvedValue([{ value: "cached", label: "Cached" }]);
		const cachedCapabilitiesFor = vi.fn().mockResolvedValue(undefined);

		const result = await loadProviderCatalog(
			[provider],
			{ modelsFor, cachedModelsFor, cachedCapabilitiesFor },
			{
				includeHostCapabilities: true,
				includeProviderCapabilities: true,
			},
		);

		expect(result[0]?.models).toEqual([{ value: "cached", label: "Cached" }]);
		expect(check).not.toHaveBeenCalled();
		expect(modelsFor).not.toHaveBeenCalled();
		expect(resolveForkCapability).not.toHaveBeenCalled();
		expect(hostCapabilities).not.toHaveBeenCalled();
		expect(discoverCapabilities).not.toHaveBeenCalled();
		expect(cachedModelsFor).toHaveBeenCalledOnce();
		expect(cachedCapabilitiesFor).toHaveBeenCalledOnce();
	});

	it("recovers host readiness without refreshing models or provider availability", async () => {
		const check = vi.fn().mockResolvedValue({ available: true });
		const hostCapabilities = vi.fn().mockResolvedValue({
			windowsComputerUse: {
				label: "Windows Computer Use",
				available: true,
			},
		});
		const provider = makeProvider({
			providerId: "codex",
			check,
			hostCapabilities,
		});
		const modelsFor = vi
			.fn()
			.mockResolvedValue([{ value: "live", label: "Live" }]);
		const cachedModelsFor = vi
			.fn()
			.mockResolvedValue([{ value: "cached", label: "Cached" }]);
		const snapshot = createProviderCatalogSnapshot([provider], {
			modelsFor,
			cachedModelsFor,
		});

		const initial = await snapshot.get({ includeHostCapabilities: true });
		expect(initial[0]?.hostCapabilities).toBeUndefined();

		const recovered = await snapshot.get({
			includeHostCapabilities: true,
			awaitHostCapabilities: true,
		});

		expect(recovered[0]).toMatchObject({
			models: [{ value: "cached", label: "Cached" }],
			hostCapabilities: {
				windowsComputerUse: {
					label: "Windows Computer Use",
					available: true,
				},
			},
		});
		expect(hostCapabilities).toHaveBeenCalledOnce();
		expect(check).not.toHaveBeenCalled();
		expect(modelsFor).not.toHaveBeenCalled();
		expect(cachedModelsFor).toHaveBeenCalledTimes(2);
	});

	it("uses a provider's cached availability without probing it", async () => {
		const check = vi.fn().mockResolvedValue({ available: true });
		const provider = makeProvider({
			providerId: "acp:test",
			check,
			cachedAvailability: () => ({
				available: false,
				reason: "test-agent is not installed",
			}),
		});

		const result = await loadProviderCatalog([provider], {
			modelsFor: vi.fn(),
			cachedModelsFor: vi.fn().mockResolvedValue([]),
		});

		expect(result[0]).toMatchObject({
			available: false,
			unavailableReason: "test-agent is not installed",
		});
		expect(check).not.toHaveBeenCalled();
	});

	it("bounds an explicit refresh before starting dependent provider probes", async () => {
		vi.useFakeTimers();
		try {
			const check = vi.fn(() => new Promise<{ available: boolean }>(() => {}));
			const modelsFor = vi.fn().mockResolvedValue([]);
			const resolveForkCapability = vi.fn().mockResolvedValue(undefined);
			const provider = makeProvider({
				providerId: "acp:test",
				check,
				resolveForkCapability,
			});

			const pending = loadProviderCatalog(
				[provider],
				{ modelsFor },
				{ refresh: true },
			);
			await vi.advanceTimersByTimeAsync(12_001);

			await expect(pending).resolves.toEqual([
				expect.objectContaining({
					id: "acp:test",
					available: false,
					unavailableReason: "check failed",
				}),
			]);
			expect(check).toHaveBeenCalledOnce();
			expect(modelsFor).not.toHaveBeenCalled();
			expect(resolveForkCapability).not.toHaveBeenCalled();
		} finally {
			vi.useRealTimers();
		}
	});

	it("runs host capability probes only when requested by an explicit refresh", async () => {
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
			{ refresh: true, includeHostCapabilities: true },
		);

		expect(hostCapabilities).toHaveBeenCalledOnce();
		expect(result[0]?.hostCapabilities).toEqual({
			windowsComputerUse: { label: "Windows Computer Use", available: true },
		});
	});

	it("publishes provider-owned structured capability metadata", async () => {
		const provider = makeProvider({
			providerId: "codex",
			capabilities: {
				goalControl: true,
				structuredActivities: ["compact", "review"],
				realtime: true,
			},
		});
		const result = await loadProviderCatalog([provider], {
			modelsFor: vi.fn().mockResolvedValue([]),
		});

		expect(result[0]?.capabilities).toEqual({
			goalControl: true,
			structuredActivities: ["compact", "review"],
			realtime: true,
		});
		expect(result[0]?.capabilities?.structuredActivities).not.toBe(
			provider.capabilities?.structuredActivities,
		);
	});

	it("only discovers provider evidence for an explicit refresh", async () => {
		const discoverCapabilities = vi.fn().mockResolvedValue({
			observedAt: 100,
			permissionProfiles: [
				{
					id: "workspace-safe",
					description: "Writes only inside the workspace.",
					allowed: true,
				},
			],
			evidence: [
				{
					id: "codex:experimental-feature:apps",
					label: "Apps",
					scope: "provider",
					support: "advertised",
					integration: "provider-native",
					readiness: "ready",
					source: "provider-runtime",
				},
			],
		});
		const provider = makeProvider({
			providerId: "codex",
			capabilities: { goalControl: true },
			discoverCapabilities,
		});
		const catalog = { modelsFor: vi.fn().mockResolvedValue([]) };

		expect(
			(await loadProviderCatalog([provider], catalog))[0]?.capabilitySnapshot,
		).toBeUndefined();
		expect(
			(await loadProviderCatalog([provider], catalog))[0]?.permissionProfiles,
		).toBeUndefined();
		expect(discoverCapabilities).not.toHaveBeenCalled();

		const cached = await loadProviderCatalog([provider], catalog, {
			includeProviderCapabilities: true,
			discoveryCwd: "/work/project",
		});
		expect(discoverCapabilities).not.toHaveBeenCalled();
		expect(cached[0]?.capabilitySnapshot).toMatchObject({
			source: "adapter",
			context: { cwd: "/work/project" },
		});

		const result = await loadProviderCatalog([provider], catalog, {
			refresh: true,
			includeProviderCapabilities: true,
			discoveryCwd: "/work/project",
		});
		expect(discoverCapabilities).toHaveBeenCalledWith({ cwd: "/work/project" });
		expect(result[0]?.capabilitySnapshot).toMatchObject({
			status: "current",
			source: "live",
			context: { cwd: "/work/project" },
			capabilities: expect.arrayContaining([
				expect.objectContaining({
					id: "codex:experimental-feature:apps",
					availability: "provider-native",
				}),
			]),
		});
		expect(result[0]?.permissionProfiles).toEqual([
			{
				id: "workspace-safe",
				label: "workspace-safe",
				description: "Writes only inside the workspace.",
				allowed: true,
			},
		]);
	});

	it("keeps an explicit uncached capability read scoped to that probe", async () => {
		const check = vi.fn().mockResolvedValue({ available: true });
		const modelsFor = vi.fn().mockResolvedValue([]);
		const cachedModelsFor = vi
			.fn()
			.mockResolvedValue([{ value: "cached", label: "Cached" }]);
		const resolveForkCapability = vi.fn().mockResolvedValue(undefined);
		const capabilitiesFor = vi.fn().mockResolvedValue({
			source: "live" as const,
			discovery: { observedAt: 1, evidence: [] },
		});
		const provider = makeProvider({
			providerId: "codex",
			check,
			resolveForkCapability,
		});

		const result = await loadProviderCatalog(
			[provider],
			{ modelsFor, cachedModelsFor, capabilitiesFor },
			{
				includeProviderCapabilities: true,
				preferCachedProviderCapabilities: false,
				discoveryCwd: "/work/project",
			},
		);

		expect(result[0]?.models).toEqual([{ value: "cached", label: "Cached" }]);
		expect(check).toHaveBeenCalledOnce();
		expect(capabilitiesFor).toHaveBeenCalledWith(
			provider,
			"/work/project",
			true,
		);
		expect(modelsFor).not.toHaveBeenCalled();
		expect(resolveForkCapability).not.toHaveBeenCalled();
	});

	it("attributes live capability timing once while retaining cached snapshot timing", async () => {
		vi.useFakeTimers();
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			const provider = makeProvider({ providerId: "timed-capability" });
			const discovery = {
				source: "live" as const,
				discovery: { observedAt: 1, evidence: [] },
			};
			const delayedDiscovery = () =>
				new Promise<typeof discovery>((resolve) => {
					setTimeout(() => resolve(discovery), 1_100);
				});
			const catalog = {
				modelsFor: vi.fn().mockResolvedValue([]),
				cachedModelsFor: vi.fn().mockResolvedValue([]),
				capabilitiesFor: vi.fn(delayedDiscovery),
				cachedCapabilitiesFor: vi.fn(delayedDiscovery),
			};

			const live = loadProviderCatalog([provider], catalog, {
				includeProviderCapabilities: true,
				preferCachedProviderCapabilities: false,
				discoveryCwd: "/work/project",
			});
			await vi.advanceTimersByTimeAsync(1_100);
			await live;

			const cached = loadProviderCatalog([provider], catalog, {
				includeProviderCapabilities: true,
				discoveryCwd: "/work/project",
			});
			await vi.advanceTimersByTimeAsync(1_100);
			await cached;

			const capabilityWarnings = warn.mock.calls
				.map(([message]) => String(message))
				.filter((message) =>
					message.includes("timed-capability provider-capability"),
				);
			expect(capabilityWarnings).toEqual([
				"[provider catalog] timed-capability provider-capability discovery took 1100ms",
				"[provider catalog] timed-capability provider-capability snapshot took 1100ms",
			]);
		} finally {
			warn.mockRestore();
			vi.useRealTimers();
		}
	});
});

describe("createProviderCatalogSnapshot", () => {
	it("publishes fresh models and realtime evidence after a runtime restart", async () => {
		let runtime = "old" as "old" | "new";
		const provider = makeProvider({
			providerId: "codex",
			listModels: vi.fn(
				(): Promise<ProviderModelInfo[]> =>
					Promise.resolve([
						{
							value: runtime === "old" ? "old-model" : "new-audio-model",
							label: runtime === "old" ? "Old model" : "New audio model",
							inputModalities: runtime === "old" ? ["text"] : ["text", "audio"],
						},
					]),
			),
			discoverCapabilities: vi.fn(() =>
				Promise.resolve({
					observedAt: runtime === "old" ? 1 : 2,
					evidence: [
						{
							id: "codex:experimental-feature:realtime_conversation",
							label: "Realtime conversation",
							scope: "provider" as const,
							support:
								runtime === "old"
									? ("not-advertised" as const)
									: ("advertised" as const),
							integration: "integrated" as const,
							readiness:
								runtime === "old"
									? ("unavailable" as const)
									: ("ready" as const),
							source: "provider-runtime" as const,
						},
					],
				}),
			),
		});
		const providers = new Map([["codex", provider]]);
		const models = createModelCatalog(providers);
		const capabilities = createProviderCapabilityCatalog(
			providers,
			"/work/project",
		);
		const snapshot = createProviderCatalogSnapshot([provider], {
			modelsFor: models.modelsFor,
			cachedModelsFor: models.cachedModelsFor,
			capabilitiesFor: capabilities.capabilitiesFor,
			cachedCapabilitiesFor: capabilities.cachedCapabilitiesFor,
		});
		const read = (refresh: boolean) =>
			snapshot.get({
				refresh,
				includeProviderCapabilities: true,
				preferCachedProviderCapabilities: !refresh,
				discoveryCwd: "/work/project",
			});

		const before = (await read(true))[0];
		expect(before?.models?.map((model) => model.value)).toEqual(["old-model"]);
		expect(
			before?.capabilitySnapshot?.capabilities.find(
				(capability) =>
					capability.id === "codex:experimental-feature:realtime_conversation",
			)?.availability,
		).toBe("unavailable");

		runtime = "new";
		mockGetSetting.mockResolvedValue(
			JSON.stringify([{ value: "old-model", label: "Persisted old model" }]),
		);
		models.register(provider, { refreshIdentity: true });
		capabilities.register(provider, { refreshIdentity: true });
		snapshot.invalidate();

		const cachedAfterRestart = (await read(false))[0];
		expect(cachedAfterRestart?.models).toEqual([
			{ value: "m1", label: "Model 1" },
		]);
		expect(provider.listModels).toHaveBeenCalledOnce();
		expect(provider.discoverCapabilities).toHaveBeenCalledOnce();

		const after = (await read(true))[0];
		expect(after?.models).toEqual([
			expect.objectContaining({
				value: "new-audio-model",
				inputModalities: ["text", "audio"],
			}),
		]);
		expect(
			after?.capabilitySnapshot?.capabilities.find(
				(capability) =>
					capability.id === "codex:experimental-feature:realtime_conversation",
			)?.availability,
		).toBe("available");
		expect(provider.listModels).toHaveBeenCalledTimes(2);
		expect(provider.discoverCapabilities).toHaveBeenCalledTimes(2);
	});

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
		const modelsFor = vi.fn().mockResolvedValue([]);
		const snapshot = createProviderCatalogSnapshot([provider], {
			modelsFor,
			cachedModelsFor,
		});

		const withCapabilities = await snapshot.get({
			refresh: true,
			includeHostCapabilities: true,
		});
		const repeated = await snapshot.get({ includeHostCapabilities: true });
		const base = await snapshot.get();

		expect(repeated).toBe(withCapabilities);
		expect(base[0]?.hostCapabilities).toBeUndefined();
		expect(check).toHaveBeenCalledOnce();
		expect(modelsFor).toHaveBeenCalledOnce();
		expect(cachedModelsFor).not.toHaveBeenCalled();
		expect(hostCapabilities).toHaveBeenCalledOnce();
	});

	it("does not reuse a provider capability snapshot across workspaces", async () => {
		const load = vi
			.fn()
			.mockImplementation(
				(
					_providers: AgentProvider[],
					_catalog: unknown,
					options: { discoveryCwd?: string },
				) =>
					Promise.resolve([
						{
							id: "codex",
							label: "Codex",
							available: true,
							models: [],
							capabilitySnapshot: {
								contractVersion: 1 as const,
								providerId: "codex",
								status: "current" as const,
								source: "live" as const,
								revision: options.discoveryCwd ?? "unknown",
								observedAt: 1,
								context: { cwd: options.discoveryCwd ?? "unknown" },
								capabilities: [],
							},
						},
					]),
			);
		const snapshot = createProviderCatalogSnapshot(
			[makeProvider({ providerId: "codex" })],
			{ modelsFor: vi.fn() },
			{ load },
		);

		const first = await snapshot.get({
			includeProviderCapabilities: true,
			discoveryCwd: "/work/one",
		});
		const second = await snapshot.get({
			includeProviderCapabilities: true,
			discoveryCwd: "/work/two",
		});
		const repeated = await snapshot.get({
			includeProviderCapabilities: true,
			discoveryCwd: "/work/one",
		});

		expect(first[0]?.capabilitySnapshot?.context).toEqual({ cwd: "/work/one" });
		expect(second[0]?.capabilitySnapshot?.context).toEqual({
			cwd: "/work/two",
		});
		expect(repeated).toBe(first);
		expect(load).toHaveBeenCalledTimes(2);
	});

	it("does not reuse an assembled model snapshot across workspaces", async () => {
		const load: typeof loadProviderCatalog = vi.fn(
			(_providers, _catalog, options = {}) =>
				Promise.resolve([
					{
						id: "acp:opencode",
						label: "OpenCode",
						available: true,
						models: [
							{
								value: options.discoveryCwd ?? "unknown",
								label: options.discoveryCwd ?? "unknown",
							},
						],
					},
				]),
		);
		const snapshot = createProviderCatalogSnapshot(
			[makeProvider({ providerId: "acp:opencode" })],
			{ modelsFor: vi.fn() },
			{ load },
		);

		const first = await snapshot.get({ discoveryCwd: "/work/one" });
		const second = await snapshot.get({ discoveryCwd: "/work/two" });
		const repeated = await snapshot.get({ discoveryCwd: "/work/one" });

		expect(first[0]?.models?.[0]?.value).toBe("/work/one");
		expect(second[0]?.models?.[0]?.value).toBe("/work/two");
		expect(repeated).toBe(first);
		expect(load).toHaveBeenCalledTimes(2);
	});

	it("rematerializes another workspace from cached metadata after a live observation", async () => {
		const windowsCwd = "C:\\Users\\Kyle\\project";
		const wslCwd =
			"\\\\wsl.localhost\\Ubuntu-24.04\\home\\kyle\\development\\project";
		const listModels = vi.fn(({ cwd }: { cwd: string }) =>
			Promise.resolve([{ value: cwd, label: cwd }]),
		);
		const provider = makeProvider({
			providerId: "acp:opencode",
			modelCatalogScope: "workspace",
			listModels,
		});
		let snapshot!: ReturnType<typeof createProviderCatalogSnapshot>;
		const models = createModelCatalog(
			new Map([[provider.providerId, provider]]),
			(providerId) => snapshot.invalidateMetadata(providerId),
		);
		snapshot = createProviderCatalogSnapshot([provider], {
			modelsFor: models.modelsFor,
			refreshModelsFor: models.refreshModelsFor,
			cachedModelsFor: models.cachedModelsFor,
		});

		await snapshot.get({
			refresh: true,
			refreshProviderId: provider.providerId,
			discoveryCwd: wslCwd,
		});
		await snapshot.get({
			refresh: true,
			refreshProviderId: provider.providerId,
			discoveryCwd: windowsCwd,
		});
		const rematerializedWsl = await snapshot.get({ discoveryCwd: wslCwd });

		expect(rematerializedWsl[0]?.models).toEqual([
			{ value: wslCwd, label: wslCwd },
		]);
		expect(listModels).toHaveBeenCalledTimes(2);
		expect(listModels).toHaveBeenNthCalledWith(1, { cwd: wslCwd });
		expect(listModels).toHaveBeenNthCalledWith(2, { cwd: windowsCwd });
	});

	it("reads a dynamic default capability workspace after a hot vault change", async () => {
		let currentCwd = "/work/one";
		const load: typeof loadProviderCatalog = vi.fn(
			(_providers, _catalog, options = {}) =>
				Promise.resolve([
					{
						id: "acp:opencode",
						label: "OpenCode",
						available: true,
						models: [],
						capabilitySnapshot: {
							contractVersion: 1 as const,
							providerId: "acp:opencode",
							status: "current" as const,
							source: "live" as const,
							revision: options.discoveryCwd ?? "unknown",
							observedAt: 1,
							context: { cwd: options.discoveryCwd ?? "unknown" },
							capabilities: [],
						},
					},
				]),
		);
		const snapshot = createProviderCatalogSnapshot(
			[makeProvider({ providerId: "acp:opencode" })],
			{ modelsFor: vi.fn() },
			{ load, discoveryCwd: () => currentCwd },
		);

		const first = await snapshot.get({ includeProviderCapabilities: true });
		currentCwd = "/work/two";
		const second = await snapshot.get({ includeProviderCapabilities: true });

		expect(first[0]?.capabilitySnapshot?.context).toEqual({ cwd: "/work/one" });
		expect(second[0]?.capabilitySnapshot?.context).toEqual({
			cwd: "/work/two",
		});
		expect(load).toHaveBeenCalledTimes(2);
	});

	it("strips permission profiles from capability-free projections", async () => {
		const load = vi.fn().mockResolvedValue([
			{
				id: "codex",
				label: "Codex",
				available: true,
				models: [],
				permissionProfiles: [
					{
						id: "workspace-safe",
						label: "workspace-safe",
						allowed: true,
					},
				],
				capabilitySnapshot: {
					contractVersion: 1 as const,
					providerId: "codex",
					status: "current" as const,
					source: "live" as const,
					revision: "permission-profile-test",
					observedAt: 1,
					capabilities: [],
				},
			},
		]);
		const snapshot = createProviderCatalogSnapshot(
			[makeProvider({ providerId: "codex" })],
			{ modelsFor: vi.fn(), cachedModelsFor: vi.fn() },
			{ load },
		);

		const base = await snapshot.get();
		const rich = await snapshot.get({
			refresh: true,
			includeProviderCapabilities: true,
			discoveryCwd: "/work/project",
		});

		expect(rich[0]?.permissionProfiles).toHaveLength(1);
		expect(base[0]?.permissionProfiles).toBeUndefined();
		expect(base[0]?.capabilitySnapshot).toBeUndefined();
		expect(load).toHaveBeenCalledTimes(2);
	});

	it("preserves permission profiles with last-known live capability fields", async () => {
		const permissionProfiles = [
			{
				id: "workspace-safe",
				label: "workspace-safe",
				description: "Writes only inside the workspace.",
				allowed: true,
			},
		];
		const capabilitySnapshot = {
			contractVersion: 1 as const,
			providerId: "codex",
			status: "current" as const,
			source: "live" as const,
			revision: "live-permission-profiles",
			observedAt: 1,
			capabilities: [],
		};
		const load = vi.fn((_providers, _catalog, options) =>
			Promise.resolve([
				{
					id: "codex",
					label: "Codex",
					available: true,
					models: options.refresh
						? [{ value: "live", label: "Live" }]
						: [{ value: "cached", label: "Cached" }],
					...(options.refresh
						? { permissionProfiles, capabilitySnapshot }
						: {}),
				},
			]),
		);
		const snapshot = createProviderCatalogSnapshot(
			[makeProvider({ providerId: "codex" })],
			{ modelsFor: vi.fn(), cachedModelsFor: vi.fn() },
			{ load },
		);
		const options = {
			includeProviderCapabilities: true,
			discoveryCwd: "/work/project",
		};

		await snapshot.get({ ...options, refresh: true });
		snapshot.invalidateMetadata();
		const rematerialized = await snapshot.get(options);

		expect(rematerialized[0]?.models).toEqual([
			{ value: "cached", label: "Cached" },
		]);
		expect(rematerialized[0]?.permissionProfiles).toEqual(permissionProfiles);
		expect(rematerialized[0]?.capabilitySnapshot).toEqual(capabilitySnapshot);
		expect(load).toHaveBeenCalledTimes(2);
	});

	it("re-materializes stale data in the background without live provider work", async () => {
		let now = 0;
		const check = vi
			.fn()
			.mockResolvedValue({ available: false, reason: "missing" });
		const cachedModelsFor = vi.fn().mockResolvedValue([]);
		const provider = makeProvider({ providerId: "codex", check });
		const snapshot = createProviderCatalogSnapshot(
			[provider],
			{
				modelsFor: vi.fn(),
				cachedModelsFor,
			},
			{ ttlMs: 100, now: () => now },
		);

		expect((await snapshot.get({ refresh: true }))[0]?.available).toBe(false);
		now = 101;
		expect((await snapshot.get())[0]?.available).toBe(false);
		await vi.waitFor(() => expect(cachedModelsFor).toHaveBeenCalledTimes(2));
		expect(check).toHaveBeenCalledOnce();
		expect((await snapshot.get())[0]?.available).toBe(false);
	});

	it("preserves live-only fields while stale snapshots re-materialize from cache", async () => {
		let now = 0;
		const forkCapability = {
			kind: "exact" as const,
			wholeSession: true,
			throughMessage: false,
		};
		const check = vi.fn().mockResolvedValue({ available: true });
		const resolveForkCapability = vi.fn().mockResolvedValue(forkCapability);
		const hostCapabilities = vi.fn().mockResolvedValue({
			windowsComputerUse: { label: "Windows Computer Use", available: true },
		});
		const cachedModelsFor = vi.fn().mockResolvedValue([]);
		const provider = makeProvider({
			providerId: "acp:test",
			check,
			resolveForkCapability,
			hostCapabilities,
		});
		const snapshot = createProviderCatalogSnapshot(
			[provider],
			{
				modelsFor: vi.fn().mockResolvedValue([]),
				cachedModelsFor,
			},
			{ ttlMs: 100, now: () => now },
		);

		await snapshot.get({ refresh: true, includeHostCapabilities: true });
		now = 101;
		await snapshot.get({ includeHostCapabilities: true });
		await vi.waitFor(() => expect(cachedModelsFor).toHaveBeenCalledOnce());
		const rematerialized = (
			await snapshot.get({ includeHostCapabilities: true })
		)[0];

		expect(rematerialized).toMatchObject({
			available: true,
			forkCapability,
			hostCapabilities: {
				windowsComputerUse: {
					label: "Windows Computer Use",
					available: true,
				},
			},
		});
		expect(check).toHaveBeenCalledOnce();
		expect(resolveForkCapability).toHaveBeenCalledOnce();
		expect(hostCapabilities).toHaveBeenCalledOnce();
	});

	it("preserves other ACP runtimes during a provider-scoped refresh", async () => {
		const piFork = {
			kind: "exact" as const,
			wholeSession: true as const,
			throughMessage: false as const,
		};
		const load = vi.fn(async (_providers, _catalog, options) => [
			{
				id: "acp:opencode",
				label: "OpenCode",
				available: true,
				models: options.refreshProviderId
					? []
					: [{ value: "old-model", label: "Old Model" }],
			},
			{
				id: "acp:pi-acp",
				label: "Pi ACP",
				available: Boolean(options.refreshProviderId),
				...(options.refreshProviderId
					? {}
					: {
							unavailableReason: "Pi is not installed",
							forkCapability: piFork,
						}),
				models: [],
			},
		]);
		const snapshot = createProviderCatalogSnapshot(
			[
				makeProvider({ providerId: "acp:opencode" }),
				makeProvider({ providerId: "acp:pi-acp" }),
			],
			{
				modelsFor: vi.fn(),
				cachedModelsFor: vi.fn().mockResolvedValue([]),
			},
			{ load },
		);

		await snapshot.get({ refresh: true });
		const refreshed = await snapshot.get({
			refresh: true,
			refreshProviderId: "acp:opencode",
		});

		expect(
			refreshed.find((provider) => provider.id === "acp:opencode")?.models,
		).toEqual([]);
		expect(
			refreshed.find((provider) => provider.id === "acp:pi-acp"),
		).toMatchObject({
			available: false,
			unavailableReason: "Pi is not installed",
			forkCapability: piFork,
		});
	});

	it("recomputes after explicit invalidation", async () => {
		const check = vi.fn().mockResolvedValue({ available: true });
		const cachedModelsFor = vi.fn().mockResolvedValue([]);
		const provider = makeProvider({ providerId: "codex", check });
		const snapshot = createProviderCatalogSnapshot([provider], {
			modelsFor: vi.fn(),
			cachedModelsFor,
		});

		await snapshot.get();
		snapshot.invalidate();
		await snapshot.get();

		expect(cachedModelsFor).toHaveBeenCalledTimes(2);
		expect(check).not.toHaveBeenCalled();
	});

	it("retains a live refresh when its metadata cache invalidates the snapshot", async () => {
		const provider = makeProvider({ providerId: "acp:test" });
		let snapshot!: ReturnType<typeof createProviderCatalogSnapshot>;
		const load = vi.fn(async () => {
			// Successful model/capability discovery invalidates the derived
			// snapshot through its cache onChange callback before returning.
			snapshot.invalidateMetadata();
			return [
				{
					id: "acp:test",
					label: "ACP Test",
					available: true,
					models: [{ value: "agent/model", label: "Agent Model" }],
					forkCapability: {
						kind: "exact" as const,
						wholeSession: true as const,
						throughMessage: false as const,
					},
				},
			];
		});
		snapshot = createProviderCatalogSnapshot(
			[provider],
			{
				modelsFor: vi.fn(),
				cachedModelsFor: vi.fn().mockResolvedValue([]),
			},
			{ load },
		);

		await snapshot.get({ refresh: true });
		const cached = await snapshot.get();

		expect(load).toHaveBeenCalledOnce();
		expect(cached[0]).toMatchObject({
			models: [{ value: "agent/model", label: "Agent Model" }],
			forkCapability: { kind: "exact" },
		});
	});

	it("does not let an older live refresh overwrite newer metadata", async () => {
		let resolveFirst: ((value: ProviderInfo[]) => void) | undefined;
		let resolveSecond: ((value: ProviderInfo[]) => void) | undefined;
		const load = vi
			.fn()
			.mockImplementationOnce(
				() =>
					new Promise<ProviderInfo[]>((resolve) => {
						resolveFirst = resolve;
					}),
			)
			.mockImplementationOnce(
				() =>
					new Promise<ProviderInfo[]>((resolve) => {
						resolveSecond = resolve;
					}),
			);
		const snapshot = createProviderCatalogSnapshot(
			[makeProvider({ providerId: "acp:test" })],
			{
				modelsFor: vi.fn(),
				cachedModelsFor: vi.fn().mockResolvedValue([]),
			},
			{ load },
		);

		const older = snapshot.get({ refresh: true });
		snapshot.invalidateMetadata();
		const newer = snapshot.get({ refresh: true });
		resolveSecond?.([
			{
				id: "acp:test",
				label: "ACP Test",
				available: true,
				models: [{ value: "new", label: "New" }],
			},
		]);
		await newer;
		resolveFirst?.([
			{
				id: "acp:test",
				label: "ACP Test",
				available: true,
				models: [{ value: "old", label: "Old" }],
			},
		]);
		await older;

		expect((await snapshot.get())[0]?.models).toEqual([
			{ value: "new", label: "New" },
		]);
		expect(load).toHaveBeenCalledTimes(2);
	});

	it("does not return a superseded targeted live refresh as current", async () => {
		let resolveOlder: ((value: ProviderInfo[]) => void) | undefined;
		let resolveNewer: ((value: ProviderInfo[]) => void) | undefined;
		const stale = [
			{
				id: "acp:a",
				label: "ACP A",
				available: true,
				models: [{ value: "a/old", label: "A Old" }],
			},
		];
		const fresh = [
			{
				id: "acp:a",
				label: "ACP A",
				available: true,
				models: [{ value: "a/new", label: "A New" }],
			},
		];
		const load = vi
			.fn()
			.mockImplementationOnce(
				() =>
					new Promise<ProviderInfo[]>((resolve) => {
						resolveOlder = resolve;
					}),
			)
			.mockImplementationOnce(
				() =>
					new Promise<ProviderInfo[]>((resolve) => {
						resolveNewer = resolve;
					}),
			)
			.mockResolvedValue(fresh);
		const snapshot = createProviderCatalogSnapshot(
			[makeProvider({ providerId: "acp:a" })],
			{
				modelsFor: vi.fn(),
				cachedModelsFor: vi.fn().mockResolvedValue([]),
			},
			{ load },
		);
		const options = {
			refresh: true,
			refreshProviderId: "acp:a",
		} as const;

		const older = snapshot.getVersioned(options);
		snapshot.invalidateMetadata("acp:a");
		const newer = snapshot.getVersioned(options);
		resolveNewer?.(fresh);
		await newer;
		resolveOlder?.(stale);

		const result = await older;
		expect(result.providers[0]?.models).toEqual(fresh[0]?.models);
		expect(snapshot.isCurrentVersion(result.version)).toBe(true);
	});

	it("retries a versioned live refresh invalidated by a runtime replacement", async () => {
		let resolveFirst: ((value: ProviderInfo[]) => void) | undefined;
		const load = vi
			.fn()
			.mockImplementationOnce(
				() =>
					new Promise<ProviderInfo[]>((resolve) => {
						resolveFirst = resolve;
					}),
			)
			.mockResolvedValueOnce([
				{
					id: "acp:test",
					label: "ACP Test",
					available: true,
					models: [{ value: "new", label: "New" }],
				},
			]);
		const snapshot = createProviderCatalogSnapshot(
			[makeProvider({ providerId: "acp:test" })],
			{
				modelsFor: vi.fn(),
				cachedModelsFor: vi.fn().mockResolvedValue([]),
			},
			{ load },
		);

		const versioned = snapshot.getVersioned({ refresh: true });
		snapshot.invalidate();
		resolveFirst?.([
			{
				id: "acp:test",
				label: "ACP Test",
				available: true,
				models: [{ value: "old", label: "Old" }],
			},
		]);

		const result = await versioned;
		expect(result.providers).toEqual([
			expect.objectContaining({
				models: [{ value: "new", label: "New" }],
			}),
		]);
		expect(snapshot.isCurrentVersion(result.version)).toBe(true);
		expect(load).toHaveBeenCalledTimes(2);
	});

	it("retries a targeted live refresh after another provider changes metadata", async () => {
		let resolveFirst: ((value: ProviderInfo[]) => void) | undefined;
		const load = vi
			.fn()
			.mockImplementationOnce(
				() =>
					new Promise<ProviderInfo[]>((resolve) => {
						resolveFirst = resolve;
					}),
			)
			.mockResolvedValueOnce([
				{
					id: "acp:a",
					label: "ACP A",
					available: true,
					models: [{ value: "a/new", label: "A New" }],
				},
			]);
		const snapshot = createProviderCatalogSnapshot(
			[makeProvider({ providerId: "acp:a" })],
			{
				modelsFor: vi.fn(),
				cachedModelsFor: vi.fn().mockResolvedValue([]),
			},
			{ load },
		);

		const versioned = snapshot.getVersioned({
			refresh: true,
			refreshProviderId: "acp:a",
		});
		snapshot.invalidateMetadata("acp:b");
		resolveFirst?.([
			{
				id: "acp:a",
				label: "ACP A",
				available: true,
				models: [{ value: "a/old", label: "A Old" }],
			},
		]);

		const result = await versioned;
		expect(result.providers[0]?.models).toEqual([
			{ value: "a/new", label: "A New" },
		]);
		expect(snapshot.isCurrentVersion(result.version)).toBe(true);
		expect(load).toHaveBeenCalledTimes(2);
	});

	it("keeps a targeted live refresh across its own metadata publication", async () => {
		let snapshot!: ReturnType<typeof createProviderCatalogSnapshot>;
		const load = vi.fn(async () => {
			snapshot.invalidateMetadata("acp:a");
			return [
				{
					id: "acp:a",
					label: "ACP A",
					available: true,
					models: [{ value: "a/current", label: "A Current" }],
				},
			];
		});
		snapshot = createProviderCatalogSnapshot(
			[makeProvider({ providerId: "acp:a" })],
			{
				modelsFor: vi.fn(),
				cachedModelsFor: vi.fn().mockResolvedValue([]),
			},
			{ load },
		);

		const result = await snapshot.getVersioned({
			refresh: true,
			refreshProviderId: "acp:a",
		});

		expect(result.providers[0]?.models).toEqual([
			{ value: "a/current", label: "A Current" },
		]);
		expect(snapshot.isCurrentVersion(result.version)).toBe(true);
		expect(load).toHaveBeenCalledOnce();
	});

	it("returns a targeted capability read across its own metadata publication", async () => {
		let snapshot!: ReturnType<typeof createProviderCatalogSnapshot>;
		const load = vi.fn(async () => {
			snapshot.invalidateMetadata("codex");
			return [
				{
					id: "codex",
					label: "Codex",
					available: true,
					models: [],
					capabilitySnapshot: {
						contractVersion: 1 as const,
						providerId: "codex",
						status: "current" as const,
						source: "live" as const,
						revision: "v1-current",
						observedAt: 1,
						capabilities: [],
					},
				},
			];
		});
		snapshot = createProviderCatalogSnapshot(
			[makeProvider({ providerId: "codex" })],
			{
				modelsFor: vi.fn(),
				cachedModelsFor: vi.fn().mockResolvedValue([]),
			},
			{ load },
		);

		const result = await snapshot.getVersioned({
			includeProviderCapabilities: true,
			preferCachedProviderCapabilities: false,
			refreshProviderId: "codex",
			discoveryCwd: "/work/project",
		});

		expect(result.providers[0]?.capabilitySnapshot?.revision).toBe(
			"v1-current",
		);
		expect(snapshot.isCurrentVersion(result.version)).toBe(true);
		expect(load).toHaveBeenCalledOnce();
		snapshot.invalidateMetadata("codex");
		expect(snapshot.isCurrentVersion(result.version)).toBe(true);
		snapshot.invalidateMetadata();
		expect(snapshot.isCurrentVersion(result.version)).toBe(false);
	});

	it.each([
		["another provider", "claude"],
		["unscoped metadata", undefined],
	] as const)("retries a capability read after %s changes", async (_label, invalidationTarget) => {
		let snapshot!: ReturnType<typeof createProviderCatalogSnapshot>;
		let call = 0;
		const load = vi.fn(async () => {
			call += 1;
			if (call === 1) snapshot.invalidateMetadata(invalidationTarget);
			return [
				{
					id: "codex",
					label: "Codex",
					available: true,
					models: [],
					capabilitySnapshot: {
						contractVersion: 1 as const,
						providerId: "codex",
						status: "current" as const,
						source: "live" as const,
						revision: `v${call}`,
						observedAt: call,
						capabilities: [],
					},
				},
			];
		});
		snapshot = createProviderCatalogSnapshot(
			[makeProvider({ providerId: "codex" })],
			{
				modelsFor: vi.fn(),
				cachedModelsFor: vi.fn().mockResolvedValue([]),
			},
			{ load },
		);

		const result = await snapshot.getVersioned({
			includeProviderCapabilities: true,
			preferCachedProviderCapabilities: false,
			refreshProviderId: "codex",
			discoveryCwd: "/work/project",
		});

		expect(result.providers[0]?.capabilitySnapshot?.revision).toBe("v2");
		expect(load).toHaveBeenCalledTimes(2);
	});

	it("accepts catalog-wide capability publications from participating providers", async () => {
		let snapshot!: ReturnType<typeof createProviderCatalogSnapshot>;
		const load = vi.fn(async () => {
			snapshot.invalidateMetadata("codex");
			snapshot.invalidateMetadata("claude");
			return [
				{
					id: "codex",
					label: "Codex",
					available: true,
					models: [],
				},
				{
					id: "claude",
					label: "Claude",
					available: true,
					models: [],
				},
			];
		});
		snapshot = createProviderCatalogSnapshot(
			[
				makeProvider({ providerId: "codex" }),
				makeProvider({ providerId: "claude" }),
			],
			{
				modelsFor: vi.fn(),
				cachedModelsFor: vi.fn().mockResolvedValue([]),
			},
			{ load },
		);

		const result = await snapshot.getVersioned({
			includeProviderCapabilities: true,
			preferCachedProviderCapabilities: false,
			discoveryCwd: "/work/project",
		});

		expect(result.providers.map((provider) => provider.id)).toEqual([
			"codex",
			"claude",
		]);
		expect(load).toHaveBeenCalledOnce();
	});

	it("does not livelock concurrent targeted capability publications", async () => {
		let snapshot!: ReturnType<typeof createProviderCatalogSnapshot>;
		const providers = [
			makeProvider({ providerId: "codex" }),
			makeProvider({ providerId: "acp:test" }),
		];
		const load = vi.fn(async (_providers, _catalog, options) => {
			const target = options.refreshProviderId;
			if (target) snapshot.invalidateMetadata(target);
			await Promise.resolve();
			return providers.map((provider) => ({
				id: provider.providerId,
				label: provider.label ?? provider.providerId,
				available: true,
				models: [],
				capabilitySnapshot: {
					contractVersion: 1 as const,
					providerId: provider.providerId,
					status: "current" as const,
					source: "live" as const,
					revision: `${target ?? "all"}-current`,
					observedAt: 1,
					capabilities: [],
				},
			}));
		});
		snapshot = createProviderCatalogSnapshot(
			providers,
			{
				modelsFor: vi.fn(),
				cachedModelsFor: vi.fn().mockResolvedValue([]),
			},
			{ load },
		);
		const options = (refreshProviderId: string) => ({
			includeProviderCapabilities: true,
			preferCachedProviderCapabilities: false,
			refreshProviderId,
			discoveryCwd: "/work/project",
		});

		const [codex, acp] = await Promise.all([
			snapshot.getVersioned(options("codex")),
			snapshot.getVersioned(options("acp:test")),
		]);

		expect(codex.providers).toHaveLength(2);
		expect(acp.providers).toHaveLength(2);
		expect(load.mock.calls.map((call) => call[2].refreshProviderId)).toEqual([
			"codex",
			"acp:test",
		]);
	});

	it("keeps concurrent capability publications current across workspaces", async () => {
		const providers = [
			makeProvider({ providerId: "codex" }),
			makeProvider({ providerId: "acp:test" }),
		];
		const resolvers = new Map<string, (value: ProviderInfo[]) => void>();
		const projection = (target: string, discoveryCwd: string): ProviderInfo[] =>
			providers.map((provider) => ({
				id: provider.providerId,
				label: provider.label ?? provider.providerId,
				available: true,
				models: [],
				...(provider.providerId === target
					? {
							capabilitySnapshot: {
								contractVersion: 1 as const,
								providerId: target,
								status: "current" as const,
								source: "live" as const,
								revision: `${target}:${discoveryCwd}`,
								observedAt: 1,
								context: { cwd: discoveryCwd },
								capabilities: [],
							},
						}
					: {}),
			}));
		const load = vi.fn((_providers, _catalog, options) => {
			const target = options.refreshProviderId ?? "all-providers";
			return new Promise<ProviderInfo[]>((resolve) => {
				resolvers.set(target, resolve);
			});
		});
		const snapshot = createProviderCatalogSnapshot(
			providers,
			{
				modelsFor: vi.fn(),
				cachedModelsFor: vi.fn().mockResolvedValue([]),
			},
			{ load },
		);
		const options = (discoveryCwd: string) => ({
			includeProviderCapabilities: true,
			preferCachedProviderCapabilities: false,
			refreshProviderId: "acp:test",
			discoveryCwd,
		});

		const codex = snapshot.getVersioned({
			...options("/work/codex"),
			refreshProviderId: "codex",
		});
		const acp = snapshot.getVersioned({
			...options("/work/acp"),
			refreshProviderId: "acp:test",
		});

		expect(load).toHaveBeenCalledTimes(2);
		snapshot.invalidateMetadata("acp:test");
		resolvers.get("acp:test")?.(projection("acp:test", "/work/acp"));
		const acpResult = await acp;
		snapshot.invalidateMetadata("codex");
		resolvers.get("codex")?.(projection("codex", "/work/codex"));
		const codexResult = await codex;

		expect(load).toHaveBeenCalledTimes(2);
		expect(acpResult.providers[1]?.capabilitySnapshot).toMatchObject({
			revision: "acp:test:/work/acp",
			context: { cwd: "/work/acp" },
		});
		expect(codexResult.providers[0]?.capabilitySnapshot).toMatchObject({
			revision: "codex:/work/codex",
			context: { cwd: "/work/codex" },
		});
		expect(snapshot.isCurrentVersion(acpResult.version)).toBe(true);
		expect(snapshot.isCurrentVersion(codexResult.version)).toBe(true);
	});

	it("continues a workspace capability queue after a failed read", async () => {
		const providers = [
			makeProvider({ providerId: "codex" }),
			makeProvider({ providerId: "acp:test" }),
		];
		const projection = providers.map((provider) => ({
			id: provider.providerId,
			label: provider.label ?? provider.providerId,
			available: true,
			models: [],
		}));
		const load = vi
			.fn()
			.mockRejectedValueOnce(new Error("probe failed"))
			.mockResolvedValueOnce(projection);
		const snapshot = createProviderCatalogSnapshot(
			providers,
			{
				modelsFor: vi.fn(),
				cachedModelsFor: vi.fn().mockResolvedValue([]),
			},
			{ load },
		);
		const options = (refreshProviderId: string) => ({
			includeProviderCapabilities: true,
			preferCachedProviderCapabilities: false,
			refreshProviderId,
			discoveryCwd: "/work/project",
		});

		const failed = snapshot.getVersioned(options("codex"));
		const recovered = snapshot.getVersioned(options("acp:test"));

		await expect(failed).rejects.toThrow("probe failed");
		await expect(recovered).resolves.toMatchObject({ providers: projection });
		expect(load).toHaveBeenCalledTimes(2);
	});

	it("does not store a capability-only model projection", async () => {
		const load = vi.fn((_providers, _catalog, options) =>
			Promise.resolve([
				{
					id: "codex",
					label: "Codex",
					available: true,
					models:
						options.preferCachedProviderCapabilities === false
							? [{ value: "capability-model", label: "Capability" }]
							: [{ value: "cached-model", label: "Cached" }],
				},
			]),
		);
		const snapshot = createProviderCatalogSnapshot(
			[makeProvider({ providerId: "codex" })],
			{
				modelsFor: vi.fn(),
				cachedModelsFor: vi.fn().mockResolvedValue([]),
			},
			{ load },
		);
		const options = {
			includeProviderCapabilities: true,
			discoveryCwd: "/work/project",
		} as const;

		const live = await snapshot.get({
			...options,
			preferCachedProviderCapabilities: false,
			refreshProviderId: "codex",
		});
		const cached = await snapshot.get(options);

		expect(live[0]?.models?.[0]?.value).toBe("capability-model");
		expect(cached[0]?.models?.[0]?.value).toBe("cached-model");
		expect(load).toHaveBeenCalledTimes(2);
	});

	it("single-flights identical direct capability reads", async () => {
		let resolveLoad: ((value: ProviderInfo[]) => void) | undefined;
		const load = vi.fn(
			() =>
				new Promise<ProviderInfo[]>((resolve) => {
					resolveLoad = resolve;
				}),
		);
		const snapshot = createProviderCatalogSnapshot(
			[makeProvider({ providerId: "codex" })],
			{
				modelsFor: vi.fn(),
				cachedModelsFor: vi.fn().mockResolvedValue([]),
			},
			{ load },
		);
		const options = {
			includeProviderCapabilities: true,
			preferCachedProviderCapabilities: false,
			refreshProviderId: "codex",
			discoveryCwd: "/work/project",
		} as const;

		const first = snapshot.getVersioned(options);
		const second = snapshot.getVersioned(options);
		expect(load).toHaveBeenCalledOnce();
		resolveLoad?.([
			{
				id: "codex",
				label: "Codex",
				available: true,
				models: [],
			},
		]);

		await expect(Promise.all([first, second])).resolves.toHaveLength(2);
		expect(load).toHaveBeenCalledOnce();
	});

	it("does not retry a capability read for an unrelated provider refresh in another workspace", async () => {
		let resolveCapability: ((value: ProviderInfo[]) => void) | undefined;
		let capabilityCalls = 0;
		const capabilityProjection: ProviderInfo[] = [
			{
				id: "codex",
				label: "Codex",
				available: true,
				models: [],
				capabilitySnapshot: {
					contractVersion: 1,
					providerId: "codex",
					status: "current",
					source: "live",
					revision: "codex-current",
					observedAt: 1,
					capabilities: [],
				},
			},
		];
		const load = vi.fn((_providers, _catalog, options) => {
			if (options.refresh) {
				return Promise.resolve<ProviderInfo[]>([
					{
						id: "claude",
						label: "Claude",
						available: true,
						models: [{ value: "claude/new", label: "Claude New" }],
					},
				]);
			}
			capabilityCalls += 1;
			if (capabilityCalls === 1) {
				return new Promise<ProviderInfo[]>((resolve) => {
					resolveCapability = resolve;
				});
			}
			return Promise.resolve(capabilityProjection);
		});
		const snapshot = createProviderCatalogSnapshot(
			[
				makeProvider({ providerId: "codex" }),
				makeProvider({ providerId: "claude" }),
			],
			{
				modelsFor: vi.fn(),
				cachedModelsFor: vi.fn().mockResolvedValue([]),
			},
			{ load },
		);

		const capability = snapshot.getVersioned({
			includeProviderCapabilities: true,
			preferCachedProviderCapabilities: false,
			refreshProviderId: "codex",
			discoveryCwd: "/work/codex",
		});
		await snapshot.get({
			refresh: true,
			refreshProviderId: "claude",
			discoveryCwd: "/work/claude",
		});
		resolveCapability?.(capabilityProjection);

		await capability;
		expect(capabilityCalls).toBe(1);
	});

	it("retains accepted host capability fields on a direct capability read", async () => {
		const hostCapabilities = {
			windowsComputerUse: { label: "Windows Computer Use", available: true },
		};
		const load = vi.fn((_providers, _catalog, options) =>
			Promise.resolve([
				{
					id: "codex",
					label: "Codex",
					available: true,
					models: [],
					...(options.refresh ? { hostCapabilities } : {}),
				},
			]),
		);
		const snapshot = createProviderCatalogSnapshot(
			[makeProvider({ providerId: "codex" })],
			{
				modelsFor: vi.fn(),
				cachedModelsFor: vi.fn().mockResolvedValue([]),
			},
			{ load },
		);

		await snapshot.get({
			refresh: true,
			includeHostCapabilities: true,
			discoveryCwd: "/work/project",
		});
		const capability = await snapshot.get({
			includeHostCapabilities: true,
			includeProviderCapabilities: true,
			preferCachedProviderCapabilities: false,
			refreshProviderId: "codex",
			discoveryCwd: "/work/project",
		});

		expect(capability[0]?.hostCapabilities).toEqual(hostCapabilities);
	});

	it("prefers fresh host fields during a combined capability and host wait", async () => {
		const staleHost = {
			windowsComputerUse: { label: "Windows Computer Use", available: false },
		};
		const freshHost = {
			windowsComputerUse: { label: "Windows Computer Use", available: true },
		};
		const load = vi
			.fn()
			.mockResolvedValueOnce([
				{
					id: "codex",
					label: "Codex",
					available: true,
					models: [],
					hostCapabilities: staleHost,
				},
			])
			.mockResolvedValueOnce([
				{
					id: "codex",
					label: "Codex",
					available: true,
					models: [],
					hostCapabilities: freshHost,
				},
			]);
		const snapshot = createProviderCatalogSnapshot(
			[makeProvider({ providerId: "codex" })],
			{
				modelsFor: vi.fn(),
				cachedModelsFor: vi.fn().mockResolvedValue([]),
			},
			{ load },
		);
		await snapshot.get({
			refresh: true,
			includeHostCapabilities: true,
			discoveryCwd: "/work/project",
		});

		const capability = await snapshot.get({
			includeHostCapabilities: true,
			awaitHostCapabilities: true,
			includeProviderCapabilities: true,
			preferCachedProviderCapabilities: false,
			refreshProviderId: "codex",
			discoveryCwd: "/work/project",
		});

		expect(capability[0]?.hostCapabilities).toEqual(freshHost);
	});

	it("retries a capability read when a full refresh starts", async () => {
		let resolveCapability: ((value: ProviderInfo[]) => void) | undefined;
		const negotiatedFork = {
			kind: "exact" as const,
			wholeSession: true as const,
			throughMessage: false,
		};
		const load = vi
			.fn()
			.mockImplementationOnce(
				() =>
					new Promise<ProviderInfo[]>((resolve) => {
						resolveCapability = resolve;
					}),
			)
			.mockResolvedValueOnce([
				{
					id: "acp:test",
					label: "ACP Test",
					available: true,
					models: [{ value: "fresh", label: "Fresh" }],
					forkCapability: negotiatedFork,
				},
			])
			.mockResolvedValueOnce([
				{
					id: "acp:test",
					label: "ACP Test",
					available: true,
					models: [{ value: "fresh", label: "Fresh" }],
				},
			]);
		const snapshot = createProviderCatalogSnapshot(
			[makeProvider({ providerId: "acp:test" })],
			{
				modelsFor: vi.fn(),
				cachedModelsFor: vi.fn().mockResolvedValue([]),
			},
			{ load },
		);
		const capability = snapshot.getVersioned({
			includeProviderCapabilities: true,
			preferCachedProviderCapabilities: false,
			refreshProviderId: "acp:test",
			discoveryCwd: "/work/project",
		});
		await snapshot.get({
			refresh: true,
			refreshProviderId: "acp:test",
			discoveryCwd: "/work/project",
		});
		resolveCapability?.([
			{
				id: "acp:test",
				label: "ACP Test",
				available: true,
				models: [{ value: "stale", label: "Stale" }],
			},
		]);

		await capability;
		expect(load).toHaveBeenCalledTimes(3);
		expect(
			load.mock.calls[2]?.[2].providerCapabilityForkOverrides?.get("acp:test"),
		).toEqual(negotiatedFork);
	});

	it("retries a capability read after an already-active full refresh completes", async () => {
		let resolveRefresh: ((value: ProviderInfo[]) => void) | undefined;
		let resolveCapability: ((value: ProviderInfo[]) => void) | undefined;
		const oldFork = {
			kind: "exact" as const,
			wholeSession: true as const,
			throughMessage: false,
		};
		const newFork = {
			kind: "exact" as const,
			cutoff: "turn" as const,
			wholeSession: true as const,
			throughMessage: true,
		};
		const load = vi
			.fn()
			.mockResolvedValueOnce([
				{
					id: "acp:test",
					label: "ACP Test",
					available: true,
					models: [],
					forkCapability: oldFork,
				},
			])
			.mockImplementationOnce(
				() =>
					new Promise<ProviderInfo[]>((resolve) => {
						resolveRefresh = resolve;
					}),
			)
			.mockImplementationOnce(
				() =>
					new Promise<ProviderInfo[]>((resolve) => {
						resolveCapability = resolve;
					}),
			)
			.mockResolvedValueOnce([
				{
					id: "acp:test",
					label: "ACP Test",
					available: true,
					models: [],
					forkCapability: newFork,
				},
			]);
		const snapshot = createProviderCatalogSnapshot(
			[makeProvider({ providerId: "acp:test" })],
			{
				modelsFor: vi.fn(),
				cachedModelsFor: vi.fn().mockResolvedValue([]),
			},
			{ load },
		);
		await snapshot.get({
			refresh: true,
			refreshProviderId: "acp:test",
			discoveryCwd: "/work/project",
		});
		const refresh = snapshot.get({
			refresh: true,
			refreshProviderId: "acp:test",
			discoveryCwd: "/work/project",
		});
		const capability = snapshot.getVersioned({
			includeProviderCapabilities: true,
			preferCachedProviderCapabilities: false,
			refreshProviderId: "acp:test",
			discoveryCwd: "/work/project",
		});
		resolveRefresh?.([
			{
				id: "acp:test",
				label: "ACP Test",
				available: true,
				models: [],
				forkCapability: newFork,
			},
		]);
		await refresh;
		resolveCapability?.([
			{
				id: "acp:test",
				label: "ACP Test",
				available: true,
				models: [],
				forkCapability: oldFork,
			},
		]);

		const result = await capability;
		expect(result.providers[0]?.forkCapability).toEqual(newFork);
		expect(load).toHaveBeenCalledTimes(4);
		expect(
			load.mock.calls[3]?.[2].providerCapabilityForkOverrides?.get("acp:test"),
		).toEqual(newFork);
	});

	it("notices out-of-order full-refresh completions in another projection", async () => {
		let resolveA: ((value: ProviderInfo[]) => void) | undefined;
		let resolveCapability: ((value: ProviderInfo[]) => void) | undefined;
		const oldFork = {
			kind: "exact" as const,
			wholeSession: true as const,
			throughMessage: false,
		};
		const newFork = {
			kind: "exact" as const,
			cutoff: "turn" as const,
			wholeSession: true as const,
			throughMessage: true,
		};
		const projection = (forkCapability: typeof oldFork | typeof newFork) => [
			{
				id: "acp:test",
				label: "ACP Test",
				available: true,
				models: [],
				forkCapability,
			},
		];
		const load = vi
			.fn()
			.mockResolvedValueOnce(projection(oldFork))
			.mockImplementationOnce(
				() =>
					new Promise<ProviderInfo[]>((resolve) => {
						resolveA = resolve;
					}),
			)
			.mockResolvedValueOnce(projection(oldFork))
			.mockImplementationOnce(
				() =>
					new Promise<ProviderInfo[]>((resolve) => {
						resolveCapability = resolve;
					}),
			)
			.mockResolvedValueOnce(projection(newFork));
		const snapshot = createProviderCatalogSnapshot(
			[makeProvider({ providerId: "acp:test" })],
			{
				modelsFor: vi.fn(),
				cachedModelsFor: vi.fn().mockResolvedValue([]),
			},
			{ load },
		);
		await snapshot.get({
			refresh: true,
			refreshProviderId: "acp:test",
			discoveryCwd: "/a",
		});
		const refreshA = snapshot.get({
			refresh: true,
			refreshProviderId: "acp:test",
			discoveryCwd: "/a",
		});
		await snapshot.get({
			refresh: true,
			refreshProviderId: "acp:test",
			discoveryCwd: "/b",
		});
		const capability = snapshot.getVersioned({
			includeProviderCapabilities: true,
			preferCachedProviderCapabilities: false,
			refreshProviderId: "acp:test",
			discoveryCwd: "/a",
		});
		resolveA?.(projection(newFork));
		await refreshA;
		resolveCapability?.(projection(oldFork));

		const result = await capability;
		expect(result.providers[0]?.forkCapability).toEqual(newFork);
		expect(load).toHaveBeenCalledTimes(5);
	});

	it("does not let an older base refresh overwrite a newer rich projection", async () => {
		let resolveBase: ((value: ProviderInfo[]) => void) | undefined;
		let resolveRich: ((value: ProviderInfo[]) => void) | undefined;
		const load = vi.fn((_providers, _catalog, options) =>
			options.includeHostCapabilities
				? new Promise<ProviderInfo[]>((resolve) => {
						resolveRich = resolve;
					})
				: new Promise<ProviderInfo[]>((resolve) => {
						resolveBase = resolve;
					}),
		);
		const snapshot = createProviderCatalogSnapshot(
			[makeProvider({ providerId: "acp:test" })],
			{
				modelsFor: vi.fn(),
				cachedModelsFor: vi.fn().mockResolvedValue([]),
			},
			{ load },
		);

		const olderBase = snapshot.get({ refresh: true });
		const newerRich = snapshot.get({
			refresh: true,
			includeHostCapabilities: true,
		});
		resolveRich?.([
			{
				id: "acp:test",
				label: "ACP Test",
				available: true,
				models: [{ value: "new", label: "New" }],
				hostCapabilities: {
					windowsComputerUse: { label: "Windows", available: true },
				},
			},
		]);
		await newerRich;
		resolveBase?.([
			{
				id: "acp:test",
				label: "ACP Test",
				available: true,
				models: [{ value: "old", label: "Old" }],
			},
		]);
		await olderBase;

		expect((await snapshot.get())[0]?.models).toEqual([
			{ value: "new", label: "New" },
		]);
	});

	it("does not let an older cached read overwrite a live unavailable result", async () => {
		let resolveCached: ((value: ProviderInfo[]) => void) | undefined;
		const load = vi.fn((_providers, _catalog, options) => {
			if (options.refresh) {
				return Promise.resolve([
					{
						id: "acp:test",
						label: "ACP Test",
						available: false,
						unavailableReason: "test-agent is not installed",
						models: [],
					},
				]);
			}
			return new Promise<ProviderInfo[]>((resolve) => {
				resolveCached = resolve;
			});
		});
		const snapshot = createProviderCatalogSnapshot(
			[makeProvider({ providerId: "acp:test" })],
			{
				modelsFor: vi.fn(),
				cachedModelsFor: vi.fn().mockResolvedValue([]),
			},
			{ load },
		);

		const cached = snapshot.get();
		const live = snapshot.get({ refresh: true });
		await live;
		resolveCached?.([
			{
				id: "acp:test",
				label: "ACP Test",
				available: true,
				models: [{ value: "stale", label: "Stale" }],
			},
		]);
		await cached;

		expect((await snapshot.get())[0]).toMatchObject({
			available: false,
			unavailableReason: "test-agent is not installed",
			models: [],
		});
		expect(load).toHaveBeenCalledTimes(2);
	});

	it("retains last-known live availability across metadata invalidation", async () => {
		const load = vi.fn((_providers, _catalog, options) =>
			Promise.resolve([
				{
					id: "acp:test",
					label: "ACP Test",
					available: !options.refresh,
					...(options.refresh
						? { unavailableReason: "test-agent is not installed" }
						: {}),
					models: [],
				},
			]),
		);
		const snapshot = createProviderCatalogSnapshot(
			[makeProvider({ providerId: "acp:test" })],
			{
				modelsFor: vi.fn(),
				cachedModelsFor: vi.fn().mockResolvedValue([]),
			},
			{ load },
		);

		await snapshot.get({ refresh: true });
		snapshot.invalidateMetadata();

		expect((await snapshot.get())[0]).toMatchObject({
			available: false,
			unavailableReason: "test-agent is not installed",
		});
		expect(load).toHaveBeenCalledTimes(2);
	});

	it("starts a new read immediately after invalidating an in-flight snapshot", async () => {
		let resolveFirst: ((value: ProviderInfo[]) => void) | undefined;
		const load = vi
			.fn()
			.mockImplementationOnce(
				() =>
					new Promise<ProviderInfo[]>((resolve) => {
						resolveFirst = resolve;
					}),
			)
			.mockResolvedValueOnce([
				{
					id: "codex",
					label: "Codex",
					available: true,
					models: [],
					hostCapabilities: {
						windowsComputerUse: {
							label: "Windows Computer Use",
							available: true,
						},
					},
				},
			]);
		const snapshot = createProviderCatalogSnapshot(
			[makeProvider({ providerId: "codex" })],
			{
				modelsFor: vi.fn(),
				cachedModelsFor: vi.fn().mockResolvedValue([]),
			},
			{ load },
		);

		const first = snapshot.get({ includeHostCapabilities: true });
		snapshot.invalidate();
		const second = snapshot.get({ includeHostCapabilities: true });
		expect(load).toHaveBeenCalledTimes(2);
		expect((await second)[0]?.hostCapabilities?.windowsComputerUse).toEqual({
			label: "Windows Computer Use",
			available: true,
		});
		resolveFirst?.([
			{
				id: "codex",
				label: "Codex",
				available: true,
				models: [],
				hostCapabilities: {
					windowsComputerUse: {
						label: "Windows Computer Use",
						available: false,
						reason: "Capability status is refreshing",
					},
				},
			},
		]);
		await first;

		expect(
			(await snapshot.get({ includeHostCapabilities: true }))[0]
				?.hostCapabilities?.windowsComputerUse,
		).toEqual({
			label: "Windows Computer Use",
			available: true,
		});
		expect(load).toHaveBeenCalledTimes(2);
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
			preferCachedProviderCapabilities: true,
			includeHostCapabilities: false,
			awaitHostCapabilities: false,
			includeProviderCapabilities: false,
		});
	});

	it("uses full live discovery only for an explicit refresh", () => {
		expect(
			providerCatalogRequestOptions(
				new URLSearchParams("refresh=1&host_capabilities=1"),
			),
		).toEqual({
			refresh: true,
			preferCachedModels: false,
			preferCachedProviderCapabilities: true,
			includeHostCapabilities: true,
			awaitHostCapabilities: false,
			includeProviderCapabilities: false,
		});
	});

	it("parses a provider-scoped explicit refresh", () => {
		expect(
			providerCatalogRequestOptions(
				new URLSearchParams("refresh=1&provider_id=acp%3Aopencode"),
			),
		).toEqual({
			refresh: true,
			refreshProviderId: "acp:opencode",
			preferCachedModels: false,
			preferCachedProviderCapabilities: true,
			includeHostCapabilities: false,
			awaitHostCapabilities: false,
			includeProviderCapabilities: false,
		});
	});

	it("requests provider capability evidence independently", () => {
		expect(
			providerCatalogRequestOptions(
				new URLSearchParams("provider_capabilities=1"),
			),
		).toEqual({
			refresh: false,
			preferCachedModels: true,
			preferCachedProviderCapabilities: true,
			includeHostCapabilities: false,
			awaitHostCapabilities: false,
			includeProviderCapabilities: true,
		});
	});

	it("keeps an explicit capability wait separate from full refresh", () => {
		expect(
			providerCatalogRequestOptions(
				new URLSearchParams(
					"provider_capabilities=1&provider_capabilities_wait=1&capability_cwd=%2Fwork%2Fproject",
				),
			),
		).toEqual({
			refresh: false,
			preferCachedModels: true,
			preferCachedProviderCapabilities: false,
			includeHostCapabilities: false,
			awaitHostCapabilities: false,
			includeProviderCapabilities: true,
			discoveryCwd: "/work/project",
		});
	});

	it("scopes an explicit capability wait to the requested provider", () => {
		expect(
			providerCatalogRequestOptions(
				new URLSearchParams(
					"provider_capabilities=1&provider_capabilities_wait=1&provider_id=codex&capability_cwd=%2Fwork%2Fproject",
				),
			),
		).toEqual({
			refresh: false,
			preferCachedModels: true,
			preferCachedProviderCapabilities: false,
			includeHostCapabilities: false,
			awaitHostCapabilities: false,
			includeProviderCapabilities: true,
			refreshProviderId: "codex",
			discoveryCwd: "/work/project",
		});
	});

	it("requests a bounded host-readiness wait separately from full refresh", () => {
		expect(
			providerCatalogRequestOptions(
				new URLSearchParams("host_capabilities=1&host_capabilities_wait=1"),
			),
		).toEqual({
			refresh: false,
			preferCachedModels: true,
			preferCachedProviderCapabilities: true,
			includeHostCapabilities: true,
			awaitHostCapabilities: true,
			includeProviderCapabilities: false,
		});
	});

	it("rejects a relative capability workspace", () => {
		expect(() =>
			providerCatalogRequestOptions(
				new URLSearchParams("capability_cwd=relative%2Fproject"),
			),
		).toThrow(/absolute path/i);
	});
});
