import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_VOICE_CONFIG } from "../config";
import {
	VoiceModelManager,
	validateVoiceRecording,
	voiceVocabularyPrompt,
} from "./voice";

function wavBlob(payloadBytes: number, bytesPerSecond = 16_000): Blob {
	const bytes = new Uint8Array(44 + payloadBytes);
	const view = new DataView(bytes.buffer);
	view.setUint32(0, 0x52494646, false);
	view.setUint32(8, 0x57415645, false);
	view.setUint32(28, bytesPerSecond, true);
	return new Blob([bytes], { type: "audio/wav" });
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

function fakeProcess() {
	return {
		exitCode: null,
		kill: vi.fn(),
	};
}

describe("VoiceModelManager", () => {
	it("builds a bounded, de-duplicated vocabulary prompt", () => {
		expect(
			voiceVocabularyPrompt([" Claude ", "Codex", "claude", "", "Hlið"]),
		).toBe("Claude, Codex, Hlið");
		expect(voiceVocabularyPrompt(Array(20).fill("x".repeat(80))).length).toBe(
			80,
		);
		expect(
			voiceVocabularyPrompt(
				Array.from({ length: 20 }, (_, index) => `${index}-${"x".repeat(75)}`),
			).length,
		).toBeLessThanOrEqual(800);
	});

	it("stays disabled without affecting server startup", async () => {
		const manager = new VoiceModelManager(DEFAULT_VOICE_CONFIG, null);
		await manager.initialize();
		expect(manager.status()).toEqual({ state: "disabled", model: "" });
	});

	it("reports setup required when enabled without a selected model", async () => {
		const manager = new VoiceModelManager(
			{ ...DEFAULT_VOICE_CONFIG, enabled: true },
			null,
		);
		await manager.initialize();
		expect(manager.status().state).toBe("unconfigured");
	});

	it("catalog exposes the curated recommended model", async () => {
		vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error("offline"));
		const manager = new VoiceModelManager(DEFAULT_VOICE_CONFIG, null);
		const models = await manager.models();
		expect(models.find((model) => model.id === "base")?.recommended).toBe(true);
		expect(
			models.every((model) => model.downloadUrl.startsWith("https://")),
		).toBe(true);
	});

	it("rejects delete and load operations outside the reviewed model manifest", async () => {
		const manager = new VoiceModelManager(DEFAULT_VOICE_CONFIG, null);
		expect(() => manager.deleteModel("x/../../../../target")).toThrow(
			"unknown voice model",
		);
		await expect(manager.load("x/../../../../target")).rejects.toThrow(
			"unknown voice model",
		);
	});
});

describe("validateVoiceRecording", () => {
	it("accepts a structurally valid recording within the duration limit", async () => {
		await expect(validateVoiceRecording(wavBlob(160_000), 10)).resolves.toBe(
			undefined,
		);
	});

	it.each([
		["a truncated header", new Blob([new Uint8Array(20)])],
		["a non-WAV header", new Blob([new Uint8Array(44)])],
	])("rejects %s", async (_label, audio) => {
		await expect(validateVoiceRecording(audio, 10)).rejects.toThrow(
			"audio must be a WAV recording",
		);
	});

	it("rejects a zero byte rate before calculating duration", async () => {
		await expect(validateVoiceRecording(wavBlob(1, 0), 10)).rejects.toThrow(
			"invalid WAV byte rate",
		);
	});

	it("allows the one-second encoding tolerance and rejects beyond it", async () => {
		await expect(validateVoiceRecording(wavBlob(176_000), 10)).resolves.toBe(
			undefined,
		);
		await expect(validateVoiceRecording(wavBlob(176_001), 10)).rejects.toThrow(
			"recording exceeds 10 second limit",
		);
	});
});

describe.sequential("VoiceModelManager load lifecycle", () => {
	let dataHome: string;
	let executable: string;

	function startPendingLoad() {
		const health = deferred<Response>();
		const process = fakeProcess();
		const spawn = vi.fn().mockReturnValue(process);
		vi.stubGlobal("Bun", {
			spawn,
			sleep: vi.fn().mockResolvedValue(undefined),
		});
		vi.spyOn(globalThis, "fetch").mockReturnValue(health.promise);
		const manager = new VoiceModelManager(
			{ ...DEFAULT_VOICE_CONFIG, enabled: true, model: "tiny" },
			executable,
		);
		return { health, loading: manager.load("tiny"), manager, process, spawn };
	}

	async function readyManager() {
		const process = fakeProcess();
		const spawn = vi.fn().mockReturnValue(process);
		vi.stubGlobal("Bun", {
			spawn,
			sleep: vi.fn().mockResolvedValue(undefined),
		});
		vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
			new Response(null, { status: 200 }),
		);
		const manager = new VoiceModelManager(
			{ ...DEFAULT_VOICE_CONFIG, enabled: true, model: "tiny" },
			executable,
		);
		await manager.load("tiny");
		return { manager, process, spawn };
	}

	beforeEach(() => {
		dataHome = mkdtempSync(join(tmpdir(), "hlid-voice-"));
		vi.stubEnv("XDG_DATA_HOME", dataHome);
		const models = join(dataHome, "hlid", "voice", "models");
		mkdirSync(models, { recursive: true });
		writeFileSync(join(models, "ggml-tiny.bin"), "tiny");
		writeFileSync(join(models, "ggml-base.bin"), "base");
		executable = join(dataHome, "whisper-server.exe");
		writeFileSync(executable, "runtime");
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		vi.unstubAllEnvs();
		vi.restoreAllMocks();
		rmSync(dataHome, { recursive: true, force: true });
	});

	it("keeps the newer model when an older health check completes last", async () => {
		const tinyHealth = deferred<Response>();
		const baseHealth = deferred<Response>();
		const tinyProcess = fakeProcess();
		const baseProcess = fakeProcess();
		const spawn = vi
			.fn()
			.mockReturnValueOnce(tinyProcess)
			.mockReturnValueOnce(baseProcess);
		vi.stubGlobal("Bun", {
			spawn,
			sleep: vi.fn().mockResolvedValue(undefined),
		});
		vi.spyOn(Math, "random").mockReturnValueOnce(0).mockReturnValueOnce(0.5);
		vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
			const url = String(input);
			if (url === "http://127.0.0.1:18000/") return tinyHealth.promise;
			if (url === "http://127.0.0.1:20000/") return baseHealth.promise;
			throw new Error(`unexpected fetch: ${url}`);
		});

		const manager = new VoiceModelManager(
			{ ...DEFAULT_VOICE_CONFIG, enabled: true, model: "tiny" },
			executable,
		);
		const loadingTiny = manager.load("tiny");
		await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(1));
		const loadingBase = manager.syncConfig({
			...DEFAULT_VOICE_CONFIG,
			enabled: true,
			model: "base",
		});
		await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(2));

		baseHealth.resolve(new Response(null, { status: 200 }));
		await loadingBase;
		tinyHealth.resolve(new Response(null, { status: 200 }));
		await loadingTiny;

		expect(manager.status()).toEqual({
			state: "ready",
			model: "base",
			loadedModel: "base",
		});
		expect(tinyProcess.kill).toHaveBeenCalled();
		expect(baseProcess.kill).not.toHaveBeenCalled();
		manager.close();
	});

	it("keeps a healthy model active when its replacement fails", async () => {
		const tinyProcess = fakeProcess();
		const failedBaseProcess = { ...fakeProcess(), exitCode: 17 };
		const spawn = vi
			.fn()
			.mockReturnValueOnce(tinyProcess)
			.mockReturnValueOnce(failedBaseProcess);
		vi.stubGlobal("Bun", {
			spawn,
			sleep: vi.fn().mockResolvedValue(undefined),
		});
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(null, { status: 200 }),
		);
		const manager = new VoiceModelManager(
			{ ...DEFAULT_VOICE_CONFIG, enabled: true, model: "tiny" },
			executable,
		);

		await manager.load("tiny");
		await manager.syncConfig({
			...DEFAULT_VOICE_CONFIG,
			enabled: true,
			model: "base",
		});

		expect(manager.status()).toEqual({
			state: "ready",
			model: "base",
			loadedModel: "tiny",
			error: "runtime exited with code 17",
		});
		expect(tinyProcess.kill).not.toHaveBeenCalled();
		expect(failedBaseProcess.kill).toHaveBeenCalled();
		manager.close();
	});

	it("passes configured threads to the runtime and reloads when they change", async () => {
		const { manager, spawn } = await readyManager();
		expect(spawn.mock.calls[0]?.[0]).toEqual(
			expect.arrayContaining(["--threads", "4"]),
		);
		const load = vi.spyOn(manager, "load").mockResolvedValue(undefined);
		await manager.syncConfig({
			...DEFAULT_VOICE_CONFIG,
			enabled: true,
			model: "tiny",
			threads: 8,
		});
		expect(load).toHaveBeenCalledWith("tiny");
		manager.close();
	});

	it("kills an in-flight load and cannot resurrect it after disable", async () => {
		const { health, loading, manager, process, spawn } = startPendingLoad();
		await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce());
		await manager.syncConfig({
			...DEFAULT_VOICE_CONFIG,
			enabled: false,
			model: "tiny",
		});

		expect(process.kill).toHaveBeenCalled();
		health.resolve(new Response(null, { status: 200 }));
		await loading;
		expect(manager.status()).toEqual({ state: "disabled", model: "tiny" });
	});

	it("kills an in-flight load and cannot resurrect it after close", async () => {
		const { health, loading, manager, process, spawn } = startPendingLoad();
		await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce());
		manager.close();

		expect(process.kill).toHaveBeenCalled();
		health.resolve(new Response(null, { status: 200 }));
		await loading;
		expect(manager.status().state).not.toBe("ready");
	});

	it("removes a partial model and resets download state after checksum failure", async () => {
		vi.spyOn(globalThis, "fetch").mockImplementation(
			async () =>
				new Response("not the reviewed model", {
					status: 200,
					headers: { "content-length": "22" },
				}),
		);
		const manager = new VoiceModelManager(DEFAULT_VOICE_CONFIG, null);
		const partial = join(
			dataHome,
			"hlid",
			"voice",
			"models",
			"ggml-tiny.bin.part",
		);

		await expect(manager.download("tiny")).rejects.toThrow(
			"model checksum mismatch",
		);
		expect(existsSync(partial)).toBe(false);
		expect(manager.status().download).toBeUndefined();
		expect(manager.status().error).toBe("model checksum mismatch");
		await expect(manager.download("tiny")).rejects.toThrow(
			"model checksum mismatch",
		);
	});

	it("cancels an active download, cleans up, and permits a later attempt", async () => {
		const fetchMock = vi
			.spyOn(globalThis, "fetch")
			.mockImplementationOnce((_input, init) => {
				return new Promise<Response>((_resolve, reject) => {
					init?.signal?.addEventListener("abort", () =>
						reject(new DOMException("cancelled", "AbortError")),
					);
				});
			})
			.mockResolvedValueOnce(new Response("still invalid", { status: 200 }));
		const manager = new VoiceModelManager(DEFAULT_VOICE_CONFIG, null);
		const active = manager.download("tiny");

		await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
		await expect(manager.download("base")).rejects.toThrow(
			"another model download is active",
		);
		manager.cancelDownload();
		await expect(active).rejects.toThrow("cancelled");
		expect(manager.status().download).toBeUndefined();
		await expect(manager.download("tiny")).rejects.toThrow(
			"model checksum mismatch",
		);
	});

	it("serializes transcription, enforces the queue limit, and recovers from failure", async () => {
		const { manager } = await readyManager();
		const firstResponse = deferred<Response>();
		const fetchMock = vi.mocked(globalThis.fetch);
		fetchMock.mockReset();
		fetchMock
			.mockReturnValueOnce(firstResponse.promise)
			.mockResolvedValueOnce(
				new Response("runtime unavailable", { status: 503 }),
			)
			.mockResolvedValueOnce(
				Response.json({ text: "  recovered text  ", language: "en" }),
			);

		const first = manager.transcribe(wavBlob(16_000), "auto");
		const second = manager.transcribe(wavBlob(16_000), "en");
		await expect(manager.transcribe(wavBlob(16_000), "auto")).rejects.toThrow(
			"voice transcription queue is full",
		);
		await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());

		firstResponse.resolve(Response.json({ text: " first " }));
		await expect(first).resolves.toMatchObject({ text: "first" });
		await expect(second).rejects.toThrow(
			"transcription failed: HTTP 503 runtime unavailable",
		);

		await expect(
			manager.transcribe(wavBlob(16_000), "en"),
		).resolves.toMatchObject({ text: "recovered text", language: "en" });
		const inferenceCalls = fetchMock.mock.calls;
		expect(inferenceCalls[0]?.[1]).toMatchObject({ method: "POST" });
		const secondBody = inferenceCalls[1]?.[1]?.body as FormData;
		expect(secondBody.get("language")).toBe("en");
		expect(secondBody.get("prompt")).toContain("Claude, Codex, Hlið");
		expect(secondBody.get("carry_initial_prompt")).toBe("true");
		manager.close();
	});

	it("releases queue capacity after validation and response parsing failures", async () => {
		const { manager } = await readyManager();
		const fetchMock = vi.mocked(globalThis.fetch);
		fetchMock.mockReset();
		fetchMock
			.mockResolvedValueOnce(
				new Response("not json", {
					status: 200,
					headers: { "content-type": "application/json" },
				}),
			)
			.mockResolvedValueOnce(Response.json({ text: "usable again" }));

		await expect(
			manager.transcribe(new Blob([new Uint8Array(8)]), "auto"),
		).rejects.toThrow("audio must be a WAV recording");
		await expect(manager.transcribe(wavBlob(16_000), "auto")).rejects.toThrow();
		await expect(
			manager.transcribe(wavBlob(16_000), "auto"),
		).resolves.toMatchObject({ text: "usable again" });
		expect(fetchMock).toHaveBeenCalledTimes(2);
		manager.close();
	});
});
