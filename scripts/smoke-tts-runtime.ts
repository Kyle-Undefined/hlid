import { createRequire } from "node:module";
import { resolve } from "node:path";
import {
	createOfflineTtsConfig,
	validateGeneratedAudio,
} from "../src/server/tts-runtime";
import type { TtsBackend } from "../src/server/ttsModels";

type TtsAddon = {
	version: string;
	createOfflineTts(config: unknown): unknown;
	offlineTtsGenerateWithConfig(
		handle: unknown,
		request: unknown,
	): { samples: Float32Array; sampleRate: number };
};

const cliArguments = process.argv.slice(2);
const [runtimeArgument, modelArgument, backendArgument = "cpu"] = cliArguments;
if (!runtimeArgument || !modelArgument || cliArguments.length > 3)
	throw new Error(
		"usage: bun scripts/smoke-tts-runtime.ts <runtime-directory> <cori-model-directory> [cpu|directml]",
	);
if (backendArgument !== "cpu" && backendArgument !== "directml")
	throw new Error("invalid TTS smoke backend");

const backend: TtsBackend = backendArgument;
const runtimeDirectory = resolve(runtimeArgument);
const modelDirectory = resolve(modelArgument);
const require = createRequire(import.meta.url);
const addon = require(resolve(runtimeDirectory, "sherpa-onnx.node")) as TtsAddon;
if (addon.version !== "1.13.4")
	throw new Error(`unexpected sherpa-onnx version ${addon.version}`);

const started = performance.now();
const handle = addon.createOfflineTts(
	createOfflineTtsConfig(
		"piper-cori-medium-int8",
		modelDirectory,
		4,
		backend,
	),
);
const initializedMs = performance.now() - started;
const synthesisStarted = performance.now();
const audio = addon.offlineTtsGenerateWithConfig(handle, {
	text: "Hlid verifies this exact local neural speech runtime before release.",
	enableExternalBuffer: true,
	generationConfig: { sid: 0, speed: 1, silenceScale: 0.75 },
});
const synthesisMs = performance.now() - synthesisStarted;
validateGeneratedAudio(audio);
const durationMs = (audio.samples.length / audio.sampleRate) * 1000;
if (audio.sampleRate !== 22_050)
	throw new Error(`unexpected Cori sample rate ${audio.sampleRate}`);
if (durationMs < 250 || durationMs > 30_000)
	throw new Error(`unexpected Cori smoke duration ${Math.round(durationMs)} ms`);
let nonzeroSamples = 0;
let peak = 0;
for (const sample of audio.samples) {
	const absolute = Math.abs(sample);
	if (absolute > 0) nonzeroSamples += 1;
	if (absolute > peak) peak = absolute;
}
if (nonzeroSamples === 0)
	throw new Error("Cori smoke synthesis produced silent audio");

console.log(
	JSON.stringify({
		runtime: `sherpa-onnx ${addon.version}`,
		backend,
		initializedMs: Math.round(initializedMs),
		synthesisMs: Math.round(synthesisMs),
		durationMs: Math.round(durationMs),
		realTimeFactor: Number((synthesisMs / durationMs).toFixed(5)),
		sampleRate: audio.sampleRate,
		samples: audio.samples.length,
		nonzeroSamples,
		peak: Number(peak.toFixed(6)),
	}),
);
