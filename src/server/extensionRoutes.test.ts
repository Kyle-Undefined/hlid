import { describe, expect, it, vi } from "vitest";
import type { HlidConfig } from "../config";
import type { ExtensionInventory, ExtensionReview } from "./extensionInventory";
import { createExtensionRouteHandler } from "./extensionRoutes";

const inventory: ExtensionInventory = {
	generatedAt: "2026-07-22T00:00:00.000Z",
	environments: [],
	extensions: [],
	marketplaces: [],
	available: [],
	errors: [],
};

const review: ExtensionReview = {
	id: "0123456789abcdef01234567",
	providerId: "codex",
	providerLabel: "Codex",
	environment: "host",
	environmentLabel: "Host",
	pluginId: "github@curated",
	name: "github",
	displayName: "GitHub",
	marketplace: "curated",
	version: "1.0.0",
	description: "",
	author: "",
	category: "",
	source: "local",
	homepage: "",
	installed: false,
	enabled: null,
	reviewLevel: "package",
	reviewMessage: "Complete package review",
	reviewToken: "f".repeat(64),
	manifestPath: "/plugin.json",
	manifestText: "{}",
	capabilities: [],
	components: [],
	skillFiles: [],
	errors: [],
};

describe("extension inventory routes", () => {
	it("serves a read-only catalog from the current config", async () => {
		const config = {
			vault: { name: "Test", path: "" },
		} as HlidConfig;
		const discover = vi.fn().mockResolvedValue(inventory);
		const handle = createExtensionRouteHandler({
			loadConfig: () => config,
			discover,
		});
		const request = new Request("http://localhost/extensions/catalog");
		const response = await handle(new URL(request.url), request);

		expect(response?.status).toBe(200);
		expect(discover).toHaveBeenCalledWith(config);
		expect(await response?.json()).toEqual(inventory);
	});

	it("loads one opaque read-only marketplace review", async () => {
		const config = { vault: { name: "Test", path: "" } } as HlidConfig;
		const inspect = vi.fn().mockResolvedValue(review);
		const handle = createExtensionRouteHandler({
			loadConfig: () => config,
			review: inspect,
		});
		const request = new Request(
			`http://localhost/extensions/review?id=${review.id}`,
		);
		const response = await handle(new URL(request.url), request);

		expect(response?.status).toBe(200);
		expect(inspect).toHaveBeenCalledWith(config, review.id);
		expect(await response?.json()).toEqual(review);
	});

	it("rejects invalid review IDs and reports missing cached entries", async () => {
		const inspect = vi.fn().mockResolvedValue(null);
		const handle = createExtensionRouteHandler({
			loadConfig: () => ({}) as HlidConfig,
			review: inspect,
		});
		const invalid = new Request(
			"http://localhost/extensions/review?id=../../secret",
		);
		expect((await handle(new URL(invalid.url), invalid))?.status).toBe(400);
		expect(inspect).not.toHaveBeenCalled();

		const missing = new Request(
			"http://localhost/extensions/review?id=0123456789abcdef01234567",
		);
		expect((await handle(new URL(missing.url), missing))?.status).toBe(404);
	});

	it("applies a validated extension mutation and refreshes dependent state", async () => {
		const config = { vault: { name: "Test", path: "" } } as HlidConfig;
		const mutate = vi.fn().mockResolvedValue({
			action: "install",
			providerId: "codex",
			subject: "github@curated",
			pluginId: "github@curated",
			environmentLabel: "Host",
			output: "installed",
		});
		const onChanged = vi.fn();
		const handle = createExtensionRouteHandler({
			loadConfig: () => config,
			mutate,
			onChanged,
		});
		const request = new Request("http://localhost/extensions/mutate", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				action: "install",
				id: "0123456789abcdef01234567",
				reviewToken: "f".repeat(64),
			}),
		});
		const response = await handle(new URL(request.url), request);

		expect(response?.status).toBe(200);
		expect(mutate).toHaveBeenCalledWith(config, {
			action: "install",
			id: "0123456789abcdef01234567",
			reviewToken: "f".repeat(64),
		});
		expect(onChanged).toHaveBeenCalledWith(config);
	});

	it("rejects unguarded mutations without invoking a provider", async () => {
		const mutate = vi.fn();
		const handle = createExtensionRouteHandler({
			loadConfig: () => ({}) as HlidConfig,
			mutate,
		});
		const request = new Request("http://localhost/extensions/mutate", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				action: "uninstall",
				id: "0123456789abcdef01234567",
			}),
		});
		const response = await handle(new URL(request.url), request);

		expect(response?.status).toBe(400);
		expect(mutate).not.toHaveBeenCalled();
	});

	it("validates marketplace source mutations before invoking a provider", async () => {
		const mutate = vi.fn().mockResolvedValue({
			action: "add_marketplace",
			providerId: "codex",
			subject: "team-tools",
			environmentLabel: "Host",
			output: "added",
		});
		const handle = createExtensionRouteHandler({
			loadConfig: () => ({}) as HlidConfig,
			mutate,
		});
		const request = new Request("http://localhost/extensions/mutate", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				action: "add_marketplace",
				providerId: "codex",
				environmentId: "1".repeat(24),
				source: "example/team-tools",
				ref: "main",
				sparse: ["plugins/reviewer"],
			}),
		});
		const response = await handle(new URL(request.url), request);
		expect(response?.status).toBe(200);
		expect(mutate).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				action: "add_marketplace",
				source: "example/team-tools",
			}),
		);

		const invalid = new Request("http://localhost/extensions/mutate", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				action: "remove_marketplace",
				id: "../../unsafe",
				expectedSource: "source",
			}),
		});
		expect((await handle(new URL(invalid.url), invalid))?.status).toBe(400);
		expect(mutate).toHaveBeenCalledTimes(1);
	});

	it("requires guarded and meaningful plugin status changes", async () => {
		const mutate = vi.fn().mockResolvedValue({
			action: "set_enabled",
			providerId: "claude",
			subject: "reviewer@official",
			environmentLabel: "Host",
			output: "disabled",
		});
		const handle = createExtensionRouteHandler({
			loadConfig: () => ({}) as HlidConfig,
			mutate,
		});
		const valid = new Request("http://localhost/extensions/mutate", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				action: "set_enabled",
				id: "1".repeat(24),
				expectedVersion: "1.0.0",
				expectedEnabled: true,
				enabled: false,
			}),
		});
		expect((await handle(new URL(valid.url), valid))?.status).toBe(200);
		expect(mutate).toHaveBeenCalledTimes(1);

		const unchanged = new Request("http://localhost/extensions/mutate", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				action: "set_enabled",
				id: "1".repeat(24),
				expectedVersion: "1.0.0",
				expectedEnabled: true,
				enabled: true,
			}),
		});
		expect((await handle(new URL(unchanged.url), unchanged))?.status).toBe(400);
		expect(mutate).toHaveBeenCalledTimes(1);
	});

	it("returns provider mutation failures without refreshing state", async () => {
		const onChanged = vi.fn();
		const handle = createExtensionRouteHandler({
			loadConfig: () => ({}) as HlidConfig,
			mutate: vi.fn().mockRejectedValue(new Error("native CLI failed")),
			onChanged,
		});
		const request = new Request("http://localhost/extensions/mutate", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				action: "uninstall",
				id: "0123456789abcdef01234567",
				expectedVersion: "1.0.0",
			}),
		});
		const response = await handle(new URL(request.url), request);

		expect(response?.status).toBe(400);
		expect(await response?.json()).toEqual({ error: "native CLI failed" });
		expect(onChanged).not.toHaveBeenCalled();
	});

	it("ignores unsupported methods and unrelated paths", async () => {
		const handle = createExtensionRouteHandler({
			loadConfig: () => ({}) as HlidConfig,
			discover: vi.fn(),
		});
		expect(
			await handle(
				new URL("http://localhost/extensions/catalog"),
				new Request("http://localhost/extensions/catalog", {
					method: "POST",
				}),
			),
		).toBeNull();
		expect(
			await handle(
				new URL("http://localhost/other"),
				new Request("http://localhost/other"),
			),
		).toBeNull();
	});
});
