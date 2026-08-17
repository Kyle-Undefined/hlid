import { lstatSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
	DIRECTML_NUGET_SHA256,
	DIRECTML_VERSION,
	manifestPath,
	ONNXRUNTIME_NUGET_SHA256,
	ONNXRUNTIME_SOURCE_COMMIT,
	ONNXRUNTIME_VERSION,
	parseTtsRuntimeArtifactManifest,
	SHERPA_DIRECTML_PATCH_DESCRIPTION,
	SHERPA_DIRECTML_PATCH_SHA256,
	SHERPA_NPM_ARCHIVE_SHA256,
	SHERPA_SOURCE_COMMIT,
	SHERPA_VERSION,
	TTS_RUNTIME_ARTIFACT,
	TTS_RUNTIME_BUILD_FLAGS,
	TTS_RUNTIME_ID,
	TTS_RUNTIME_PATHS,
	type TtsRuntimeArtifactManifest,
} from "./tts-runtime-artifact";
import {
	fileSha256,
	manifestEntriesFromTree,
} from "./runtime-artifact-utils";

const cliArguments = process.argv.slice(2);
const [artifactDirectory, runtimeRoot] = cliArguments;
if (!artifactDirectory || !runtimeRoot || cliArguments.length !== 2)
	throw new Error(
		"usage: bun scripts/create-tts-runtime-manifest.ts <artifact-directory> <runtime-root>",
	);

const artifact = resolve(artifactDirectory);
const runtime = resolve(runtimeRoot);
const archive = join(artifact, TTS_RUNTIME_ARTIFACT);
const archiveStat = lstatSync(archive);
if (!archiveStat.isFile()) throw new Error(`runtime archive not found: ${archive}`);

const manifest: TtsRuntimeArtifactManifest = {
	schemaVersion: 1,
	runtimeId: TTS_RUNTIME_ID,
	platform: "windows",
	architecture: "x64",
	sherpa: {
		version: SHERPA_VERSION,
		sourceCommit: SHERPA_SOURCE_COMMIT,
		npmArchiveSha256: SHERPA_NPM_ARCHIVE_SHA256,
	},
	onnxRuntime: {
		version: ONNXRUNTIME_VERSION,
		sourceCommit: ONNXRUNTIME_SOURCE_COMMIT,
		nugetSha256: ONNXRUNTIME_NUGET_SHA256,
	},
	directMl: {
		version: DIRECTML_VERSION,
		nugetSha256: DIRECTML_NUGET_SHA256,
	},
	build: {
		runner: "windows-2022",
		generator: "Visual Studio 17 2022",
		architecture: "x64",
		configuration: "Release",
		toolset: "v143",
		windowsSdk: "10.0.26100.0",
		patchDescription: SHERPA_DIRECTML_PATCH_DESCRIPTION,
		patchSha256: SHERPA_DIRECTML_PATCH_SHA256,
		flags: [...TTS_RUNTIME_BUILD_FLAGS],
	},
	archive: {
		name: TTS_RUNTIME_ARTIFACT,
		sha256: fileSha256(archive),
		size: archiveStat.size,
	},
	files: manifestEntriesFromTree(runtime, TTS_RUNTIME_PATHS),
};

const validated = parseTtsRuntimeArtifactManifest(manifest);
const output = manifestPath(artifact);
writeFileSync(output, `${JSON.stringify(validated, null, 2)}\n`, "utf8");
console.log(`Wrote unqualified candidate TTS runtime manifest ${output}`);
