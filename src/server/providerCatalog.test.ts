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
			includeProviderCapabilities: true,
			discoveryCwd: "/work/project",
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
