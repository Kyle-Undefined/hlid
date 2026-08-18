import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import type { TtsRuntimeAssets } from "./tts";

export const TTS_DIRECTML_RUNTIME_ID =
	"sherpa-tts-1.13.4-ort-dml-1.24.4-directml-1.15.4-r2-win-x64";

export type TtsRuntimeFile = {
	name: string;
	size: number;
	sha256: string;
};

/** Exact files from the RX 6700 XT-qualified DirectML runtime candidate. */
export const TTS_DIRECTML_RUNTIME_FILES: readonly TtsRuntimeFile[] = [
	{
		name: "sherpa-onnx.node",
		size: 667_648,
		sha256: "65735621661f698c8291f7be669c7bcd53cf572f80f5d8f805e2468e0c1c657c",
	},
	{
		name: "sherpa-onnx-c-api.dll",
		size: 4_188_672,
		sha256: "0eccb0f445f0dfa81f26c9de2633da34fcf681b0513b9209bdc5dc14f5b9b1ac",
	},
	{
		name: "onnxruntime.dll",
		size: 17_328_152,
		sha256: "e7eedec6a6f26dc39dc948276a75ef6d2bee3fff944d874ceed0bbd3b97bff40",
	},
	{
		name: "onnxruntime_providers_shared.dll",
		size: 22_040,
		sha256: "265c8daf29637cb259cac8be9f08f2cd45f3883f0f0e4949cbfddd5b4cbec3b6",
	},
	{
		name: "DirectML.dll",
		size: 18_527_776,
		sha256: "9c9e6d822561c6c41b90e6994b3e8857cf1d66dbfb1e0c4c799c7c89b4e92da1",
	},
] as const;

function isContainedFile(directory: string, candidate: string): boolean {
	if (!lstatSync(candidate).isFile()) return false;
	const pathFromDirectory = relative(directory, realpathSync(candidate));
	return (
		pathFromDirectory !== "" &&
		!pathFromDirectory.startsWith("..") &&
		!isAbsolute(pathFromDirectory)
	);
}

function fileSha256(path: string): string {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/**
 * Verify a loose runtime before its directory is added to PATH or its addon is
 * loaded. Hashes bind the exact qualified binaries, not only their filenames.
 */
export function verifyTtsRuntimeAssets(
	directory: string,
	files: readonly TtsRuntimeFile[] = TTS_DIRECTML_RUNTIME_FILES,
): TtsRuntimeAssets | null {
	try {
		const canonicalDirectory = realpathSync(directory);
		const allowedTopLevel = new Set([
			...files.map((file) => file.name),
			".hash",
			"licenses",
			"runtime-manifest.json",
		]);
		if (
			readdirSync(canonicalDirectory, { withFileTypes: true }).some(
				(entry) => !allowedTopLevel.has(entry.name),
			)
		)
			return null;
		for (const file of files) {
			const candidate = join(canonicalDirectory, file.name);
			if (!isContainedFile(canonicalDirectory, candidate)) return null;
			const stat = lstatSync(candidate);
			if (stat.size !== file.size || fileSha256(candidate) !== file.sha256)
				return null;
		}
		return {
			directory: canonicalDirectory,
			addonPath: join(canonicalDirectory, "sherpa-onnx.node"),
			backends: ["directml"],
		};
	} catch {
		return null;
	}
}

export function defaultTtsDirectMlRuntimeDirectory(
	environment: NodeJS.ProcessEnv = process.env,
): string {
	const local = environment.LOCALAPPDATA ?? join(homedir(), "AppData", "Local");
	return join(local, "hlid", "tts", "runtime", TTS_DIRECTML_RUNTIME_ID);
}

export function bootstrapTtsRuntimeAssets({
	platform = process.platform,
	environment = process.env,
	files = TTS_DIRECTML_RUNTIME_FILES,
}: {
	platform?: NodeJS.Platform;
	environment?: NodeJS.ProcessEnv;
	files?: readonly TtsRuntimeFile[];
} = {}): TtsRuntimeAssets | null {
	if (platform !== "win32" || process.arch !== "x64") return null;
	const override = environment.HLID_TTS_DIRECTML_RUNTIME_DIR?.trim();
	return verifyTtsRuntimeAssets(
		override || defaultTtsDirectMlRuntimeDirectory(environment),
		files,
	);
}
