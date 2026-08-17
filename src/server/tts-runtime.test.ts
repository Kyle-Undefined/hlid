import { describe, expect, it, vi } from "vitest";
import {
	createOfflineTtsConfig,
	createTtsRuntimeFetchHandler,
	createVitsRuntimeConfig,
	float32ToPcmWav,
	parseTtsRuntimeOptions,
	validateGeneratedAudio,
} from "./tts-runtime";

describe("TTS child runtime", () => {
	it("validates private loopback startup options", () => {
		const options = parseTtsRuntimeOptions([
			"bun",
			"server.ts",
			"--port",
			"24567",
			"--token",
			"a".repeat(64),
			"--addon",
			"./sherpa-onnx.node",
			"--model-dir",
			"./model",
			"--model-id",
			"kitten-nano-v0.8-int8",
			"--threads",
			"4",
			"--backend",
			"cpu",
		]);
		expect(options).toMatchObject({
			port: 24567,
			token: "a".repeat(64),
			threads: 4,
			backend: "cpu",
		});
		expect(() =>
			parseTtsRuntimeOptions([
				"--port",
				"80",
				"--token",
				"no",
				"--addon",
				"x",
				"--model-dir",
				"y",
				"--model-id",
				"unknown",
				"--threads",
				"0",
				"--backend",
				"directml",
			]),
		).toThrow();
	});

	it("builds lexicon-only VITS configuration without inventing dataDir", () => {
		const config = createVitsRuntimeConfig(
			{
				model: "model.onnx",
				tokens: "tokens.txt",
				lexicon: "lexicon.txt",
				noiseScale: 0.6,
				noiseScaleW: 0.8,
			},
			"/models/lexicon-vits",
		);
		expect(config).toMatchObject({
			model: expect.stringContaining("model.onnx"),
			tokens: expect.stringContaining("tokens.txt"),
			lexicon: expect.stringContaining("lexicon.txt"),
			noiseScale: 0.6,
			noiseScaleW: 0.8,
		});
		expect(config).not.toHaveProperty("dataDir");
		expect(() =>
			createVitsRuntimeConfig(
				{ model: "model.onnx", tokens: "tokens.txt" },
				"/models/incomplete-vits",
			),
		).toThrow("requires dataDir or lexicon");
		expect(() =>
			createVitsRuntimeConfig(
				{
					model: "model.onnx",
					tokens: "tokens.txt",
					lexicon: "lexicon.txt",
					noiseScale: 0,
				},
				"/models/invalid-vits",
			),
		).toThrow("invalid noiseScale");
	});

	it("builds family-specific sherpa-onnx configurations", () => {
		expect(
			createOfflineTtsConfig("piper-kristin-medium-int8", "/models/piper", 4),
		).toMatchObject({
			model: {
				vits: {
					model: expect.stringContaining("en_US-kristin-medium.onnx"),
					tokens: expect.stringContaining("tokens.txt"),
				},
				numThreads: 4,
				provider: "cpu",
			},
		});
		expect(
			createOfflineTtsConfig("kitten-nano-v0.8-int8", "/models/kitten", 8),
		).toMatchObject({
			model: {
				kitten: {
					model: expect.stringContaining("model.int8.onnx"),
					voices: expect.stringContaining("voices.bin"),
				},
				numThreads: 8,
				provider: "cpu",
			},
		});
		expect(
			createOfflineTtsConfig(
				"piper-cori-medium-int8",
				"/models/cori",
				4,
				"directml",
			),
		).toMatchObject({ model: { provider: "directml" } });
		expect(
			createOfflineTtsConfig(
				"piper-norman-medium-int8",
				"/models/norman",
				4,
				"directml",
			),
		).toMatchObject({
			model: {
				vits: {
					model: expect.stringContaining("en_US-norman-medium.onnx"),
					tokens: expect.stringContaining("tokens.txt"),
					dataDir: expect.stringContaining("espeak-ng-data"),
				},
				provider: "directml",
			},
		});
		expect(
			createOfflineTtsConfig(
				"piper-ljspeech-high-int8",
				"/models/ljspeech",
				4,
				"directml",
			),
		).toMatchObject({
			model: {
				vits: {
					model: expect.stringContaining("en_US-ljspeech-high.onnx"),
				},
				provider: "directml",
			},
		});
		expect(
			createOfflineTtsConfig(
				"piper-libritts-high-int8",
				"/models/libritts",
				4,
				"directml",
			),
		).toMatchObject({
			model: {
				vits: {
					model: expect.stringContaining("en_US-libritts-high.onnx"),
					tokens: expect.stringContaining("tokens.txt"),
					dataDir: expect.stringContaining("espeak-ng-data"),
				},
				provider: "directml",
			},
		});
		expect(
			createOfflineTtsConfig("melo-english", "/models/melo", 4, "directml"),
		).toMatchObject({
			model: {
				vits: {
					model: expect.stringContaining("model.onnx"),
					tokens: expect.stringContaining("tokens.txt"),
					lexicon: expect.stringContaining("lexicon.txt"),
					noiseScale: 0.6,
					noiseScaleW: 0.8,
				},
				provider: "directml",
			},
		});
		expect(
			(
				createOfflineTtsConfig("melo-english", "/models/melo", 4) as {
					model: { vits: Record<string, unknown> };
				}
			).model.vits,
		).not.toHaveProperty("dataDir");
		expect(() =>
			createOfflineTtsConfig(
				"kitten-nano-v0.8-int8",
				"/models/kitten",
				4,
				"directml",
			),
		).toThrow("unsupported TTS model backend");
	});

	it("encodes finite mono PCM WAV output", () => {
		const wav = float32ToPcmWav(new Float32Array([-2, 0, 2]), 24_000);
		expect(new TextDecoder().decode(wav.slice(0, 4))).toBe("RIFF");
		expect(new TextDecoder().decode(wav.slice(8, 12))).toBe("WAVE");
		expect(new DataView(wav.buffer).getUint32(24, true)).toBe(24_000);
		expect(wav.byteLength).toBe(50);
	});

	it("authorizes requests and returns synthesis metrics", async () => {
		const generate = vi.fn(() => ({
			samples: new Float32Array(24_000).fill(0.1),
			sampleRate: 24_000,
		}));
		const handler = createTtsRuntimeFetchHandler(
			{
				version: "1.13.4",
				createOfflineTts: vi.fn(),
				getOfflineTtsNumSpeakers: () => 8,
				getOfflineTtsSampleRate: () => 24_000,
				offlineTtsGenerateWithConfig: generate,
			},
			{},
			"a".repeat(64),
			"piper-kristin-medium-int8",
		);
		expect((await handler(new Request("http://127.0.0.1/status"))).status).toBe(
			401,
		);
		const status = await handler(
			new Request("http://127.0.0.1/status", {
				headers: { authorization: `Bearer ${"a".repeat(64)}` },
			}),
		);
		expect(await status.json()).toMatchObject({
			model: "piper-kristin-medium-int8",
			backend: "cpu",
			speakers: 8,
		});
		const response = await handler(
			new Request("http://127.0.0.1/synthesize", {
				method: "POST",
				headers: {
					authorization: `Bearer ${"a".repeat(64)}`,
					"content-type": "application/json",
				},
				body: JSON.stringify({ text: "Hello.", speaker: 3, speed: 1.25 }),
			}),
		);
		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toBe("audio/wav");
		expect(response.headers.get("x-hlid-audio-duration-ms")).toBe("1000");
		expect(generate).toHaveBeenCalledWith(
			{},
			expect.objectContaining({
				text: "Hello.",
				generationConfig: expect.objectContaining({
					sid: 3,
					speed: 1.25,
					silenceScale: 0.75,
				}),
			}),
		);
	});

	it("rejects corrupt model output before PCM conversion", () => {
		expect(() =>
			validateGeneratedAudio({
				samples: new Float32Array([0.1, Number.NaN]),
				sampleRate: 24_000,
			}),
		).toThrow("non-finite");
		expect(() =>
			validateGeneratedAudio({
				samples: new Float32Array([0.1, 1e20]),
				sampleRate: 24_000,
			}),
		).toThrow("numerically unstable");
		expect(() =>
			validateGeneratedAudio({
				samples: new Float32Array(100),
				sampleRate: 24_000,
			}),
		).not.toThrow();
	});
});
