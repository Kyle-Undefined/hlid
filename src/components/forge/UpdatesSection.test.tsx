// @vitest-environment jsdom
import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CliUpdateStatus } from "#/lib/cliUpdateTypes";
import { UpdatesSection } from "./UpdatesSection";

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

type UpdateStatus = {
	current: string;
	latest: string | null;
	available: boolean;
	lastCheckedAt: number;
	cliUpdates?: CliUpdateStatus[];
	error?: string;
};

function makeStatus(overrides?: Partial<UpdateStatus>): UpdateStatus {
	return {
		current: "1.0.0",
		latest: null,
		available: false,
		lastCheckedAt: Date.now() - 30_000,
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
		const { unmount } = render(<UpdatesSection />);
		unmount();
		for (const [ageMs, label] of [
			[5 * 60_000, "last checked 5m ago"],
			[2 * 3_600_000, "last checked 2h ago"],
			[3 * 86_400_000, "last checked 3d ago"],
		] as const) {
			stubFetch(makeStatus({ lastCheckedAt: Date.now() - ageMs }));
			render(<UpdatesSection />);
			expect(await screen.findByText(new RegExp(label))).toBeTruthy();
			cleanup();
		}
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
