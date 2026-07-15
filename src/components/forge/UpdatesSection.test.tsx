// @vitest-environment jsdom
import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	__resetForTesting as resetUpdateStore,
	setUpdateStatus,
} from "#/hooks/updateStore";
import type { CliUpdateStatus } from "#/lib/cliUpdateTypes";
import type { ReleaseNotes } from "#/lib/updates";
import { UpdatesSection } from "./UpdatesSection";

vi.mock("#/components/TerminalView", () => ({
	TerminalView: (props: {
		cwd: string;
		wsPath: string;
		terminateOnDisconnect: boolean;
	}) => (
		<div
			data-testid="update-terminal"
			data-cwd={props.cwd}
			data-ws-path={props.wsPath}
			data-terminate={String(props.terminateOnDisconnect)}
		/>
	),
}));

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

type UpdateStatus = {
	current: string;
	latest: string | null;
	available: boolean;
	lastCheckedAt: number;
	release?: ReleaseNotes | null;
	cliUpdates?: CliUpdateStatus[];
	cliUpdateActionsAllowed?: boolean;
	error?: string;
};

function makeStatus(overrides?: Partial<UpdateStatus>): UpdateStatus {
	return {
		current: "1.0.0",
		latest: null,
		available: false,
		lastCheckedAt: Date.now() - 30_000,
		release: null,
		...overrides,
	};
}

function jsonResponse(body: unknown): Response {
	return {
		ok: true,
		json: () => Promise.resolve(body),
	} as Response;
}

/**
 * Stubs global fetch. GET /api/updates resolves with `status`; POST actions
 * are dispatched through `postResults` keyed by action name.
 */
function stubFetch(
	status: UpdateStatus | Error,
	postResults: Record<string, unknown> = {},
) {
	const fn = vi.fn((_url: RequestInfo | URL, init?: RequestInit) => {
		if (init?.method === "POST") {
			const { action } = JSON.parse(String(init.body)) as { action: string };
			return Promise.resolve(
				jsonResponse(postResults[action] ?? { ok: false }),
			);
		}
		if (status instanceof Error) return Promise.reject(status);
		return Promise.resolve(jsonResponse({ ok: true, data: status }));
	});
	vi.stubGlobal("fetch", fn);
	return fn;
}

describe("UpdatesSection", () => {
	beforeEach(() => {
		vi.restoreAllMocks();
		resetUpdateStore();
	});

	it("shows current version and up-to-date hint", async () => {
		stubFetch(makeStatus());
		render(<UpdatesSection />);
		expect(await screen.findByText("v1.0.0")).toBeTruthy();
		expect(screen.getByText("you're on the latest version")).toBeTruthy();
		expect(screen.getByText(/last checked just now/)).toBeTruthy();
	});

	it("shows available update with target version and download button", async () => {
		stubFetch(makeStatus({ latest: "1.1.0", available: true }));
		render(<UpdatesSection />);
		expect(await screen.findByText("update available: v1.1.0")).toBeTruthy();
		expect(screen.getByText("→ v1.1.0")).toBeTruthy();
		expect(screen.getByRole("button", { name: "DOWNLOAD" })).toBeTruthy();
	});

	it("applies the shared background reconciliation while Forge stays mounted", async () => {
		stubFetch(makeStatus());
		render(<UpdatesSection />);
		await screen.findByText("v1.0.0");

		act(() => {
			setUpdateStatus(
				makeStatus({ current: "1.0.0", latest: "1.1.0", available: true }),
			);
		});

		expect(screen.getByText("update available: v1.1.0")).toBeTruthy();
	});

	it("renders the latest published release notes and GitHub link", async () => {
		stubFetch(
			makeStatus({
				release: {
					version: "1.1.0",
					name: "Hlið v1.1.0",
					publishedAt: "2026-07-13T20:04:40Z",
					url: "https://github.com/Kyle-Undefined/hlid/releases/tag/v1.1.0",
					notes: "## Highlights\n\n- Added **Forge release notes**.",
				},
			}),
		);
		render(<UpdatesSection />);

		expect(await screen.findByText("Latest changes")).toBeTruthy();
		expect(screen.getByText("Hlið v1.1.0")).toBeTruthy();
		expect(screen.getByText("Forge release notes")).toBeTruthy();
		expect(
			screen.getByRole("link", { name: "View on GitHub" }).getAttribute("href"),
		).toBe("https://github.com/Kyle-Undefined/hlid/releases/tag/v1.1.0");
	});

	it("shows installed provider CLI versions and update instructions", async () => {
		stubFetch(
			makeStatus({
				cliUpdates: [
					{
						id: "codex",
						label: "Codex",
						installedVersion: "0.144.1",
						latestVersion: "0.144.2",
						available: true,
						updateCommand: "npm install --global @openai/codex@latest",
						checkedAt: Date.now(),
					},
				],
			}),
		);
		render(<UpdatesSection />);
		expect(await screen.findByText("Codex CLI")).toBeTruthy();
		expect(screen.getByText("update available: v0.144.2")).toBeTruthy();
		expect(
			screen.getByText("npm install --global @openai/codex@latest"),
		).toBeTruthy();
	});

	it("shows ACP updates without inventing a command for custom binaries", async () => {
		stubFetch(
			makeStatus({
				cliUpdates: [
					{
						id: "acp:custom",
						label: "Custom Agent (ACP)",
						installedVersion: "1.0.0",
						latestVersion: "2.0.0",
						available: true,
						checkedAt: Date.now(),
					},
				],
			}),
		);
		render(<UpdatesSection />);
		expect(await screen.findByText("Custom Agent (ACP) CLI")).toBeTruthy();
		expect(
			screen.getByText("update using the original installer"),
		).toBeTruthy();
	});

	it("applies an automatic CLI update only from the local Forge", async () => {
		const fetchMock = stubFetch(
			makeStatus({
				cliUpdateActionsAllowed: true,
				cliUpdates: [
					{
						id: "codex",
						label: "Codex",
						installedVersion: "1.0.0",
						latestVersion: "1.1.0",
						available: true,
						updateCommand: "npm install --global @openai/codex@latest",
						updateMode: "automatic",
						requiresElevation: false,
						checkedAt: Date.now(),
					},
				],
			}),
			{ apply_cli: { ok: true, data: {} } },
		);
		render(<UpdatesSection />);
		fireEvent.click(await screen.findByRole("button", { name: "UPDATE" }));
		expect(screen.getByText("stop sessions and update?")).toBeTruthy();
		expect(
			fetchMock.mock.calls.some((call) =>
				String(call[1]?.body).includes('"apply_cli"'),
			),
		).toBe(false);
		fireEvent.click(screen.getByRole("button", { name: "update" }));
		expect(await screen.findByText(/Codex updated/)).toBeTruthy();
		const request = fetchMock.mock.calls.find((call) => {
			const body = call[1]?.body;
			return typeof body === "string" && body.includes('"apply_cli"');
		});
		expect(JSON.parse(String(request?.[1]?.body))).toEqual({
			action: "apply_cli",
			id: "codex",
		});
	});

	it("opens an embedded terminal in the matching WSL distro for sudo", async () => {
		const wslCwd =
			"\\\\wsl.localhost\\Ubuntu-24.04\\home\\kyle\\development\\repos\\hlid";
		const updatedStatus = makeStatus({
			cliUpdateActionsAllowed: true,
			cliUpdates: [
				{
					id: "wsl:Ubuntu-24.04:claude",
					label: "Claude Code (Ubuntu-24.04)",
					installedVersion: "1.1.0",
					latestVersion: "1.1.0",
					available: false,
					checkedAt: Date.now(),
				},
			],
		});
		const fetchMock = stubFetch(
			makeStatus({
				cliUpdateActionsAllowed: true,
				cliUpdates: [
					{
						id: "wsl:Ubuntu-24.04:claude",
						label: "Claude Code (Ubuntu-24.04)",
						installedVersion: "1.0.0",
						latestVersion: "1.1.0",
						available: true,
						updateCommand: "sudo claude update",
						updateMode: "interactive",
						requiresElevation: true,
						checkedAt: Date.now(),
					},
				],
			}),
			{
				prepare_cli: {
					ok: true,
					data: {
						command: "sudo claude update",
						terminalCwd: wslCwd,
					},
				},
				check: { ok: true, data: updatedStatus },
			},
		);
		const writeText = vi.fn().mockResolvedValue(undefined);
		Object.defineProperty(navigator, "clipboard", {
			value: { writeText },
			configurable: true,
		});
		render(<UpdatesSection />);
		fireEvent.click(
			await screen.findByRole("button", { name: "OPEN TERMINAL" }),
		);
		expect(screen.getByText("stop sessions and open terminal?")).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: "open" }));
		await waitFor(() =>
			expect(writeText).toHaveBeenCalledWith("sudo claude update"),
		);
		expect(
			await screen.findByRole("dialog", {
				name: "Claude Code (Ubuntu-24.04) update terminal",
			}),
		).toBeTruthy();
		const terminal = screen.getByTestId("update-terminal");
		expect(terminal.getAttribute("data-cwd")).toBe(wslCwd);
		expect(terminal.getAttribute("data-ws-path")).toBe("/ws/shell");
		expect(terminal.getAttribute("data-terminate")).toBe("true");
		expect(screen.getAllByText("sudo claude update")).toHaveLength(2);

		fireEvent.click(
			screen.getByRole("button", { name: "Close update terminal" }),
		);
		expect(screen.queryByRole("dialog")).toBeNull();
		expect(
			await screen.findByText("Installed CLI versions refreshed."),
		).toBeTruthy();
		expect(
			fetchMock.mock.calls.some((call) =>
				String(call[1]?.body).includes('"action":"check"'),
			),
		).toBe(true);
		expect(screen.queryByRole("button", { name: "OPEN TERMINAL" })).toBeNull();
	});

	it("does not expose CLI mutation controls to remote browsers", async () => {
		stubFetch(
			makeStatus({
				cliUpdateActionsAllowed: false,
				cliUpdates: [
					{
						id: "codex",
						label: "Codex",
						installedVersion: "1.0.0",
						latestVersion: "1.1.0",
						available: true,
						updateCommand: "npm update",
						updateMode: "automatic",
						checkedAt: Date.now(),
					},
				],
			}),
		);
		render(<UpdatesSection />);
		await screen.findByText("Codex CLI");
		expect(screen.queryByRole("button", { name: "UPDATE" })).toBeNull();
	});

	it("shows last-check error notice from status", async () => {
		stubFetch(makeStatus({ error: "registry unreachable" }));
		render(<UpdatesSection />);
		expect(
			await screen.findByText("last check: registry unreachable"),
		).toBeTruthy();
	});

	it("renders retry button on fetch failure and refetches on click", async () => {
		const fetchMock = stubFetch(new Error("boom"));
		render(<UpdatesSection />);
		const retry = await screen.findByRole("button", { name: "RETRY" });
		expect(screen.getByText("error: boom")).toBeTruthy();
		fireEvent.click(retry);
		expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(2);
	});

	it("relative time buckets render minutes/hours/days/never", async () => {
		for (const [ageMs, label] of [
			[5 * 60_000, "last checked 5m ago"],
			[2 * 3_600_000, "last checked 2h ago"],
			[3 * 86_400_000, "last checked 3d ago"],
		] as const) {
			resetUpdateStore();
			stubFetch(makeStatus({ lastCheckedAt: Date.now() - ageMs }));
			render(<UpdatesSection />);
			expect(await screen.findByText(new RegExp(label))).toBeTruthy();
			cleanup();
		}
		resetUpdateStore();
		stubFetch(makeStatus({ lastCheckedAt: 0 }));
		render(<UpdatesSection />);
		expect(await screen.findByText("never checked")).toBeTruthy();
	});

	it("CHECK posts action and applies returned status", async () => {
		stubFetch(makeStatus(), {
			check: {
				ok: true,
				data: makeStatus({ latest: "2.0.0", available: true }),
			},
		});
		render(<UpdatesSection />);
		await screen.findByText("v1.0.0");
		fireEvent.click(screen.getByRole("button", { name: "CHECK" }));
		expect(await screen.findByText("update available: v2.0.0")).toBeTruthy();
	});

	it("CHECK failure surfaces error notice", async () => {
		stubFetch(makeStatus(), { check: { ok: false, error: "network down" } });
		render(<UpdatesSection />);
		await screen.findByText("v1.0.0");
		fireEvent.click(screen.getByRole("button", { name: "CHECK" }));
		expect(await screen.findByText("network down")).toBeTruthy();
	});

	it("DOWNLOAD success shows launch button for target version", async () => {
		stubFetch(makeStatus({ latest: "1.1.0", available: true }), {
			download: { ok: true, data: { version: "1.1.0" } },
		});
		render(<UpdatesSection />);
		fireEvent.click(await screen.findByRole("button", { name: "DOWNLOAD" }));
		expect(
			await screen.findByRole("button", { name: "LAUNCH v1.1.0" }),
		).toBeTruthy();
	});

	it("DOWNLOAD with missing version in response shows error", async () => {
		stubFetch(makeStatus({ latest: "1.1.0", available: true }), {
			download: { ok: true, data: {} },
		});
		render(<UpdatesSection />);
		fireEvent.click(await screen.findByRole("button", { name: "DOWNLOAD" }));
		expect(
			await screen.findByText(/incomplete download response/),
		).toBeTruthy();
	});

	it("DOWNLOAD failure shows error message", async () => {
		stubFetch(makeStatus({ latest: "1.1.0", available: true }), {
			download: { ok: false, error: "checksum mismatch" },
		});
		render(<UpdatesSection />);
		fireEvent.click(await screen.findByRole("button", { name: "DOWNLOAD" }));
		expect(await screen.findByText("checksum mismatch")).toBeTruthy();
	});

	it("LAUNCH failure surfaces error instead of launching notice", async () => {
		stubFetch(makeStatus({ latest: "1.1.0", available: true }), {
			download: { ok: true, data: { version: "1.1.0" } },
			apply: { ok: false, error: "spawn blocked" },
		});
		render(<UpdatesSection />);
		fireEvent.click(await screen.findByRole("button", { name: "DOWNLOAD" }));
		fireEvent.click(
			await screen.findByRole("button", { name: "LAUNCH v1.1.0" }),
		);
		expect(await screen.findByText("spawn blocked")).toBeTruthy();
	});

	it("polls /api/version while launching without reloading on same version", async () => {
		const fetchMock = stubFetch(
			makeStatus({ latest: "1.1.0", available: true }),
			{
				download: { ok: true, data: { version: "1.1.0" } },
				apply: { ok: true, data: {} },
			},
		);
		render(<UpdatesSection />);
		fireEvent.click(await screen.findByRole("button", { name: "DOWNLOAD" }));
		fireEvent.click(
			await screen.findByRole("button", { name: "LAUNCH v1.1.0" }),
		);
		await screen.findByText(/launching v1.1.0/);
		// interval fires at 1.5s; same version in response = no reload
		await waitFor(
			() =>
				expect(
					fetchMock.mock.calls.some((c) => String(c[0]) === "/api/version"),
				).toBe(true),
			{ timeout: 3000 },
		);
	});

	it("LAUNCH success shows launching notice", async () => {
		stubFetch(makeStatus({ latest: "1.1.0", available: true }), {
			download: { ok: true, data: { version: "1.1.0" } },
			apply: { ok: true, data: {} },
		});
		render(<UpdatesSection />);
		fireEvent.click(await screen.findByRole("button", { name: "DOWNLOAD" }));
		fireEvent.click(
			await screen.findByRole("button", { name: "LAUNCH v1.1.0" }),
		);
		expect(await screen.findByText(/launching v1.1.0/)).toBeTruthy();
	});
});
