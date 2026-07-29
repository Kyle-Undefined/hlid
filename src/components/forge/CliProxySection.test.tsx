// @vitest-environment jsdom
import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CLIPROXY_CONFIG } from "#/config";
import type { CliProxyStatus } from "#/server/cliproxyManager";

const actions = vi.hoisted(() => ({
	connectCliProxyAntigravityFn: vi.fn(),
	connectCliProxyClaudeFn: vi.fn(),
	connectCliProxyCodexFn: vi.fn(),
	connectCliProxyKimiFn: vi.fn(),
	connectCliProxyXaiFn: vi.fn(),
	getCliProxyInfoFn: vi.fn(),
	installCliProxyFn: vi.fn(),
	refreshCliProxyInfoFn: vi.fn(),
	removeCliProxyFn: vi.fn(),
	startCliProxyFn: vi.fn(),
	stopCliProxyFn: vi.fn(),
}));

vi.mock("#/lib/serverFns/cliproxy", () => actions);

import { CliProxySection } from "./CliProxySection";

function status(
	patch: Omit<Partial<CliProxyStatus>, "accounts"> & {
		accounts?: Partial<CliProxyStatus["accounts"]>;
	} = {},
): CliProxyStatus {
	const accounts = {
		codex: "idle" as const,
		claude: "idle" as const,
		antigravity: "idle" as const,
		kimi: "idle" as const,
		xai: "idle" as const,
		...patch.accounts,
	};
	return {
		state: "installed",
		managed: true,
		installedVersion: "7.2.88",
		approvedVersion: "7.2.88",
		versionMismatch: false,
		wslInstalled: true,
		authenticated: false,
		oauth: "idle",
		...patch,
		accounts,
	};
}

beforeEach(() => {
	const installed = status();
	for (const action of Object.values(actions)) {
		action.mockReset();
		action.mockResolvedValue(installed);
	}
});

afterEach(() => {
	cleanup();
});

describe("CliProxySection", () => {
	it("moves an external integration into the managed install flow", async () => {
		const external = status({
			state: "not_installed",
			managed: false,
			installedVersion: undefined,
		});
		render(
			<CliProxySection
				config={{
					...DEFAULT_CLIPROXY_CONFIG,
					enabled: true,
					mode: "external",
					base_url: "https://proxy.example.test",
				}}
				initialInfo={external}
			/>,
		);

		expect(screen.getByText("External")).toBeTruthy();
		expect(screen.getByText(/proxy\.example\.test/)).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: "Install managed" }));

		await waitFor(() =>
			expect(actions.installCliProxyFn).toHaveBeenCalledOnce(),
		);
		expect(await screen.findByText("OAuth accounts")).toBeTruthy();
	});

	it("routes every account button to its provider action", async () => {
		render(
			<CliProxySection
				config={{ ...DEFAULT_CLIPROXY_CONFIG, mode: "managed" }}
				initialInfo={status({ accounts: { codex: "connected" } })}
			/>,
		);

		const accountActions = [
			["Reconnect OpenAI Codex", actions.connectCliProxyCodexFn],
			["Connect Anthropic Claude", actions.connectCliProxyClaudeFn],
			["Connect Google Antigravity", actions.connectCliProxyAntigravityFn],
			["Connect Moonshot Kimi", actions.connectCliProxyKimiFn],
			["Connect xAI", actions.connectCliProxyXaiFn],
		] as const;
		for (const [label, action] of accountActions) {
			fireEvent.click(screen.getByRole("button", { name: label }));
			await waitFor(() => expect(action).toHaveBeenCalledOnce());
		}
	});

	it("shows install progress and browser-assisted OAuth details", () => {
		render(
			<CliProxySection
				config={{ ...DEFAULT_CLIPROXY_CONFIG, mode: "managed" }}
				initialInfo={status({
					state: "downloading",
					activeOAuth: "codex",
					oauth: "running",
					oauthUrl: "https://login.example.test/device",
					oauthCode: "ABCD-EFGH",
					oauthBrowserOpened: false,
					download: { received: 1024, total: 2048 },
				})}
			/>,
		);

		expect(screen.getByText("Downloaded 1 KB of 2 KB")).toBeTruthy();
		expect(screen.getByText(/Browser launch failed/)).toBeTruthy();
		expect(
			screen
				.getByRole("link", { name: "Open sign-in page" })
				.getAttribute("href"),
		).toBe("https://login.example.test/device");
		expect(screen.getByText("ABCD-EFGH")).toBeTruthy();
		expect(
			screen
				.getByRole("button", { name: "Installing…" })
				.hasAttribute("disabled"),
		).toBe(true);
	});

	it("recovers status and surfaces a failed lifecycle action", async () => {
		actions.startCliProxyFn.mockRejectedValueOnce(new Error("start exploded"));
		actions.getCliProxyInfoFn.mockResolvedValueOnce(status());
		render(
			<CliProxySection
				config={{ ...DEFAULT_CLIPROXY_CONFIG, mode: "managed" }}
				initialInfo={status()}
			/>,
		);

		fireEvent.click(screen.getByRole("button", { name: "Enable" }));

		expect((await screen.findByRole("alert")).textContent).toContain(
			"start exploded",
		);
		expect(actions.getCliProxyInfoFn).toHaveBeenCalledOnce();
	});

	it("presents running, repair, and removal actions from status", async () => {
		render(
			<CliProxySection
				config={{ ...DEFAULT_CLIPROXY_CONFIG, mode: "managed" }}
				initialInfo={status({
					state: "running",
					versionMismatch: true,
					approvedVersion: "7.3.0",
				})}
			/>,
		);

		expect(
			screen.getByRole("button", { name: "Use approved v7.3.0" }),
		).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: "Disable" }));
		await waitFor(() => expect(actions.stopCliProxyFn).toHaveBeenCalledOnce());

		fireEvent.click(screen.getByRole("button", { name: "Remove" }));
		fireEvent.click(screen.getByRole("button", { name: "remove" }));
		await waitFor(() =>
			expect(actions.removeCliProxyFn).toHaveBeenCalledOnce(),
		);
	});

	it("refreshes release status from the WSL support action state", async () => {
		render(
			<CliProxySection
				config={{ ...DEFAULT_CLIPROXY_CONFIG, mode: "managed" }}
				initialInfo={status({ wslInstalled: false })}
			/>,
		);

		expect(
			screen.getByRole("button", { name: "Add WSL support" }),
		).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: "Refresh" }));

		await waitFor(() =>
			expect(actions.refreshCliProxyInfoFn).toHaveBeenCalledOnce(),
		);
		expect(
			await screen.findByRole("button", { name: "Check / repair" }),
		).toBeTruthy();
	});
});
