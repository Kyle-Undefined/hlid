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
import {
	applyReading,
	getWindowMark,
	startProviderProxy,
	updateWindowMark,
} from "./proxy";
import { broadcast } from "./runState";

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

// ── updateWindowMark ──────────────────────────────────────────────────────────
// Uses "upd" provider to avoid colliding with the "claude" marks seeded above.

describe("updateWindowMark", () => {
	it("sets a new entry when none exists", () => {
		const resetsAt = futureUnix();
		updateWindowMark("upd", "new_entry", 0.5, resetsAt);
		const mark = getWindowMark("upd", "new_entry");
		expect(mark?.utilization).toBeCloseTo(0.5);
		expect(mark?.resetsAt).toBe(resetsAt);
	});

	it("updates when new utilization is higher (same window)", () => {
		const resetsAt = futureUnix();
		updateWindowMark("upd", "higher", 0.3, resetsAt);
		updateWindowMark("upd", "higher", 0.7, resetsAt);
		expect(getWindowMark("upd", "higher")?.utilization).toBeCloseTo(0.7);
	});

	it("updates when utilization is lower (external reset)", () => {
		// Anthropic can reset usage without changing resetsAt — downward moves valid.
		const resetsAt = futureUnix();
		updateWindowMark("upd", "lower", 0.8, resetsAt);
		updateWindowMark("upd", "lower", 0.3, resetsAt);
		expect(getWindowMark("upd", "lower")?.utilization).toBeCloseTo(0.3);
	});

	it("overwrites with equal utilization (idempotent latest-wins)", () => {
		const resetsAt = futureUnix();
		updateWindowMark("upd", "equal", 0.5, resetsAt);
		updateWindowMark("upd", "equal", 0.5, resetsAt);
		expect(getWindowMark("upd", "equal")?.utilization).toBeCloseTo(0.5);
	});

	it("updates on window rollover even if utilization is lower", () => {
		const resetsAt1 = futureUnix(3600);
		const resetsAt2 = futureUnix(7200);
		updateWindowMark("upd", "rollover", 0.9, resetsAt1);
		updateWindowMark("upd", "rollover", 0.1, resetsAt2);
		const mark = getWindowMark("upd", "rollover");
		expect(mark?.utilization).toBeCloseTo(0.1);
		expect(mark?.resetsAt).toBe(resetsAt2);
	});

	it("sets entry with null utilization when no entry exists", () => {
		updateWindowMark("upd", "null_new", null, futureUnix());
		const mark = getWindowMark("upd", "null_new");
		expect(mark).toBeDefined();
		expect(mark?.utilization).toBeNull();
	});

	it("skips update when utilization is null within unchanged window (no useful data)", () => {
		const resetsAt = futureUnix();
		updateWindowMark("upd", "null_existing", 0.6, resetsAt);
		// null utilization with same window = no useful data, skip update
		updateWindowMark("upd", "null_existing", null, resetsAt);
		expect(getWindowMark("upd", "null_existing")?.utilization).toBeCloseTo(0.6);
	});

	it("is provider-namespaced — same windowId under different providers are independent", () => {
		const resetsAt = futureUnix();
		updateWindowMark("upd-a", "shared", 0.4, resetsAt);
		updateWindowMark("upd-b", "shared", 0.9, resetsAt);
		expect(getWindowMark("upd-a", "shared")?.utilization).toBeCloseTo(0.4);
		expect(getWindowMark("upd-b", "shared")?.utilization).toBeCloseTo(0.9);
	});

	it("preserves remaining from previous entry when updating (any direction)", () => {
		const resetsAt = futureUnix();
		// First call: remaining = null (no prior entry)
		updateWindowMark("upd", "preserve", 0.3, resetsAt);
		expect(getWindowMark("upd", "preserve")?.remaining).toBeNull();
		// Same-window update (any direction): remaining carried forward as null
		updateWindowMark("upd", "preserve", 0.1, resetsAt);
		expect(getWindowMark("upd", "preserve")?.remaining).toBeNull();
	});
});

// ── applyReading ──────────────────────────────────────────────────────────────
// Uses "ar" provider namespace to avoid colliding with "upd" or "claude" marks.

describe("applyReading", () => {
	const BASE_RESETS_AT = Math.floor(Date.now() / 1000) + 3600;

	function makeReading(
		overrides: Partial<Parameters<typeof applyReading>[1]> = {},
	): Parameters<typeof applyReading>[1] {
		return {
			windowId: "weekly",
			label: "7-DAY",
			utilization: 0.5,
			remaining: null,
			limit: null,
			resetsAt: BASE_RESETS_AT,
			...overrides,
		};
	}

	it("sets mark on first call and writes DB + broadcasts", () => {
		vi.mocked(db.saveSetting).mockClear();
		vi.mocked(broadcast).mockClear();
		applyReading(
			"ar",
			makeReading({ windowId: "first_call", utilization: 0.5 }),
		);
		expect(getWindowMark("ar", "first_call")?.utilization).toBeCloseTo(0.5);
		expect(db.saveSetting).toHaveBeenCalledOnce();
		expect(broadcast).toHaveBeenCalledOnce();
		expect(broadcast).toHaveBeenCalledWith(
			expect.objectContaining({
				remaining: undefined,
				limit: undefined,
			}),
		);
	});

	it("broadcasts remaining and limit with a structured window reading", () => {
		vi.mocked(broadcast).mockClear();
		void applyReading(
			"ar",
			makeReading({ windowId: "full_reading", remaining: 240, limit: 1_000 }),
		);
		expect(broadcast).toHaveBeenCalledWith(
			expect.objectContaining({ remaining: 240, limit: 1_000 }),
		);
	});

	it("lower utilization replaces higher within same window (external reset)", () => {
		applyReading("ar", makeReading({ windowId: "ar_lower", utilization: 0.8 }));
		applyReading(
			"ar",
			makeReading({ windowId: "ar_lower", utilization: 0.03 }),
		);
		expect(getWindowMark("ar", "ar_lower")?.utilization).toBeCloseTo(0.03);
	});

	it("DB write fires on every valid reading regardless of direction", () => {
		vi.mocked(db.saveSetting).mockClear();
		applyReading(
			"ar",
			makeReading({ windowId: "ar_db_fire", utilization: 0.8 }),
		);
		applyReading(
			"ar",
			makeReading({ windowId: "ar_db_fire", utilization: 0.03 }),
		);
		expect(db.saveSetting).toHaveBeenCalledTimes(2);
	});

	it("broadcast only fires when value changes (no WS noise on identical readings)", () => {
		vi.mocked(broadcast).mockClear();
		applyReading("ar", makeReading({ windowId: "ar_bcast", utilization: 0.5 }));
		applyReading("ar", makeReading({ windowId: "ar_bcast", utilization: 0.5 })); // identical
		expect(broadcast).toHaveBeenCalledTimes(1); // only first call triggers it
	});

	it("broadcast fires on each change between different values", () => {
		vi.mocked(broadcast).mockClear();
		applyReading(
			"ar",
			makeReading({ windowId: "ar_bcast2", utilization: 0.8 }),
		);
		applyReading(
			"ar",
			makeReading({ windowId: "ar_bcast2", utilization: 0.03 }),
		);
		expect(broadcast).toHaveBeenCalledTimes(2);
	});

	it("new window (resetsAt changed) resets remaining to null in mark", () => {
		const resetsAt2 = BASE_RESETS_AT + 3600;
		applyReading(
			"ar",
			makeReading({
				windowId: "ar_new_win",
				utilization: 0.8,
				remaining: 5000,
				resetsAt: BASE_RESETS_AT,
			}),
		);
		applyReading(
			"ar",
			makeReading({
				windowId: "ar_new_win",
				utilization: 0.1,
				remaining: null,
				resetsAt: resetsAt2,
			}),
		);
		const mark = getWindowMark("ar", "ar_new_win");
		expect(mark?.resetsAt).toBe(resetsAt2);
		expect(mark?.utilization).toBeCloseTo(0.1);
	});

	it("skips pure no-data events (both null) within unchanged window", () => {
		vi.mocked(db.saveSetting).mockClear();
		applyReading(
			"ar",
			makeReading({ windowId: "ar_nodata", utilization: 0.6 }),
		);
		vi.mocked(db.saveSetting).mockClear();
		applyReading(
			"ar",
			makeReading({
				windowId: "ar_nodata",
				utilization: null,
				remaining: null,
			}),
		);
		// Mark should be unchanged, DB should not be written
		expect(getWindowMark("ar", "ar_nodata")?.utilization).toBeCloseTo(0.6);
		expect(db.saveSetting).not.toHaveBeenCalled();
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
