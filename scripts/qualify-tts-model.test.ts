import {
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	AUDIO_SAFETY_LIMITS,
	audioSafetyViolations,
	createQualificationModelConfig,
	inspectQualificationAudio,
	parseQualificationArguments,
	PRODUCTION_CHUNKS,
	WARM_REPETITIONS,
} from "./qualify-tts-model";

const MODEL_ARCHIVE_SHA256 = "a".repeat(64);
const temporaryDirectories: string[] = [];

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0))
		rmSync(directory, { recursive: true, force: true });
});

const requiredArguments = [
	"--kind",
	"vits",
	"--backend",
	"cpu",
	"--model-id",
	"candidate",
	"--model-archive-sha256",
	MODEL_ARCHIVE_SHA256,
	"--runtime-dir",
	"runtime",
	"--model-dir",
	"model",
	"--output-dir",
	"output",
	"--expected-runtime-version",
	"1.13.4",
] as const;

describe("TTS model qualification arguments", () => {
	it("parses the strict qualification contract and fixed defaults", () => {
		expect(parseQualificationArguments(requiredArguments)).toEqual({
			help: false,
			options: {
				kind: "vits",
				backend: "cpu",
				modelId: "candidate",
				modelArchiveSha256: MODEL_ARCHIVE_SHA256,
				runtimeDirectory: "runtime",
				modelDirectory: "model",
				outputDirectory: "output",
				expectedRuntimeVersion: "1.13.4",
				threads: 4,
				speaker: 0,
			},
		});
		expect(parseQualificationArguments(["--help"])).toEqual({ help: true });
	});

	it("rejects unknown, duplicate, incomplete, and family-specific options", () => {
		expect(() =>
			parseQualificationArguments([...requiredArguments, "--mystery", "x"]),
		).toThrow("unknown option --mystery");
		expect(() =>
			parseQualificationArguments(
				requiredArguments.map((argument) =>
					argument === MODEL_ARCHIVE_SHA256 ? "ABC" : argument,
				),
			),
		).toThrow("64 lowercase hex characters");
		expect(() =>
			parseQualificationArguments([
				...requiredArguments,
				"--threads",
				"4",
				"--threads",
				"8",
			]),
		).toThrow("duplicate option --threads");
		expect(() =>
			parseQualificationArguments(requiredArguments.slice(0, -2)),
		).toThrow("missing required option --expected-runtime-version");
		expect(() =>
			parseQualificationArguments([...requiredArguments, "--vocoder", "vocos.onnx"]),
		).toThrow("--vocoder is only valid");
		expect(() =>
			parseQualificationArguments([...requiredArguments, "--noise-scale", "0"]),
		).toThrow("positive finite number");
		expect(() =>
			parseQualificationArguments([
				...requiredArguments.map((argument) =>
					argument === "vits" ? "kitten" : argument,
				),
				"--noise-scale",
				"0.6",
			]),
		).toThrow("only valid with --kind vits");
	});

	it("records explicit model-qualified VITS noise settings", () => {
		expect(
			parseQualificationArguments([
				...requiredArguments,
				"--noise-scale",
				"0.6",
				"--noise-scale-w",
				"0.8",
			]),
		).toMatchObject({
			help: false,
			options: { noiseScale: 0.6, noiseScaleW: 0.8 },
		});
	});
});

describe("TTS qualification model layouts", () => {
	it("accepts a lexicon-only VITS model and omits dataDir", () => {
		const directory = realpathSync(
			mkdtempSync(join(tmpdir(), "hlid-vits-lexicon-")),
		);
		temporaryDirectories.push(directory);
		writeFileSync(join(directory, "model.onnx"), "model");
		writeFileSync(join(directory, "tokens.txt"), "tokens");
		writeFileSync(join(directory, "lexicon.txt"), "lexicon");

		const result = createQualificationModelConfig({
			kind: "vits",
			backend: "cpu",
			modelId: "lexicon-vits",
			modelArchiveSha256: MODEL_ARCHIVE_SHA256,
			runtimeDirectory: directory,
			modelDirectory: directory,
			outputDirectory: join(directory, "output"),
			expectedRuntimeVersion: "1.13.4",
			threads: 4,
			speaker: 0,
			noiseScale: 0.6,
			noiseScaleW: 0.8,
		});
		const vits = result.config.vits as Record<string, string | number>;
		expect(vits.lexicon).toBe(join(directory, "lexicon.txt"));
		expect(vits).not.toHaveProperty("dataDir");
		expect(vits).toMatchObject({ noiseScale: 0.6, noiseScaleW: 0.8 });
		expect(result.files).toContain(join(directory, "lexicon.txt"));
	});

	it("requires a VITS frontend resource", () => {
		const directory = realpathSync(
			mkdtempSync(join(tmpdir(), "hlid-vits-incomplete-")),
		);
		temporaryDirectories.push(directory);
		writeFileSync(join(directory, "model.onnx"), "model");
		writeFileSync(join(directory, "tokens.txt"), "tokens");
		expect(() =>
			createQualificationModelConfig({
				kind: "vits",
				backend: "cpu",
				modelId: "incomplete-vits",
				modelArchiveSha256: MODEL_ARCHIVE_SHA256,
				runtimeDirectory: directory,
				modelDirectory: directory,
				outputDirectory: join(directory, "output"),
				expectedRuntimeVersion: "1.13.4",
				threads: 4,
				speaker: 0,
			}),
		).toThrow("requires espeak-ng-data or lexicon.txt");
	});
});

describe("TTS qualification audio safety", () => {
	it("records stable finite audio metrics without violations", () => {
		const metrics = inspectQualificationAudio({
			sampleRate: 8_000,
			samples: new Float32Array([0, 0.1, -0.2, 0.2, -0.1, 0]),
		});
		expect(metrics).toMatchObject({
			sampleRate: 8_000,
			samples: 6,
			peak: 0.2,
			clippedSamples: 0,
			nonzeroSamples: 4,
			audibleSamples: 4,
		});
		expect(audioSafetyViolations(metrics)).toEqual([]);
	});

	it("fails closed for non-finite, silent, clipped, and DC-biased audio", () => {
		expect(() =>
			inspectQualificationAudio({
				sampleRate: 22_050,
				samples: new Float32Array([0, Number.NaN]),
			}),
		).toThrow("non-finite audio sample");

		const silent = inspectQualificationAudio({
			sampleRate: 22_050,
			samples: new Float32Array(32),
		});
		expect(audioSafetyViolations(silent)).toContain(
			"audio is silent or below the audible floor",
		);

		const clipped = inspectQualificationAudio({
			sampleRate: 22_050,
			samples: new Float32Array([0.1, 1, -1, 0.1]),
		});
		expect(audioSafetyViolations(clipped).join(" ")).toContain("clipping");

		const biased = inspectQualificationAudio({
			sampleRate: 22_050,
			samples: new Float32Array([0.2, 0.21, 0.19, 0.2]),
		});
		expect(biased.dcToRms).toBeGreaterThan(
			AUDIO_SAFETY_LIMITS.maximumDcToRms,
		);
		expect(audioSafetyViolations(biased).join(" ")).toContain("DC-to-RMS");
	});
});

describe("TTS qualification policy", () => {
	it("pins six warm runs and the four production-sized chunks", () => {
		expect(WARM_REPETITIONS).toBe(6);
		expect(PRODUCTION_CHUNKS.map((text) => text.length)).toEqual([
			280, 279, 300, 266,
		]);
	});

	it("keeps the Windows monitor portable and DirectML fail-closed", () => {
		const wrapper = readFileSync(
			resolve(import.meta.dirname, "run-tts-qualification.ps1"),
			"utf8",
		);
		expect(wrapper).toContain("$PSScriptRoot");
		expect(wrapper).toContain("Get-Counter");
		expect(wrapper).toContain("$positiveAny.Count -eq 0");
		expect(wrapper).toContain("HLID_TTS_QUALIFICATION_MONITORED");
		expect(wrapper).toContain("$TimeoutSeconds = 900");
		expect(wrapper).toContain("$timedOut = $true");
		expect(wrapper).toContain('Add("--noise-scale")');
		expect(wrapper).toContain("CultureInfo]::InvariantCulture");
		expect(wrapper).not.toMatch(/[A-Za-z]:\\Users\\/);
	});
});
