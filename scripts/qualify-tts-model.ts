import { existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { delimiter, isAbsolute, join, relative, resolve } from "node:path";

export const QUALIFICATION_SCHEMA_VERSION = 1;
export const WARM_REPETITIONS = 6;
export const MONITOR_SETTLE_MS = 1_200;

export const COLD_TEXT =
	"The local speech engine should read this sentence clearly, keep its timing steady, and return safe audio without loading the model again.";

export const PRODUCTION_CHUNKS = [
	"When a longer response reaches the reader, Hlid divides it at natural sentence boundaries and prepares the next pieces before playback reaches them. This first chunk checks that ordinary prose remains stable, clear, and comfortably paced while the same model session stays loaded.",
	"The second prepared chunk contains punctuation, a short list of apples, pears, and oranges, plus numbers such as twenty four and one hundred. It helps expose repeated words, skipped phrases, unusually long pauses, or numerical instability that a tiny greeting might never reveal.",
	"For the third chunk, the runtime must continue synthesizing without reinitializing the neural model. That distinction matters because long read aloud sessions should not pause to reload between every piece, especially when a larger model is using GPU memory and the following audio is already queued.",
	"Finally, this fourth chunk closes the qualification passage. Its output is checked for finite samples, clipping, direct current offset, leading silence, trailing silence, duration, and real time factor so that a quick benchmark cannot hide damaged or unusable audio.",
] as const;

export const AUDIO_SAFETY_LIMITS = {
	minimumSampleRate: 8_000,
	maximumSampleRate: 192_000,
	maximumDurationMs: 5 * 60_000,
	audibleMagnitude: 0.0001,
	minimumRms: 0.00001,
	maximumPeak: 1,
	maximumDcToRms: 0.05,
} as const;

export type QualificationKind = "vits" | "kitten" | "supertonic" | "matcha";
export type QualificationBackend = "cpu" | "directml";

export type QualificationOptions = {
	kind: QualificationKind;
	backend: QualificationBackend;
	modelId: string;
	modelArchiveSha256: string;
	runtimeDirectory: string;
	modelDirectory: string;
	outputDirectory: string;
	expectedRuntimeVersion: string;
	threads: number;
	speaker: number;
	noiseScale?: number;
	noiseScaleW?: number;
	modelFile?: string;
	vocoder?: string;
};

export type AudioMetrics = {
	durationMs: number;
	sampleRate: number;
	samples: number;
	peak: number;
	rms: number;
	mean: number;
	dcToRms: number | null;
	clippedSamples: number;
	clippedFraction: number;
	nonzeroSamples: number;
	audibleSamples: number;
	leadingSilenceMs: number;
	trailingSilenceMs: number;
};

type GeneratedAudio = {
	samples: Float32Array;
	sampleRate: number;
};

type TtsAddon = {
	version: string;
	createOfflineTts(config: unknown): unknown;
	getOfflineTtsNumSpeakers(handle: unknown): number;
	getOfflineTtsSampleRate(handle: unknown): number;
	offlineTtsGenerateWithConfig(
		handle: unknown,
		request: unknown,
	): GeneratedAudio;
	writeWave(path: string, audio: GeneratedAudio): void;
};

type SynthesisMetric = AudioMetrics & {
	textChars: number;
	speaker: number;
	synthesisMs: number;
	realTimeFactor: number;
};

type ParsedArguments =
	| { help: true }
	| { help: false; options: QualificationOptions };

const USAGE = `Usage:
  bun scripts/qualify-tts-model.ts \\
    --kind <vits|kitten|supertonic|matcha> \\
    --backend <cpu|directml> \\
    --model-id <candidate-id> \\
    --model-archive-sha256 <64 lowercase hex characters> \\
    --runtime-dir <directory> \\
    --model-dir <directory> \\
    --output-dir <new-or-empty-directory> \\
    --expected-runtime-version <version> \\
    [--threads <1-32>] [--speaker <zero-based-id>] \\
    [--noise-scale <positive-number>] [--noise-scale-w <positive-number>] \\
    [--model-file <path>] [--vocoder <path>]

Runs exactly one cold synthesis, six warm repetitions, and four production-sized
chunks through one persistent sherpa-onnx TTS handle. It writes result.json and
representative.wav. Paths are resolved at runtime; no model or runtime is edited.

Model layout:
  vits       Infers the only top-level .onnx file unless --model-file is given;
             requires espeak-ng-data, lexicon.txt, or both.
  kitten     Defaults to model.int8.onnx; --model-file may override it.
  supertonic Uses the standard int8 component filenames and voice.bin.
  matcha     Defaults to model-steps-3.onnx and requires --vocoder.

DirectML qualification must be launched through:
  pwsh -File scripts/run-tts-qualification.ps1 -Help

The wrapper captures process-scoped Windows GPU Engine counters and fails the
qualification when it observes no positive engine sample. Running this child
script directly with --backend directml is intentionally rejected.
`;

class AudioSafetyError extends Error {
	constructor(
		readonly metrics: AudioMetrics,
		readonly violations: readonly string[],
	) {
		super(`unsafe generated audio: ${violations.join("; ")}`);
		this.name = "AudioSafetyError";
	}
}

function usageError(message: string): never {
	throw new Error(`${message}\n\n${USAGE}`);
}

function requiredValue(values: Map<string, string>, name: string): string {
	const value = values.get(name)?.trim();
	if (!value) usageError(`missing required option ${name}`);
	return value;
}

function integerOption(
	values: Map<string, string>,
	name: string,
	fallback: number,
	minimum: number,
	maximum: number,
): number {
	const raw = values.get(name);
	if (raw === undefined) return fallback;
	if (!/^\d+$/.test(raw)) usageError(`${name} must be an integer`);
	const value = Number(raw);
	if (!Number.isSafeInteger(value) || value < minimum || value > maximum)
		usageError(`${name} must be between ${minimum} and ${maximum}`);
	return value;
}

function positiveNumberOption(
	values: Map<string, string>,
	name: string,
): number | undefined {
	const raw = values.get(name);
	if (raw === undefined) return undefined;
	const value = Number(raw);
	if (!Number.isFinite(value) || value <= 0)
		usageError(`${name} must be a positive finite number`);
	return value;
}

export function parseQualificationArguments(
	arguments_: readonly string[],
): ParsedArguments {
	if (
		arguments_.length === 1 &&
		(arguments_[0] === "--help" || arguments_[0] === "-h")
	)
		return { help: true };
	if (arguments_.some((argument) => argument === "--help" || argument === "-h"))
		usageError("--help cannot be combined with qualification options");

	const allowed = new Set([
		"--kind",
		"--backend",
		"--model-id",
		"--model-archive-sha256",
		"--runtime-dir",
		"--model-dir",
		"--output-dir",
		"--expected-runtime-version",
		"--threads",
		"--speaker",
		"--noise-scale",
		"--noise-scale-w",
		"--model-file",
		"--vocoder",
	]);
	const values = new Map<string, string>();
	for (let index = 0; index < arguments_.length; index += 2) {
		const name = arguments_[index];
		const value = arguments_[index + 1];
		if (!name || !allowed.has(name)) usageError(`unknown option ${name ?? ""}`);
		if (values.has(name)) usageError(`duplicate option ${name}`);
		if (value === undefined || value.startsWith("--"))
			usageError(`missing value for ${name}`);
		values.set(name, value);
	}

	const kind = requiredValue(values, "--kind");
	if (!new Set(["vits", "kitten", "supertonic", "matcha"]).has(kind))
		usageError(`unsupported model kind ${kind}`);
	const backend = requiredValue(values, "--backend");
	if (backend !== "cpu" && backend !== "directml")
		usageError(`unsupported backend ${backend}`);
	const modelId = requiredValue(values, "--model-id");
	if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(modelId))
		usageError("--model-id must be a stable filename-safe identifier");
	const modelArchiveSha256 = requiredValue(
		values,
		"--model-archive-sha256",
	);
	if (!/^[a-f0-9]{64}$/.test(modelArchiveSha256))
		usageError("--model-archive-sha256 must be 64 lowercase hex characters");

	const vocoder = values.get("--vocoder");
	if (kind === "matcha" && !vocoder)
		usageError("--vocoder is required for Matcha qualification");
	if (kind !== "matcha" && vocoder)
		usageError("--vocoder is only valid with --kind matcha");
	const modelFile = values.get("--model-file");
	if (kind === "supertonic" && modelFile)
		usageError("--model-file is not valid for the multi-file Supertonic layout");
	const noiseScale = positiveNumberOption(values, "--noise-scale");
	const noiseScaleW = positiveNumberOption(values, "--noise-scale-w");
	if (kind !== "vits" && (noiseScale !== undefined || noiseScaleW !== undefined))
		usageError("--noise-scale and --noise-scale-w are only valid with --kind vits");

	return {
		help: false,
			options: {
				kind: kind as QualificationKind,
				backend,
				modelId,
				modelArchiveSha256,
				runtimeDirectory: requiredValue(values, "--runtime-dir"),
			modelDirectory: requiredValue(values, "--model-dir"),
			outputDirectory: requiredValue(values, "--output-dir"),
			expectedRuntimeVersion: requiredValue(
				values,
				"--expected-runtime-version",
			),
			threads: integerOption(values, "--threads", 4, 1, 32),
			speaker: integerOption(values, "--speaker", 0, 0, 100_000),
			...(noiseScale !== undefined ? { noiseScale } : {}),
			...(noiseScaleW !== undefined ? { noiseScaleW } : {}),
			...(modelFile ? { modelFile } : {}),
			...(vocoder ? { vocoder } : {}),
		},
	};
}

function round(value: number, digits: number): number {
	return Number(value.toFixed(digits));
}

export function inspectQualificationAudio(audio: GeneratedAudio): AudioMetrics {
	if (!(audio.samples instanceof Float32Array))
		throw new Error("audio samples are not a Float32Array");
	if (
		!Number.isSafeInteger(audio.sampleRate) ||
		audio.sampleRate < AUDIO_SAFETY_LIMITS.minimumSampleRate ||
		audio.sampleRate > AUDIO_SAFETY_LIMITS.maximumSampleRate
	)
		throw new Error(`invalid audio sample rate ${audio.sampleRate}`);
	if (audio.samples.length === 0) throw new Error("generated audio is empty");

	let peak = 0;
	let sum = 0;
	let sumSquares = 0;
	let nonzeroSamples = 0;
	let audibleSamples = 0;
	let clippedSamples = 0;
	let firstAudible = -1;
	let lastAudible = -1;
	for (let index = 0; index < audio.samples.length; index += 1) {
		const sample = audio.samples[index] ?? Number.NaN;
		if (!Number.isFinite(sample))
			throw new Error(`non-finite audio sample at index ${index}`);
		const magnitude = Math.abs(sample);
		peak = Math.max(peak, magnitude);
		if (magnitude > 0) nonzeroSamples += 1;
		if (magnitude >= AUDIO_SAFETY_LIMITS.maximumPeak) clippedSamples += 1;
		if (magnitude >= AUDIO_SAFETY_LIMITS.audibleMagnitude) {
			audibleSamples += 1;
			if (firstAudible < 0) firstAudible = index;
			lastAudible = index;
		}
		sum += sample;
		sumSquares += sample * sample;
	}

	const durationMs = (audio.samples.length / audio.sampleRate) * 1_000;
	const mean = sum / audio.samples.length;
	const rms = Math.sqrt(sumSquares / audio.samples.length);
	const leadingSilenceMs =
		firstAudible < 0 ? durationMs : (firstAudible / audio.sampleRate) * 1_000;
	const trailingSilenceMs =
		lastAudible < 0
			? durationMs
			: ((audio.samples.length - 1 - lastAudible) / audio.sampleRate) * 1_000;
	return {
		durationMs: round(durationMs, 3),
		sampleRate: audio.sampleRate,
		samples: audio.samples.length,
		peak: round(peak, 7),
		rms: round(rms, 7),
		mean: round(mean, 8),
		dcToRms: rms === 0 ? null : round(Math.abs(mean) / rms, 6),
		clippedSamples,
		clippedFraction: round(clippedSamples / audio.samples.length, 8),
		nonzeroSamples,
		audibleSamples,
		leadingSilenceMs: round(leadingSilenceMs, 3),
		trailingSilenceMs: round(trailingSilenceMs, 3),
	};
}

export function audioSafetyViolations(metrics: AudioMetrics): string[] {
	const violations: string[] = [];
	if (metrics.durationMs <= 0 || metrics.durationMs > AUDIO_SAFETY_LIMITS.maximumDurationMs)
		violations.push(`duration ${metrics.durationMs} ms is outside the safe range`);
	if (metrics.audibleSamples === 0 || metrics.rms < AUDIO_SAFETY_LIMITS.minimumRms)
		violations.push("audio is silent or below the audible floor");
	if (metrics.peak > AUDIO_SAFETY_LIMITS.maximumPeak || metrics.clippedSamples > 0)
		violations.push(
			`${metrics.clippedSamples} samples reached or exceeded normalized clipping`,
		);
	if (
		metrics.dcToRms === null ||
		metrics.dcToRms > AUDIO_SAFETY_LIMITS.maximumDcToRms
	)
		violations.push(`DC-to-RMS ratio ${metrics.dcToRms ?? "unknown"} is unsafe`);
	return violations;
}

function assertDirectory(path: string, label: string): string {
	if (!existsSync(path) || !lstatSync(path).isDirectory())
		throw new Error(`${label} is not a directory: ${path}`);
	return realpathSync(path);
}

function assertFile(path: string, label: string): string {
	if (!existsSync(path) || !lstatSync(path).isFile())
		throw new Error(`${label} is not a regular file: ${path}`);
	return realpathSync(path);
}

function pathInside(directory: string, candidate: string): boolean {
	const fromDirectory = relative(directory, candidate);
	return (
		fromDirectory !== "" &&
		!fromDirectory.startsWith("..") &&
		!isAbsolute(fromDirectory)
	);
}

function modelFile(
	modelDirectory: string,
	explicitPath: string | undefined,
	fallback: string | (() => string),
	label: string,
): string {
	const candidate = explicitPath
		? resolve(explicitPath)
		: typeof fallback === "function"
			? fallback()
			: join(modelDirectory, fallback);
	const resolved = assertFile(candidate, label);
	if (!pathInside(modelDirectory, resolved))
		throw new Error(`${label} must be inside the model directory`);
	return resolved;
}

function onlyTopLevelOnnx(modelDirectory: string): string {
	const matches = readdirSync(modelDirectory, { withFileTypes: true })
		.filter((entry) => entry.isFile() && entry.name.endsWith(".onnx"))
		.map((entry) => entry.name);
	if (matches.length !== 1)
		throw new Error(
			`expected exactly one top-level VITS .onnx file; found ${matches.join(", ") || "none"}`,
		);
	return join(modelDirectory, matches[0] ?? "");
}

function prepareOutputDirectory(path: string): string {
	const resolved = resolve(path);
	if (existsSync(resolved)) {
		if (!lstatSync(resolved).isDirectory())
			throw new Error(`output path is not a directory: ${resolved}`);
		if (readdirSync(resolved).length !== 0)
			throw new Error(`output directory must be empty: ${resolved}`);
		return realpathSync(resolved);
	}
	mkdirSync(resolved, { recursive: true });
	return realpathSync(resolved);
}

export function createQualificationModelConfig(options: QualificationOptions): {
	config: Record<string, unknown>;
	files: string[];
} {
	const directory = options.modelDirectory;
	if (options.kind === "vits") {
		const onnx = modelFile(
			directory,
			options.modelFile,
			() => onlyTopLevelOnnx(directory),
			"VITS model",
		);
		const tokens = assertFile(join(directory, "tokens.txt"), "VITS tokens");
		const unresolvedDataDirectory = join(directory, "espeak-ng-data");
		const unresolvedLexicon = join(directory, "lexicon.txt");
		const dataDirectory = existsSync(unresolvedDataDirectory)
			? assertDirectory(unresolvedDataDirectory, "VITS eSpeak data")
			: undefined;
		const lexicon = existsSync(unresolvedLexicon)
			? assertFile(unresolvedLexicon, "VITS lexicon")
			: undefined;
		if (!dataDirectory && !lexicon)
			throw new Error("VITS model requires espeak-ng-data or lexicon.txt");
		return {
			config: {
				vits: {
					model: onnx,
					tokens,
					...(dataDirectory ? { dataDir: dataDirectory } : {}),
					...(lexicon ? { lexicon } : {}),
					...(options.noiseScale !== undefined
						? { noiseScale: options.noiseScale }
						: {}),
					...(options.noiseScaleW !== undefined
						? { noiseScaleW: options.noiseScaleW }
						: {}),
				},
			},
			files: [onnx, tokens, dataDirectory, lexicon].filter(
				(path): path is string => path !== undefined,
			),
		};
	}
	if (options.kind === "kitten") {
		const onnx = modelFile(
			directory,
			options.modelFile,
			"model.int8.onnx",
			"Kitten model",
		);
		const voices = assertFile(join(directory, "voices.bin"), "Kitten voices");
		const tokens = assertFile(join(directory, "tokens.txt"), "Kitten tokens");
		const dataDirectory = assertDirectory(
			join(directory, "espeak-ng-data"),
			"Kitten eSpeak data",
		);
		return {
			config: {
				kitten: { model: onnx, voices, tokens, dataDir: dataDirectory },
			},
			files: [onnx, voices, tokens, dataDirectory],
		};
	}
	if (options.kind === "matcha") {
		const acousticModel = modelFile(
			directory,
			options.modelFile,
			"model-steps-3.onnx",
			"Matcha acoustic model",
		);
		const vocoder = assertFile(resolve(options.vocoder ?? ""), "Matcha vocoder");
		const tokens = assertFile(join(directory, "tokens.txt"), "Matcha tokens");
		const dataDirectory = assertDirectory(
			join(directory, "espeak-ng-data"),
			"Matcha eSpeak data",
		);
		return {
			config: {
				matcha: {
					acousticModel,
					vocoder,
					tokens,
					dataDir: dataDirectory,
				},
			},
			files: [acousticModel, vocoder, tokens, dataDirectory],
		};
	}

	const supertonic = {
		durationPredictor: assertFile(
			join(directory, "duration_predictor.int8.onnx"),
			"Supertonic duration predictor",
		),
		textEncoder: assertFile(
			join(directory, "text_encoder.int8.onnx"),
			"Supertonic text encoder",
		),
		vectorEstimator: assertFile(
			join(directory, "vector_estimator.int8.onnx"),
			"Supertonic vector estimator",
		),
		vocoder: assertFile(
			join(directory, "vocoder.int8.onnx"),
			"Supertonic vocoder",
		),
		ttsJson: assertFile(join(directory, "tts.json"), "Supertonic config"),
		unicodeIndexer: assertFile(
			join(directory, "unicode_indexer.bin"),
			"Supertonic Unicode indexer",
		),
		voiceStyle: assertFile(
			join(directory, "voice.bin"),
			"Supertonic voice style",
		),
	};
	return {
		config: { supertonic },
		files: Object.values(supertonic),
	};
}

function median(values: readonly number[]): number {
	if (values.length === 0) throw new Error("cannot calculate an empty median");
	const sorted = [...values].sort((left, right) => left - right);
	const midpoint = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 0
		? ((sorted[midpoint - 1] ?? 0) + (sorted[midpoint] ?? 0)) / 2
		: (sorted[midpoint] ?? 0);
}

function generationConfig(kind: QualificationKind, speaker: number): unknown {
	return kind === "supertonic"
		? { sid: speaker, speed: 1, numSteps: 8, extra: { lang: "en" } }
		: { sid: speaker, speed: 1, silenceScale: 0.75 };
}

function synthesize(
	addon: TtsAddon,
	handle: unknown,
	text: string,
	options: QualificationOptions,
	expectedSampleRate: number,
): { audio: GeneratedAudio; metric: SynthesisMetric } {
	const started = performance.now();
	const audio = addon.offlineTtsGenerateWithConfig(handle, {
		text,
		enableExternalBuffer: true,
		generationConfig: generationConfig(options.kind, options.speaker),
	});
	const synthesisMs = performance.now() - started;
	const metrics = inspectQualificationAudio(audio);
	if (metrics.sampleRate !== expectedSampleRate)
		throw new Error(
			`generated sample rate ${metrics.sampleRate} differs from model rate ${expectedSampleRate}`,
		);
	const violations = audioSafetyViolations(metrics);
	if (violations.length > 0) throw new AudioSafetyError(metrics, violations);
	return {
		audio,
		metric: {
			textChars: text.length,
			speaker: options.speaker,
			synthesisMs: round(synthesisMs, 3),
			realTimeFactor: round(synthesisMs / metrics.durationMs, 5),
			...metrics,
		},
	};
}

function writeJson(path: string, value: unknown): void {
	writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function qualify(options: QualificationOptions): Promise<unknown> {
	options.runtimeDirectory = assertDirectory(
		resolve(options.runtimeDirectory),
		"runtime directory",
	);
	options.modelDirectory = assertDirectory(
		resolve(options.modelDirectory),
		"model directory",
	);
	const unresolvedOutput = resolve(options.outputDirectory);
	if (
		unresolvedOutput === options.runtimeDirectory ||
		unresolvedOutput === options.modelDirectory ||
		pathInside(options.runtimeDirectory, unresolvedOutput) ||
		pathInside(options.modelDirectory, unresolvedOutput)
	)
		throw new Error("output directory must be outside the runtime and model trees");
	options.outputDirectory = prepareOutputDirectory(unresolvedOutput);
	const resultPath = join(options.outputDirectory, "result.json");
	const wavPath = join(options.outputDirectory, "representative.wav");
	const addonPath = assertFile(
		join(options.runtimeDirectory, "sherpa-onnx.node"),
		"sherpa-onnx addon",
	);
	const model = createQualificationModelConfig(options);
	const startedAt = new Date().toISOString();
	const baseResult = {
		schemaVersion: QUALIFICATION_SCHEMA_VERSION,
		status: "running",
		modelId: options.modelId,
		kind: options.kind,
		backend: options.backend,
		process: {
			pid: process.pid,
			platform: process.platform,
			architecture: process.arch,
			bunVersion: Bun.version,
		},
		runtime: {
			directory: options.runtimeDirectory,
			addon: addonPath,
			expectedVersion: options.expectedRuntimeVersion,
		},
		model: {
			archiveSha256: options.modelArchiveSha256,
			directory: options.modelDirectory,
			files: model.files,
			speaker: options.speaker,
		},
		policy: {
			persistentHandles: 1,
			coldSyntheses: 1,
			warmRepetitions: WARM_REPETITIONS,
			productionChunks: PRODUCTION_CHUNKS.length,
				productionTextCharacters: PRODUCTION_CHUNKS.map((text) => text.length),
				threads: options.threads,
				vitsInference:
					options.kind === "vits"
						? {
								noiseScale: options.noiseScale ?? null,
								noiseScaleW: options.noiseScaleW ?? null,
							}
						: null,
				audioSafetyLimits: AUDIO_SAFETY_LIMITS,
		},
		startedAt,
	};

	try {
		if (
			options.backend === "directml" &&
			process.env.HLID_TTS_QUALIFICATION_MONITORED !== "1"
		)
			throw new Error(
				"DirectML qualification requires scripts/run-tts-qualification.ps1 so GPU evidence can be captured",
			);
		await Bun.sleep(MONITOR_SETTLE_MS);
		process.env.PATH = `${options.runtimeDirectory}${delimiter}${process.env.PATH ?? ""}`;
		const require = createRequire(import.meta.url);
		const addonLoadStarted = performance.now();
		const addon = require(addonPath) as TtsAddon;
		const addonLoadMs = performance.now() - addonLoadStarted;
		if (addon.version !== options.expectedRuntimeVersion)
			throw new Error(
				`unexpected sherpa-onnx version ${addon.version}; expected ${options.expectedRuntimeVersion}`,
			);
		for (const method of [
			"createOfflineTts",
			"getOfflineTtsNumSpeakers",
			"getOfflineTtsSampleRate",
			"offlineTtsGenerateWithConfig",
			"writeWave",
		] as const) {
			if (typeof addon[method] !== "function")
				throw new Error(`sherpa-onnx addon is missing ${method}`);
		}

		const initializeStarted = performance.now();
		const handle = addon.createOfflineTts({
			model: {
				...model.config,
				debug: options.backend === "directml",
				numThreads: options.threads,
				provider: options.backend,
			},
			maxNumSentences: 1,
		});
		const initializedMs = performance.now() - initializeStarted;
		const speakerCount = addon.getOfflineTtsNumSpeakers(handle);
		const modelSampleRate = addon.getOfflineTtsSampleRate(handle);
		if (!Number.isSafeInteger(speakerCount) || speakerCount <= options.speaker)
			throw new Error(
				`speaker ${options.speaker} is unavailable; model reports ${speakerCount} speakers`,
			);
		if (
			!Number.isSafeInteger(modelSampleRate) ||
			modelSampleRate < AUDIO_SAFETY_LIMITS.minimumSampleRate ||
			modelSampleRate > AUDIO_SAFETY_LIMITS.maximumSampleRate
		)
			throw new Error(`invalid model sample rate ${modelSampleRate}`);

		const cold = synthesize(
			addon,
			handle,
			COLD_TEXT,
			options,
			modelSampleRate,
		);
		const warm: SynthesisMetric[] = [];
		for (let index = 0; index < WARM_REPETITIONS; index += 1) {
			warm.push(
				synthesize(
					addon,
					handle,
					COLD_TEXT,
					options,
					modelSampleRate,
				).metric,
			);
		}
		const production: SynthesisMetric[] = [];
		let representativeAudio = cold.audio;
		for (const text of PRODUCTION_CHUNKS) {
			const generated = synthesize(
				addon,
				handle,
				text,
				options,
				modelSampleRate,
			);
			production.push(generated.metric);
			representativeAudio = generated.audio;
		}
		addon.writeWave(wavPath, representativeAudio);
		assertFile(wavPath, "representative WAV");

		const productionSynthesisMs = production.reduce(
			(sum, metric) => sum + metric.synthesisMs,
			0,
		);
		const productionDurationMs = production.reduce(
			(sum, metric) => sum + metric.durationMs,
			0,
		);
		const result = {
			...baseResult,
			status:
				options.backend === "directml"
					? "pending-gpu-evidence"
					: "qualified",
			completedAt: new Date().toISOString(),
			runtime: { ...baseResult.runtime, version: addon.version },
			addonLoadMs: round(addonLoadMs, 3),
			initializedMs: round(initializedMs, 3),
			speakerCount,
			modelSampleRate,
			cold: cold.metric,
			warm: {
				count: warm.length,
				metrics: warm,
				medianRealTimeFactor: round(
					median(warm.map((metric) => metric.realTimeFactor)),
					5,
				),
				medianSynthesisMs: round(
					median(warm.map((metric) => metric.synthesisMs)),
					3,
				),
			},
			production: {
				count: production.length,
				textCharacters: PRODUCTION_CHUNKS.map((text) => text.length),
				metrics: production,
				totalSynthesisMs: round(productionSynthesisMs, 3),
				totalDurationMs: round(productionDurationMs, 3),
				combinedRealTimeFactor: round(
					productionSynthesisMs / productionDurationMs,
					5,
				),
			},
			representativeWav: wavPath,
			qualification: {
				passed: options.backend === "cpu",
				gpuEvidenceRequired: options.backend === "directml",
				failureReasons:
					options.backend === "directml"
						? ["awaiting process-scoped Windows GPU Engine evidence"]
						: [],
			},
		};
		writeJson(resultPath, result);
		return result;
	} catch (error) {
		const failure = {
			...baseResult,
			status: "failed",
			failedAt: new Date().toISOString(),
			error: error instanceof Error ? error.message : String(error),
			stack: error instanceof Error ? error.stack : undefined,
			...(error instanceof AudioSafetyError
				? {
					audioFailure: {
						metrics: error.metrics,
						violations: error.violations,
					},
				}
				: {}),
			qualification: {
				passed: false,
				gpuEvidenceRequired: options.backend === "directml",
				failureReasons: [error instanceof Error ? error.message : String(error)],
			},
		};
		writeJson(resultPath, failure);
		throw error;
	}
}

export async function runQualificationCli(
	arguments_: readonly string[],
): Promise<number> {
	try {
		const parsed = parseQualificationArguments(arguments_);
		if (parsed.help) {
			console.log(USAGE);
			return 0;
		}
		for (const text of PRODUCTION_CHUNKS) {
			if (text.length < 266 || text.length > 300)
				throw new Error(
					`production chunk length ${text.length} is outside the 266-300 character policy`,
				);
		}
		const result = await qualify({ ...parsed.options });
		console.log(JSON.stringify(result));
		return 0;
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		return 1;
	}
}

if (import.meta.main) process.exit(await runQualificationCli(process.argv.slice(2)));
