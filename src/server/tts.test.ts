import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_VOICE_CONFIG } from "../config";
import {
	relativeTtsArchivePath,
	TtsModelManager,
	ttsArchiveExtractionArgs,
	ttsTarExecutable,
	validateTtsArchiveEntries,
} from "./tts";
import { TTS_MODEL_DEFINITIONS } from "./ttsModels";

const tempDirectories: string[] = [];

function tempDirectory(): string {
	const directory = mkdtempSync(join(tmpdir(), "hlid-tts-test-"));
	tempDirectories.push(directory);
	return directory;
}

afterEach(() => {
	for (const directory of tempDirectories.splice(0))
		rmSync(directory, { recursive: true, force: true });
});

describe("TTS model manager", () => {
	it("rejects traversal and absolute archive entries", () => {
		expect(
			validateTtsArchiveEntries(
				"package/sherpa-onnx.node\npackage/onnxruntime.dll",
				"package",
			),
		).toHaveLength(2);
		expect(() =>
			validateTtsArchiveEntries("package/../outside", "package"),
		).toThrow("unsafe TTS archive entry");
		expect(() => validateTtsArchiveEntries("C:/outside", "package")).toThrow(
			"unsafe TTS archive entry",
		);
	});

	it("uses portable relative tar arguments without GNU-only flags", () => {
		const directory = tempDirectory();
		const extraction = join(directory, "runtime", "sherpa.tmp");
		const archive = join(directory, "downloads", "sherpa.tgz.part");

		expect(ttsArchiveExtractionArgs(extraction, archive, "gzip")).toEqual([
			"-xzf",
			"../../downloads/sherpa.tgz.part",
		]);
		expect(ttsArchiveExtractionArgs(extraction, archive, "bzip2")).toEqual([
			"-xjf",
			"../../downloads/sherpa.tgz.part",
		]);
		expect(ttsArchiveExtractionArgs(extraction, archive, "gzip")).not.toContain(
			"--strip-components=1",
		);
		expect(relativeTtsArchivePath(extraction, archive)).not.toMatch(
			/^(?:[A-Za-z]:)?\//,
		);
	});

	it("uses Windows system tar instead of a PATH-shadowing executable", () => {
		expect(ttsTarExecutable("win32", "D:\\Windows")).toBe(
			"D:\\Windows\\System32\\tar.exe",
		);
		expect(ttsTarExecutable("linux")).toBe("tar");
	});

	it("reports an explicit unconfigured neural model", async () => {
		const manager = new TtsModelManager(
			{
				...DEFAULT_VOICE_CONFIG,
				read_aloud_provider: "neural",
				tts_model: "kitten-nano-v0.8-int8",
			},
			{ dataDir: tempDirectory(), spawn: vi.fn() as never },
		);
		await manager.initialize();
		expect(manager.status()).toMatchObject({
			state: "unconfigured",
			model: "kitten-nano-v0.8-int8",
		});
		expect(manager.models()).toHaveLength(4);
		expect(manager.models()).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					id: "kitten-nano-v0.8-int8",
					installed: false,
					tier: "fast",
					voices: expect.arrayContaining([
						expect.objectContaining({ id: "expr-voice-2-f", speaker: 1 }),
					]),
				}),
				expect.objectContaining({
					id: "piper-kristin-medium-int8",
					tier: "fast",
					voices: [
						expect.objectContaining({ id: "piper-kristin", speaker: 0 }),
					],
				}),
			]),
		);
		manager.close();
	});

	it("keeps model and voice identifiers unique with one recommendation", () => {
		const modelIds = TTS_MODEL_DEFINITIONS.map((model) => model.id);
		const voiceIds = TTS_MODEL_DEFINITIONS.flatMap((model) =>
			model.voices.map((voice) => voice.id),
		);
		expect(new Set(modelIds).size).toBe(modelIds.length);
		expect(new Set(voiceIds).size).toBe(voiceIds.length);
		expect(
			TTS_MODEL_DEFINITIONS.filter((model) => model.recommended).map(
				(model) => model.id,
			),
		).toEqual(["kitten-nano-v0.8-int8"]);
		expect(TTS_MODEL_DEFINITIONS.every((model) => model.tier === "fast")).toBe(
			true,
		);
		expect(
			TTS_MODEL_DEFINITIONS.every(
				(model) =>
					model.requiredFiles.length > 0 &&
					model.voices.length > 0 &&
					/^[a-f0-9]{64}$/.test(model.archiveSha256),
			),
		).toBe(true);
	});

	it("rejects a runtime download that fails its checksum", async () => {
		const manager = new TtsModelManager(DEFAULT_VOICE_CONFIG, {
			dataDir: tempDirectory(),
			fetcher: vi.fn().mockResolvedValue(
				new Response("not the reviewed runtime", {
					headers: { "content-length": "24" },
				}),
			),
			spawn: vi.fn() as never,
		});
		await expect(manager.download("kitten-nano-v0.8-int8")).rejects.toThrow(
			"checksum mismatch",
		);
		expect(manager.status().error).toContain("checksum mismatch");
		manager.close();
	});
});
