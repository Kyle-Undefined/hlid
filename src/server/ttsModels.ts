export type TtsVoiceInfo = {
	id: string;
	label: string;
	language: string;
	speaker: number;
};

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
		dataDir: string;
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
] as const;

export function getTtsModelDefinition(
	id: string,
): TtsModelDefinition | undefined {
	return TTS_MODEL_DEFINITIONS.find((model) => model.id === id);
}
