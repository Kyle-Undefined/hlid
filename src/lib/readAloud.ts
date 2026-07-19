export const READ_ALOUD_PREFERENCES_KEY = "hlid:read-aloud";

export type ReadAloudProvider = "device" | "microsoft";

export type ReadAloudPreferences = {
	provider: ReadAloudProvider;
	voiceURI: string;
	microsoftVoiceId: string;
	rate: number;
};

export const DEFAULT_READ_ALOUD_PREFERENCES: ReadAloudPreferences = {
	provider: "device",
	voiceURI: "",
	microsoftVoiceId: "",
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
				.replace(/^\s*>+\s?/, "")
				.replace(/^\s*[-+*]\s+/, "")
				.replace(/^\s*\d+[.)]\s+/, "")
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
	const sentences = text.match(/[^.!?]+(?:[.!?]+|$)/g) ?? [text];
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
		provider: candidate.provider === "microsoft" ? "microsoft" : "device",
		voiceURI: typeof candidate.voiceURI === "string" ? candidate.voiceURI : "",
		microsoftVoiceId:
			typeof candidate.microsoftVoiceId === "string"
				? candidate.microsoftVoiceId
				: "",
		rate:
			typeof candidate.rate === "number" &&
			Number.isFinite(candidate.rate) &&
			candidate.rate >= 0.5 &&
			candidate.rate <= 2
				? candidate.rate
				: DEFAULT_READ_ALOUD_PREFERENCES.rate,
	};
}
