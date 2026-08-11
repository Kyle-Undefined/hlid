// @vitest-environment jsdom

import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	authenticateProviderAppFn,
	getProviderAppsFn,
} from "#/lib/serverFns/providerApps";
import { ProviderAppsCatalog } from "./ProviderAppsCatalog";

vi.mock("#/lib/serverFns/providerApps", () => ({
	getProviderAppsFn: vi.fn(),
	authenticateProviderAppFn: vi.fn(),
}));

const catalog = {
	contractVersion: 1 as const,
	providerId: "codex",
	status: "current" as const,
	observedAt: 1,
	scope: {
		providerId: "codex",
		account: "active-provider-account" as const,
		host: "current-hlid-host" as const,
		workspace: "/work/project",
		sessionId: null,
	},
	apps: [
		{
			id: "github",
			name: "GitHub",
			available: true,
			installed: true,
			configured: true,
			authentication: "ready" as const,
			usable: true,
			readiness: "usable" as const,
			canAuthenticate: true,
			oauthState: "idle" as const,
		},
		{
			id: "linear",
			name: "Linear",
			available: true,
			installed: false,
			configured: true,
			authentication: "required" as const,
			usable: false,
			readiness: "not-installed" as const,
			canAuthenticate: true,
			oauthState: "idle" as const,
			reason: "Connect this app.",
		},
	],
	connectors: [
		{
			id: "codex_apps",
			name: "Codex Apps",
			authentication: "ready" as const,
			usable: true,
			canAuthenticate: false,
			oauthState: "idle" as const,
			toolCount: 12,
			resourceCount: 2,
			resourceTemplateCount: 1,
		},
	],
	installedCount: 1,
	usableCount: 1,
	missingAuthenticationCount: 0,
	returned: 2,
	nextCursor: null,
	truncated: false,
};

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

describe("ProviderAppsCatalog", () => {
	it("keeps transport errors bounded and user-facing", async () => {
		vi.mocked(getProviderAppsFn).mockRejectedValue(
			new Error("<!doctype html><html>internal server error</html>"),
		);
		render(
			<ProviderAppsCatalog
				providerId="codex"
				providerLabel="Codex"
				cwd="/work/project"
			/>,
		);

		expect(
			await screen.findByText("Provider app inventory is unavailable."),
		).toBeTruthy();
		expect(screen.queryByText(/doctype html/i)).toBeNull();
	});

	it("distinguishes installed, available, and connector readiness", async () => {
		vi.mocked(getProviderAppsFn).mockResolvedValue(catalog);
		render(
			<ProviderAppsCatalog
				providerId="codex"
				providerLabel="Codex"
				cwd="/work/project"
			/>,
		);

		expect(await screen.findByText("GitHub")).toBeTruthy();
		expect(screen.getByText("auth ready")).toBeTruthy();
		expect(screen.queryByText("Linear")).toBeNull();

		fireEvent.click(screen.getByRole("button", { name: "available" }));
		expect(screen.getByText("Linear")).toBeTruthy();
		expect(screen.getByText("auth required")).toBeTruthy();

		fireEvent.click(screen.getByRole("button", { name: "connect" }));
		await waitFor(() =>
			expect(authenticateProviderAppFn).toHaveBeenCalledWith({
				data: {
					providerId: "codex",
					cwd: "/work/project",
					kind: "app",
					id: "linear",
				},
			}),
		);

		fireEvent.click(screen.getByRole("button", { name: "connectors" }));
		expect(screen.getByText("Codex Apps")).toBeTruthy();
		expect(
			screen.getByText("12 tools · 2 resources · 1 templates"),
		).toBeTruthy();
	});
});
