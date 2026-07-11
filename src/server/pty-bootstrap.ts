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
	rmSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { replaceRuntimeDirectory } from "./embeddedRuntime";
import { PTY_ASSETS, PTY_ASSETS_HASH } from "./pty-assets";

/** Return the path to pty-worker.cjs to use for spawning the PTY worker. */
async function materializeEmbeddedFile(
	source: string,
	destination: string,
): Promise<void> {
	await Bun.write(destination, Bun.file(source));
}

function existingPtyRuntime(rtDir: string): string | null {
	const workerPath = join(rtDir, "pty-worker.cjs");
	const hashFile = join(rtDir, ".hash");
	if (!existsSync(hashFile)) return null;
	try {
		const current = readFileSync(hashFile, "utf8").trim();
		return current === PTY_ASSETS_HASH && existsSync(workerPath)
			? workerPath
			: null;
	} catch {
		return null;
	}
}

async function materializeAssetMap(
	assets: Record<string, string>,
	destinationRoot: string,
): Promise<void> {
	for (const [relativePath, sourcePath] of Object.entries(assets)) {
		const destination = join(destinationRoot, relativePath);
		mkdirSync(dirname(destination), { recursive: true });
		await materializeEmbeddedFile(sourcePath, destination);
	}
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
	const existingRuntime = existingPtyRuntime(rtDir);
	if (existingRuntime) return existingRuntime;

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

	const nodePtyDir = join(tmpDir, "node_modules", "node-pty");
	await materializeAssetMap(PTY_ASSETS.natives, nodePtyDir);
	await materializeAssetMap(PTY_ASSETS.lib, nodePtyDir);

	// ── Write hash sentinel ───────────────────────────────────────────────────
	writeFileSync(join(tmpDir, ".hash"), PTY_ASSETS_HASH, "utf8");

	// ── Atomic swap: rename tmpDir → rtDir ───────────────────────────────────
	// Windows does not support atomic rename over an existing directory,
	// so we remove rtDir first if it exists.
	replaceRuntimeDirectory(tmpDir, rtDir);

	return join(rtDir, "pty-worker.cjs");
}
