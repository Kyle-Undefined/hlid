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
import { basename, dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const vendor = join(root, "vendor", "whisper");
const cachedArchive = join(
	root,
	".cache",
	"whisper",
	"hlid-whisper-runtime-windows-x64-v1.9.1.zip",
);
const generatedDir = join(root, "build", "embed-assets", "whisper");
const stagedDir = join(generatedDir, "files");
const outFile = join(generatedDir, "voice-assets.generated.js");
export const WHISPER_VERSION = "v1.9.1";
export const WHISPER_SOURCE_COMMIT =
	"f049fff95a089aa9969deb009cdd4892b3e74916";
export const WHISPER_RUNTIME_ARTIFACT =
	"hlid-whisper-runtime-windows-x64-v1.9.1.zip";
const WHISPER_ARCHIVE_URL = `https://github.com/Kyle-Undefined/hlid/releases/download/whisper-runtime-${WHISPER_VERSION}/${WHISPER_RUNTIME_ARTIFACT}`;
export const WHISPER_ARCHIVE_SHA256 =
	"47b215473946a33ba916507a687ef4c5914c08030a10e93a4b37763ac25f9577";
export const WHISPER_ARCHIVE_MAX_BYTES = 64 * 1024 * 1024;

export type RuntimeManifestEntry = {
	path: string;
	sha256: string;
};

type Fetcher = (
	input: string | URL | Request,
	init?: RequestInit,
) => Promise<Response>;

// This is the complete reviewed runtime surface Hlid bundles. Any unreviewed
// DLL or executable in the archive causes verification to fail.
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
] as const;

function sha256(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

export function verifyRuntimeTree(
	dir: string,
	manifest: readonly RuntimeManifestEntry[] = WHISPER_RUNTIME_MANIFEST,
): boolean {
	const reviewed = new Set(manifest.map((entry) => entry.path.replaceAll("\\", "/")));
	const releaseDir = join(dir, "Release");
	let binaries: string[];
	try {
		binaries = readdirSync(releaseDir)
			.filter((name) => /\.(?:dll|exe)$/i.test(name))
			.map((name) => `Release/${name}`);
	} catch {
		return false;
	}
	if (
		binaries.length !== reviewed.size ||
		binaries.some((path) => !reviewed.has(path))
	)
		return false;
	return manifest.every((entry) => {
		const file = join(dir, entry.path);
		try {
			const stat = lstatSync(file);
			return stat.isFile() && sha256(readFileSync(file)) === entry.sha256;
		} catch {
			return false;
		}
	});
}

export async function downloadVerifiedArchive(
	url: string,
	destination: string,
	expectedSha256 = WHISPER_ARCHIVE_SHA256,
	maxBytes = WHISPER_ARCHIVE_MAX_BYTES,
	fetcher: Fetcher = fetch,
): Promise<void> {
	const response = await fetcher(url);
	if (!response.ok) {
		throw new Error(`runtime download failed: HTTP ${response.status}`);
	}
	const declaredLength = Number(response.headers.get("content-length"));
	if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
		throw new Error(`runtime archive exceeds ${maxBytes} byte limit`);
	}
	if (!response.body) throw new Error("runtime download returned no body");

	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		total += value.byteLength;
		if (total > maxBytes) {
			await reader.cancel();
			throw new Error(`runtime archive exceeds ${maxBytes} byte limit`);
		}
		chunks.push(value);
	}
	const archive = Buffer.concat(chunks, total);
	const actualSha256 = sha256(archive);
	if (actualSha256 !== expectedSha256) {
		throw new Error(
			`runtime archive SHA-256 mismatch: expected ${expectedSha256}, received ${actualSha256}`,
		);
	}
	writeFileSync(destination, archive, { flag: "wx" });
}

export function copyVerifiedArchive(
	source: string,
	destination: string,
	expectedSha256 = WHISPER_ARCHIVE_SHA256,
	maxBytes = WHISPER_ARCHIVE_MAX_BYTES,
): void {
	const stat = lstatSync(source);
	if (!stat.isFile()) throw new Error("runtime archive override must be a file");
	if (stat.size > maxBytes)
		throw new Error(`runtime archive exceeds ${maxBytes} byte limit`);
	const archive = readFileSync(source);
	const actualSha256 = sha256(archive);
	if (actualSha256 !== expectedSha256) {
		throw new Error(
			`runtime archive SHA-256 mismatch: expected ${expectedSha256}, received ${actualSha256}`,
		);
	}
	writeFileSync(destination, archive, { flag: "wx" });
}

export function resolveLocalRuntimeArchive(
	override: string | undefined,
	cache = cachedArchive,
	fileExists: (path: string) => boolean = existsSync,
): string | undefined {
	if (override) return override;
	return fileExists(cache) ? cache : undefined;
}

async function extractArchive(archive: string, destination: string): Promise<void> {
	const commands =
		process.platform === "win32"
			? [
					["tar", "-xf", archive, "-C", destination],
					["unzip", "-q", archive, "-d", destination],
				]
			: [
					["unzip", "-q", archive, "-d", destination],
					["tar", "-xf", archive, "-C", destination],
				];
	for (const command of commands) {
		rmSync(destination, { recursive: true, force: true });
		mkdirSync(destination, { recursive: true });
		try {
			const child = Bun.spawn(command, { stdout: "ignore", stderr: "ignore" });
			if ((await child.exited) === 0) return;
		} catch {
			// Try the next platform extractor.
		}
	}
	throw new Error("failed to extract whisper runtime with unzip or tar");
}

async function ensureRuntime(): Promise<void> {
	if (existsSync(vendor) && verifyRuntimeTree(vendor)) return;

	console.log(
		`Preparing whisper.cpp ${WHISPER_VERSION} CPU + Vulkan runtime (${WHISPER_SOURCE_COMMIT.slice(0, 12)})...`,
	);
	// Stage beside the vendor directory so the final verified-tree rename stays
	// on one filesystem and can be atomic.
	mkdirSync(dirname(vendor), { recursive: true });
	const temp = mkdtempSync(join(dirname(vendor), ".whisper-download-"));
	const archive = join(temp, "whisper-bin-x64.zip");
	const extracted = join(temp, "extracted");
	try {
		const localArchive = resolveLocalRuntimeArchive(
			process.env.HLID_WHISPER_RUNTIME_ARCHIVE,
		);
		if (localArchive) {
			console.log(`Using reviewed local runtime archive ${localArchive}`);
			copyVerifiedArchive(localArchive, archive);
		} else {
			await downloadVerifiedArchive(WHISPER_ARCHIVE_URL, archive);
		}
		await extractArchive(archive, extracted);
		if (!verifyRuntimeTree(extracted)) {
			throw new Error("extracted whisper runtime does not match the reviewed manifest");
		}
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
	} finally {
		rmSync(temp, { recursive: true, force: true });
	}
}

export async function bundleWhisperAssets(): Promise<void> {
	await ensureRuntime();

	// Only manifest entries are bundled, never arbitrary EXE/DLL files found in
	// the vendor tree.
	const files = WHISPER_RUNTIME_MANIFEST.map((entry) => entry.path);
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
