import { createHash } from "node:crypto";
import {
	mkdtempSync,
	mkdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { TTS_DIRECTML_RUNTIME_FILES } from "../src/server/tts-bootstrap";
import {
	DIRECTML_NUGET_SHA256,
	DIRECTML_VERSION,
	MSVC_TOOLSET_VERSION,
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
	verifyTtsRuntimeTree,
} from "./tts-runtime-artifact";

function sha256(value: string | Uint8Array): string {
	return createHash("sha256").update(value).digest("hex");
}

function candidateManifest(): TtsRuntimeArtifactManifest {
	const pinnedFiles = new Map(
		TTS_DIRECTML_RUNTIME_FILES.map((file) => [file.name, file]),
	);
	return {
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
			toolsetVersion: MSVC_TOOLSET_VERSION,
			windowsSdk: "10.0.26100.0",
			patchDescription: SHERPA_DIRECTML_PATCH_DESCRIPTION,
			patchSha256: SHERPA_DIRECTML_PATCH_SHA256,
			flags: [...TTS_RUNTIME_BUILD_FLAGS],
		},
		archive: {
			name: TTS_RUNTIME_ARTIFACT,
			sha256: sha256("candidate archive"),
			size: 17,
		},
		files: TTS_RUNTIME_PATHS.map((path) => {
			const pinned = pinnedFiles.get(path);
			return pinned
				? { path, sha256: pinned.sha256, size: pinned.size }
				: { path, sha256: sha256(path), size: path.length };
		}),
	};
}

describe("TTS runtime candidate manifest", () => {
	it("accepts a newly built C API only as an unqualified candidate", () => {
		const manifest = candidateManifest();
		const cApi = manifest.files.find(
			(file) => file.path === "sherpa-onnx-c-api.dll",
		);
		expect(cApi).toBeDefined();
		if (!cApi) return;
		cApi.sha256 = sha256("new candidate C API");
		cApi.size = 4_500_000;

		expect(
			parseTtsRuntimeArtifactManifest(manifest).files.find(
				(file) => file.path === cApi.path,
			),
		).toEqual(cApi);
		expect(() =>
			parseTtsRuntimeArtifactManifest(manifest, { requireQualified: true }),
		).toThrow("sherpa-onnx-c-api.dll does not match the pinned upstream binary");
	});

	it("pins provenance, schema keys, file order, and build flags", () => {
		const changedSource = candidateManifest();
		changedSource.sherpa.sourceCommit = "0".repeat(40);
		expect(() => parseTtsRuntimeArtifactManifest(changedSource)).toThrow(
			"sherpa source commit mismatch",
		);

		const extraField = {
			...candidateManifest(),
			qualification: "qualified",
		};
		expect(() => parseTtsRuntimeArtifactManifest(extraField)).toThrow(
			"unexpected or missing top-level field",
		);

		const reordered = candidateManifest();
		[reordered.files[0], reordered.files[1]] = [
			reordered.files[1],
			reordered.files[0],
		];
		expect(() => parseTtsRuntimeArtifactManifest(reordered)).toThrow(
			"file 0 path mismatch",
		);

		const changedFlags = candidateManifest();
		changedFlags.build.flags.reverse();
		expect(() => parseTtsRuntimeArtifactManifest(changedFlags)).toThrow(
			"build flags mismatch",
		);
	});

	it("rejects changed pinned upstream runtime files in candidate mode", () => {
		const manifest = candidateManifest();
		const directMl = manifest.files.find(
			(file) => file.path === "DirectML.dll",
		);
		expect(directMl).toBeDefined();
		if (!directMl) return;
		directMl.sha256 = sha256("different DirectML");

		expect(() => parseTtsRuntimeArtifactManifest(manifest)).toThrow(
			"DirectML.dll does not match the pinned upstream binary",
		);
	});
});

describe("TTS runtime candidate files", () => {
	it("requires the exact manifested tree and rejects extras and symlinks", () => {
		const root = mkdtempSync(join(tmpdir(), "hlid-tts-tree-test-"));
		try {
			mkdirSync(join(root, "licenses"));
			writeFileSync(join(root, "runtime.dll"), "runtime");
			writeFileSync(join(root, "licenses", "NOTICE"), "notice");
			const manifest = [
				{
					path: "runtime.dll",
					sha256: sha256("runtime"),
					size: 7,
				},
				{
					path: "licenses/NOTICE",
					sha256: sha256("notice"),
					size: 6,
				},
			];

			expect(verifyTtsRuntimeTree(root, manifest)).toBe(true);
			writeFileSync(join(root, "unexpected.txt"), "unexpected");
			expect(verifyTtsRuntimeTree(root, manifest)).toBe(false);
			rmSync(join(root, "unexpected.txt"));
			rmSync(join(root, "licenses", "NOTICE"));
			symlinkSync(join(root, "runtime.dll"), join(root, "licenses", "NOTICE"));
			expect(verifyTtsRuntimeTree(root, manifest)).toBe(false);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("binds the reviewed source correction by content hash", () => {
		const patch = readFileSync(
			resolve(import.meta.dirname, "..", SHERPA_DIRECTML_PATCH_DESCRIPTION),
		);
		expect(sha256(patch)).toBe(SHERPA_DIRECTML_PATCH_SHA256);
		expect(patch.toString("utf8")).toContain(
			"if(SHERPA_ONNX_ENABLE_GPU OR SHERPA_ONNX_ENABLE_DIRECTML)",
		);
	});
});
