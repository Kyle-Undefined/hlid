import { createHash } from "node:crypto";
import { lstatSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
	parseRuntimeArtifactManifest,
	type RuntimeArtifactManifest,
	WHISPER_BUILD_FLAGS,
	WHISPER_RUNTIME_ARTIFACT,
	WHISPER_RUNTIME_PATHS,
	WHISPER_SOURCE_COMMIT,
	WHISPER_VERSION,
	WHISPER_VULKAN_SDK_VERSION,
} from "./bundle-whisper-assets";

function sha256(path: string): string {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}

const artifactDirectory = process.argv[2];
const runtimeRoot = process.argv[3];
if (!artifactDirectory || !runtimeRoot) {
	throw new Error(
		"usage: bun scripts/create-whisper-runtime-manifest.ts <artifact-directory> <runtime-root>",
	);
}

const artifact = resolve(artifactDirectory);
const runtime = resolve(runtimeRoot);
const archive = join(artifact, WHISPER_RUNTIME_ARTIFACT);
const archiveStat = lstatSync(archive);
if (!archiveStat.isFile()) throw new Error(`runtime archive not found: ${archive}`);

const manifest: RuntimeArtifactManifest = {
	schemaVersion: 1,
	whisperVersion: WHISPER_VERSION,
	whisperSourceCommit: WHISPER_SOURCE_COMMIT,
	vulkanSdkVersion: WHISPER_VULKAN_SDK_VERSION,
	buildFlags: [...WHISPER_BUILD_FLAGS],
	archive: WHISPER_RUNTIME_ARTIFACT,
	archiveSha256: sha256(archive),
	files: WHISPER_RUNTIME_PATHS.map((path) => {
		const file = join(runtime, path);
		const stat = lstatSync(file);
		if (!stat.isFile()) throw new Error(`runtime file not found: ${file}`);
		return { path, sha256: sha256(file), size: stat.size };
	}),
};

const validated = parseRuntimeArtifactManifest(manifest);
const output = join(artifact, "runtime-manifest.json");
writeFileSync(output, `${JSON.stringify(validated, null, 2)}\n`, "utf8");
console.log(`Wrote reviewed runtime manifest ${output}`);
