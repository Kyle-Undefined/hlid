/**
 * Pure formatter function tests — no mocks needed.
 */
import { describe, expect, it } from "vitest";
import {
	fmt,
	fmtBytes,
	fmtModel,
	fmtMs,
	fmtResetTime,
	fmtRunTime,
	normalizeModel,
} from "./formatters";

// ── normalizeModel ────────────────────────────────────────────────────────────

describe("normalizeModel", () => {
	it("strips 8-digit date suffix", () => {
		expect(normalizeModel("claude-opus-4-7-20251001")).toBe("claude-opus-4-7");
	});

	it("no-ops when no date suffix present", () => {
		expect(normalizeModel("claude-sonnet-4-6")).toBe("claude-sonnet-4-6");
	});

	it("does not strip partial numeric suffixes", () => {
		expect(normalizeModel("claude-haiku-4-5")).toBe("claude-haiku-4-5");
	});
});

// ── fmtModel ──────────────────────────────────────────────────────────────────

describe("fmtModel", () => {
	it("returns known label for exact match", () => {
		expect(fmtModel("claude-opus-4-7")).toBe("Opus 4.7");
		expect(fmtModel("claude-sonnet-4-6")).toBe("Sonnet 4.6");
		expect(fmtModel("claude-haiku-4-5-20251001")).toBe("Haiku 4.5");
	});

	it("matches after stripping date suffix", () => {
		expect(fmtModel("claude-opus-4-7-20251001")).toBe("Opus 4.7");
	});

	it("falls back to stripping claude- prefix for unknown models", () => {
		expect(fmtModel("claude-new-model-3-0")).toBe("new-model-3-0");
	});

	it("fallback preserves string when no claude- prefix", () => {
		expect(fmtModel("gpt-4")).toBe("gpt-4");
	});
});

// ── fmt ───────────────────────────────────────────────────────────────────────

describe("fmt", () => {
	it("returns raw string for < 1k", () => {
		expect(fmt(0)).toBe("0");
		expect(fmt(999)).toBe("999");
	});

	it("formats thousands with k suffix", () => {
		expect(fmt(1000)).toBe("1.0k");
		expect(fmt(1500)).toBe("1.5k");
		expect(fmt(999_999)).toBe("1000.0k");
	});

	it("formats millions with M suffix", () => {
		expect(fmt(1_000_000)).toBe("1.0M");
		expect(fmt(2_500_000)).toBe("2.5M");
	});
});

// ── fmtMs ─────────────────────────────────────────────────────────────────────

describe("fmtMs", () => {
	it("returns ms for < 1000", () => {
		expect(fmtMs(0)).toBe("0ms");
		expect(fmtMs(999)).toBe("999ms");
	});

	it("returns seconds for >= 1000", () => {
		expect(fmtMs(1000)).toBe("1.0s");
		expect(fmtMs(2500)).toBe("2.5s");
	});
});

// ── fmtBytes ──────────────────────────────────────────────────────────────────

describe("fmtBytes", () => {
	it("formats bytes", () => {
		expect(fmtBytes(0)).toBe("0 B");
		expect(fmtBytes(512)).toBe("512 B");
		expect(fmtBytes(1023)).toBe("1023 B");
	});

	it("formats kilobytes", () => {
		expect(fmtBytes(1024)).toBe("1.0 KB");
		expect(fmtBytes(2048)).toBe("2.0 KB");
	});

	it("formats megabytes", () => {
		expect(fmtBytes(1024 * 1024)).toBe("1.0 MB");
		expect(fmtBytes(1.5 * 1024 * 1024)).toBe("1.5 MB");
	});

	it("formats gigabytes", () => {
		expect(fmtBytes(1024 ** 3)).toBe("1.00 GB");
	});

	it("throws on negative input", () => {
		expect(() => fmtBytes(-1)).toThrow(RangeError);
	});
});

// ── fmtResetTime ──────────────────────────────────────────────────────────────

describe("fmtResetTime", () => {
	it("returns 'now' when time already passed", () => {
		const past = Math.floor(Date.now() / 1000) - 60;
		expect(fmtResetTime(past)).toBe("now");
	});

	it("formats minutes-only when < 1h", () => {
		const future = Math.floor(Date.now() / 1000) + 30 * 60; // 30 min
		expect(fmtResetTime(future)).toMatch(/^\d+m$/);
	});

	it("formats hours and minutes when 1h–24h", () => {
		const future = Math.floor(Date.now() / 1000) + 2 * 3600 + 15 * 60; // 2h15m
		expect(fmtResetTime(future)).toMatch(/^\d+h \d+m$/);
	});

	it("formats days and hours when >= 24h", () => {
		const future = Math.floor(Date.now() / 1000) + 25 * 3600; // 25h
		expect(fmtResetTime(future)).toMatch(/^\d+d \d+h$/);
	});
});

// ── fmtRunTime ────────────────────────────────────────────────────────────────

describe("fmtRunTime", () => {
	it("returns HH:MM format", () => {
		// Test structural shape: should be exactly HH:MM
		const result = fmtRunTime(Math.floor(Date.now() / 1000));
		expect(result).toMatch(/^\d{2}:\d{2}$/);
	});

	it("pads single-digit hours and minutes with zero", () => {
		// Midnight UTC as reference — use a fixed epoch that is 00:00 local
		// We can't assume timezone, so just verify the format holds
		const result = fmtRunTime(0);
		expect(result).toMatch(/^\d{2}:\d{2}$/);
	});
});
