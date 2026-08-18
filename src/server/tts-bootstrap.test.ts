import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	bootstrapTtsRuntimeAssets,
	defaultTtsDirectMlRuntimeDirectory,
	type TtsRuntimeFile,
	verifyTtsRuntimeAssets,
} from "./tts-bootstrap";

const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
	const directory = mkdtempSync(join(tmpdir(), "hlid-tts-assets-"));
	temporaryDirectories.push(directory);
	return directory;
}

function sha256(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

function fixture(): { directory: string; files: TtsRuntimeFile[] } {
	const directory = temporaryDirectory();
	const values = {
		"sherpa-onnx.node": "addon",
		"sherpa-onnx-c-api.dll": "c-api",
		"onnxruntime.dll": "ort",
		"onnxruntime_providers_shared.dll": "providers",
		"DirectML.dll": "directml",
	};
	const files = Object.entries(values).map(([name, value]) => {
		writeFileSync(join(directory, name), value);
		return { name, size: Buffer.byteLength(value), sha256: sha256(value) };
	});
	return { directory, files };
}

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0))
		rmSync(directory, { recursive: true, force: true });
});

describe("TTS DirectML runtime bootstrap", () => {
	it("returns only exact hash-verified assets", () => {
		const { directory, files } = fixture();
		expect(verifyTtsRuntimeAssets(directory, files)).toEqual({
			directory,
			addonPath: join(directory, "sherpa-onnx.node"),
			backends: ["directml"],
		});

		writeFileSync(join(directory, "DirectML.dll"), "changed");
		expect(verifyTtsRuntimeAssets(directory, files)).toBeNull();
	});

	it("rejects unreviewed top-level files and links", () => {
		const first = fixture();
		writeFileSync(join(first.directory, "unreviewed.dll"), "extra");
		expect(verifyTtsRuntimeAssets(first.directory, first.files)).toBeNull();

		const second = fixture();
		const external = join(temporaryDirectory(), "outside.node");
		writeFileSync(external, "addon");
		rmSync(join(second.directory, "sherpa-onnx.node"));
		symlinkSync(external, join(second.directory, "sherpa-onnx.node"));
		expect(verifyTtsRuntimeAssets(second.directory, second.files)).toBeNull();
	});

	it("uses an explicit Windows override and stays unavailable elsewhere", () => {
		const { directory, files } = fixture();
		const environment = { HLID_TTS_DIRECTML_RUNTIME_DIR: directory };
		expect(
			bootstrapTtsRuntimeAssets({
				platform: "win32",
				environment,
				files,
			}),
		).toMatchObject({ directory, backends: ["directml"] });
		expect(
			bootstrapTtsRuntimeAssets({
				platform: "linux",
				environment,
				files,
			}),
		).toBeNull();
	});

	it("uses the immutable runtime ID under local application data", () => {
		expect(
			defaultTtsDirectMlRuntimeDirectory({ LOCALAPPDATA: "C:/Local" }),
		).toMatch(
			/sherpa-tts-1\.13\.4-ort-dml-1\.24\.4-directml-1\.15\.4-r2-win-x64$/,
		);
	});
});
