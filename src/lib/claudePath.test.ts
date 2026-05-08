/**
 * resolveClaudeExecutable — tests env override and platform fallback logic.
 * node:fs is mocked to control path existence without touching disk.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── mock fs before import ─────────────────────────────────────────────────────

vi.mock("node:fs", () => ({
	existsSync: vi.fn().mockReturnValue(false),
}));

import { existsSync } from "node:fs";
import { resolveClaudeExecutable } from "./claudePath";

const mockExists = vi.mocked(existsSync);

beforeEach(() => {
	mockExists.mockReset().mockReturnValue(false);
	delete process.env.HLID_CLAUDE_EXE;
});

afterEach(() => {
	delete process.env.HLID_CLAUDE_EXE;
});

// ── HLID_CLAUDE_EXE override ──────────────────────────────────────────────────

describe("HLID_CLAUDE_EXE env override", () => {
	it("returns env path when file exists", () => {
		process.env.HLID_CLAUDE_EXE = "/custom/claude";
		mockExists.mockReturnValue(true);
		expect(resolveClaudeExecutable()).toBe("/custom/claude");
	});

	it("skips env override when file not found", () => {
		process.env.HLID_CLAUDE_EXE = "/nonexistent/claude";
		// existsSync returns false for everything
		// On non-musl linux x64, falls through and returns undefined (no glibc found)
		const result = resolveClaudeExecutable();
		// May return undefined or a glibc path depending on platform
		// Key assertion: NOT the missing env path
		expect(result).not.toBe("/nonexistent/claude");
	});

	it("ignores empty HLID_CLAUDE_EXE (falsy)", () => {
		process.env.HLID_CLAUDE_EXE = "";
		// Empty string is falsy — should not call existsSync for env path
		resolveClaudeExecutable();
		// existsSync should not have been called with empty string
		const calledWith = mockExists.mock.calls.map((c) => c[0]);
		expect(calledWith).not.toContain("");
	});
});

// ── linux x64 glibc fallback ──────────────────────────────────────────────────

// These tests only run on linux/x64 — the platform we use in CI.
// On other platforms the linux branch is unreachable so we skip.
const isLinuxX64 = process.platform === "linux" && process.arch === "x64";

describe.skipIf(!isLinuxX64)("linux x64 — glibc fallback", () => {
	it("returns glibc binary when musl absent and glibc found", () => {
		// Call sequence (no HLID_CLAUDE_EXE set):
		//   1st: existsSync("/lib/ld-musl-x86_64.so.1") → false (no musl)
		//   2nd: existsSync(glibcBin) → true
		mockExists
			.mockReturnValueOnce(false) // musl absent
			.mockReturnValueOnce(true); // glibc present
		const result = resolveClaudeExecutable();
		expect(typeof result).toBe("string");
		expect(result).toContain("claude");
	});

	it("returns undefined when musl absent and glibc not found", () => {
		mockExists
			.mockReturnValueOnce(false) // musl absent
			.mockReturnValueOnce(false); // glibc absent too
		expect(resolveClaudeExecutable()).toBeUndefined();
	});

	it("skips glibc fallback when musl library present", () => {
		// musl found → SDK can use its bundled musl binary → return undefined
		mockExists.mockReturnValueOnce(true); // musl present
		expect(resolveClaudeExecutable()).toBeUndefined();
		// Only one existsSync call (musl check); glibc check skipped
		expect(mockExists).toHaveBeenCalledTimes(1);
	});
});

// ── non-linux / non-win fallthrough ──────────────────────────────────────────

describe("fallthrough — returns undefined", () => {
	it("returns undefined when no override found (all existsSync false)", () => {
		// On the current platform with no env set and no matching paths:
		// function should return undefined or a matched path (linux glibc)
		// We verify it returns undefined when existsSync always returns false
		expect(resolveClaudeExecutable()).toBeUndefined();
	});
});
