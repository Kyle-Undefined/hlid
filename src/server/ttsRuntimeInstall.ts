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
import { replaceRuntimeDirectory } from "./embeddedRuntime";
import type { TtsRuntimeAssets } from "./tts";
import {
	defaultTtsDirectMlRuntimeDirectory,
	TTS_DIRECTML_RUNTIME_ID,
	verifyTtsRuntimeAssets,
} from "./tts-bootstrap";

export const MAX_TTS_RUNTIME_INSTALL_BODY_BYTES =
	TTS_RUNTIME_ARCHIVE_MAX_BYTES + TTS_RUNTIME_MANIFEST_MAX_BYTES + 1024 * 1024;

export type TtsRuntimeInstallStatus = {
	supported: boolean;
	installed: boolean;
	runtimeId: string;
};

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

export function runtimeInstallFilenames(): {
	archive: string;
	manifest: "runtime-manifest.json";
} {
	return { archive: TTS_RUNTIME_ARTIFACT, manifest: "runtime-manifest.json" };
}
