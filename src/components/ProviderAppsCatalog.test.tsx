// @vitest-environment jsdom

import {
	act,
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
	vi.useRealTimers();
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

		await act(async () => {
			await Promise.resolve();
		});
		expect(screen.getByText("GitHub")).toBeTruthy();
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

	it("renders optional discovery issues as informational with usable inventory", async () => {
		const message =
			"Available app discovery could not be checked in the active provider runtime. The provider still reports usable installed apps or connectors.";
		vi.mocked(getProviderAppsFn).mockResolvedValue({
			...catalog,
			status: "partial",
			issues: [message],
			issueSeverity: "info",
		});
		render(
			<ProviderAppsCatalog
				providerId="codex"
				providerLabel="Codex"
				cwd="/work/project"
			/>,
		);

		const issue = await screen.findByText(message);
		expect(issue.className).toContain("text-status-info/80");
		expect(issue.className).not.toContain("text-status-warning/75");
	});

	it("keeps unavailable empty-inventory issues visually warning", async () => {
		const message = "app/list is unavailable in the active provider runtime.";
		vi.mocked(getProviderAppsFn).mockResolvedValue({
			...catalog,
			status: "unavailable",
			apps: [],
			connectors: [],
			installedCount: 0,
			usableCount: 0,
			returned: 0,
			issues: [message],
			issueSeverity: "info",
		});
		render(
			<ProviderAppsCatalog
				providerId="codex"
				providerLabel="Codex"
				cwd="/work/project"
			/>,
		);

		const issue = await screen.findByText(message);
		expect(issue.className).toContain("text-status-warning/75");
		expect(issue.className).not.toContain("text-status-info/80");
	});

	it("polls a cold background refresh until the late catalog is ready", async () => {
		vi.useFakeTimers();
		vi.mocked(getProviderAppsFn)
			.mockResolvedValueOnce({
				...catalog,
				status: "partial",
				refreshing: true,
				observedAt: 0,
				apps: [],
				connectors: [],
				installedCount: 0,
				usableCount: 0,
				returned: 0,
			})
			.mockResolvedValueOnce(catalog);
		render(
			<ProviderAppsCatalog
				providerId="codex"
				providerLabel="Codex"
				cwd="/work/project"
			/>,
		);

		await act(async () => {
			await Promise.resolve();
		});
		expect(
			screen.getByText("Loading provider Apps and connectors…"),
		).toBeTruthy();
		expect(
			screen.getByRole("button", { name: "refresh" }).hasAttribute("disabled"),
		).toBe(true);

		await act(async () => {
			vi.advanceTimersByTime(1_000);
			await Promise.resolve();
		});
		expect(screen.getByText("GitHub")).toBeTruthy();
		expect(getProviderAppsFn).toHaveBeenCalledTimes(2);
	});

	it("ends a failed pending poll and allows manual recovery", async () => {
		vi.useFakeTimers();
		const pendingPage = {
			...catalog,
			status: "partial" as const,
			refreshing: true,
			observedAt: 0,
			apps: [],
			connectors: [],
			installedCount: 0,
			usableCount: 0,
			returned: 0,
		};
		vi.mocked(getProviderAppsFn)
			.mockResolvedValueOnce(pendingPage)
			.mockRejectedValueOnce(new Error("request failed"))
			.mockResolvedValueOnce(catalog);
		render(
			<ProviderAppsCatalog
				providerId="codex"
				providerLabel="Codex"
				cwd="/work/project"
			/>,
		);
		await act(async () => {
			await Promise.resolve();
		});

		await act(async () => {
			vi.advanceTimersByTime(1_000);
			await Promise.resolve();
		});
		expect(
			screen.getByText("Provider app inventory is unavailable."),
		).toBeTruthy();
		const refresh = screen.getByRole("button", { name: "refresh" });
		expect(refresh.hasAttribute("disabled")).toBe(false);
		expect(
			screen.queryByText("Loading provider Apps and connectors…"),
		).toBeNull();

		fireEvent.click(refresh);
		await act(async () => {
			await Promise.resolve();
		});
		expect(screen.getByText("GitHub")).toBeTruthy();
		expect(getProviderAppsFn).toHaveBeenCalledTimes(3);
	});

	it("polls a pending load-more page with the same cursor", async () => {
		vi.useFakeTimers();
		const firstPage = {
			...catalog,
			apps: [catalog.apps[0]],
			connectors: [],
			returned: 1,
			nextCursor: "page-2",
			truncated: true,
		};
		const pendingPage = {
			...catalog,
			status: "partial" as const,
			refreshing: true,
			observedAt: 0,
			apps: [],
			connectors: [],
			installedCount: 0,
			usableCount: 0,
			returned: 0,
			nextCursor: null,
			truncated: false,
		};
		const secondPage = {
			...catalog,
			observedAt: 2,
			apps: [catalog.apps[1]],
			connectors: [],
			installedCount: 0,
			usableCount: 0,
			returned: 1,
		};
		vi.mocked(getProviderAppsFn)
			.mockResolvedValueOnce(firstPage)
			.mockResolvedValueOnce(pendingPage)
			.mockResolvedValueOnce(secondPage);
		render(
			<ProviderAppsCatalog
				providerId="codex"
				providerLabel="Codex"
				cwd="/work/project"
			/>,
		);

		await act(async () => {
			await Promise.resolve();
		});
		expect(screen.getByText("GitHub")).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: "available" }));
		fireEvent.click(
			screen.getByRole("button", { name: "Load more available apps" }),
		);
		await act(async () => {
			await Promise.resolve();
		});
		expect(
			screen.getByText("Loading provider Apps and connectors…"),
		).toBeTruthy();

		await act(async () => {
			vi.advanceTimersByTime(1_000);
			await Promise.resolve();
		});
		expect(screen.getByText("Linear")).toBeTruthy();
		expect(getProviderAppsFn).toHaveBeenCalledTimes(3);
		expect(getProviderAppsFn).toHaveBeenLastCalledWith({
			data: {
				providerId: "codex",
				cwd: "/work/project",
				cursor: "page-2",
				limit: 50,
			},
		});
	});
});
