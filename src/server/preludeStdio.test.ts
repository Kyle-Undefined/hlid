/**
 * Guards the compiled-exe stdout kill-switch exemption list.
 *
 * Regression: --internal-hlid-mcp was missing from the exemptions, so the
 * prelude no-op'd stdout in hlid MCP mode. The stdio MCP server could never
 * answer `initialize`, and Claude Desktop reported "Could not attach to MCP
 * server hlid" after its 60s timeout — while hlid_obsidian (exempted)
 * attached fine.
 *
 * preludeStdio.ts duplicates the flag strings on purpose (it must stay
 * dependency-free); these tests pin them against the real constants so a
 * rename cannot silently silence a stdio mode again.
 */
import { describe, expect, it } from "vitest";
import { INTERNAL_HLID_MCP_FLAG } from "./hlidMcpServer";
import { INTERNAL_OBSIDIAN_MCP_FLAG } from "./obsidianMcpServer";
import { STDIO_MODE_FLAGS, stdioModeRequested } from "./preludeStdio";

const argv = (...rest: string[]) => ["bun", "hlid.exe", ...rest];

describe("STDIO_MODE_FLAGS", () => {
	it("contains every stdio MCP server flag (pinned to owning constants)", () => {
		expect(STDIO_MODE_FLAGS).toContain(INTERNAL_HLID_MCP_FLAG);
		expect(STDIO_MODE_FLAGS).toContain(INTERNAL_OBSIDIAN_MCP_FLAG);
	});
});

describe("stdioModeRequested", () => {
	it("keeps real stdio for every flagged mode", () => {
		for (const flag of STDIO_MODE_FLAGS) {
			expect(stdioModeRequested(argv(flag))).toBe(true);
		}
	});

	it("keeps real stdio for auth reset", () => {
		expect(stdioModeRequested(argv("auth", "reset"))).toBe(true);
	});

	it("silences stdio for normal server launches", () => {
		expect(stdioModeRequested(argv())).toBe(false);
		expect(stdioModeRequested(argv("--background"))).toBe(false);
		expect(stdioModeRequested(argv("--restart"))).toBe(false);
	});
});
