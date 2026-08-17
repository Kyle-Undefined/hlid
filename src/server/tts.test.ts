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
		backend: "cpu" | "directml";
	} | null;
	loadGeneration: number;
	statusValue: TtsStatus;
	directMlFailureReasons: Map<string, string>;
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
		expect(manager.models()).toHaveLength(8);
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
					backends: ["cpu"],
					tier: "fast",
					voices: [
						expect.objectContaining({ id: "piper-kristin", speaker: 0 }),
					],
				}),
				expect.objectContaining({
					id: "piper-norman-medium-int8",
					backends: ["cpu"],
					tier: "fast",
					voices: [expect.objectContaining({ id: "piper-norman", speaker: 0 })],
				}),
			]),
		);
		expect(
			manager.models().find((model) => model.id === "piper-cori-medium-int8"),
		).toMatchObject({ backends: ["cpu"] });
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
		expect(
			TTS_MODEL_DEFINITIONS.filter((model) => model.tier === "quality"),
		).toEqual([
			expect.objectContaining({
				id: "piper-libritts-high-int8",
				voices: [
					expect.objectContaining({
						id: "piper-libritts-p6701",
						speaker: 3,
					}),
					expect.objectContaining({
						id: "piper-libritts-p922",
						speaker: 5,
					}),
					expect.objectContaining({
						id: "piper-libritts-p3922",
						speaker: 0,
					}),
					expect.objectContaining({
						id: "piper-libritts-p8152",
						speaker: 132,
					}),
					expect.objectContaining({
						id: "piper-libritts-p2085",
						speaker: 903,
					}),
				],
			}),
			expect.objectContaining({
				id: "melo-english",
				sizeBytes: 162_758_237,
				archiveName: "vits-melo-tts-en.tar.bz2",
				archiveSha256:
					"f87bc5752ea3ec34273a2cc0c5086854c18b6b89dfd0534b5248e86a14cedb5d",
				extractedDirectory: "vits-melo-tts-en",
				requiredFiles: [
					"model.onnx",
					"tokens.txt",
					"lexicon.txt",
					"README.md",
					"LICENSE",
				],
				license: expect.stringMatching(
					/publisher-declared MIT.+lineage undisclosed/i,
				),
				voices: [
					expect.objectContaining({
						id: "melo-english-american",
						language: "en-US",
						speaker: 0,
					}),
					expect.objectContaining({
						id: "melo-english-british",
						language: "en-GB",
						speaker: 1,
					}),
					expect.objectContaining({
						id: "melo-english-indian",
						language: "en-IN",
						speaker: 2,
					}),
					expect.objectContaining({
						id: "melo-english-australian",
						language: "en-AU",
						speaker: 3,
					}),
					expect.objectContaining({
						id: "melo-english-default",
						label: expect.stringMatching(/default.+unspecified/i),
						language: "en",
						speaker: 4,
					}),
				],
				runtime: expect.objectContaining({
					lexicon: "lexicon.txt",
					noiseScale: 0.6,
					noiseScaleW: 0.8,
				}),
			}),
		]);
		expect(
			TTS_MODEL_DEFINITIONS.find((model) => model.id === "melo-english")
				?.runtime,
		).not.toHaveProperty("dataDir");
		expect(
			TTS_MODEL_DEFINITIONS.find(
				(model) => model.id === "piper-norman-medium-int8",
			),
		).toMatchObject({
			sizeBytes: 20_987_233,
			license: expect.stringMatching(
				/Piper repository MIT.+public-domain LibriVox training data/,
			),
			qualifiedBackends: ["cpu", "directml"],
			archiveName: "vits-piper-en_US-norman-medium-int8.tar.bz2",
			archiveSha256:
				"cb481a514bc213ccf3899391c0f27fdcc4e4b814ec30496f28089a027b5aa01b",
			extractedDirectory: "vits-piper-en_US-norman-medium-int8",
			requiredFiles: expect.arrayContaining([
				"en_US-norman-medium.onnx",
				"en_US-norman-medium.onnx.json",
				"tokens.txt",
				"espeak-ng-data/phondata",
				"MODEL_CARD",
			]),
			runtime: {
				model: "en_US-norman-medium.onnx",
				tokens: "tokens.txt",
				dataDir: "espeak-ng-data",
			},
			voices: [expect.objectContaining({ id: "piper-norman", speaker: 0 })],
		});
		expect(
			TTS_MODEL_DEFINITIONS.every(
				(model) =>
					model.requiredFiles.length > 0 &&
					model.voices.length > 0 &&
					model.archiveMaxBytes >= model.sizeBytes &&
					/^[a-f0-9]{64}$/.test(model.archiveSha256),
			),
		).toBe(true);
		expect(
			TTS_MODEL_DEFINITIONS.filter((model) =>
				model.qualifiedBackends.includes("directml"),
			).map((model) => model.id),
		).toEqual([
			"piper-kristin-medium-int8",
			"piper-bryce-medium-int8",
			"piper-norman-medium-int8",
			"piper-cori-medium-int8",
			"piper-ljspeech-high-int8",
			"piper-libritts-high-int8",
			"melo-english",
		]);
	});

	it("exposes qualified acceleration only with verified runtime assets", () => {
		const manager = new TtsModelManager(DEFAULT_VOICE_CONFIG, {
			dataDir: tempDirectory(),
			spawn: vi.fn() as never,
			runtimeAssets: {
				directory: "/reviewed/tts-directml",
				addonPath: "/reviewed/tts-directml/sherpa-onnx.node",
				backends: ["directml"],
			},
		});

		expect(
			manager.models().find((model) => model.id === "piper-cori-medium-int8"),
		).toMatchObject({ backends: ["cpu", "directml"] });
		expect(
			manager
				.models()
				.find((model) => model.id === "piper-kristin-medium-int8"),
		).toMatchObject({ backends: ["cpu", "directml"] });
		expect(
			manager.models().find((model) => model.id === "piper-norman-medium-int8"),
		).toMatchObject({ backends: ["cpu", "directml"] });
		expect(
			manager.models().find((model) => model.id === "kitten-nano-v0.8-int8"),
		).toMatchObject({ backends: ["cpu"] });
		manager.close();
	});

	it("allows an explicit auto toggle to retry DirectML for the selected model", async () => {
		const manager = new TtsModelManager(
			{ ...DEFAULT_VOICE_CONFIG, tts_acceleration: "cpu" },
			{ dataDir: tempDirectory(), spawn: vi.fn() as never },
		);
		const state = manager as unknown as MutableTtsManagerState;
		state.directMlFailureReasons.set(
			"piper-cori-medium-int8",
			"DirectML synthesis failed",
		);
		state.directMlFailureReasons.set(
			"another-model",
			"DirectML initialization failed",
		);

		await manager.syncConfig({
			...DEFAULT_VOICE_CONFIG,
			tts_model: "piper-cori-medium-int8",
			tts_acceleration: "auto",
		});

		expect(state.directMlFailureReasons.has("piper-cori-medium-int8")).toBe(
			false,
		);
		expect(state.directMlFailureReasons.has("another-model")).toBe(true);
		manager.close();
	});

	it("retains the DirectML fallback reason across later automatic CPU reloads", async () => {
		const manager = new TtsModelManager(
			{
				...DEFAULT_VOICE_CONFIG,
				read_aloud_provider: "neural",
				tts_model: "piper-cori-medium-int8",
				tts_acceleration: "auto",
			},
			{ dataDir: tempDirectory(), spawn: vi.fn() as never },
		);
		const state = manager as unknown as MutableTtsManagerState;
		state.directMlFailureReasons.set(
			"piper-cori-medium-int8",
			"DirectML synthesis failed: corrupt output",
		);
		const nextProcess = { exitCode: null, kill: vi.fn() };
		const startRuntime = vi.fn().mockResolvedValue({
			process: nextProcess,
			port: 24_013,
			token: "cpu-token",
			model: "piper-cori-medium-int8",
			threads: 4,
			version: "1.13.4",
			backend: "cpu" as const,
		});
		(
			manager as unknown as {
				startRuntime: typeof startRuntime;
			}
		).startRuntime = startRuntime;

		await manager.load("piper-cori-medium-int8");

		expect(startRuntime).toHaveBeenCalledWith(
			"piper-cori-medium-int8",
			expect.any(Number),
			"cpu",
		);
		expect(manager.status()).toMatchObject({
			state: "ready",
			backend: "cpu",
			fallbackReason: "DirectML synthesis failed: corrupt output",
		});
		manager.close();
	});

	it("retains a healthy CPU runtime when an auto DirectML reload fails", async () => {
		const manager = new TtsModelManager(
			{
				...DEFAULT_VOICE_CONFIG,
				read_aloud_provider: "neural",
				tts_model: "piper-cori-medium-int8",
				tts_acceleration: "auto",
			},
			{ dataDir: tempDirectory(), spawn: vi.fn() as never },
		);
		const state = manager as unknown as MutableTtsManagerState;
		const process = { exitCode: null, kill: vi.fn() };
		state.runtime = {
			process,
			port: 24_009,
			token: "healthy-cpu-token",
			model: "piper-cori-medium-int8",
			threads: 2,
			version: "1.13.4",
			backend: "cpu",
		};
		state.statusValue = {
			state: "ready",
			model: "piper-cori-medium-int8",
			loadedModel: "piper-cori-medium-int8",
			backend: "cpu",
		};

		await manager.load("piper-cori-medium-int8", "directml");

		expect(state.runtime?.process).toBe(process);
		expect(process.kill).not.toHaveBeenCalled();
		expect(manager.status()).toMatchObject({
			state: "ready",
			backend: "cpu",
			error: expect.any(String),
		});
		manager.close();
	});

	it("discards a DirectML runtime when CPU is explicitly required", async () => {
		const manager = new TtsModelManager(
			{
				...DEFAULT_VOICE_CONFIG,
				read_aloud_provider: "neural",
				tts_model: "piper-cori-medium-int8",
				tts_acceleration: "cpu",
			},
			{ dataDir: tempDirectory(), spawn: vi.fn() as never },
		);
		const state = manager as unknown as MutableTtsManagerState;
		const process = { exitCode: null, kill: vi.fn() };
		state.runtime = {
			process,
			port: 24_010,
			token: "directml-token",
			model: "piper-cori-medium-int8",
			threads: 2,
			version: "1.13.4",
			backend: "directml",
		};
		state.statusValue = {
			state: "ready",
			model: "piper-cori-medium-int8",
			loadedModel: "piper-cori-medium-int8",
			backend: "directml",
		};

		await manager.load("piper-cori-medium-int8", "cpu");

		expect(process.kill).toHaveBeenCalledOnce();
		expect(state.runtime).toBeNull();
		expect(manager.status().state).toBe("error");
		manager.close();
	});

	it("passes DirectML explicitly and rejects an untruthful runtime status", async () => {
		const child = { exitCode: null, kill: vi.fn(), stderr: null };
		const spawn = vi.fn(
			(_command: string[], _options?: { env?: Record<string, string> }) =>
				child,
		);
		const fetcher = vi
			.fn()
			.mockResolvedValueOnce(
				Response.json({ version: "1.13.4", backend: "directml" }),
			)
			.mockResolvedValueOnce(
				Response.json({ version: "1.13.4", backend: "cpu" }),
			);
		const manager = new TtsModelManager(DEFAULT_VOICE_CONFIG, {
			dataDir: tempDirectory(),
			fetcher,
			spawn: spawn as never,
			runtimeCommand: (args) => [...args],
		});
		const internals = manager as unknown as {
			loadGeneration: number;
			runtimeLocation: () => { directory: string; addonPath: string };
			installedModelDir: () => string;
			startRuntime: (
				model: string,
				generation: number,
				backend: "cpu" | "directml",
			) => Promise<{ backend: "cpu" | "directml" }>;
		};
		internals.loadGeneration = 3;
		internals.runtimeLocation = () => ({
			directory: "/reviewed/tts-directml",
			addonPath: "/reviewed/tts-directml/sherpa-onnx.node",
		});
		internals.installedModelDir = () => "/models/cori";

		await expect(
			internals.startRuntime("piper-cori-medium-int8", 3, "directml"),
		).resolves.toMatchObject({ backend: "directml" });
		const command = spawn.mock.calls[0]?.[0] as string[];
		expect(command).toContain("--backend");
		expect(command.at(command.indexOf("--backend") + 1)).toBe("directml");
		const spawnOptions = spawn.mock.calls[0]?.[1] as
			| { env?: Record<string, string> }
			| undefined;
		expect(spawnOptions?.env?.HLID_SKIP_SELF_INSTALL).toBe("1");

		await expect(
			internals.startRuntime("piper-cori-medium-int8", 3, "directml"),
		).rejects.toThrow("backend mismatch");
		expect(child.kill).toHaveBeenCalledOnce();
		manager.close();
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
			backend: "cpu",
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
			backend: "cpu",
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
			backend: "cpu",
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
			backend: "cpu",
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
			backend: "cpu",
		};
		rejectFirst?.(new Error("attempted runtime exited"));

		await expect(synthesis).resolves.toMatchObject({
			audio: expect.any(Uint8Array),
		});
		expect(load).toHaveBeenCalledWith("kitten-nano-v0.8-int8", "cpu");
		expect(fetcher).toHaveBeenCalledTimes(2);
		manager.close();
	});

	it("falls back once to CPU when DirectML synthesis fails", async () => {
		const fetcher = vi
			.fn()
			.mockResolvedValueOnce(
				Response.json(
					{ error: "TTS generated non-finite audio" },
					{ status: 503 },
				),
			)
			.mockResolvedValueOnce(new Response("cpu audio"));
		const manager = new TtsModelManager(
			{
				...DEFAULT_VOICE_CONFIG,
				read_aloud_provider: "neural",
				tts_model: "piper-cori-medium-int8",
			},
			{ dataDir: tempDirectory(), fetcher, spawn: vi.fn() as never },
		);
		const state = manager as unknown as MutableTtsManagerState;
		const directMlProcess = { exitCode: null, kill: vi.fn() };
		state.runtime = {
			process: directMlProcess,
			port: 24_007,
			token: "directml-token",
			model: "piper-cori-medium-int8",
			threads: 2,
			version: "1.13.4",
			backend: "directml",
		};
		state.statusValue = {
			state: "ready",
			model: "piper-cori-medium-int8",
			loadedModel: "piper-cori-medium-int8",
			backend: "directml",
		};
		const load = vi
			.spyOn(manager, "load")
			.mockImplementation(async (_model, backend) => {
				state.runtime = {
					process: { exitCode: null, kill: vi.fn() },
					port: 24_008,
					token: "cpu-token",
					model: "piper-cori-medium-int8",
					threads: 2,
					version: "1.13.4",
					backend: backend ?? "cpu",
				};
				state.statusValue = {
					state: "ready",
					model: "piper-cori-medium-int8",
					loadedModel: "piper-cori-medium-int8",
					backend: backend ?? "cpu",
				};
			});

		await expect(
			manager.synthesize("Use the safe fallback.", "piper-cori", 1),
		).resolves.toMatchObject({ audio: expect.any(Uint8Array) });
		expect(load).toHaveBeenCalledOnce();
		expect(load).toHaveBeenCalledWith("piper-cori-medium-int8", "cpu");
		expect(fetcher).toHaveBeenCalledTimes(2);
		expect(directMlProcess.kill).toHaveBeenCalledOnce();
		expect(manager.status()).toMatchObject({
			backend: "cpu",
			fallbackReason: expect.stringContaining("DirectML synthesis failed"),
		});
		manager.close();
	});

	it("does not restart CPU after closing during DirectML synthesis", async () => {
		let rejectSynthesis: ((error: Error) => void) | undefined;
		const response = new Promise<Response>((_resolve, reject) => {
			rejectSynthesis = reject;
		});
		const fetcher = vi.fn().mockReturnValue(response);
		const manager = new TtsModelManager(
			{
				...DEFAULT_VOICE_CONFIG,
				read_aloud_provider: "neural",
				tts_model: "piper-cori-medium-int8",
			},
			{ dataDir: tempDirectory(), fetcher, spawn: vi.fn() as never },
		);
		const state = manager as unknown as MutableTtsManagerState;
		const directMlProcess = { exitCode: null, kill: vi.fn() };
		state.runtime = {
			process: directMlProcess,
			port: 24_011,
			token: "directml-token",
			model: "piper-cori-medium-int8",
			threads: 2,
			version: "1.13.4",
			backend: "directml",
		};
		state.statusValue = {
			state: "ready",
			model: "piper-cori-medium-int8",
			loadedModel: "piper-cori-medium-int8",
			backend: "directml",
		};
		const load = vi.spyOn(manager, "load");

		const synthesis = manager.synthesize(
			"Do not restart after shutdown.",
			"piper-cori",
			1,
		);
		const rejected = expect(synthesis).rejects.toThrow("request was closed");
		await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
		manager.close();
		rejectSynthesis?.(new Error("request was closed"));

		await rejected;
		expect(load).not.toHaveBeenCalled();
		expect(directMlProcess.kill).toHaveBeenCalledOnce();
		expect(state.runtime).toBeNull();
	});

	it("releases cancelled buffered synthesis without triggering fallback", async () => {
		const fetcher = vi.fn(
			(_input: string | URL | Request, init?: RequestInit) => {
				const body = JSON.parse(String(init?.body)) as { text?: string };
				if (body.text === "Fresh request.") {
					return Promise.resolve(new Response("fresh audio"));
				}
				return new Promise<Response>((_resolve, reject) => {
					const signal = init?.signal;
					if (!signal) {
						reject(new Error("missing synthesis signal"));
						return;
					}
					if (signal.aborted) {
						reject(signal.reason);
						return;
					}
					signal.addEventListener("abort", () => reject(signal.reason), {
						once: true,
					});
				});
			},
		);
		const manager = new TtsModelManager(
			{
				...DEFAULT_VOICE_CONFIG,
				read_aloud_provider: "neural",
				tts_model: "piper-cori-medium-int8",
			},
			{ dataDir: tempDirectory(), fetcher, spawn: vi.fn() as never },
		);
		const state = manager as unknown as MutableTtsManagerState & {
			pendingSynthesis: number;
		};
		const directMlProcess = { exitCode: null, kill: vi.fn() };
		state.runtime = {
			process: directMlProcess,
			port: 24_012,
			token: "directml-token",
			model: "piper-cori-medium-int8",
			threads: 2,
			version: "1.13.4",
			backend: "directml",
		};
		state.statusValue = {
			state: "ready",
			model: "piper-cori-medium-int8",
			loadedModel: "piper-cori-medium-int8",
			backend: "directml",
		};
		const load = vi.spyOn(manager, "load");
		const firstAbort = new AbortController();
		const secondAbort = new AbortController();

		const first = manager.synthesize(
			"First buffered request.",
			"piper-cori",
			1,
			undefined,
			firstAbort.signal,
		);
		const second = manager.synthesize(
			"Second buffered request.",
			"piper-cori",
			1,
			undefined,
			secondAbort.signal,
		);
		await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
		firstAbort.abort();
		secondAbort.abort();
		await expect(first).rejects.toMatchObject({ name: "AbortError" });
		await expect(second).rejects.toMatchObject({ name: "AbortError" });

		await expect(
			manager.synthesize("Fresh request.", "piper-cori", 1),
		).resolves.toMatchObject({ audio: expect.any(Uint8Array) });
		expect(state.pendingSynthesis).toBe(0);
		expect(load).not.toHaveBeenCalled();
		expect(directMlProcess.kill).not.toHaveBeenCalled();
		expect(manager.status()).toMatchObject({ backend: "directml" });
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
			backend: "cpu",
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

	it("maps curated LibriTTS voices to their qualified speaker IDs", async () => {
		const fetcher = vi
			.fn()
			.mockImplementation(async () => new Response("audio"));
		const manager = new TtsModelManager(
			{
				...DEFAULT_VOICE_CONFIG,
				read_aloud_provider: "neural",
				tts_model: "piper-libritts-high-int8",
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
			port: 24_005,
			token: "ready-token",
			model: "piper-libritts-high-int8",
			threads: 2,
			version: "1.13.4",
			backend: "cpu",
		};
		state.statusValue = {
			state: "ready",
			model: "piper-libritts-high-int8",
			loadedModel: "piper-libritts-high-int8",
		};

		const expectedVoices = [
			{ id: "piper-libritts-p6701", speaker: 3 },
			{ id: "piper-libritts-p922", speaker: 5 },
			{ id: "piper-libritts-p3922", speaker: 0 },
			{ id: "piper-libritts-p8152", speaker: 132 },
			{ id: "piper-libritts-p2085", speaker: 903 },
		];
		expect(
			manager.models().find((model) => model.id === "piper-libritts-high-int8")
				?.voices,
		).toEqual(expectedVoices.map((voice) => expect.objectContaining(voice)));
		expect(
			manager.models().find((model) => model.id === "piper-libritts-high-int8")
				?.voices,
		).not.toEqual(
			expect.arrayContaining([
				expect.objectContaining({ id: "piper-libritts-p711" }),
			]),
		);

		for (const voice of expectedVoices) {
			await manager.synthesize(
				"Use the selected curated voice.",
				voice.id,
				1,
				"piper-libritts-high-int8",
			);
		}

		expect(
			fetcher.mock.calls.map((call) => {
				const requestInit = call[1] as RequestInit | undefined;
				return JSON.parse(String(requestInit?.body)).speaker;
			}),
		).toEqual(expectedVoices.map((voice) => voice.speaker));
		manager.close();
	});

	it("maps every official MeloTTS voice to its speaker ID", async () => {
		const fetcher = vi
			.fn()
			.mockImplementation(async () => new Response("audio"));
		const manager = new TtsModelManager(
			{
				...DEFAULT_VOICE_CONFIG,
				read_aloud_provider: "neural",
				tts_model: "melo-english",
			},
			{
				dataDir: tempDirectory(),
				fetcher,
				spawn: vi.fn() as never,
			},
		);
		const model = manager.models().find((item) => item.id === "melo-english");
		const expectedVoices = [
			{
				id: "melo-english-american",
				label: "MeloTTS American English",
				language: "en-US",
				speaker: 0,
			},
			{
				id: "melo-english-british",
				label: "MeloTTS British English",
				language: "en-GB",
				speaker: 1,
			},
			{
				id: "melo-english-indian",
				label: "MeloTTS Indian English",
				language: "en-IN",
				speaker: 2,
			},
			{
				id: "melo-english-australian",
				label: "MeloTTS Australian English",
				language: "en-AU",
				speaker: 3,
			},
			{
				id: "melo-english-default",
				label: "MeloTTS Default English · unspecified",
				language: "en",
				speaker: 4,
			},
		];
		expect(model?.voices).toEqual(expectedVoices);
		const state = manager as unknown as MutableTtsManagerState;
		state.runtime = {
			process: { exitCode: null, kill: vi.fn() },
			port: 24_006,
			token: "ready-token",
			model: "melo-english",
			threads: 2,
			version: "1.13.4",
			backend: "cpu",
		};
		state.statusValue = {
			state: "ready",
			model: "melo-english",
			loadedModel: "melo-english",
		};

		for (const [index, voice] of expectedVoices.entries()) {
			await manager.synthesize(
				`Use MeloTTS speaker ${voice.speaker}.`,
				voice.id,
				1,
				"melo-english",
			);
			const requestInit = fetcher.mock.calls[index]?.[1] as
				| RequestInit
				| undefined;
			expect(JSON.parse(String(requestInit?.body))).toMatchObject({
				speaker: voice.speaker,
			});
		}
		manager.close();
	});
});
