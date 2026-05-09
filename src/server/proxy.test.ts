/**
 * proxy.ts — provider proxy startup, DB seeding, and high-water-mark tracking.
 *
 * windowHighMark is module-level state that accumulates across tests. We work
 * around this by:
 *   1. Placing initial-state tests before any startProviderProxy calls.
 *   2. Using distinct providerId + windowId combinations per test where possible.
 *   3. Testing "skip" behaviour by verifying the value is NOT updated.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── module mocks (hoisted) ────────────────────────────────────────────────────

vi.mock("../db", () => ({
	getSetting: vi.fn().mockResolvedValue(null),
	saveSetting: vi.fn().mockResolvedValue(undefined),
	appendLog: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../lib/lifecycle", () => ({
	registerBunServer: vi.fn().mockImplementation((server) => server),
}));

vi.mock("./runState", () => ({
	broadcast: vi.fn(),
}));

// ── imports after mocks ───────────────────────────────────────────────────────

import * as db from "../db";
import { registerBunServer } from "../lib/lifecycle";
import type { AgentProvider } from "./agentProvider";
import { getWindowMark, startProviderProxy } from "./proxy";

// ── helpers ───────────────────────────────────────────────────────────────────

function futureUnix(offsetSeconds = 3600): number {
	return Math.floor(Date.now() / 1000) + offsetSeconds;
}

function pastUnix(offsetSeconds = 3600): number {
	return Math.floor(Date.now() / 1000) - offsetSeconds;
}

function makeClaudeProvider(): AgentProvider {
	return {
		providerId: "claude",
		query: vi.fn() as AgentProvider["query"],
		proxyConfig: {
			envVar: "ANTHROPIC_BASE_URL",
			windowIds: ["five_hour", "weekly", "weekly_sonnet"],
			parseHeaders: vi.fn().mockReturnValue([]),
		},
	};
}

beforeEach(() => {
	vi.stubGlobal("Bun", {
		serve: vi.fn().mockReturnValue({ stop: vi.fn(), port: 9999 }),
	});
	// resetAllMocks wipes mockImplementation; restore it each test.
	vi.mocked(registerBunServer).mockImplementation(
		(s) => s as ReturnType<typeof Bun.serve>,
	);
});

afterEach(() => {
	vi.resetAllMocks();
	vi.unstubAllGlobals();
	vi.mocked(db.getSetting).mockResolvedValue(null);
});

// ── initial state — MUST run before any startProviderProxy calls ──────────────

describe("getWindowMark — initial state", () => {
	it("returns undefined for unknown provider/window", () => {
		expect(getWindowMark("nonexistent", "five_hour")).toBeUndefined();
	});

	it("returns undefined for claude/five_hour before any proxy startup", () => {
		expect(getWindowMark("claude", "five_hour_init_test")).toBeUndefined();
	});
});

// ── startProviderProxy — seedWindowMarks ──────────────────────────────────────

describe("startProviderProxy — DB seeding on startup", () => {
	it("seeds five_hour from DB with a future resetsAt", async () => {
		const resetsAt = futureUnix();
		vi.mocked(db.getSetting)
			.mockResolvedValueOnce(JSON.stringify({ utilization: 0.42, resetsAt })) // rl_claude_five_hour
			.mockResolvedValueOnce(null) // rl_claude_weekly
			.mockResolvedValueOnce(null); // rl_claude_weekly_sonnet

		await startProviderProxy(makeClaudeProvider(), "https://api.anthropic.com");

		const mark = getWindowMark("claude", "five_hour");
		expect(mark).toBeDefined();
		expect(mark?.utilization).toBeCloseTo(0.42);
		expect(mark?.resetsAt).toBe(resetsAt);
	});

	it("seeds weekly from DB", async () => {
		const resetsAt = futureUnix(7 * 24 * 3600);
		vi.mocked(db.getSetting)
			.mockResolvedValueOnce(null)
			.mockResolvedValueOnce(JSON.stringify({ utilization: 0.8, resetsAt }))
			.mockResolvedValueOnce(null);

		await startProviderProxy(makeClaudeProvider(), "https://api.anthropic.com");

		expect(getWindowMark("claude", "weekly")?.utilization).toBeCloseTo(0.8);
	});

	it("seeds weekly_sonnet from DB", async () => {
		const resetsAt = futureUnix(7 * 24 * 3600);
		vi.mocked(db.getSetting)
			.mockResolvedValueOnce(null)
			.mockResolvedValueOnce(null)
			.mockResolvedValueOnce(JSON.stringify({ utilization: 0.55, resetsAt }));

		await startProviderProxy(makeClaudeProvider(), "https://api.anthropic.com");

		expect(getWindowMark("claude", "weekly_sonnet")?.utilization).toBeCloseTo(
			0.55,
		);
	});

	it("accepts null resetsAt (no reset time known)", async () => {
		vi.mocked(db.getSetting)
			.mockResolvedValueOnce(
				JSON.stringify({ utilization: 0.3, resetsAt: null }),
			)
			.mockResolvedValueOnce(null)
			.mockResolvedValueOnce(null);

		await startProviderProxy(makeClaudeProvider(), "https://api.anthropic.com");

		const mark = getWindowMark("claude", "five_hour");
		expect(mark).toBeDefined();
	});

	it("does NOT update Map for expired entries (resetsAt in the past)", async () => {
		const validResetsAt = futureUnix(3600);
		vi.mocked(db.getSetting)
			.mockResolvedValueOnce(
				JSON.stringify({ utilization: 0.11, resetsAt: validResetsAt }),
			)
			.mockResolvedValueOnce(null)
			.mockResolvedValueOnce(null);
		await startProviderProxy(makeClaudeProvider(), "https://api.anthropic.com");
		expect(getWindowMark("claude", "five_hour")?.utilization).toBeCloseTo(0.11);

		vi.mocked(db.getSetting)
			.mockResolvedValueOnce(
				JSON.stringify({ utilization: 0.99, resetsAt: pastUnix(60) }),
			)
			.mockResolvedValueOnce(null)
			.mockResolvedValueOnce(null);
		await startProviderProxy(makeClaudeProvider(), "https://api.anthropic.com");

		expect(getWindowMark("claude", "five_hour")?.utilization).not.toBeCloseTo(
			0.99,
		);
		expect(getWindowMark("claude", "five_hour")?.utilization).toBeCloseTo(0.11);
	});

	it("does NOT set Map for null utilization and null remaining", async () => {
		const baselineUtil = getWindowMark("claude", "five_hour")?.utilization;

		vi.mocked(db.getSetting)
			.mockResolvedValueOnce(
				JSON.stringify({
					utilization: null,
					remaining: null,
					resetsAt: futureUnix(),
				}),
			)
			.mockResolvedValueOnce(null)
			.mockResolvedValueOnce(null);
		await startProviderProxy(makeClaudeProvider(), "https://api.anthropic.com");

		const after = getWindowMark("claude", "five_hour");
		if (baselineUtil != null) {
			expect(after?.utilization).toBeCloseTo(baselineUtil);
		} else {
			expect(after).toBeUndefined();
		}
	});

	it("tolerates corrupt DB JSON without throwing", async () => {
		vi.mocked(db.getSetting)
			.mockResolvedValueOnce("not-valid-json{{{")
			.mockResolvedValueOnce(null)
			.mockResolvedValueOnce(null);

		await expect(
			startProviderProxy(makeClaudeProvider(), "https://api.anthropic.com"),
		).resolves.not.toThrow();
	});

	it("registers the Bun server with the lifecycle tracker", async () => {
		vi.mocked(db.getSetting).mockResolvedValue(null);

		await startProviderProxy(makeClaudeProvider(), "https://api.anthropic.com");

		expect(registerBunServer).toHaveBeenCalledOnce();
	});

	it("sets ANTHROPIC_BASE_URL env var pointing to 127.0.0.1", async () => {
		vi.mocked(db.getSetting).mockResolvedValue(null);
		delete process.env.ANTHROPIC_BASE_URL;

		await startProviderProxy(makeClaudeProvider(), "https://api.anthropic.com");

		expect(process.env.ANTHROPIC_BASE_URL).toMatch(/^http:\/\/127\.0\.0\.1:/);
	});

	it("seeds all three window types in a single startup call", async () => {
		const resetsAt = futureUnix();
		vi.mocked(db.getSetting)
			.mockResolvedValueOnce(JSON.stringify({ utilization: 0.21, resetsAt }))
			.mockResolvedValueOnce(JSON.stringify({ utilization: 0.22, resetsAt }))
			.mockResolvedValueOnce(JSON.stringify({ utilization: 0.23, resetsAt }));

		await startProviderProxy(makeClaudeProvider(), "https://api.anthropic.com");

		expect(getWindowMark("claude", "five_hour")?.utilization).toBeCloseTo(0.21);
		expect(getWindowMark("claude", "weekly")?.utilization).toBeCloseTo(0.22);
		expect(getWindowMark("claude", "weekly_sonnet")?.utilization).toBeCloseTo(
			0.23,
		);
	});

	it("does nothing when provider has no proxyConfig", async () => {
		const provider: AgentProvider = {
			providerId: "acp-test",
			query: vi.fn() as AgentProvider["query"],
		};

		await startProviderProxy(provider, "http://localhost:9000");

		expect(registerBunServer).not.toHaveBeenCalled();
	});
});

// ── getWindowMark — provider-namespaced ───────────────────────────────────────

describe("getWindowMark — provider namespacing", () => {
	it("returns undefined for a windowId under a different provider than what was seeded", async () => {
		const resetsAt = futureUnix();
		vi.mocked(db.getSetting)
			.mockResolvedValueOnce(JSON.stringify({ utilization: 0.5, resetsAt }))
			.mockResolvedValueOnce(null)
			.mockResolvedValueOnce(null);

		await startProviderProxy(makeClaudeProvider(), "https://api.anthropic.com");

		// Seeded under "claude" — "openai" must be separate namespace.
		expect(getWindowMark("openai", "five_hour")).toBeUndefined();
	});
});
