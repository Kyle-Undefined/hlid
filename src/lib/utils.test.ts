/**
 * Utility function tests — pure logic, no mocks needed.
 */
import { describe, expect, it } from "vitest";
import { clampInt, cn, SESSION_LABEL_LENGTH, uid } from "./utils";

// ── SESSION_LABEL_LENGTH ──────────────────────────────────────────────────────

describe("SESSION_LABEL_LENGTH", () => {
	it("is a positive integer", () => {
		expect(SESSION_LABEL_LENGTH).toBeGreaterThan(0);
		expect(Number.isInteger(SESSION_LABEL_LENGTH)).toBe(true);
	});

	it("equals 40", () => {
		expect(SESSION_LABEL_LENGTH).toBe(40);
	});
});

// ── cn ────────────────────────────────────────────────────────────────────────

describe("cn", () => {
	it("joins class names", () => {
		expect(cn("a", "b")).toBe("a b");
	});

	it("filters falsy values", () => {
		expect(cn("a", false, null, undefined, "b")).toBe("a b");
	});

	it("merges conflicting Tailwind classes (last wins)", () => {
		// tailwind-merge deduplicates bg- utilities
		expect(cn("bg-red-500", "bg-blue-500")).toBe("bg-blue-500");
	});

	it("handles empty call", () => {
		expect(cn()).toBe("");
	});

	it("handles conditional object syntax", () => {
		expect(cn({ "text-bold": true, "text-italic": false })).toBe("text-bold");
	});
});

// ── uid ───────────────────────────────────────────────────────────────────────

describe("uid", () => {
	it("returns a non-empty string", () => {
		expect(typeof uid()).toBe("string");
		expect(uid().length).toBeGreaterThan(0);
	});

	it("generates unique values", () => {
		const ids = new Set(Array.from({ length: 50 }, uid));
		expect(ids.size).toBe(50);
	});

	it("looks like a UUID or fallback format", () => {
		const id = uid();
		// Either UUID format (xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx) or fallback
		const isUuid =
			/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id);
		const isFallback = /^[a-z0-9]+-[a-z0-9]+$/.test(id);
		expect(isUuid || isFallback).toBe(true);
	});
});

// ── clampInt ──────────────────────────────────────────────────────────────────

describe("clampInt", () => {
	it("parses valid integer string", () => {
		expect(clampInt("5", 1, 0, 10)).toBe(5);
	});

	it("returns default for null input", () => {
		expect(clampInt(null, 3, 0, 10)).toBe(3);
	});

	it("returns default for non-numeric string", () => {
		expect(clampInt("abc", 7, 0, 10)).toBe(7);
	});

	it("returns default when value < min", () => {
		expect(clampInt("-5", 3, 0, 10)).toBe(3);
	});

	it("returns default when value > max", () => {
		expect(clampInt("15", 5, 0, 10)).toBe(5);
	});

	it("accepts value equal to min", () => {
		expect(clampInt("0", 5, 0, 10)).toBe(0);
	});

	it("accepts value equal to max", () => {
		expect(clampInt("10", 5, 0, 10)).toBe(10);
	});

	it("uses MAX_SAFE_INTEGER as default upper bound", () => {
		expect(clampInt("999999", 0, 0)).toBe(999999);
	});
});
