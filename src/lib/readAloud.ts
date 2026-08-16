export const READ_ALOUD_PREFERENCES_KEY = "hlid:read-aloud";

export const MAX_NEURAL_READING_ID_CHARACTERS = 64;

export function isValidNeuralReadingId(value: string): boolean {
	return (
		value.length > 0 &&
		value.length <= MAX_NEURAL_READING_ID_CHARACTERS &&
		/^[A-Za-z0-9_-]+$/u.test(value)
	);
}

export type ReadAloudProvider = "device" | "microsoft" | "neural" | "codex";

export type ReadAloudPreferences = {
	provider: ReadAloudProvider;
	voiceURI: string;
	microsoftVoiceId: string;
	neuralVoiceId: string;
	rate: number;
};

export const DEFAULT_READ_ALOUD_PREFERENCES: ReadAloudPreferences = {
	provider: "device",
	voiceURI: "",
	microsoftVoiceId: "",
	neuralVoiceId: "expr-voice-2-f",
	rate: 1,
};

const HTML_ENTITIES: Record<string, string> = {
	"&amp;": "&",
	"&apos;": "'",
	"&#39;": "'",
	"&gt;": ">",
	"&lt;": "<",
	"&quot;": '"',
};

const NON_TERMINAL_SPEECH_ABBREVIATIONS = new Set([
	"dr",
	"e.g",
	"fig",
	"i.e",
	"jr",
	"mr",
	"mrs",
	"ms",
	"prof",
	"sr",
	"st",
	"vs",
]);
const SPEECH_SENTENCE_CLOSERS = new Set([
	'"',
	"'",
	"”",
	"’",
	")",
	"]",
	"}",
	"*",
	"_",
	"~",
]);

function precedingSpeechWord(text: string, dotIndex: number): string {
	let start = dotIndex;
	while (start > 0 && /[A-Za-z.]/u.test(text[start - 1] ?? "")) start -= 1;
	return text.slice(start, dotIndex + 1);
}

export function isNonTerminalSpeechPeriod(
	text: string,
	index: number,
	afterPunctuation: number,
): boolean {
	if (text[index] !== ".") return false;
	const previous = text[index - 1] ?? "";
	const next = text[afterPunctuation] ?? "";
	if (/\d/u.test(previous) && (/\d/u.test(next) || !next)) return true;
	const word = precedingSpeechWord(text, index);
	const normalized = word.slice(0, -1).toLowerCase();
	if (normalized === "no" && /^\s+\d/u.test(text.slice(afterPunctuation))) {
		return true;
	}
	if (NON_TERMINAL_SPEECH_ABBREVIATIONS.has(normalized)) return true;
	if (/^(?:[A-Za-z]\.){2,}$/u.test(word)) return true;
	return /^[A-Z]\.$/u.test(word);
}

function speechSentenceEnd(
	text: string,
	punctuationIndex: number,
): number | null {
	const punctuation = text[punctuationIndex];
	if (punctuation !== "." && punctuation !== "!" && punctuation !== "?") {
		return null;
	}
	let end = punctuationIndex + 1;
	while (text[end] === "." || text[end] === "!" || text[end] === "?") {
		end += 1;
	}
	if (isNonTerminalSpeechPeriod(text, punctuationIndex, end)) return null;
	while (SPEECH_SENTENCE_CLOSERS.has(text[end] ?? "")) end += 1;
	if (text[end] !== undefined && !/\s/u.test(text[end] ?? "")) return null;
	return end;
}

function splitSpeechSentences(text: string): string[] {
	const sentences: string[] = [];
	let start = 0;
	for (let index = 0; index < text.length; index += 1) {
		const end = speechSentenceEnd(text, index);
		if (end === null) continue;
		const sentence = text.slice(start, end).trim();
		if (sentence) sentences.push(sentence);
		start = end;
		index = end - 1;
	}
	const tail = text.slice(start).trim();
	if (tail) sentences.push(tail);
	return sentences;
}

/** Convert an assistant's Markdown into text that sounds natural when spoken. */
export function readableTextFromMarkdown(markdown: string): string {
	const withoutCodeBlocks = markdown
		.replace(/```[\s\S]*?```/g, "\n")
		.replace(/~~~[\s\S]*?~~~/g, "\n");
	const lines = withoutCodeBlocks
		.replace(/<!--([\s\S]*?)-->/g, " ")
		.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
		.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
		.replace(/<https?:\/\/[^>]+>/g, " ")
		.replace(/https?:\/\/\S+/g, " ")
		.replace(/<[^>]+>/g, " ")
		.replace(/`([^`]+)`/g, "$1")
		.replace(/^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/gm, "")
		.split(/\r?\n/)
		.map((line) =>
			line
				.replace(/^\s{0,3}#{1,6}\s+/, "")
				.replace(/^\s*(?:>\s*)+/u, "")
				.replace(/^\s*(?:[-+*]|\d+[.)])\s+(?:\[[ x]\]\s+)?/iu, "")
				.replace(/^\s*\|\s?|\s?\|\s*$/g, "")
				.replace(/\s*\|\s*/g, ", ")
				.replace(/[*_~]/g, "")
				.trim(),
		)
		.filter(Boolean)
		.map((line) => (/[,.:;!?]$/u.test(line) ? line : `${line}.`));

	return lines
		.join(" ")
		.replace(
			/&(?:amp|apos|#39|gt|lt|quot);/g,
			(entity) => HTML_ENTITIES[entity] ?? entity,
		)
		.replace(/\s+/g, " ")
		.trim();
}

function splitLongSegment(segment: string, maxCharacters: number): string[] {
	const words = segment.split(/\s+/);
	const chunks: string[] = [];
	let current = "";
	for (const word of words) {
		if (!word) continue;
		if (current && current.length + word.length + 1 > maxCharacters) {
			chunks.push(current);
			current = word;
		} else {
			current = current ? `${current} ${word}` : word;
		}
	}
	if (current) chunks.push(current);
	return chunks;
}

/** Keep browser utterances short enough to remain responsive on long answers. */
export function chunkReadAloudText(
	text: string,
	maxCharacters = 240,
): string[] {
	if (!text.trim()) return [];
	const sentences = splitSpeechSentences(text);
	const chunks: string[] = [];
	let current = "";
	for (const rawSentence of sentences) {
		const sentence = rawSentence.trim();
		if (!sentence) continue;
		for (const part of splitLongSegment(sentence, maxCharacters)) {
			if (current && current.length + part.length + 1 > maxCharacters) {
				chunks.push(current);
				current = part;
			} else {
				current = current ? `${current} ${part}` : part;
			}
		}
	}
	if (current) chunks.push(current);
	return chunks;
}

/**
 * Neural synthesis gets one deliberately short first chunk so playback can
 * start while the next sentence-sized chunk is generated.
 */
export function chunkNeuralReadAloudText(
	text: string,
	firstChunkCharacters = 20,
	maxCharacters = 220,
): string[] {
	const chunks = chunkReadAloudText(text, maxCharacters).flatMap((chunk) => {
		if (chunk.length <= maxCharacters) return [chunk];
		const bounded: string[] = [];
		for (let index = 0; index < chunk.length; index += maxCharacters)
			bounded.push(chunk.slice(index, index + maxCharacters));
		return bounded;
	});
	const first = chunks[0];
	if (!first) return chunks;
	let split = 0;
	for (let index = 0; index < first.length; index += 1) {
		const end = speechSentenceEnd(first, index);
		if (end === null) continue;
		if (end > firstChunkCharacters) break;
		if (end < first.length) split = end;
		break;
	}
	if (split <= 0 && first.length <= firstChunkCharacters) return chunks;
	if (split <= 0) split = first.lastIndexOf(" ", firstChunkCharacters);
	if (split <= 0) split = Math.min(firstChunkCharacters, first.length);
	const leading = first.slice(0, split).trim();
	const trailing = first.slice(split).trim();
	return [
		...(leading ? [leading] : []),
		...(trailing ? [trailing] : []),
		...chunks.slice(1),
	];
}

const CONSERVATIVE_WORD_MS = 550;

/**
 * Estimate a safe resume point for engines such as Chrome Android that do not
 * emit speech word-boundary events. The prior word is intentionally repeated
 * so an imperfect speech-rate estimate is less likely to skip unheard text.
 */
export function estimateReadAloudResumeIndex(
	text: string,
	startIndex: number,
	elapsedMs: number,
	rate: number,
): number {
	if (elapsedMs <= 0 || rate <= 0) return startIndex;
	const remaining = text.slice(startIndex);
	const words = [...remaining.matchAll(/\S+/g)];
	if (words.length < 2) return startIndex;
	const progressedWords = Math.floor(elapsedMs / (CONSERVATIVE_WORD_MS / rate));
	if (progressedWords < 2) return startIndex;
	const resumeWord = Math.min(progressedWords - 1, words.length - 1);
	return startIndex + (words[resumeWord]?.index ?? 0);
}

export function normalizeReadAloudPreferences(
	value: unknown,
): ReadAloudPreferences {
	if (!value || typeof value !== "object")
		return DEFAULT_READ_ALOUD_PREFERENCES;
	const candidate = value as Partial<ReadAloudPreferences>;
	return {
		provider:
			candidate.provider === "microsoft" || candidate.provider === "neural"
				? candidate.provider
				: "device",
		voiceURI: typeof candidate.voiceURI === "string" ? candidate.voiceURI : "",
		microsoftVoiceId:
			typeof candidate.microsoftVoiceId === "string"
				? candidate.microsoftVoiceId
				: "",
		neuralVoiceId:
			typeof candidate.neuralVoiceId === "string" && candidate.neuralVoiceId
				? candidate.neuralVoiceId
				: DEFAULT_READ_ALOUD_PREFERENCES.neuralVoiceId,
		rate:
			typeof candidate.rate === "number" &&
			Number.isFinite(candidate.rate) &&
			candidate.rate >= 0.5 &&
			candidate.rate <= 2
				? candidate.rate
				: DEFAULT_READ_ALOUD_PREFERENCES.rate,
	};
}
