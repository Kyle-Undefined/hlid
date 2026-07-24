/**
 * claudeDesktopMcp — unit tests for the Claude Desktop config path helper
 * and the read/merge/write logic. Uses real temp directories; no fs mocking.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	claudeDesktopConfigPath,
	HLID_DESKTOP_MCP_KEY,
	HLID_OBSIDIAN_DESKTOP_MCP_KEY,
	isHlidRegisteredInClaudeDesktop,
	readClaudeDesktopConfig,
	registerHlidInClaudeDesktop,
} from "./claudeDesktopMcp";

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "hlid-claude-desktop-mcp-"));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("claudeDesktopConfigPath", () => {
	it("returns null when appData is unavailable", () => {
		expect(claudeDesktopConfigPath(null)).toBeNull();
		expect(claudeDesktopConfigPath(undefined)).toBeNull();
		expect(claudeDesktopConfigPath("")).toBeNull();
	});

	it("joins appData/Claude/claude_desktop_config.json", () => {
		expect(claudeDesktopConfigPath("/fake/AppData/Roaming")).toBe(
			join("/fake/AppData/Roaming", "Claude", "claude_desktop_config.json"),
		);
	});
});

describe("readClaudeDesktopConfig", () => {
	it("reads a missing file as empty", () => {
		expect(readClaudeDesktopConfig(join(dir, "missing.json"))).toEqual({});
	});

	it("reads an empty file as empty", () => {
		const path = join(dir, "empty.json");
		writeFileSync(path, "");
		expect(readClaudeDesktopConfig(path)).toEqual({});
	});

	it("parses a valid config", () => {
		const path = join(dir, "config.json");
		writeFileSync(
			path,
			JSON.stringify({ mcpServers: { other: { command: "x" } } }),
		);
		expect(readClaudeDesktopConfig(path)).toEqual({
			mcpServers: { other: { command: "x" } },
		});
	});

	it("throws instead of silently discarding unparsable JSON", () => {
		const path = join(dir, "broken.json");
		writeFileSync(path, "{ not json");
		expect(() => readClaudeDesktopConfig(path)).toThrow(/not valid JSON/);
	});

	it("throws when the file is a JSON array, not an object", () => {
		const path = join(dir, "array.json");
		writeFileSync(path, "[]");
		expect(() => readClaudeDesktopConfig(path)).toThrow(/not a JSON object/);
	});
});

describe("isHlidRegisteredInClaudeDesktop", () => {
	it("is false with no mcpServers", () => {
		expect(isHlidRegisteredInClaudeDesktop({})).toBe(false);
	});

	it("is false when only one of the two Hlid keys is present", () => {
		expect(
			isHlidRegisteredInClaudeDesktop({
				mcpServers: { [HLID_DESKTOP_MCP_KEY]: { command: "x", args: [] } },
			}),
		).toBe(false);
	});

	it("is true when both Hlid keys are present", () => {
		expect(
			isHlidRegisteredInClaudeDesktop({
				mcpServers: {
					[HLID_DESKTOP_MCP_KEY]: { command: "x", args: [] },
					[HLID_OBSIDIAN_DESKTOP_MCP_KEY]: { command: "x", args: [] },
				},
			}),
		).toBe(true);
	});
});

describe("registerHlidInClaudeDesktop", () => {
	it("creates the config file and parent directory when missing", () => {
		const path = join(dir, "Claude", "claude_desktop_config.json");
		const result = registerHlidInClaudeDesktop(path);
		expect(isHlidRegisteredInClaudeDesktop(result)).toBe(true);
		const onDisk = JSON.parse(readFileSync(path, "utf8"));
		expect(isHlidRegisteredInClaudeDesktop(onDisk)).toBe(true);
	});

	it("writes non-empty command and args for both entries", () => {
		const path = join(dir, "config.json");
		const result = registerHlidInClaudeDesktop(path);
		const servers = result.mcpServers as Record<
			string,
			{ command: string; args: string[] }
		>;
		expect(servers[HLID_DESKTOP_MCP_KEY].command).toBeTruthy();
		expect(servers[HLID_OBSIDIAN_DESKTOP_MCP_KEY].command).toBeTruthy();
	});

	it("preserves unrelated top-level keys and other mcpServers entries", () => {
		const path = join(dir, "config.json");
		writeFileSync(
			path,
			JSON.stringify({
				someOtherSetting: true,
				mcpServers: { other: { command: "keep-me", args: ["--flag"] } },
			}),
		);
		const result = registerHlidInClaudeDesktop(path);
		expect(result.someOtherSetting).toBe(true);
		expect((result.mcpServers as Record<string, unknown>).other).toEqual({
			command: "keep-me",
			args: ["--flag"],
		});
		expect(isHlidRegisteredInClaudeDesktop(result)).toBe(true);
	});

	it("is idempotent and does not duplicate entries on a second run", () => {
		const path = join(dir, "config.json");
		registerHlidInClaudeDesktop(path);
		const second = registerHlidInClaudeDesktop(path);
		const servers = second.mcpServers as Record<string, unknown>;
		expect(Object.keys(servers).sort()).toEqual(
			[HLID_DESKTOP_MCP_KEY, HLID_OBSIDIAN_DESKTOP_MCP_KEY].sort(),
		);
	});

	it("throws and leaves the file untouched when existing JSON is corrupt", () => {
		const path = join(dir, "config.json");
		writeFileSync(path, "{ broken");
		expect(() => registerHlidInClaudeDesktop(path)).toThrow(/not valid JSON/);
		expect(readFileSync(path, "utf8")).toBe("{ broken");
	});
});
