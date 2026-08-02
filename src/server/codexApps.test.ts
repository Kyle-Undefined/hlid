import { describe, expect, it } from "vitest";
import { mapCodexAppCatalogPage } from "./codexApps";

describe("Codex Apps catalog mapping", () => {
	it("keeps installation, configuration, authentication, and usability distinct", () => {
		const page = mapCodexAppCatalogPage({
			providerId: "codex",
			cwd: "/work/project",
			sessionId: "raven-1",
			appsResponse: {
				data: [
					{
						id: "github",
						name: "GitHub",
						isAccessible: true,
						isEnabled: true,
						installUrl: "https://example.test/github",
					},
					{
						id: "linear",
						name: "Linear",
						isAccessible: false,
						isEnabled: true,
						installUrl: "https://example.test/linear",
					},
				],
				nextCursor: "2",
			},
			installedResponse: {
				apps: [
					{
						id: "github",
						runtimeName: "GitHub",
						enabled: true,
						callable: true,
					},
					{
						id: "hidden",
						runtimeName: "Hidden",
						enabled: false,
						callable: false,
					},
				],
			},
			mcpResponse: {
				data: [
					{
						name: "codex_apps",
						authStatus: "bearerToken",
						tools: { search: {} },
						resources: [{ uri: "app://github" }],
						resourceTemplates: [],
					},
					{
						name: "remote",
						authStatus: "notLoggedIn",
						tools: {},
						resources: [],
						resourceTemplates: [],
					},
				],
			},
			now: 100,
		});

		expect(page).toMatchObject({
			status: "current",
			scope: {
				providerId: "codex",
				account: "active-provider-account",
				host: "current-hlid-host",
				workspace: "/work/project",
				sessionId: "raven-1",
			},
			installedCount: 2,
			usableCount: 1,
			missingAuthenticationCount: 1,
			nextCursor: "2",
			truncated: true,
		});
		expect(page.apps.find((app) => app.id === "github")).toMatchObject({
			installed: true,
			configured: true,
			authentication: "ready",
			usable: true,
			readiness: "usable",
		});
		expect(page.apps.find((app) => app.id === "linear")).toMatchObject({
			installed: false,
			configured: true,
			authentication: "required",
			usable: false,
			readiness: "not-installed",
		});
		expect(page.apps.find((app) => app.id === "hidden")).toMatchObject({
			installed: true,
			configured: false,
			authentication: "unknown",
			usable: false,
			readiness: "disabled",
		});
		expect(page.connectors).toEqual([
			expect.objectContaining({
				id: "codex_apps",
				authentication: "ready",
				usable: true,
				toolCount: 1,
				resourceCount: 1,
			}),
			expect.objectContaining({
				id: "remote",
				authentication: "required",
				usable: false,
				canAuthenticate: true,
			}),
		]);
	});

	it("tracks OAuth completion without exposing authorization URLs", () => {
		const pending = mapCodexAppCatalogPage({
			providerId: "codex",
			cwd: "/work",
			appsResponse: {
				data: [
					{
						id: "linear",
						name: "Linear",
						isAccessible: false,
						isEnabled: true,
						installUrl: "https://secret.example.test/state-token",
					},
				],
			},
			installedResponse: { apps: [] },
			mcpResponse: { data: [] },
			authAttempts: new Map([
				["app:linear", { state: "pending" as const, startedAt: 100 }],
			]),
			now: 200,
		});
		expect(pending.apps[0]?.oauthState).toBe("pending");
		expect(JSON.stringify(pending)).not.toContain("state-token");

		const complete = mapCodexAppCatalogPage({
			providerId: "codex",
			cwd: "/work",
			appsResponse: {
				data: [{ id: "linear", name: "Linear", isEnabled: true }],
			},
			installedResponse: {
				apps: [
					{
						id: "linear",
						runtimeName: "Linear",
						enabled: true,
						callable: true,
					},
				],
			},
			mcpResponse: { data: [] },
			authAttempts: new Map([
				["app:linear", { state: "pending" as const, startedAt: 100 }],
			]),
			now: 300,
		});
		expect(complete.apps[0]).toMatchObject({
			oauthState: "complete",
			authentication: "ready",
			usable: true,
		});
	});
});
