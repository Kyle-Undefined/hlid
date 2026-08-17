import {
	existsSync,
	lstatSync,
	mkdtempSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import {
	TTS_DIRECTML_RUNTIME_FILES,
	TTS_DIRECTML_RUNTIME_ID,
} from "../src/server/tts-bootstrap";
import { extractZipArchive, listZipEntries } from "./archive-utils";
import {
	createRuntimeManifestAssertion,
	hasExactKeys,
	isRecord,
	isSha256,
	parseStrictRuntimeManifestEntries,
	type RuntimeManifestAssertion,
	sha256Digest,
} from "./runtime-artifact-utils";

export const TTS_RUNTIME_ID = TTS_DIRECTML_RUNTIME_ID;
export const TTS_RUNTIME_ARTIFACT = `${TTS_RUNTIME_ID}.zip`;
export const TTS_RUNTIME_ARCHIVE_ROOT = "package";
export const TTS_RUNTIME_ARCHIVE_MAX_BYTES = 32 * 1024 * 1024;
export const TTS_RUNTIME_MANIFEST_MAX_BYTES = 256 * 1024;
export const TTS_RUNTIME_MAX_FILE_BYTES = 64 * 1024 * 1024;

export const SHERPA_VERSION = "1.13.4";
export const SHERPA_SOURCE_COMMIT =
	"142807252687d81b40d6315f23470a1512a00de3";
export const SHERPA_NPM_ARCHIVE_SHA256 =
	"c180199ee4ed16a25b8ed50e2706a2d3dbe1aaa8b0699ea7d249288290c7998e";

export const ONNXRUNTIME_VERSION = "1.24.4";
export const ONNXRUNTIME_SOURCE_COMMIT =
	"2d924974ef147392ced8409d36bd6d2e7fcc8a74";
export const ONNXRUNTIME_NUGET_SHA256 =
	"57e9f11b73437bef7a309496135d4c1f96b1a8e9ddba60013fa27bfc1d788681";

export const DIRECTML_VERSION = "1.15.4";
export const DIRECTML_NUGET_SHA256 =
	"4e7cb7ddce8cf837a7a75dc029209b520ca0101470fcdf275c1f49736a3615b9";

export const SHERPA_DIRECTML_PATCH_DESCRIPTION =
	"scripts/patches/sherpa-onnx-1.13.4-directml-preinstalled.patch";
export const SHERPA_DIRECTML_PATCH_SHA256 =
	"d9d80e7b50571d9d2b59cc85aaf08b64af6005fdf28e4954071d4eec695ff41f";

export const TTS_RUNTIME_BUILD_FLAGS = [
	"BUILD_SHARED_LIBS=ON",
	"SHERPA_ONNX_USE_STATIC_CRT=ON",
	"SHERPA_ONNX_USE_PRE_INSTALLED_ONNXRUNTIME_IF_AVAILABLE=ON",
	"SHERPA_ONNX_ENABLE_DIRECTML=ON",
	"SHERPA_ONNX_ENABLE_TTS=ON",
	"SHERPA_ONNX_ENABLE_C_API=ON",
	"SHERPA_ONNX_ENABLE_BINARY=OFF",
	"SHERPA_ONNX_BUILD_C_API_EXAMPLES=OFF",
	"SHERPA_ONNX_ENABLE_PORTAUDIO=OFF",
	"SHERPA_ONNX_ENABLE_WEBSOCKET=OFF",
	"SHERPA_ONNX_ENABLE_TESTS=OFF",
	"SHERPA_ONNX_ENABLE_SPEAKER_DIARIZATION=OFF",
] as const;

export const TTS_RUNTIME_LICENSE_PATHS = [
	"licenses/sherpa-onnx/LICENSE",
	"licenses/eigen/COPYING.APACHE",
	"licenses/eigen/COPYING.BSD",
	"licenses/eigen/COPYING.MINPACK",
	"licenses/eigen/COPYING.MPL2",
	"licenses/eigen/COPYING.README",
	"licenses/eigen/LICENSE",
	"licenses/espeak-ng/COPYING",
	"licenses/espeak-ng/COPYING.APACHE",
	"licenses/espeak-ng/COPYING.BSD2",
	"licenses/espeak-ng/COPYING.UCD",
	"licenses/json/LICENSE.MIT",
	"licenses/kaldi-decoder/LICENSE",
	"licenses/kaldi-native-fbank/LICENSE",
	"licenses/kaldifst/LICENSE",
	"licenses/kissfft/COPYING",
	"licenses/openfst/COPYING",
	"licenses/piper-phonemize/LICENSE.md",
	"licenses/piper-phonemize/uni-algo-LICENSE.md",
	"licenses/simple-sentencepiece/LICENSE",
	"licenses/onnxruntime/LICENSE",
	"licenses/onnxruntime/ThirdPartyNotices.txt",
	"licenses/directml/LICENSE.txt",
	"licenses/directml/LICENSE-CODE.txt",
	"licenses/directml/ThirdPartyNotices.txt",
] as const;

export const TTS_RUNTIME_PATHS: readonly string[] = [
	...TTS_DIRECTML_RUNTIME_FILES.map((file) => file.name),
	...TTS_RUNTIME_LICENSE_PATHS,
];

export type TtsRuntimeManifestEntry = {
	path: string;
	sha256: string;
	size: number;
};

export type TtsRuntimeArtifactManifest = {
	schemaVersion: 1;
	runtimeId: string;
	platform: "windows";
	architecture: "x64";
	sherpa: {
		version: string;
		sourceCommit: string;
		npmArchiveSha256: string;
	};
	onnxRuntime: {
		version: string;
		sourceCommit: string;
		nugetSha256: string;
	};
	directMl: {
		version: string;
		nugetSha256: string;
	};
	build: {
		runner: "windows-2022";
		generator: "Visual Studio 17 2022";
		architecture: "x64";
		configuration: "Release";
		toolset: "v143";
		windowsSdk: "10.0.26100.0";
		patchDescription: string;
		patchSha256: string;
		flags: string[];
	};
	archive: {
		name: string;
		sha256: string;
		size: number;
	};
	files: TtsRuntimeManifestEntry[];
};

export type TtsRuntimeVerificationOptions = {
	requireQualified?: boolean;
};

const assertManifest: RuntimeManifestAssertion =
	createRuntimeManifestAssertion("TTS");

function parseSherpa(value: unknown): TtsRuntimeArtifactManifest["sherpa"] {
	assertManifest(isRecord(value), "sherpa must be an object");
	assertManifest(
		hasExactKeys(value, ["version", "sourceCommit", "npmArchiveSha256"]),
		"unexpected or missing sherpa field",
	);
	assertManifest(value.version === SHERPA_VERSION, "sherpa version mismatch");
	assertManifest(
		value.sourceCommit === SHERPA_SOURCE_COMMIT,
		"sherpa source commit mismatch",
	);
	assertManifest(
		value.npmArchiveSha256 === SHERPA_NPM_ARCHIVE_SHA256,
		"sherpa npm archive mismatch",
	);
	return {
		version: value.version,
		sourceCommit: value.sourceCommit,
		npmArchiveSha256: value.npmArchiveSha256,
	};
}

function parseOnnxRuntime(
	value: unknown,
): TtsRuntimeArtifactManifest["onnxRuntime"] {
	assertManifest(isRecord(value), "onnxRuntime must be an object");
	assertManifest(
		hasExactKeys(value, ["version", "sourceCommit", "nugetSha256"]),
		"unexpected or missing onnxRuntime field",
	);
	assertManifest(
		value.version === ONNXRUNTIME_VERSION,
		"ONNX Runtime version mismatch",
	);
	assertManifest(
		value.sourceCommit === ONNXRUNTIME_SOURCE_COMMIT,
		"ONNX Runtime source commit mismatch",
	);
	assertManifest(
		value.nugetSha256 === ONNXRUNTIME_NUGET_SHA256,
		"ONNX Runtime NuGet mismatch",
	);
	return {
		version: value.version,
		sourceCommit: value.sourceCommit,
		nugetSha256: value.nugetSha256,
	};
}

function parseDirectMl(value: unknown): TtsRuntimeArtifactManifest["directMl"] {
	assertManifest(isRecord(value), "directMl must be an object");
	assertManifest(
		hasExactKeys(value, ["version", "nugetSha256"]),
		"unexpected or missing directMl field",
	);
	assertManifest(
		value.version === DIRECTML_VERSION,
		"DirectML version mismatch",
	);
	assertManifest(
		value.nugetSha256 === DIRECTML_NUGET_SHA256,
		"DirectML NuGet mismatch",
	);
	return { version: value.version, nugetSha256: value.nugetSha256 };
}

function parseBuild(value: unknown): TtsRuntimeArtifactManifest["build"] {
	assertManifest(isRecord(value), "build must be an object");
	assertManifest(
		hasExactKeys(value, [
			"runner",
			"generator",
			"architecture",
			"configuration",
			"toolset",
			"windowsSdk",
			"patchDescription",
			"patchSha256",
			"flags",
		]),
		"unexpected or missing build field",
	);
	assertManifest(value.runner === "windows-2022", "runner mismatch");
	assertManifest(
		value.generator === "Visual Studio 17 2022",
		"generator mismatch",
	);
	assertManifest(value.architecture === "x64", "build architecture mismatch");
	assertManifest(value.configuration === "Release", "configuration mismatch");
	assertManifest(value.toolset === "v143", "toolset mismatch");
	assertManifest(value.windowsSdk === "10.0.26100.0", "Windows SDK mismatch");
	assertManifest(
		value.patchDescription === SHERPA_DIRECTML_PATCH_DESCRIPTION,
		"patch description mismatch",
	);
	assertManifest(
		value.patchSha256 === SHERPA_DIRECTML_PATCH_SHA256,
		"patch SHA-256 mismatch",
	);
	assertManifest(
		Array.isArray(value.flags) &&
			value.flags.length === TTS_RUNTIME_BUILD_FLAGS.length &&
			value.flags.every(
				(flag, index) => flag === TTS_RUNTIME_BUILD_FLAGS[index],
			),
		"build flags mismatch",
	);
	return {
		runner: value.runner,
		generator: value.generator,
		architecture: value.architecture,
		configuration: value.configuration,
		toolset: value.toolset,
		windowsSdk: value.windowsSdk,
		patchDescription: value.patchDescription,
		patchSha256: value.patchSha256,
		flags: [...value.flags],
	};
}

function parseArchive(value: unknown): TtsRuntimeArtifactManifest["archive"] {
	assertManifest(isRecord(value), "archive must be an object");
	assertManifest(
		hasExactKeys(value, ["name", "sha256", "size"]),
		"unexpected or missing archive field",
	);
	assertManifest(value.name === TTS_RUNTIME_ARTIFACT, "archive name mismatch");
	assertManifest(isSha256(value.sha256), "archive SHA-256");
	assertManifest(
		Number.isSafeInteger(value.size) &&
			typeof value.size === "number" &&
			value.size > 0 &&
			value.size <= TTS_RUNTIME_ARCHIVE_MAX_BYTES,
		"archive size",
	);
	return { name: value.name, sha256: value.sha256, size: value.size };
}

function parseFiles(
	value: unknown,
	options: TtsRuntimeVerificationOptions,
): TtsRuntimeManifestEntry[] {
	const files = parseStrictRuntimeManifestEntries(value, {
		expectedPaths: TTS_RUNTIME_PATHS,
		maxFileBytes: TTS_RUNTIME_MAX_FILE_BYTES,
		maxTotalBytes: TTS_RUNTIME_MAX_FILE_BYTES * 2,
		assertManifest,
	});
	const fixedFiles = new Map(
		TTS_DIRECTML_RUNTIME_FILES.filter(
			(file) =>
				options.requireQualified || file.name !== "sherpa-onnx-c-api.dll",
		).map((file) => [file.name, file]),
	);
	for (const file of files) {
		const expected = fixedFiles.get(file.path);
		assertManifest(
			!expected ||
				(file.sha256 === expected.sha256 && file.size === expected.size),
			`${file.path} does not match the pinned upstream binary`,
		);
	}
	return files;
}

export function parseTtsRuntimeArtifactManifest(
	value: unknown,
	options: TtsRuntimeVerificationOptions = {},
): TtsRuntimeArtifactManifest {
	assertManifest(isRecord(value), "expected an object");
	assertManifest(
		hasExactKeys(value, [
			"schemaVersion",
			"runtimeId",
			"platform",
			"architecture",
			"sherpa",
			"onnxRuntime",
			"directMl",
			"build",
			"archive",
			"files",
		]),
		"unexpected or missing top-level field",
	);
	assertManifest(value.schemaVersion === 1, "unsupported schema version");
	assertManifest(value.runtimeId === TTS_RUNTIME_ID, "runtime ID mismatch");
	assertManifest(value.platform === "windows", "platform mismatch");
	assertManifest(value.architecture === "x64", "architecture mismatch");
	return {
		schemaVersion: 1,
		runtimeId: value.runtimeId,
		platform: value.platform,
		architecture: value.architecture,
		sherpa: parseSherpa(value.sherpa),
		onnxRuntime: parseOnnxRuntime(value.onnxRuntime),
		directMl: parseDirectMl(value.directMl),
		build: parseBuild(value.build),
		archive: parseArchive(value.archive),
		files: parseFiles(value.files, options),
	};
}

export function readTtsRuntimeArtifactManifest(
	path: string,
	options: TtsRuntimeVerificationOptions = {},
): TtsRuntimeArtifactManifest {
	const stat = lstatSync(path);
	if (!stat.isFile()) throw new Error("TTS runtime manifest must be a file");
	if (stat.size > TTS_RUNTIME_MANIFEST_MAX_BYTES)
		throw new Error("TTS runtime manifest exceeds the size limit");
	return parseTtsRuntimeArtifactManifest(
		JSON.parse(readFileSync(path, "utf8")),
		options,
	);
}

function collectTreeFiles(root: string, directory = root): string[] {
	const files: string[] = [];
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		const absolute = join(directory, entry.name);
		if (entry.isSymbolicLink()) throw new Error("runtime tree contains a symlink");
		if (entry.isDirectory()) {
			files.push(...collectTreeFiles(root, absolute));
			continue;
		}
		if (!entry.isFile()) throw new Error("runtime tree contains a special file");
		files.push(relative(root, absolute).replaceAll("\\", "/"));
	}
	return files;
}

export function verifyTtsRuntimeTree(
	directory: string,
	manifest: readonly TtsRuntimeManifestEntry[],
): boolean {
	try {
		const actual = collectTreeFiles(directory).sort();
		const expected = manifest.map((entry) => entry.path).sort();
		if (
			actual.length !== expected.length ||
			actual.some((path, index) => path !== expected[index])
		)
			return false;
		return manifest.every((entry) => {
			const path = join(directory, entry.path);
			const stat = lstatSync(path);
			return (
				stat.isFile() &&
				stat.size === entry.size &&
				sha256Digest(readFileSync(path)) === entry.sha256
			);
		});
	} catch {
		return false;
	}
}

export async function verifyTtsRuntimeArtifact(
	archivePath: string,
	manifestPath: string,
	options: TtsRuntimeVerificationOptions = {},
): Promise<TtsRuntimeArtifactManifest> {
	const manifest = readTtsRuntimeArtifactManifest(manifestPath, options);
	const stat = lstatSync(archivePath);
	if (!stat.isFile()) throw new Error("TTS runtime archive must be a file");
	if (stat.size !== manifest.archive.size)
		throw new Error("TTS runtime archive size mismatch");
	if (stat.size > TTS_RUNTIME_ARCHIVE_MAX_BYTES)
		throw new Error("TTS runtime archive exceeds the size limit");
	const actualSha256 = sha256Digest(readFileSync(archivePath));
	if (actualSha256 !== manifest.archive.sha256)
		throw new Error("TTS runtime archive SHA-256 mismatch");

	const expectedEntries = TTS_RUNTIME_PATHS.map(
		(path) => `${TTS_RUNTIME_ARCHIVE_ROOT}/${path}`,
	).sort();
	const actualEntries = (
		await listZipEntries(archivePath, "failed to inspect TTS runtime archive")
	).sort();
	if (
		actualEntries.length !== expectedEntries.length ||
		actualEntries.some((entry, index) => entry !== expectedEntries[index])
	)
		throw new Error("TTS runtime archive entries do not match the manifest");

	const temporary = mkdtempSync(join(tmpdir(), "hlid-tts-runtime-verify-"));
	try {
		await extractZipArchive(
			archivePath,
			temporary,
			"failed to extract TTS runtime archive",
		);
		const root = join(temporary, TTS_RUNTIME_ARCHIVE_ROOT);
		if (!verifyTtsRuntimeTree(root, manifest.files))
			throw new Error("TTS runtime files do not match the manifest");
	} finally {
		rmSync(temporary, { recursive: true, force: true });
	}
	return manifest;
}

export function assertTtsArtifactDirectory(directory: string): void {
	if (!existsSync(directory) || !lstatSync(directory).isDirectory())
		throw new Error(`TTS runtime artifact must be a directory: ${directory}`);
	const expected = [TTS_RUNTIME_ARTIFACT, "runtime-manifest.json"].sort();
	const actual = readdirSync(directory).sort();
	if (
		actual.length !== expected.length ||
		actual.some((entry, index) => entry !== expected[index])
	)
		throw new Error("TTS runtime artifact has unexpected or missing files");
}

export function artifactPath(directory: string): string {
	return join(directory, TTS_RUNTIME_ARTIFACT);
}

export function manifestPath(directory: string): string {
	return join(directory, "runtime-manifest.json");
}

export function ensureParentDirectory(path: string): void {
	mkdirSync(dirname(path), { recursive: true });
}
