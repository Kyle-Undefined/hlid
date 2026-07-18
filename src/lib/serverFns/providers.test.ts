import { describe, expect, it } from "vitest";
import { providerCatalogPath, providerUsageIds } from "./providers";

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
