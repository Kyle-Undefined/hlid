// @vitest-environment jsdom
import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
	pathname: "/raven",
	search: {} as Record<string, string>,
	status: null as null | {
		current: string;
		latest: string | null;
		available: boolean;
		lastCheckedAt: number;
		cliUpdates?: Array<{
			id: "codex" | "claude" | "codex-desktop" | `acp:${string}`;
			label: string;
			surface?: "cli" | "desktop";
			installedVersion: string | null;
			latestVersion: string | null;
			available: boolean;
			noticeId?: string;
			noticeDestination?: {
				category?: string;
				section?: string;
				view?: string;
			};
			checkedAt: number;
		}>;
	},
}));

vi.mock("@tanstack/react-router", () => ({
	Link: ({
		children,
		className,
		search,
	}: {
		children: ReactNode;
		className?: string;
		search?: Record<string, string>;
	}) => {
		const query = search ? `?${new URLSearchParams(search)}` : "";
		return (
			<a href={`/forge${query}`} className={className}>
				{children}
			</a>
		);
	},
	useLocation: () => ({ pathname: state.pathname, search: state.search }),
}));

vi.mock("#/hooks/updateStore", () => ({
	fetchUpdateStatus: vi.fn().mockResolvedValue(undefined),
	getUpdateServerSnapshot: () => null,
	getUpdateSnapshot: () => state.status,
	subscribeUpdateStatus: () => () => {},
}));

import { UpdateBanner } from "./UpdateBanner";

afterEach(cleanup);

beforeEach(() => {
	localStorage.clear();
	state.pathname = "/raven";
	state.search = {};
	state.status = {
		current: "0.0.106",
		latest: "0.0.106",
		available: false,
		lastCheckedAt: Date.now(),
		cliUpdates: [],
	};
});

describe("UpdateBanner", () => {
	it("prompts when an installed provider CLI has an update", () => {
		state.status?.cliUpdates?.push({
			id: "codex",
			label: "Codex",
			installedVersion: "0.144.1",
			latestVersion: "0.144.2",
			available: true,
			checkedAt: Date.now(),
		});

		render(<UpdateBanner />);

		expect(screen.getByText("Codex CLI v0.144.2 available")).toBeTruthy();
	});

	it("prompts for an enabled ACP agent update", () => {
		state.status?.cliUpdates?.push({
			id: "acp:opencode",
			label: "OpenCode (ACP)",
			installedVersion: "1.0.0",
			latestVersion: "1.1.0",
			available: true,
			checkedAt: Date.now(),
		});

		render(<UpdateBanner />);

		expect(
			screen.getByText("OpenCode (ACP) CLI v1.1.0 available"),
		).toBeTruthy();
	});

	it("prompts for a Microsoft Store desktop app update", () => {
		state.status?.cliUpdates?.push({
			id: "codex-desktop",
			label: "Codex desktop app",
			surface: "desktop",
			installedVersion: "26.707.9981.0",
			latestVersion: "26.708.10000.0",
			available: true,
			checkedAt: Date.now(),
		});

		render(<UpdateBanner />);

		expect(
			screen.getByText("Codex desktop app v26.708.10000.0 available"),
		).toBeTruthy();
	});

	it("prioritizes an Hlid update over a provider CLI update", () => {
		if (!state.status) throw new Error("missing status fixture");
		state.status.available = true;
		state.status.latest = "0.0.107";
		state.status.cliUpdates = [
			{
				id: "codex",
				label: "Codex",
				installedVersion: "0.144.1",
				latestVersion: "0.144.2",
				available: true,
				checkedAt: Date.now(),
			},
		];

		render(<UpdateBanner />);

		expect(screen.getByText("Hlid v0.0.107 available")).toBeTruthy();
	});

	it("advances through available updates as each notice is dismissed", () => {
		if (!state.status) throw new Error("missing status fixture");
		state.status.available = true;
		state.status.latest = "0.0.107";
		state.status.cliUpdates = [
			{
				id: "codex",
				label: "Codex",
				installedVersion: "0.144.1",
				latestVersion: "0.144.2",
				available: true,
				checkedAt: Date.now(),
			},
			{
				id: "acp:opencode",
				label: "OpenCode (ACP)",
				installedVersion: "1.0.0",
				latestVersion: "1.1.0",
				available: true,
				checkedAt: Date.now(),
			},
		];

		render(<UpdateBanner />);

		expect(screen.getByText("Hlid v0.0.107 available")).toBeTruthy();
		fireEvent.click(
			screen.getByRole("button", { name: "Dismiss update notification" }),
		);
		expect(screen.getByText("Codex CLI v0.144.2 available")).toBeTruthy();
		fireEvent.click(
			screen.getByRole("button", { name: "Dismiss update notification" }),
		);
		expect(
			screen.getByText("OpenCode (ACP) CLI v1.1.0 available"),
		).toBeTruthy();
	});

	it("skips a notice dismissed during an earlier visit", async () => {
		localStorage.setItem("hlid:update-dismissed:codex:0.144.2", "1");
		state.status?.cliUpdates?.push(
			{
				id: "codex",
				label: "Codex",
				installedVersion: "0.144.1",
				latestVersion: "0.144.2",
				available: true,
				checkedAt: Date.now(),
			},
			{
				id: "claude",
				label: "Claude",
				installedVersion: "2.0.0",
				latestVersion: "2.1.0",
				available: true,
				checkedAt: Date.now(),
			},
		);

		render(<UpdateBanner />);

		await waitFor(() =>
			expect(screen.getByText("Claude CLI v2.1.0 available")).toBeTruthy(),
		);
	});

	it("uses a notice identity distinct from the update version", async () => {
		localStorage.setItem(
			"hlid:update-dismissed:acp:opencode:windows:revision-1",
			"1",
		);
		state.status?.cliUpdates?.push({
			id: "acp:opencode:windows",
			label: "OpenCode (Windows)",
			installedVersion: "1.0.0",
			latestVersion: "1.1.0",
			available: true,
			noticeId: "acp:opencode:windows:revision-2",
			checkedAt: Date.now(),
		});

		render(<UpdateBanner />);

		await waitFor(() =>
			expect(
				screen.getByText("OpenCode (Windows) CLI v1.1.0 available"),
			).toBeTruthy(),
		);
	});

	it("links a managed notice to its owning integration", () => {
		state.status?.cliUpdates?.push({
			id: "acp:opencode:windows",
			label: "OpenCode (Windows)",
			installedVersion: "1.0.0",
			latestVersion: "1.1.0",
			available: true,
			noticeDestination: {
				category: "integrations",
				section: "opencode-acp",
				view: "acp",
			},
			checkedAt: Date.now(),
		});

		render(<UpdateBanner />);

		expect(
			screen
				.getByRole("link", { name: "OpenCode (Windows) CLI v1.1.0 available" })
				.getAttribute("href"),
		).toBe("/forge?category=integrations&section=opencode-acp&view=acp");
	});

	it("keeps a target-qualified managed notice inside the mobile viewport", () => {
		state.status?.cliUpdates?.push({
			id: "acp:opencode:managed:wsl-ubuntu-24.04",
			label: "OpenCode (ACP · WSL · Ubuntu-24.04)",
			installedVersion: "1.18.16",
			latestVersion: "1.18.18",
			available: true,
			noticeDestination: {
				category: "integrations",
				section: "opencode-acp",
				view: "acp",
			},
			checkedAt: Date.now(),
		});

		render(<UpdateBanner />);

		const notice = screen.getByRole("status");
		const link = screen.getByRole("link", {
			name: "OpenCode (ACP · WSL · Ubuntu-24.04) CLI v1.18.18 available",
		});
		const dismiss = screen.getByRole("button", {
			name: "Dismiss update notification",
		});
		expect(notice.className).toContain("w-max");
		expect(notice.className).toContain("max-w-[calc(100%_-_1.5rem)]");
		expect(link.className).toContain("min-w-0");
		expect(link.className).toContain("whitespace-normal");
		expect(link.className).toContain("[overflow-wrap:anywhere]");
		expect(dismiss.className).toContain("shrink-0");
	});

	it("shows a destination notice on an unrelated Forge page", () => {
		state.pathname = "/forge";
		state.search = { category: "overview", section: "updates" };
		state.status?.cliUpdates?.push({
			id: "acp:opencode:windows",
			label: "OpenCode (Windows)",
			installedVersion: "1.0.0",
			latestVersion: "1.1.0",
			available: true,
			noticeDestination: {
				category: "integrations",
				section: "opencode-acp",
				view: "acp",
			},
			checkedAt: Date.now(),
		});

		render(<UpdateBanner />);

		expect(
			screen.getByText("OpenCode (Windows) CLI v1.1.0 available"),
		).toBeTruthy();
	});

	it("hides a destination notice at its exact Forge destination", () => {
		state.pathname = "/forge";
		state.search = {
			category: "integrations",
			section: "opencode-acp",
			view: "acp",
		};
		state.status?.cliUpdates?.push({
			id: "acp:opencode:windows",
			label: "OpenCode (Windows)",
			installedVersion: "1.0.0",
			latestVersion: "1.1.0",
			available: true,
			noticeDestination: {
				category: "integrations",
				section: "opencode-acp",
				view: "acp",
			},
			checkedAt: Date.now(),
		});

		render(<UpdateBanner />);

		expect(screen.queryByText(/OpenCode \(Windows\) CLI/)).toBeNull();
	});

	it("skips the notice owned by the current Forge view and shows the next", () => {
		state.pathname = "/forge";
		state.search = {
			category: "integrations",
			section: "opencode-acp",
			view: "acp",
		};
		state.status?.cliUpdates?.push(
			{
				id: "acp:opencode:windows",
				label: "OpenCode (Windows)",
				installedVersion: "1.0.0",
				latestVersion: "1.1.0",
				available: true,
				noticeDestination: {
					category: "integrations",
					section: "opencode-acp",
					view: "acp",
				},
				checkedAt: Date.now(),
			},
			{
				id: "codex",
				label: "Codex",
				installedVersion: "0.144.1",
				latestVersion: "0.144.2",
				available: true,
				checkedAt: Date.now(),
			},
		);

		render(<UpdateBanner />);

		expect(screen.getByText("Codex CLI v0.144.2 available")).toBeTruthy();
	});

	it("leaves update details to Forge while already on that page", () => {
		state.pathname = "/forge";
		state.status?.cliUpdates?.push({
			id: "codex",
			label: "Codex",
			installedVersion: "0.144.1",
			latestVersion: "0.144.2",
			available: true,
			checkedAt: Date.now(),
		});

		render(<UpdateBanner />);

		expect(screen.queryByText(/Codex CLI/)).toBeNull();
	});
});
