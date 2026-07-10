/**
 * pty-bootstrap.ts — extract embedded node-pty runtime assets at startup.
 *
 * In dev (PTY_ASSETS === null): returns the pty-worker.cjs path on disk.
 * In the compiled Windows exe: extracts embedded assets to
 *   %LOCALAPPDATA%\hlid\pty-rt\  (or C:\Users\Default\AppData\Local as fallback)
 * and returns the path to the extracted pty-worker.cjs.
 *
 * Extraction is skipped when the existing .hash file matches PTY_ASSETS_HASH.
 * The swap is performed atomically (write to tmp dir, rename).
 */

import {
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PTY_ASSETS, PTY_ASSETS_HASH } from "./pty-assets";

/** Return the path to pty-worker.cjs to use for spawning the PTY worker. */
async function materializeEmbeddedFile(
	source: string,
	destination: string,
): Promise<void> {
	await Bun.write(destination, Bun.file(source));
}

export async function bootstrapPtyRuntime(): Promise<string> {
	// Dev mode or non-Windows stub: PTY_ASSETS is null, use on-disk file.
	if (PTY_ASSETS === null) {
		const __filename = fileURLToPath(import.meta.url);
		return join(dirname(__filename), "pty-worker.cjs");
	}

	// Compiled Windows exe path: extract embedded assets.
	const localAppData =
		process.env.LOCALAPPDATA ?? "C:\\Users\\Default\\AppData\\Local";
	const rtDir = join(localAppData, "hlid", "pty-rt");
	const hashFile = join(rtDir, ".hash");

	// Check if already extracted and up-to-date.
	if (existsSync(hashFile)) {
		try {
			const existingHash = readFileSync(hashFile, "utf8").trim();
			if (
				existingHash === PTY_ASSETS_HASH &&
				existsSync(join(rtDir, "pty-worker.cjs"))
			) {
				return join(rtDir, "pty-worker.cjs");
			}
		} catch {
			// If we can't read the hash file, proceed with re-extraction.
		}
	}

	// Extract atomically to a temp dir, then rename into place.
	const tmpDir = `${rtDir}.tmp`;

	// Remove any stale temp dir from a prior interrupted extraction.
	if (existsSync(tmpDir)) {
		rmSync(tmpDir, { recursive: true, force: true });
	}

	// Create directory structure.
	mkdirSync(tmpDir, { recursive: true });
	mkdirSync(join(tmpDir, "node_modules", "node-pty"), { recursive: true });

	// ── pty-worker.cjs ───────────────────────────────────────────────────────
	await materializeEmbeddedFile(
		PTY_ASSETS.workerCjs,
		join(tmpDir, "pty-worker.cjs"),
	);

	// ── node-pty package.json ────────────────────────────────────────────────
	await materializeEmbeddedFile(
		PTY_ASSETS.packageJson,
		join(tmpDir, "node_modules", "node-pty", "package.json"),
	);

	// ── Native binaries (.node / .dll / .exe) ────────────────────────────────
	// Keys are relative paths like "prebuilds/win32-x64/pty.node"
	// or "prebuilds/win32-x64/conpty/OpenConsole.exe".
	for (const [relPath, srcPath] of Object.entries(PTY_ASSETS.natives) as [
		string,
		string,
	][]) {
		const destAbs = join(tmpDir, "node_modules", "node-pty", relPath);
		mkdirSync(dirname(destAbs), { recursive: true });
		await materializeEmbeddedFile(srcPath, destAbs);
	}

	// ── Lib JS files ─────────────────────────────────────────────────────────
	// Keys are relative paths like "lib/index.js" or "lib/shared/conout.js".
	for (const [relPath, srcPath] of Object.entries(PTY_ASSETS.lib) as [
		string,
		string,
	][]) {
		const destAbs = join(tmpDir, "node_modules", "node-pty", relPath);
		mkdirSync(dirname(destAbs), { recursive: true });
		await materializeEmbeddedFile(srcPath, destAbs);
	}

	// ── Write hash sentinel ───────────────────────────────────────────────────
	writeFileSync(join(tmpDir, ".hash"), PTY_ASSETS_HASH, "utf8");

	// ── Atomic swap: rename tmpDir → rtDir ───────────────────────────────────
	// Windows does not support atomic rename over an existing directory,
	// so we remove rtDir first if it exists.
	try {
		renameSync(tmpDir, rtDir);
	} catch (err) {
		const code = (err as NodeJS.ErrnoException)?.code;
		if (code === "ENOTEMPTY" || code === "EPERM" || code === "EEXIST") {
			rmSync(rtDir, { recursive: true, force: true });
			renameSync(tmpDir, rtDir);
		} else {
			throw err;
		}
	}

	return join(rtDir, "pty-worker.cjs");
}
