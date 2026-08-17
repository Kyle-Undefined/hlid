import { createHash } from "node:crypto";
import {
	copyFileSync,
	existsSync,
	lstatSync,
	mkdtempSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
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

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const vendor = join(root, "vendor", "whisper");
const vendorManifest = join(vendor, "runtime-manifest.json");
const cachedArchive = join(
	root,
	".cache",
	"whisper",
	"hlid-whisper-runtime-windows-x64-v1.9.1.zip",
);
const cachedManifest = join(
	root,
	".cache",
	"whisper",
	"runtime-manifest.json",
);
const generatedDir = join(root, "build", "embed-assets", "whisper");
const stagedDir = join(generatedDir, "files");
const outFile = join(generatedDir, "voice-assets.generated.js");
export const WHISPER_VERSION = "v1.9.1";
export const WHISPER_SOURCE_COMMIT =
	"f049fff95a089aa9969deb009cdd4892b3e74916";
export const WHISPER_RUNTIME_ARTIFACT =
	"hlid-whisper-runtime-windows-x64-v1.9.1.zip";
export const WHISPER_VULKAN_SDK_VERSION = "1.4.350.0";
export const WHISPER_LICENSE_SHA256 =
	"94f29bbed6a22c35b992c5c6ebf0e7c92f13b836b90f36f461c9cf2f0f1d010d";
export const WHISPER_BUILD_FLAGS = [
	"BUILD_SHARED_LIBS=ON",
	"GGML_BACKEND_DL=ON",
	"GGML_NATIVE=OFF",
	"GGML_CPU_ALL_VARIANTS=OFF",
	"GGML_VULKAN=ON",
	"GGML_VULKAN_RUN_TESTS=OFF",
	"WHISPER_BUILD_TESTS=OFF",
	"WHISPER_BUILD_EXAMPLES=ON",
	"WHISPER_BUILD_SERVER=ON",
	"WHISPER_CURL=OFF",
] as const;
export const WHISPER_ARCHIVE_MAX_BYTES = 64 * 1024 * 1024;
export const WHISPER_MANIFEST_MAX_BYTES = 256 * 1024;
const WHISPER_RUNTIME_MAX_FILE_BYTES = 128 * 1024 * 1024;

export type RuntimeManifestEntry = {
	path: string;
	sha256: string;
	size?: number;
};

export type RuntimeArtifactManifest = {
	schemaVersion: 1;
	whisperVersion: string;
	whisperSourceCommit: string;
	vulkanSdkVersion: string;
	buildFlags: string[];
	archive: string;
	archiveSha256: string;
	files: Array<Required<RuntimeManifestEntry>>;
};

export type LocalRuntimeArtifact = {
	archive: string;
	manifest: string;
};

// This legacy manifest keeps an already-reviewed local runtime usable. Release
// builds supply the archive and manifest produced earlier in the same workflow.
export const WHISPER_RUNTIME_MANIFEST: readonly RuntimeManifestEntry[] = [
	{
		path: "Release/ggml-base.dll",
		sha256: "1d4a0a4d71a8d124a16ecd2e4e7be7eccf2c161e520c749b238739870d7352a2",
	},
	{
		path: "Release/ggml-cpu.dll",
		sha256: "6187f780c7b47e2641e7e2517f4f2a25b1a49fece7943878750247c0c98231ed",
	},
	{
		path: "Release/ggml-vulkan.dll",
		sha256: "fdfc3174ce00821a9e2c60e4799d2afdc4fca85da6f10b42ab482d887433686c",
	},
	{
		path: "Release/ggml.dll",
		sha256: "703feb8a697975d919185e1722c168525e30d29558766740e56489adc66b44df",
	},
	{
		path: "Release/whisper.dll",
		sha256: "7d341138009e026151e701c09a4c1510620806a371df75b76b122cfbf9dc92d1",
	},
	{
		path: "Release/whisper-server.exe",
		sha256: "65d08fcde5f080e0378f2da521cc8566b1756ca6463de56df8c0ad85237dcabd",
	},
	{
		path: "Release/LICENSE",
		sha256: WHISPER_LICENSE_SHA256,
	},
] as const;

export const WHISPER_RUNTIME_PATHS = WHISPER_RUNTIME_MANIFEST.map(
	(entry) => entry.path,
);

const assertManifest: RuntimeManifestAssertion =
	createRuntimeManifestAssertion("whisper");

export function parseRuntimeArtifactManifest(
	value: unknown,
): RuntimeArtifactManifest {
	assertManifest(isRecord(value), "expected an object");
	assertManifest(
		hasExactKeys(value, [
			"schemaVersion",
			"whisperVersion",
			"whisperSourceCommit",
			"vulkanSdkVersion",
			"buildFlags",
			"archive",
			"archiveSha256",
			"files",
		]),
		"unexpected or missing top-level field",
	);
	assertManifest(value.schemaVersion === 1, "unsupported schema version");
	assertManifest(
		value.whisperVersion === WHISPER_VERSION,
		"whisper version mismatch",
	);
	assertManifest(
		value.whisperSourceCommit === WHISPER_SOURCE_COMMIT,
		"whisper source commit mismatch",
	);
	assertManifest(
		value.vulkanSdkVersion === WHISPER_VULKAN_SDK_VERSION,
		"Vulkan SDK version mismatch",
	);
	assertManifest(
		Array.isArray(value.buildFlags) &&
			value.buildFlags.length === WHISPER_BUILD_FLAGS.length &&
			value.buildFlags.every(
				(flag, index) => flag === WHISPER_BUILD_FLAGS[index],
			),
		"build flags mismatch",
	);
	assertManifest(
		value.archive === WHISPER_RUNTIME_ARTIFACT,
		"archive name mismatch",
	);
	assertManifest(isSha256(value.archiveSha256), "invalid archive SHA-256");
	const files = parseStrictRuntimeManifestEntries(value.files, {
		expectedPaths: WHISPER_RUNTIME_PATHS,
		maxFileBytes: WHISPER_RUNTIME_MAX_FILE_BYTES,
		maxTotalBytes: WHISPER_RUNTIME_MAX_FILE_BYTES,
		assertManifest,
	});
	const license = files.at(-1);
	assertManifest(
		license?.path === "Release/LICENSE" &&
			license.sha256 === WHISPER_LICENSE_SHA256,
		"license mismatch",
	);

	return {
		schemaVersion: 1,
		whisperVersion: value.whisperVersion,
		whisperSourceCommit: value.whisperSourceCommit,
		vulkanSdkVersion: value.vulkanSdkVersion,
		buildFlags: [...value.buildFlags],
		archive: value.archive,
		archiveSha256: value.archiveSha256,
		files,
	};
}

export function readRuntimeArtifactManifest(
	path: string,
): RuntimeArtifactManifest {
	const stat = lstatSync(path);
	if (!stat.isFile()) throw new Error("runtime manifest must be a file");
	if (stat.size > WHISPER_MANIFEST_MAX_BYTES) {
		throw new Error(
			`runtime manifest exceeds ${WHISPER_MANIFEST_MAX_BYTES} byte limit`,
		);
	}
	return parseRuntimeArtifactManifest(JSON.parse(readFileSync(path, "utf8")));
}

export function verifyRuntimeTree(
	dir: string,
	manifest: readonly RuntimeManifestEntry[] = WHISPER_RUNTIME_MANIFEST,
): boolean {
	const reviewed = new Set(manifest.map((entry) => entry.path.replaceAll("\\", "/")));
	const releaseDir = join(dir, "Release");
	let files: string[];
	try {
		files = readdirSync(releaseDir).map((name) => `Release/${name}`);
	} catch {
		return false;
	}
	if (
		files.length !== reviewed.size ||
		files.some((path) => !reviewed.has(path))
	)
		return false;
	return manifest.every((entry) => {
		const file = join(dir, entry.path);
		try {
			const stat = lstatSync(file);
			return (
				stat.isFile() &&
				(entry.size === undefined || stat.size === entry.size) &&
				sha256Digest(readFileSync(file)) === entry.sha256
			);
		} catch {
			return false;
		}
	});
}

export function copyVerifiedArchive(
	source: string,
	destination: string,
	expectedSha256: string,
	maxBytes = WHISPER_ARCHIVE_MAX_BYTES,
): void {
	const stat = lstatSync(source);
	if (!stat.isFile()) throw new Error("runtime archive override must be a file");
	if (stat.size > maxBytes)
		throw new Error(`runtime archive exceeds ${maxBytes} byte limit`);
	const archive = readFileSync(source);
	const actualSha256 = sha256Digest(archive);
	if (actualSha256 !== expectedSha256) {
		throw new Error(
			`runtime archive SHA-256 mismatch: expected ${expectedSha256}, received ${actualSha256}`,
		);
	}
	writeFileSync(destination, archive, { flag: "wx" });
}

export function resolveLocalRuntimeArtifact(
	archiveOverride: string | undefined,
	manifestOverride: string | undefined,
	cacheArchive = cachedArchive,
	cacheManifest = cachedManifest,
	fileExists: (path: string) => boolean = existsSync,
): LocalRuntimeArtifact | undefined {
	if (archiveOverride || manifestOverride) {
		if (!archiveOverride || !manifestOverride) {
			throw new Error(
				"runtime archive and manifest overrides must be provided together",
			);
		}
		return { archive: archiveOverride, manifest: manifestOverride };
	}
	return fileExists(cacheArchive) && fileExists(cacheManifest)
		? { archive: cacheArchive, manifest: cacheManifest }
		: undefined;
}

function verifyArchiveEntries(
	entries: string[],
	manifest: RuntimeArtifactManifest,
): boolean {
	const expected = manifest.files.map((entry) => entry.path).sort();
	const actual = [...entries].sort();
	return (
		actual.length === expected.length &&
		actual.every((entry, index) => entry === expected[index])
	);
}

export async function verifyRuntimeArtifact(
	archivePath: string,
	manifestPath: string,
): Promise<RuntimeArtifactManifest> {
	const manifest = readRuntimeArtifactManifest(manifestPath);
	const archiveStat = lstatSync(archivePath);
	if (!archiveStat.isFile()) throw new Error("runtime archive must be a file");
	if (archiveStat.size > WHISPER_ARCHIVE_MAX_BYTES) {
		throw new Error(
			`runtime archive exceeds ${WHISPER_ARCHIVE_MAX_BYTES} byte limit`,
		);
	}
	const actualSha256 = sha256Digest(readFileSync(archivePath));
	if (actualSha256 !== manifest.archiveSha256) {
		throw new Error(
			`runtime archive SHA-256 mismatch: expected ${manifest.archiveSha256}, received ${actualSha256}`,
		);
	}
	const entries = await listZipEntries(
		archivePath,
		"failed to inspect whisper runtime with unzip or tar",
	);
	if (!verifyArchiveEntries(entries, manifest)) {
		throw new Error("runtime archive entries do not match the reviewed manifest");
	}

	const temp = mkdtempSync(join(tmpdir(), "hlid-whisper-verify-"));
	try {
		const extracted = join(temp, "extracted");
		await extractZipArchive(
			archivePath,
			extracted,
			"failed to extract whisper runtime with unzip or tar",
		);
		if (!verifyRuntimeTree(extracted, manifest.files)) {
			throw new Error("runtime archive contents do not match the reviewed manifest");
		}
	} finally {
		rmSync(temp, { recursive: true, force: true });
	}
	return manifest;
}

async function ensureRuntime(): Promise<readonly RuntimeManifestEntry[]> {
	const localArtifact = resolveLocalRuntimeArtifact(
		process.env.HLID_WHISPER_RUNTIME_ARCHIVE,
		process.env.HLID_WHISPER_RUNTIME_MANIFEST,
	);
	let manifest = localArtifact
		? await verifyRuntimeArtifact(localArtifact.archive, localArtifact.manifest)
		: undefined;
	if (manifest && existsSync(vendor) && verifyRuntimeTree(vendor, manifest.files)) {
		return manifest.files;
	}
	if (!manifest && existsSync(vendorManifest)) {
		try {
			const persisted = readRuntimeArtifactManifest(vendorManifest);
			if (verifyRuntimeTree(vendor, persisted.files)) return persisted.files;
		} catch {
			// Fall through to the legacy tree or a required artifact pair below.
		}
	}
	if (!manifest && existsSync(vendor) && verifyRuntimeTree(vendor)) {
		return WHISPER_RUNTIME_MANIFEST;
	}
	if (!localArtifact || !manifest) {
		throw new Error(
			"reviewed Whisper runtime unavailable: provide both HLID_WHISPER_RUNTIME_ARCHIVE and HLID_WHISPER_RUNTIME_MANIFEST",
		);
	}

	console.log(
		`Preparing whisper.cpp ${WHISPER_VERSION} CPU + Vulkan runtime (${WHISPER_SOURCE_COMMIT.slice(0, 12)})...`,
	);
	// Stage beside the vendor directory so the final verified-tree rename stays
	// on one filesystem and can be atomic.
	mkdirSync(dirname(vendor), { recursive: true });
	const temp = mkdtempSync(join(dirname(vendor), ".whisper-download-"));
	const archive = join(temp, WHISPER_RUNTIME_ARTIFACT);
	const manifestFile = join(temp, "runtime-manifest.json");
	const extracted = join(temp, "extracted");
	try {
		console.log(`Using reviewed local runtime archive ${localArtifact.archive}`);
		copyVerifiedArchive(
			localArtifact.archive,
			archive,
			manifest.archiveSha256,
		);
		writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
		const archiveEntries = await listZipEntries(
			archive,
			"failed to inspect whisper runtime with unzip or tar",
		);
		if (!verifyArchiveEntries(archiveEntries, manifest)) {
			throw new Error("runtime archive entries do not match the reviewed manifest");
		}
		await extractZipArchive(
			archive,
			extracted,
			"failed to extract whisper runtime with unzip or tar",
		);
		if (!verifyRuntimeTree(extracted, manifest.files)) {
			throw new Error("extracted whisper runtime does not match the reviewed manifest");
		}
		writeFileSync(
			join(extracted, "runtime-manifest.json"),
			`${JSON.stringify(manifest, null, 2)}\n`,
		);
		const previous = `${vendor}.previous`;
		rmSync(previous, { recursive: true, force: true });
		mkdirSync(dirname(vendor), { recursive: true });
		if (existsSync(vendor)) renameSync(vendor, previous);
		try {
			renameSync(extracted, vendor);
			rmSync(previous, { recursive: true, force: true });
		} catch (error) {
			if (existsSync(previous)) renameSync(previous, vendor);
			throw error;
		}
		return manifest.files;
	} finally {
		rmSync(temp, { recursive: true, force: true });
	}
}

export async function bundleWhisperAssets(): Promise<void> {
	const runtimeManifest = await ensureRuntime();

	// Only manifest entries are bundled, never arbitrary EXE/DLL files found in
	// the vendor tree.
	const files = runtimeManifest.map((entry) => entry.path);
	rmSync(generatedDir, { recursive: true, force: true });
	mkdirSync(stagedDir, { recursive: true });
	const hash = createHash("sha256");
	const entries = files.map((file, index) => {
		const bytes = readFileSync(join(vendor, file));
		hash.update(file).update(bytes);
		const staged = join(stagedDir, `${index}-${basename(file)}.asset`);
		copyFileSync(join(vendor, file), staged);
		return { file: basename(file), staged, ident: `asset_${index}` };
	});
	const lines = ["// AUTO-GENERATED by scripts/bundle-whisper-assets.ts", ""];
	for (const entry of entries) {
		const importPath = `./${relative(generatedDir, entry.staged).replaceAll("\\", "/")}`;
		lines.push(
			`import ${entry.ident} from ${JSON.stringify(importPath)} with { type: "file" };`,
		);
	}
	lines.push(
		"",
		`export const WHISPER_ASSETS_HASH = ${JSON.stringify(hash.digest("hex"))};`,
		"",
		"export const WHISPER_ASSETS = {",
	);
	for (const entry of entries)
		lines.push(`\t${JSON.stringify(entry.file)}: ${entry.ident},`);
	lines.push("};", "");
	writeFileSync(outFile, lines.join("\n"), "utf8");
	console.log(`Bundled ${entries.length} whisper runtime files`);
	console.log(`Wrote ${outFile}`);
}

if (import.meta.main) await bundleWhisperAssets();
