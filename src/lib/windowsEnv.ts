/**
 * Bun-on-Windows spawn workaround.
 *
 * When a parent process launches us with an environment whose PATH variable
 * uses the exact key "PATH" (Claude Desktop does this when it spawns MCP
 * servers), Bun's child_process spawn re-validates even absolute executable
 * paths against an internal extension allowlist that lacks ".com" — so
 * spawning Obsidian's CLI shim (Obsidian.com) fails with
 * `Executable not found in $PATH: "C:\...\Obsidian.com"`.
 *
 * With the native Windows casing "Path", Bun skips that validation and the
 * spawn succeeds. Renaming the key at startup fixes every downstream spawn
 * in this process. Verified empirically 2026-07-29:
 *   env {PATH: ...}  -> spawn Obsidian.com fails (ENOENT/-4058)
 *   env {Path: ...}  -> spawn Obsidian.com succeeds
 */
export function normalizeWindowsPathEnvCasing(
	env: Record<string, string | undefined>,
	platform: NodeJS.Platform = process.platform,
): void {
	if (platform !== "win32") return;
	if (!Object.hasOwn(env, "PATH")) return;
	const value = env.PATH;
	delete env.PATH;
	if (value !== undefined) env.Path = value;
}
