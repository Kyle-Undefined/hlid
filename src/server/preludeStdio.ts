/**
 * Which launch modes must keep real stdout/stderr in the compiled exe.
 *
 * The prelude no-ops stdout/stderr writes to keep Windows from allocating a
 * console window (--windows-hide-console). But some modes speak a protocol or
 * print for a human over stdio — an MCP server with a silenced stdout can
 * never answer `initialize`, and Claude Desktop then reports "Could not
 * attach to MCP server".
 *
 * This module must stay dependency-free: the prelude imports it before the
 * stdout patch runs, so any transitive import that writes during init would
 * itself trigger AllocConsole. Flag strings are therefore duplicated from
 * their owning modules; preludeStdio.test.ts pins them against the real
 * constants so they cannot drift.
 */
export const STDIO_MODE_FLAGS = [
	"--internal-vault-snapshot-worker",
	"--internal-obsidian-mcp",
	"--internal-hlid-mcp",
] as const;

export function stdioModeRequested(argv: readonly string[]): boolean {
	if (argv[2] === "auth" && argv[3] === "reset") return true;
	return STDIO_MODE_FLAGS.some((flag) => argv.includes(flag));
}
