export type TtsVoiceInfo = {
	id: string;
	label: string;
	language: string;
	speaker: number;
};

export type TtsBackend = "cpu" | "directml";

export type TtsModelFamily = "kitten" | "vits";

export type TtsModelDefinition = {
	id: string;
	label: string;
	description: string;
	tier: "fast" | "balanced" | "quality";
	family: TtsModelFamily;
	sizeBytes: number;
	recommended: boolean;
	quantized: boolean;
	language: string;
	license: string;
	/** Backends that passed Hlid's model-specific qualification matrix. */
	qualifiedBackends: readonly TtsBackend[];
	voices: readonly TtsVoiceInfo[];
	archiveName: string;
	archiveUrl: string;
	archiveSha256: string;
	archiveMaxBytes: number;
	extractedDirectory: string;
	requiredFiles: readonly string[];
	runtime: {
		model: string;
		tokens: string;
		/** Optional eSpeak-ng data used by phonemizer-backed frontends. */
		dataDir?: string;
		/** Optional pronunciation lexicon used by lexicon-backed VITS frontends. */
		lexicon?: string;
		/** Optional model-qualified VITS synthesis noise scale. */
		noiseScale?: number;
		/** Optional model-qualified VITS duration noise scale. */
		noiseScaleW?: number;
		voices?: string;
	};
};

const MIB = 1024 * 1024;

const KITTEN_VOICES: readonly TtsVoiceInfo[] = [
	{
		id: "expr-voice-2-m",
		label: "Expressive 2 · masculine",
		language: "en-US",
		speaker: 0,
	},
	{
		id: "expr-voice-2-f",
		label: "Expressive 2 · feminine",
		language: "en-US",
		speaker: 1,
	},
	{
		id: "expr-voice-3-m",
		label: "Expressive 3 · masculine",
		language: "en-US",
		speaker: 2,
	},
	{
		id: "expr-voice-3-f",
		label: "Expressive 3 · feminine",
		language: "en-US",
		speaker: 3,
	},
	{
		id: "expr-voice-4-m",
		label: "Expressive 4 · masculine",
		language: "en-US",
		speaker: 4,
	},
	{
		id: "expr-voice-4-f",
		label: "Expressive 4 · feminine",
		language: "en-US",
		speaker: 5,
	},
	{
		id: "expr-voice-5-m",
		label: "Expressive 5 · masculine",
		language: "en-US",
		speaker: 6,
	},
	{
		id: "expr-voice-5-f",
		label: "Expressive 5 · feminine",
		language: "en-US",
		speaker: 7,
	},
] as const;

const LIBRITTS_HIGH_VOICES: readonly TtsVoiceInfo[] = [
	{
		id: "piper-libritts-p6701",
		label: "LibriTTS 6701 · masculine",
		language: "en-US",
		speaker: 3,
	},
	{
		id: "piper-libritts-p922",
		label: "LibriTTS 922 · masculine",
		language: "en-US",
		speaker: 5,
	},
	{
		id: "piper-libritts-p3922",
		label: "LibriTTS 3922 · feminine",
		language: "en-US",
		speaker: 0,
	},
	{
		id: "piper-libritts-p8152",
		label: "LibriTTS 8152 · masculine",
		language: "en-US",
		speaker: 132,
	},
	{
		id: "piper-libritts-p2085",
		label: "LibriTTS 2085 · feminine",
		language: "en-US",
		speaker: 903,
	},
] as const;

const MELO_ENGLISH_VOICES: readonly TtsVoiceInfo[] = [
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
] as const;

function piperVoice(
	id: string,
	name: string,
	locale: "en-US" | "en-GB",
	presentation: string,
): readonly TtsVoiceInfo[] {
	return [
		{
			id,
			label: `${name} · ${presentation}`,
			language: locale,
			speaker: 0,
		},
	];
}

export const TTS_MODEL_DEFINITIONS: readonly TtsModelDefinition[] = [
	{
		id: "kitten-nano-v0.8-int8",
		label: "Kitten Nano v0.8 (Int8)",
		description: "Fast English speech with eight expressive voices",
		tier: "fast",
		family: "kitten",
		sizeBytes: 31_220_690,
		recommended: true,
		quantized: true,
		language: "English",
		license: "Apache-2.0 model · eSpeak-ng GPL-3.0-or-later",
		qualifiedBackends: ["cpu"],
		voices: KITTEN_VOICES,
		archiveName: "kitten-nano-en-v0_8-int8.tar.bz2",
		archiveUrl:
			"https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/kitten-nano-en-v0_8-int8.tar.bz2",
		archiveSha256:
			"6fa5be852612ce761094ba74ee6123b4fc4acfefa79bf64dc63acae4a83af2fd",
		archiveMaxBytes: 40 * MIB,
		extractedDirectory: "kitten-nano-en-v0_8-int8",
		requiredFiles: [
			"model.int8.onnx",
			"voices.bin",
			"tokens.txt",
			"espeak-ng-data/phondata",
			"LICENSE",
		],
		runtime: {
			model: "model.int8.onnx",
			voices: "voices.bin",
			tokens: "tokens.txt",
			dataDir: "espeak-ng-data",
		},
	},
	{
		id: "piper-kristin-medium-int8",
		label: "Piper Kristin (Int8)",
		description: "Fast US English feminine voice",
		tier: "fast",
		family: "vits",
		sizeBytes: 20_882_061,
		recommended: false,
		quantized: true,
		language: "English (US)",
		license:
			"MIT model · public-domain training data · eSpeak-ng GPL-3.0-or-later",
		qualifiedBackends: ["cpu", "directml"],
		voices: piperVoice("piper-kristin", "Kristin", "en-US", "US feminine"),
		archiveName: "vits-piper-en_US-kristin-medium-int8.tar.bz2",
		archiveUrl:
			"https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/vits-piper-en_US-kristin-medium-int8.tar.bz2",
		archiveSha256:
			"16289d7ee8e6b2311a0a0af6531a55f498f82499644a1bb6fddb991fe6fa950c",
		archiveMaxBytes: 28 * MIB,
		extractedDirectory: "vits-piper-en_US-kristin-medium-int8",
		requiredFiles: [
			"en_US-kristin-medium.onnx",
			"tokens.txt",
			"espeak-ng-data/phondata",
			"MODEL_CARD",
		],
		runtime: {
			model: "en_US-kristin-medium.onnx",
			tokens: "tokens.txt",
			dataDir: "espeak-ng-data",
		},
	},
	{
		id: "piper-bryce-medium-int8",
		label: "Piper Bryce (Int8)",
		description: "Fast US English masculine voice",
		tier: "fast",
		family: "vits",
		sizeBytes: 20_910_568,
		recommended: false,
		quantized: true,
		language: "English (US)",
		license:
			"MIT model · public-domain training data · eSpeak-ng GPL-3.0-or-later",
		qualifiedBackends: ["cpu", "directml"],
		voices: piperVoice("piper-bryce", "Bryce", "en-US", "US masculine"),
		archiveName: "vits-piper-en_US-bryce-medium-int8.tar.bz2",
		archiveUrl:
			"https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/vits-piper-en_US-bryce-medium-int8.tar.bz2",
		archiveSha256:
			"89cd4f464c91579440565927bfca9d26555f577c4e37431167568c934fdb82f6",
		archiveMaxBytes: 28 * MIB,
		extractedDirectory: "vits-piper-en_US-bryce-medium-int8",
		requiredFiles: [
			"en_US-bryce-medium.onnx",
			"tokens.txt",
			"espeak-ng-data/phondata",
			"MODEL_CARD",
		],
		runtime: {
			model: "en_US-bryce-medium.onnx",
			tokens: "tokens.txt",
			dataDir: "espeak-ng-data",
		},
	},
	{
		id: "piper-norman-medium-int8",
		label: "Piper Norman (Int8)",
		description: "Fast US English masculine voice",
		tier: "fast",
		family: "vits",
		sizeBytes: 20_987_233,
		recommended: false,
		quantized: true,
		language: "English (US)",
		license:
			"Piper repository MIT · public-domain LibriVox training data · eSpeak-ng GPL-3.0-or-later",
		qualifiedBackends: ["cpu", "directml"],
		voices: piperVoice("piper-norman", "Norman", "en-US", "US masculine"),
		archiveName: "vits-piper-en_US-norman-medium-int8.tar.bz2",
		archiveUrl:
			"https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/vits-piper-en_US-norman-medium-int8.tar.bz2",
		archiveSha256:
			"cb481a514bc213ccf3899391c0f27fdcc4e4b814ec30496f28089a027b5aa01b",
		archiveMaxBytes: 28 * MIB,
		extractedDirectory: "vits-piper-en_US-norman-medium-int8",
		requiredFiles: [
			"en_US-norman-medium.onnx",
			"en_US-norman-medium.onnx.json",
			"tokens.txt",
			"espeak-ng-data/phondata",
			"MODEL_CARD",
		],
		runtime: {
			model: "en_US-norman-medium.onnx",
			tokens: "tokens.txt",
			dataDir: "espeak-ng-data",
		},
	},
	{
		id: "piper-cori-medium-int8",
		label: "Piper Cori (Int8)",
		description: "Fast UK English feminine voice",
		tier: "fast",
		family: "vits",
		sizeBytes: 20_768_736,
		recommended: false,
		quantized: true,
		language: "English (UK)",
		license:
			"MIT model · public-domain training data · eSpeak-ng GPL-3.0-or-later",
		qualifiedBackends: ["cpu", "directml"],
		voices: piperVoice("piper-cori", "Cori", "en-GB", "UK feminine"),
		archiveName: "vits-piper-en_GB-cori-medium-int8.tar.bz2",
		archiveUrl:
			"https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/vits-piper-en_GB-cori-medium-int8.tar.bz2",
		archiveSha256:
			"169ca8aff3adb271f009a4924c99928a811dbf2b52eaca2dbb460e8c34478c93",
		archiveMaxBytes: 28 * MIB,
		extractedDirectory: "vits-piper-en_GB-cori-medium-int8",
		requiredFiles: [
			"en_GB-cori-medium.onnx",
			"tokens.txt",
			"espeak-ng-data/phondata",
			"MODEL_CARD",
		],
		runtime: {
			model: "en_GB-cori-medium.onnx",
			tokens: "tokens.txt",
			dataDir: "espeak-ng-data",
		},
	},
	{
		id: "piper-ljspeech-high-int8",
		label: "Piper LJSpeech High (Int8)",
		description: "GPU-oriented larger US English feminine voice",
		tier: "balanced",
		family: "vits",
		sizeBytes: 33_886_472,
		recommended: false,
		quantized: true,
		language: "English (US)",
		license:
			"MIT model · public-domain training data · eSpeak-ng GPL-3.0-or-later",
		qualifiedBackends: ["cpu", "directml"],
		voices: piperVoice(
			"piper-ljspeech-high",
			"LJSpeech High",
			"en-US",
			"US feminine",
		),
		archiveName: "vits-piper-en_US-ljspeech-high-int8.tar.bz2",
		archiveUrl:
			"https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/vits-piper-en_US-ljspeech-high-int8.tar.bz2",
		archiveSha256:
			"916b2526d4ea191f9710bd2753698ac97926ec38eade867408d3f5fd422ca285",
		archiveMaxBytes: 44 * MIB,
		extractedDirectory: "vits-piper-en_US-ljspeech-high-int8",
		requiredFiles: [
			"en_US-ljspeech-high.onnx",
			"en_US-ljspeech-high.onnx.json",
			"tokens.txt",
			"espeak-ng-data/phondata",
			"MODEL_CARD",
		],
		runtime: {
			model: "en_US-ljspeech-high.onnx",
			tokens: "tokens.txt",
			dataDir: "espeak-ng-data",
		},
	},
	{
		id: "piper-libritts-high-int8",
		label: "Piper LibriTTS High (Int8)",
		description: "GPU-oriented larger English model with five curated voices",
		tier: "quality",
		family: "vits",
		sizeBytes: 36_406_088,
		recommended: false,
		quantized: true,
		language: "English (US)",
		license:
			"MIT model · LibriTTS training data CC BY 4.0 · eSpeak-ng GPL-3.0-or-later",
		qualifiedBackends: ["cpu", "directml"],
		voices: LIBRITTS_HIGH_VOICES,
		archiveName: "vits-piper-en_US-libritts-high-int8.tar.bz2",
		archiveUrl:
			"https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/vits-piper-en_US-libritts-high-int8.tar.bz2",
		archiveSha256:
			"c35f249498fe9406c5ca3b6db1fc16749d7ee415ff2a09d5da9334206c2e0026",
		archiveMaxBytes: 44 * MIB,
		extractedDirectory: "vits-piper-en_US-libritts-high-int8",
		requiredFiles: [
			"en_US-libritts-high.onnx",
			"en_US-libritts-high.onnx.json",
			"tokens.txt",
			"espeak-ng-data/phondata",
			"MODEL_CARD",
		],
		runtime: {
			model: "en_US-libritts-high.onnx",
			tokens: "tokens.txt",
			dataDir: "espeak-ng-data",
		},
	},
	{
		id: "melo-english",
		label: "MeloTTS English",
		description: "Larger English model with five publisher-labeled voices",
		tier: "quality",
		family: "vits",
		sizeBytes: 162_758_237,
		recommended: false,
		quantized: false,
		language: "English",
		license:
			"Publisher-declared MIT · training data and source-voice lineage undisclosed",
		qualifiedBackends: ["cpu", "directml"],
		voices: MELO_ENGLISH_VOICES,
		archiveName: "vits-melo-tts-en.tar.bz2",
		archiveUrl:
			"https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/vits-melo-tts-en.tar.bz2",
		archiveSha256:
			"f87bc5752ea3ec34273a2cc0c5086854c18b6b89dfd0534b5248e86a14cedb5d",
		archiveMaxBytes: 176 * MIB,
		extractedDirectory: "vits-melo-tts-en",
		requiredFiles: [
			"model.onnx",
			"tokens.txt",
			"lexicon.txt",
			"README.md",
			"LICENSE",
		],
		runtime: {
			model: "model.onnx",
			tokens: "tokens.txt",
			lexicon: "lexicon.txt",
			noiseScale: 0.6,
			noiseScaleW: 0.8,
		},
	},
] as const;

export function getTtsModelDefinition(
	id: string,
): TtsModelDefinition | undefined {
	return TTS_MODEL_DEFINITIONS.find((model) => model.id === id);
}
