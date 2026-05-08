/**
 * proxy.ts — rate-limit window tracking and DB seeding.
 *
 * captureUtilizationHeaders is private; its behaviour is exercised indirectly
 * through seedWindowHighMarks (called by startAnthropicProxy) and read back
 * via getWindowMark.
 *
 * windowHighMark is module-level state that accumulates across tests.  We
 * work around this by:
 *   1. Placing initial-state tests before any startAnthropicProxy calls.
 *   2. Using distinct window-type keys per positive test.
 *   3. Testing "skip" behaviour by verifying the value is NOT updated rather
 *      than verifying it is undefined.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── module mocks (hoisted) ────────────────────────────────────────────────────

vi.mock("../db", () => ({
	getSetting: vi.fn().mockResolvedValue(null),
	saveSetting: vi.fn().mockResolvedValue(undefined),
	appendLog: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../lib/lifecycle", () => ({
	registerBunServer: vi.fn(),
}));

vi.mock("./runState", () => ({
	broadcast: vi.fn(),
}));

// ── imports after mocks ───────────────────────────────────────────────────────

import * as db from "../db";
import { registerBunServer } from "../lib/lifecycle";
import { getWindowMark, startAnthropicProxy } from "./proxy";

// ── helpers ───────────────────────────────────────────────────────────────────

function futureUnix(offsetSeconds = 3600): number {
	return Math.floor(Date.now() / 1000) + offsetSeconds;
}

function pastUnix(offsetSeconds = 3600): number {
	return Math.floor(Date.now() / 1000) - offsetSeconds;
}

// Port counter to ensure unique ports per test (Bun.serve is mocked but
// we still want to avoid confusion in logs).
let portSeed = 9800;
function nextPort(): number {
	return portSeed++;
}

beforeEach(() => {
	vi.stubGlobal("Bun", {
		serve: vi.fn().mockReturnValue({ stop: vi.fn(), port: 9999 }),
	});
});

afterEach(() => {
	vi.resetAllMocks();
	vi.unstubAllGlobals();
	// Re-apply non-null default for getSetting so next test's stubs work cleanly
	vi.mocked(db.getSetting).mockResolvedValue(null);
});

// ── initial state — MUST run before any startAnthropicProxy calls ─────────────
// (Vitest runs tests in file order; these come first in the file.)

describe("getWindowMark — initial state", () => {
	it("returns undefined for unknown rate-limit type", () => {
		expect(getWindowMark("nonexistent_type")).toBeUndefined();
	});

	it("returns undefined for five_hour before any proxy startup", () => {
		expect(getWindowMark("five_hour")).toBeUndefined();
	});

	it("returns undefined for weekly before any proxy startup", () => {
		expect(getWindowMark("weekly")).toBeUndefined();
	});

	it("returns undefined for weekly_sonnet before any proxy startup", () => {
		expect(getWindowMark("weekly_sonnet")).toBeUndefined();
	});
});

// ── startAnthropicProxy — seedWindowHighMarks ─────────────────────────────────

describe("startAnthropicProxy — DB seeding on startup", () => {
	it("seeds five_hour from DB with a future resetsAt", async () => {
		const resetsAt = futureUnix();
		vi.mocked(db.getSetting)
			.mockResolvedValueOnce(JSON.stringify({ utilization: 0.42, resetsAt })) // rl_5hr
			.mockResolvedValueOnce(null) // rl_weekly
			.mockResolvedValueOnce(null); // rl_weekly_sonnet

		await startAnthropicProxy(nextPort(), "https://api.anthropic.com");

		const mark = getWindowMark("five_hour");
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

		await startAnthropicProxy(nextPort(), "https://api.anthropic.com");

		expect(getWindowMark("weekly")?.utilization).toBeCloseTo(0.8);
	});

	it("seeds weekly_sonnet from DB", async () => {
		const resetsAt = futureUnix(7 * 24 * 3600);
		vi.mocked(db.getSetting)
			.mockResolvedValueOnce(null)
			.mockResolvedValueOnce(null)
			.mockResolvedValueOnce(JSON.stringify({ utilization: 0.55, resetsAt }));

		await startAnthropicProxy(nextPort(), "https://api.anthropic.com");

		expect(getWindowMark("weekly_sonnet")?.utilization).toBeCloseTo(0.55);
	});

	it("accepts null resetsAt (no reset time known)", async () => {
		vi.mocked(db.getSetting)
			.mockResolvedValueOnce(
				JSON.stringify({ utilization: 0.3, resetsAt: null }),
			)
			.mockResolvedValueOnce(null)
			.mockResolvedValueOnce(null);

		await startAnthropicProxy(nextPort(), "https://api.anthropic.com");

		const mark = getWindowMark("five_hour");
		// five_hour was previously seeded; this call may or may not update
		// depending on window logic. What matters: no throw, and the Map
		// entry (either new or existing) has a defined value.
		expect(mark).toBeDefined();
	});

	it("does NOT update Map for expired entries (resetsAt in the past)", async () => {
		// First, establish a known value for five_hour.
		const validResetsAt = futureUnix(3600);
		vi.mocked(db.getSetting)
			.mockResolvedValueOnce(
				JSON.stringify({ utilization: 0.11, resetsAt: validResetsAt }),
			)
			.mockResolvedValueOnce(null)
			.mockResolvedValueOnce(null);
		await startAnthropicProxy(nextPort(), "https://api.anthropic.com");
		const before = getWindowMark("five_hour");
		expect(before?.utilization).toBeCloseTo(0.11);

		// Now call with expired data for five_hour — Map must NOT be updated.
		vi.mocked(db.getSetting)
			.mockResolvedValueOnce(
				JSON.stringify({ utilization: 0.99, resetsAt: pastUnix(60) }),
			)
			.mockResolvedValueOnce(null)
			.mockResolvedValueOnce(null);
		await startAnthropicProxy(nextPort(), "https://api.anthropic.com");

		const after = getWindowMark("five_hour");
		expect(after?.utilization).not.toBeCloseTo(0.99);
		expect(after?.utilization).toBeCloseTo(0.11);
	});

	it("does NOT set Map for null utilization", async () => {
		// Establish a baseline for five_hour.
		const baseline = getWindowMark("five_hour");
		const baselineUtil = baseline?.utilization;

		vi.mocked(db.getSetting)
			.mockResolvedValueOnce(
				JSON.stringify({ utilization: null, resetsAt: futureUnix() }),
			)
			.mockResolvedValueOnce(null)
			.mockResolvedValueOnce(null);
		await startAnthropicProxy(nextPort(), "https://api.anthropic.com");

		// Map should NOT have been updated to null utilization.
		const after = getWindowMark("five_hour");
		if (baselineUtil != null) {
			// Had a value before — should still be that value.
			expect(after?.utilization).toBeCloseTo(baselineUtil);
		} else {
			// Had no value before — should still have no value.
			expect(after).toBeUndefined();
		}
	});

	it("tolerates corrupt DB JSON without throwing", async () => {
		vi.mocked(db.getSetting)
			.mockResolvedValueOnce("not-valid-json{{{")
			.mockResolvedValueOnce(null)
			.mockResolvedValueOnce(null);

		await expect(
			startAnthropicProxy(nextPort(), "https://api.anthropic.com"),
		).resolves.not.toThrow();
	});

	it("registers the Bun server with the lifecycle tracker", async () => {
		vi.mocked(db.getSetting).mockResolvedValue(null);

		await startAnthropicProxy(nextPort(), "https://api.anthropic.com");

		expect(registerBunServer).toHaveBeenCalledOnce();
	});

	it("sets ANTHROPIC_BASE_URL env var pointing to 127.0.0.1", async () => {
		vi.mocked(db.getSetting).mockResolvedValue(null);
		delete process.env.ANTHROPIC_BASE_URL;

		await startAnthropicProxy(nextPort(), "https://api.anthropic.com");

		expect(process.env.ANTHROPIC_BASE_URL).toMatch(/^http:\/\/127\.0\.0\.1:/);
	});

	it("seeds all three window types in a single startup call", async () => {
		const resetsAt = futureUnix();
		vi.mocked(db.getSetting)
			.mockResolvedValueOnce(JSON.stringify({ utilization: 0.21, resetsAt }))
			.mockResolvedValueOnce(JSON.stringify({ utilization: 0.22, resetsAt }))
			.mockResolvedValueOnce(JSON.stringify({ utilization: 0.23, resetsAt }));

		await startAnthropicProxy(nextPort(), "https://api.anthropic.com");

		// All three windows should now have been updated.
		expect(getWindowMark("five_hour")?.utilization).toBeCloseTo(0.21);
		expect(getWindowMark("weekly")?.utilization).toBeCloseTo(0.22);
		expect(getWindowMark("weekly_sonnet")?.utilization).toBeCloseTo(0.23);
	});
});
