import { createHash } from "node:crypto";
import {
	copyFileSync,
	existsSync,
	lstatSync,
	mkdtempSync,
	mkdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const vendor = join(root, "vendor", "whisper");
const generatedDir = join(root, "build", "embed-assets", "whisper");
const stagedDir = join(generatedDir, "files");
const outFile = join(generatedDir, "voice-assets.generated.js");
export const WHISPER_VERSION = "v1.8.6";
const WHISPER_ARCHIVE_URL = `https://github.com/ggml-org/whisper.cpp/releases/download/${WHISPER_VERSION}/whisper-bin-x64.zip`;
export const WHISPER_ARCHIVE_SHA256 =
	"b07ea0b1b4115a38e1a7b07debf581f0b77d999925f8acb8f39d322b0ba0a822";
export const WHISPER_ARCHIVE_MAX_BYTES = 16 * 1024 * 1024;

export type RuntimeManifestEntry = {
	path: string;
	sha256: string;
};

type Fetcher = (
	input: string | URL | Request,
	init?: RequestInit,
) => Promise<Response>;

// These are the complete runtime surface Hlid bundles. The release archive also
// contains unrelated CLI, benchmark, test, and SDL executables; they are not
// copied into the application.
export const WHISPER_RUNTIME_MANIFEST: readonly RuntimeManifestEntry[] = [
	{
		path: "Release/ggml-base.dll",
		sha256: "017cd9c859d0da3c6d0e8da120ec5641db7c8d1f266df7ce1f9eca42029186ba",
	},
	{
		path: "Release/ggml-cpu.dll",
		sha256: "cb5bfd79c0255e282982527fee42d8aa8407b63ae46ef1acd395c3e21d1f52f9",
	},
	{
		path: "Release/ggml.dll",
		sha256: "722ff1350efe25a1bffa048bef2a8aa7fe7552fce3c38d2c1505f99beb0fb1f7",
	},
	{
		path: "Release/whisper.dll",
		sha256: "aecc185550327461d74a7c89436e13a62e12cc408c05719e7a677e1586a9cda3",
	},
	{
		path: "Release/whisper-server.exe",
		sha256: "d52adc17f509da58717e853a0c56a281a40847c56a12d01933e227426616eabf",
	},
] as const;

function sha256(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

export function verifyRuntimeTree(
	dir: string,
	manifest: readonly RuntimeManifestEntry[] = WHISPER_RUNTIME_MANIFEST,
): boolean {
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

	console.log(`Downloading whisper.cpp ${WHISPER_VERSION} CPU runtime...`);
	// Stage beside the vendor directory so the final verified-tree rename stays
	// on one filesystem and can be atomic.
	mkdirSync(dirname(vendor), { recursive: true });
	const temp = mkdtempSync(join(dirname(vendor), ".whisper-download-"));
	const archive = join(temp, "whisper-bin-x64.zip");
	const extracted = join(temp, "extracted");
	try {
		await downloadVerifiedArchive(WHISPER_ARCHIVE_URL, archive);
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
