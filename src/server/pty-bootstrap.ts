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

import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	materializeEmbeddedFile,
	stageRuntimeDirectory,
	verifyRuntimeDirectory,
} from "./embeddedRuntime";
import { PTY_ASSETS, PTY_ASSETS_HASH } from "./pty-assets";

function existingPtyRuntime(rtDir: string): string | null {
	const workerPath = join(rtDir, "pty-worker.cjs");
	return verifyRuntimeDirectory(rtDir, PTY_ASSETS_HASH, ["pty-worker.cjs"])
		? workerPath
		: null;
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
	const assets = PTY_ASSETS;
	if (assets === null) {
		const __filename = fileURLToPath(import.meta.url);
		return join(dirname(__filename), "pty-worker.cjs");
	}

	// Compiled Windows exe path: extract embedded assets.
	const localAppData =
		process.env.LOCALAPPDATA ?? "C:\\Users\\Default\\AppData\\Local";
	const rtDir = join(localAppData, "hlid", "pty-rt");
	const existingRuntime = existingPtyRuntime(rtDir);
	if (existingRuntime) return existingRuntime;

	await stageRuntimeDirectory(rtDir, PTY_ASSETS_HASH, async (tmpDir) => {
		mkdirSync(join(tmpDir, "node_modules", "node-pty"), { recursive: true });

		// ── pty-worker.cjs ─────────────────────────────────────────────────────
		await materializeEmbeddedFile(
			assets.workerCjs,
			join(tmpDir, "pty-worker.cjs"),
		);

		// ── node-pty package.json ──────────────────────────────────────────────
		await materializeEmbeddedFile(
			assets.packageJson,
			join(tmpDir, "node_modules", "node-pty", "package.json"),
		);

		const nodePtyDir = join(tmpDir, "node_modules", "node-pty");
		await materializeAssetMap(assets.natives, nodePtyDir);
		await materializeAssetMap(assets.lib, nodePtyDir);
	});

	return join(rtDir, "pty-worker.cjs");
}
