import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { extractZipArchive } from "../../scripts/archive-utils";
import {
	artifactPath,
	manifestPath,
	TTS_RUNTIME_ARCHIVE_MAX_BYTES,
	TTS_RUNTIME_ARTIFACT,
	TTS_RUNTIME_MANIFEST_MAX_BYTES,
	verifyTtsRuntimeArtifact,
	verifyTtsRuntimeTree,
} from "../../scripts/tts-runtime-artifact";
import { CURRENT_VERSION } from "../lib/version";
import { replaceRuntimeDirectory } from "./embeddedRuntime";
import type { TtsRuntimeAssets } from "./tts";
import {
	defaultTtsDirectMlRuntimeDirectory,
	TTS_DIRECTML_RUNTIME_ID,
	verifyTtsRuntimeAssets,
} from "./tts-bootstrap";

export const MAX_TTS_RUNTIME_INSTALL_BODY_BYTES =
	TTS_RUNTIME_ARCHIVE_MAX_BYTES + TTS_RUNTIME_MANIFEST_MAX_BYTES + 1024 * 1024;
const TTS_RUNTIME_DOWNLOAD_TIMEOUT_MS = 2 * 60_000;
const TTS_RUNTIME_RELEASE_BASE_URL =
	"https://github.com/Kyle-Undefined/hlid/releases/download";

export type TtsRuntimeInstallStatus = {
	supported: boolean;
	installed: boolean;
	runtimeId: string;
};

export type TtsRuntimeReleaseUrls = {
	archive: string;
	manifest: string;
};

export function ttsRuntimeReleaseUrls(
	version = CURRENT_VERSION,
): TtsRuntimeReleaseUrls {
	if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
		throw new Error("The Hlid release version is invalid.");
	}
	const release = `${TTS_RUNTIME_RELEASE_BASE_URL}/${encodeURIComponent(`v${version}`)}`;
	return {
		archive: `${release}/${encodeURIComponent(TTS_RUNTIME_ARTIFACT)}`,
		manifest: `${release}/runtime-manifest.json`,
	};
}

async function runtimeDownloadLength(
	response: Response,
	label: string,
	maxBytes: number,
): Promise<number | null> {
	const header = response.headers.get("content-length");
	if (header === null) return null;
	const bytes = Number(header);
	if (Number.isSafeInteger(bytes) && bytes >= 0 && bytes <= maxBytes) {
		return bytes;
	}
	await response.body?.cancel().catch(() => {});
	throw new Error(
		`The DirectML runtime ${label} has an invalid download size.`,
	);
}

async function downloadRuntimeReleaseFile(
	url: string,
	label: string,
	maxBytes: number,
	fetcher: typeof fetch,
	signal: AbortSignal,
): Promise<Uint8Array> {
	const response = await fetcher(url, {
		headers: { accept: "application/octet-stream" },
		redirect: "follow",
		signal,
	});
	if (!response.ok || !response.body) {
		await response.body?.cancel().catch(() => {});
		throw new Error(
			`The DirectML runtime ${label} download failed with HTTP ${response.status}.`,
		);
	}
	const declared = await runtimeDownloadLength(response, label, maxBytes);

	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let received = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			received += value.byteLength;
			if (received > maxBytes) {
				await reader.cancel();
				throw new Error(
					`The DirectML runtime ${label} exceeds the download size limit.`,
				);
			}
			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}
	if (declared !== null && received !== declared) {
		throw new Error(`The DirectML runtime ${label} download was incomplete.`);
	}
	const result = new Uint8Array(received);
	let offset = 0;
	for (const chunk of chunks) {
		result.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return result;
}

export function ttsRuntimeInstallStatus({
	platform = process.platform,
	architecture = process.arch,
	directory = defaultTtsDirectMlRuntimeDirectory(),
	installed,
}: {
	platform?: NodeJS.Platform;
	architecture?: string;
	directory?: string;
	installed?: boolean;
} = {}): TtsRuntimeInstallStatus {
	const supported = platform === "win32" && architecture === "x64";
	return {
		supported,
		installed:
			supported && (installed ?? verifyTtsRuntimeAssets(directory) !== null),
		runtimeId: TTS_DIRECTML_RUNTIME_ID,
	};
}

export async function installQualifiedTtsRuntime(
	archive: Uint8Array,
	manifest: Uint8Array,
	{
		platform = process.platform,
		architecture = process.arch,
		directory = defaultTtsDirectMlRuntimeDirectory(),
	}: {
		platform?: NodeJS.Platform;
		architecture?: string;
		directory?: string;
	} = {},
): Promise<TtsRuntimeAssets> {
	if (platform !== "win32" || architecture !== "x64") {
		throw new Error("The reviewed DirectML runtime requires Windows x64.");
	}
	if (
		archive.byteLength === 0 ||
		archive.byteLength > TTS_RUNTIME_ARCHIVE_MAX_BYTES
	)
		throw new Error("The DirectML runtime archive has an invalid size.");
	if (
		manifest.byteLength === 0 ||
		manifest.byteLength > TTS_RUNTIME_MANIFEST_MAX_BYTES
	)
		throw new Error("The DirectML runtime manifest has an invalid size.");

	mkdirSync(dirname(directory), { recursive: true });
	const artifactDirectory = mkdtempSync(join(dirname(directory), ".import-"));
	const extractionDirectory = `${directory}.extract`;
	try {
		writeFileSync(artifactPath(artifactDirectory), archive, {
			flag: "wx",
			mode: 0o600,
		});
		writeFileSync(manifestPath(artifactDirectory), manifest, {
			flag: "wx",
			mode: 0o600,
		});
		const verifiedManifest = await verifyTtsRuntimeArtifact(
			artifactPath(artifactDirectory),
			manifestPath(artifactDirectory),
			{ requireQualified: true },
		);

		rmSync(extractionDirectory, { recursive: true, force: true });
		await extractZipArchive(
			artifactPath(artifactDirectory),
			extractionDirectory,
			"failed to extract the qualified DirectML runtime",
		);
		const packageDirectory = join(extractionDirectory, "package");
		if (!verifyTtsRuntimeTree(packageDirectory, verifiedManifest.files)) {
			throw new Error(
				"The extracted DirectML runtime does not match its manifest.",
			);
		}
		writeFileSync(
			join(packageDirectory, "runtime-manifest.json"),
			readFileSync(manifestPath(artifactDirectory)),
			{ flag: "wx", mode: 0o600 },
		);
		replaceRuntimeDirectory(packageDirectory, directory);
		const installed = verifyTtsRuntimeAssets(directory);
		if (!installed) {
			throw new Error(
				"The installed DirectML runtime failed final verification.",
			);
		}
		return installed;
	} finally {
		rmSync(artifactDirectory, { recursive: true, force: true });
		rmSync(extractionDirectory, { recursive: true, force: true });
	}
}

export async function downloadAndInstallQualifiedTtsRuntime({
	version = CURRENT_VERSION,
	platform = process.platform,
	architecture = process.arch,
	directory = defaultTtsDirectMlRuntimeDirectory(),
	fetcher = fetch,
	signal,
	installer = installQualifiedTtsRuntime,
}: {
	version?: string;
	platform?: NodeJS.Platform;
	architecture?: string;
	directory?: string;
	fetcher?: typeof fetch;
	signal?: AbortSignal;
	installer?: typeof installQualifiedTtsRuntime;
} = {}): Promise<TtsRuntimeAssets> {
	if (platform !== "win32" || architecture !== "x64") {
		throw new Error("The reviewed DirectML runtime requires Windows x64.");
	}
	const timeout = AbortSignal.timeout(TTS_RUNTIME_DOWNLOAD_TIMEOUT_MS);
	const downloadSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
	const urls = ttsRuntimeReleaseUrls(version);
	const manifest = await downloadRuntimeReleaseFile(
		urls.manifest,
		"manifest",
		TTS_RUNTIME_MANIFEST_MAX_BYTES,
		fetcher,
		downloadSignal,
	);
	const archive = await downloadRuntimeReleaseFile(
		urls.archive,
		"archive",
		TTS_RUNTIME_ARCHIVE_MAX_BYTES,
		fetcher,
		downloadSignal,
	);
	return installer(archive, manifest, { platform, architecture, directory });
}

export function runtimeInstallFilenames(): {
	archive: string;
	manifest: "runtime-manifest.json";
} {
	return { archive: TTS_RUNTIME_ARTIFACT, manifest: "runtime-manifest.json" };
}
