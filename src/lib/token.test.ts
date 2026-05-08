/**
 * verifyToken — timing-safe comparison logic.
 * No mocks needed: pure crypto logic, no disk I/O (loadToken skipped).
 */
import { describe, expect, it } from "vitest";
import { verifyToken } from "./token";

// ── verifyToken ───────────────────────────────────────────────────────────────

describe("verifyToken", () => {
	it("returns true for matching tokens", () => {
		const token = "a".repeat(64);
		expect(verifyToken(token, token)).toBe(true);
	});

	it("returns false for null candidate", () => {
		expect(verifyToken(null, "sometoken")).toBe(false);
	});

	it("returns false for undefined candidate", () => {
		expect(verifyToken(undefined, "sometoken")).toBe(false);
	});

	it("returns false for empty string candidate", () => {
		expect(verifyToken("", "sometoken")).toBe(false);
	});

	it("returns false when lengths differ", () => {
		// timingSafeEqual requires equal-length buffers; function short-circuits on length mismatch
		expect(verifyToken("short", "a".repeat(64))).toBe(false);
	});

	it("returns false for same-length but different tokens", () => {
		const a = "a".repeat(64);
		const b = "b".repeat(64);
		expect(verifyToken(a, b)).toBe(false);
	});

	it("is case-sensitive", () => {
		const lower = `${"abcdef".repeat(10)}abcd`;
		const upper = `${"ABCDEF".repeat(10)}ABCD`;
		expect(lower.length).toBe(upper.length);
		expect(verifyToken(lower, upper)).toBe(false);
	});

	it("handles real-world 64-char hex tokens", () => {
		const hex =
			"3f8a2c1d9e4b07f56a21bc8de30945f17c6082a3f1d94e5b760c28f3a9051b4e";
		expect(verifyToken(hex, hex)).toBe(true);
		const mutated = hex.slice(0, -1) + (hex.endsWith("e") ? "f" : "e");
		expect(verifyToken(mutated, hex)).toBe(false);
	});
});
