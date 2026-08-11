import { describe, expect, it } from "vitest";
import {
	providerCatalogPath,
	providerUsageIds,
	withProviderCatalogRevision,
} from "./providers";

describe("providerCatalogPath", () => {
	it("keeps normal route loaders free of host capability probes", () => {
		expect(providerCatalogPath(undefined)).toBe("/providers");
		expect(providerCatalogPath({ refresh: true })).toBe("/providers?refresh=1");
	});

	it("lets Einherjar request cached models without live discovery", () => {
		expect(providerCatalogPath({ preferCachedModels: true })).toBe(
			"/providers?cached_models=1",
		);
	});

	it("opts Forge into host capability discovery", () => {
		expect(providerCatalogPath({ includeHostCapabilities: true })).toBe(
			"/providers?host_capabilities=1",
		);
		expect(
			providerCatalogPath({
				refresh: true,
				includeHostCapabilities: true,
			}),
		).toBe("/providers?refresh=1&host_capabilities=1");
	});

	it("requests bounded host readiness without a full catalog refresh", () => {
		expect(
			providerCatalogPath({
				waitForHostCapabilities: true,
				preferCachedModels: true,
			}),
		).toBe(
			"/providers?host_capabilities=1&host_capabilities_wait=1&cached_models=1",
		);
	});

	it("scopes an explicit ACP option refresh to its provider", () => {
		expect(
			providerCatalogPath({
				refresh: true,
				refreshProviderId: "acp:opencode",
				includeProviderCapabilities: true,
			}),
		).toBe(
			"/providers?refresh=1&provider_capabilities=1&provider_id=acp%3Aopencode",
		);
	});

	it("opts focused surfaces into provider capability evidence", () => {
		expect(providerCatalogPath({ includeProviderCapabilities: true })).toBe(
			"/providers?provider_capabilities=1",
		);
		expect(
			providerCatalogPath({
				includeHostCapabilities: true,
				includeProviderCapabilities: true,
			}),
		).toBe("/providers?host_capabilities=1&provider_capabilities=1");
	});

	it("scopes cached model reads to the active discovery workspace", () => {
		expect(
			providerCatalogPath({
				preferCachedModels: true,
				discoveryCwd: "C:\\Users\\Kyle\\project",
			}),
		).toBe(
			"/providers?cached_models=1&capability_cwd=C%3A%5CUsers%5CKyle%5Cproject",
		);
	});
});

describe("withProviderCatalogRevision", () => {
	it("stamps only the explicitly refreshed provider with the server revision", () => {
		const providers = [
			{
				id: "acp:opencode",
				label: "OpenCode",
				available: true,
				modelCatalogRefresh: {
					status: "current" as const,
					source: "live" as const,
				},
			},
			{ id: "claude", label: "Claude", available: true },
		];

		expect(
			withProviderCatalogRevision(providers, "acp:opencode", "17"),
		).toEqual([
			{
				...providers[0],
				modelCatalogRefresh: {
					status: "current",
					source: "live",
					revision: 17,
				},
			},
			providers[1],
		]);
		expect(
			withProviderCatalogRevision(providers, "acp:opencode", "invalid"),
		).toBe(providers);
	});
});

describe("providerUsageIds", () => {
	it("falls back to both built-in providers when catalog discovery times out", () => {
		expect(providerUsageIds([])).toEqual(["claude", "codex"]);
	});

	it("uses the discovered provider inventory when available", () => {
		expect(
			providerUsageIds([
				{ id: "acp:test", label: "Test", available: true, models: [] },
			]),
		).toEqual(["acp:test"]);
	});
});
