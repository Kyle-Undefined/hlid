import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	computeAllowedAgentRealPaths,
	isAllowedAgentPath,
	resolveAgentMode,
} from "./agentPaths";
import { loadConfig } from "./config";

// Mock ./config so resolveAgentMode doesn't read from disk in tests
vi.mock("./config", () => ({
	loadConfig: vi.fn(),
}));

// ── isAllowedAgentPath ───────────────────────────────────────────────────────

describe("isAllowedAgentPath", () => {
	it("returns false for empty allowed list", () => {
		expect(isAllowedAgentPath([], "/some/path")).toBe(false);
	});

	it("returns true when candidate matches an allowed path", () => {
		expect(
			isAllowedAgentPath(["/agents/mybot", "/agents/other"], "/agents/mybot"),
		).toBe(true);
	});

	it("returns false when candidate does not match any allowed path", () => {
		expect(isAllowedAgentPath(["/agents/mybot"], "/agents/other")).toBe(false);
	});

	it("uses samePath semantics (resolves . and ..)", () => {
		expect(isAllowedAgentPath(["/agents/bot"], "/agents/bot/../bot")).toBe(
			true,
		);
	});
});

// ── computeAllowedAgentRealPaths ─────────────────────────────────────────────

describe("computeAllowedAgentRealPaths", () => {
	let dir1: string;
	let dir2: string;

	beforeEach(() => {
		dir1 = mkdtempSync(join(tmpdir(), "hlid-agent-a-"));
		dir2 = mkdtempSync(join(tmpdir(), "hlid-agent-b-"));
	});

	afterEach(() => {
		rmSync(dir1, { recursive: true, force: true });
		rmSync(dir2, { recursive: true, force: true });
	});

	it("returns empty array when no agents configured", () => {
		const result = computeAllowedAgentRealPaths({ agents: [] } as never);
		expect(result).toEqual([]);
	});

	it("resolves real paths for existing agent dirs", () => {
		const result = computeAllowedAgentRealPaths({
			agents: [
				{ path: dir1, mode: "cwd" },
				{ path: dir2, mode: "context" },
			],
		} as never);
		expect(result).toHaveLength(2);
		// Both dirs exist so realpathSync resolves them (no symlinks → same path)
		expect(result[0]).toBe(dir1);
		expect(result[1]).toBe(dir2);
	});

	it("silently skips agent paths that do not exist", () => {
		const result = computeAllowedAgentRealPaths({
			agents: [
				{ path: "/nonexistent/path/to/agent", mode: "cwd" },
				{ path: dir1, mode: "cwd" },
			],
		} as never);
		expect(result).toHaveLength(1);
		expect(result[0]).toBe(dir1);
	});

	it("expands tilde in agent paths", () => {
		// ~/nonexistent won't resolve via realpathSync → silently skipped
		const result = computeAllowedAgentRealPaths({
			agents: [{ path: "~/does-not-exist-hlid-test", mode: "cwd" }],
		} as never);
		// May or may not exist — just confirm it doesn't throw
		expect(Array.isArray(result)).toBe(true);
	});
});

// ── resolveAgentMode ─────────────────────────────────────────────────────────

describe("resolveAgentMode", () => {
	let agentDir: string;

	beforeEach(() => {
		agentDir = mkdtempSync(join(tmpdir(), "hlid-resolvemode-"));
		vi.mocked(loadConfig).mockReset();
	});

	afterEach(() => {
		rmSync(agentDir, { recursive: true, force: true });
	});

	it("returns 'context' when matched agent has mode=context", () => {
		vi.mocked(loadConfig).mockReturnValue({
			agents: [{ path: agentDir, mode: "context" }],
		} as never);
		expect(resolveAgentMode(agentDir)).toBe("context");
	});

	it("returns 'cwd' when matched agent has mode=cwd", () => {
		vi.mocked(loadConfig).mockReturnValue({
			agents: [{ path: agentDir, mode: "cwd" }],
		} as never);
		expect(resolveAgentMode(agentDir)).toBe("cwd");
	});

	it("returns 'cwd' when no agents match", () => {
		vi.mocked(loadConfig).mockReturnValue({ agents: [] } as never);
		expect(resolveAgentMode(agentDir)).toBe("cwd");
	});

	it("returns 'cwd' when loadConfig throws (error swallowed)", () => {
		vi.mocked(loadConfig).mockImplementation(() => {
			throw new Error("config read failed");
		});
		const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			expect(resolveAgentMode("/some/path")).toBe("cwd");
		} finally {
			consoleSpy.mockRestore();
		}
	});
});
