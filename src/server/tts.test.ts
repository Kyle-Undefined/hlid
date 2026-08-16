import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_VOICE_CONFIG } from "../config";
import {
	relativeTtsArchivePath,
	TtsModelManager,
	TtsModelMismatchError,
	type TtsStatus,
	ttsArchiveExtractionArgs,
	ttsTarExecutable,
	validateTtsArchiveEntries,
} from "./tts";
import { TTS_MODEL_DEFINITIONS } from "./ttsModels";

const tempDirectories: string[] = [];

type MutableTtsManagerState = {
	config: typeof DEFAULT_VOICE_CONFIG;
	runtime: {
		process: { exitCode: number | null; kill: () => void };
		port: number;
		token: string;
		model: string;
		threads: number;
		version: string;
	} | null;
	loadGeneration: number;
	statusValue: TtsStatus;
};

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

	it("checks an expected model inside the serialized synthesis run", async () => {
		let resolveFirst: ((response: Response) => void) | undefined;
		const firstResponse = new Promise<Response>((resolve) => {
			resolveFirst = resolve;
		});
		const fetcher = vi.fn().mockReturnValue(firstResponse);
		const manager = new TtsModelManager(
			{
				...DEFAULT_VOICE_CONFIG,
				read_aloud_provider: "neural",
				tts_model: "kitten-nano-v0.8-int8",
			},
			{
				dataDir: tempDirectory(),
				fetcher,
				spawn: vi.fn() as never,
			},
		);
		const state = manager as unknown as MutableTtsManagerState;
		state.loadGeneration = 7;
		state.runtime = {
			process: { exitCode: null, kill: vi.fn() },
			port: 24_001,
			token: "old-token",
			model: "kitten-nano-v0.8-int8",
			threads: 2,
			version: "1.13.4",
		};
		state.statusValue = {
			state: "ready",
			model: "kitten-nano-v0.8-int8",
			loadedModel: "kitten-nano-v0.8-int8",
		};
		expect(manager.status().loadedModel).toBe("kitten-nano-v0.8-int8");

		const first = manager.synthesize("First.", "expr-voice-2-f", 1);
		await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
		const queued = manager.synthesize(
			"Second.",
			"expr-voice-2-f",
			1,
			"kitten-nano-v0.8-int8",
		);
		const queuedExpectation = expect(queued).rejects.toBeInstanceOf(
			TtsModelMismatchError,
		);
		state.loadGeneration = 8;
		state.runtime = {
			process: { exitCode: null, kill: vi.fn() },
			port: 24_002,
			token: "new-token",
			model: "piper-kristin-medium-int8",
			threads: 2,
			version: "1.13.4",
		};
		state.statusValue = {
			state: "ready",
			model: "piper-kristin-medium-int8",
			loadedModel: "piper-kristin-medium-int8",
		};
		resolveFirst?.(new Response("audio"));

		await expect(first).resolves.toMatchObject({
			audio: expect.any(Uint8Array),
		});
		await queuedExpectation;
		expect(fetcher).toHaveBeenCalledOnce();
		manager.close();
	});

	it("does not retry a pinned reading with a newly configured model", async () => {
		const fetcher = vi.fn().mockRejectedValue(new Error("runtime exited"));
		const manager = new TtsModelManager(
			{
				...DEFAULT_VOICE_CONFIG,
				read_aloud_provider: "neural",
				tts_model: "kitten-nano-v0.8-int8",
			},
			{
				dataDir: tempDirectory(),
				fetcher,
				spawn: vi.fn() as never,
			},
		);
		const state = manager as unknown as MutableTtsManagerState;
		state.runtime = {
			process: { exitCode: 1, kill: vi.fn() },
			port: 24_003,
			token: "stopped-token",
			model: "kitten-nano-v0.8-int8",
			threads: 2,
			version: "1.13.4",
		};
		state.statusValue = {
			state: "ready",
			model: "kitten-nano-v0.8-int8",
			loadedModel: "kitten-nano-v0.8-int8",
		};
		state.config = {
			...state.config,
			tts_model: "piper-kristin-medium-int8",
		};
		const load = vi.spyOn(manager, "load");

		await expect(
			manager.synthesize(
				"Do not switch models.",
				"expr-voice-2-f",
				1,
				"kitten-nano-v0.8-int8",
			),
		).rejects.toBeInstanceOf(TtsModelMismatchError);
		expect(fetcher).toHaveBeenCalledOnce();
		expect(load).not.toHaveBeenCalled();
		manager.close();
	});

	it("bases crash retry on the runtime that attempted the synthesis", async () => {
		let rejectFirst: ((error: Error) => void) | undefined;
		const firstResponse = new Promise<Response>((_resolve, reject) => {
			rejectFirst = reject;
		});
		const fetcher = vi
			.fn()
			.mockReturnValueOnce(firstResponse)
			.mockResolvedValueOnce(new Response("retried audio"));
		const manager = new TtsModelManager(
			{
				...DEFAULT_VOICE_CONFIG,
				read_aloud_provider: "neural",
				tts_model: "kitten-nano-v0.8-int8",
			},
			{
				dataDir: tempDirectory(),
				fetcher,
				spawn: vi.fn() as never,
			},
		);
		const state = manager as unknown as MutableTtsManagerState;
		const attemptedProcess = { exitCode: null as number | null, kill: vi.fn() };
		state.runtime = {
			process: attemptedProcess,
			port: 24_005,
			token: "attempted-token",
			model: "kitten-nano-v0.8-int8",
			threads: 2,
			version: "1.13.4",
		};
		state.statusValue = {
			state: "ready",
			model: "kitten-nano-v0.8-int8",
			loadedModel: "kitten-nano-v0.8-int8",
		};
		const load = vi.spyOn(manager, "load").mockResolvedValue();

		const synthesis = manager.synthesize(
			"Retry on the pinned model.",
			"expr-voice-2-f",
			1,
			"kitten-nano-v0.8-int8",
		);
		await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
		attemptedProcess.exitCode = 1;
		state.runtime = {
			process: { exitCode: null, kill: vi.fn() },
			port: 24_006,
			token: "replacement-token",
			model: "kitten-nano-v0.8-int8",
			threads: 2,
			version: "1.13.4",
		};
		rejectFirst?.(new Error("attempted runtime exited"));

		await expect(synthesis).resolves.toMatchObject({
			audio: expect.any(Uint8Array),
		});
		expect(load).toHaveBeenCalledWith("kitten-nano-v0.8-int8");
		expect(fetcher).toHaveBeenCalledTimes(2);
		manager.close();
	});

	it("keeps stale voice fallback deterministic within the pinned model", async () => {
		const fetcher = vi.fn().mockResolvedValue(new Response("audio"));
		const manager = new TtsModelManager(
			{
				...DEFAULT_VOICE_CONFIG,
				read_aloud_provider: "neural",
				tts_model: "kitten-nano-v0.8-int8",
			},
			{
				dataDir: tempDirectory(),
				fetcher,
				spawn: vi.fn() as never,
			},
		);
		const state = manager as unknown as MutableTtsManagerState;
		state.runtime = {
			process: { exitCode: null, kill: vi.fn() },
			port: 24_004,
			token: "ready-token",
			model: "kitten-nano-v0.8-int8",
			threads: 2,
			version: "1.13.4",
		};
		state.statusValue = {
			state: "ready",
			model: "kitten-nano-v0.8-int8",
			loadedModel: "kitten-nano-v0.8-int8",
		};

		await manager.synthesize(
			"Use the model fallback.",
			"removed-voice-id",
			1,
			"kitten-nano-v0.8-int8",
		);

		const requestInit = fetcher.mock.calls[0]?.[1] as RequestInit | undefined;
		expect(JSON.parse(String(requestInit?.body))).toMatchObject({ speaker: 0 });
		manager.close();
	});
});
