import { lstatSync, writeFileSync } from "node:fs";
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
import {
	fileSha256,
	manifestEntriesFromTree,
} from "./runtime-artifact-utils";

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
	archiveSha256: fileSha256(archive),
	files: manifestEntriesFromTree(runtime, WHISPER_RUNTIME_PATHS),
};

const validated = parseRuntimeArtifactManifest(manifest);
const output = join(artifact, "runtime-manifest.json");
writeFileSync(output, `${JSON.stringify(validated, null, 2)}\n`, "utf8");
console.log(`Wrote reviewed runtime manifest ${output}`);
