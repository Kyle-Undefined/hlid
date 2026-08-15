export type SpeechPronunciation = {
	written: string;
	spoken: string;
};

export const MAX_SPEECH_PRONUNCIATIONS = 50;
export const MAX_SPEECH_PRONUNCIATION_FIELD_CHARS = 80;

type PreparedPronunciation = {
	written: string;
	spoken: string;
	sourceIndex: number;
	caseSensitive: boolean;
	exactMatcher: RegExp;
};

const TERM_CHARACTER_SOURCE = String.raw`\p{L}\p{M}\p{N}_`;

function escapeRegularExpression(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function exactCaseInsensitiveMatcher(value: string): RegExp {
	return new RegExp(`^(?:${escapeRegularExpression(value)})$`, "iu");
}

function isUppercaseAcronymLike(value: string): boolean {
	const letters = value.match(/\p{L}/gu) ?? [];
	return (
		letters.length >= 2 && letters.every((letter) => /^\p{Lu}$/u.test(letter))
	);
}

function pronunciationMatcher(value: string): RegExp {
	return new RegExp(
		`^(?:${escapeRegularExpression(value)})$`,
		isUppercaseAcronymLike(value) ? "u" : "iu",
	);
}

/** Safely hydrate pronunciation entries from persisted or networked config. */
export function normalizeSpeechPronunciations(
	value: unknown,
): SpeechPronunciation[] {
	if (!Array.isArray(value)) return [];

	const normalized: SpeechPronunciation[] = [];
	const writtenMatchers: RegExp[] = [];
	for (const candidate of value) {
		if (normalized.length >= MAX_SPEECH_PRONUNCIATIONS) break;
		if (
			!candidate ||
			typeof candidate !== "object" ||
			Array.isArray(candidate)
		) {
			continue;
		}
		const entry = candidate as { written?: unknown; spoken?: unknown };
		if (typeof entry.written !== "string" || typeof entry.spoken !== "string") {
			continue;
		}

		const written = entry.written.trim().normalize("NFC");
		const spoken = entry.spoken.trim().normalize("NFC");
		if (
			!written ||
			!spoken ||
			written.length > MAX_SPEECH_PRONUNCIATION_FIELD_CHARS ||
			spoken.length > MAX_SPEECH_PRONUNCIATION_FIELD_CHARS ||
			writtenMatchers.some((matcher) => matcher.test(written))
		) {
			continue;
		}

		normalized.push({ written, spoken });
		writtenMatchers.push(exactCaseInsensitiveMatcher(written));
	}
	return normalized;
}

function preparePronunciations(
	pronunciations: readonly SpeechPronunciation[],
): PreparedPronunciation[] {
	const prepared: PreparedPronunciation[] = [];

	for (const [sourceIndex, pronunciation] of normalizeSpeechPronunciations(
		pronunciations,
	).entries()) {
		const { written, spoken } = pronunciation;
		const caseSensitive = isUppercaseAcronymLike(written);
		const exactMatcher = pronunciationMatcher(written);
		prepared.push({
			written,
			spoken,
			sourceIndex,
			caseSensitive,
			exactMatcher,
		});
	}

	return prepared.sort(
		(left, right) =>
			right.written.length - left.written.length ||
			left.sourceIndex - right.sourceIndex,
	);
}

type PronunciationMatch = {
	entry: PreparedPronunciation;
	start: number;
	end: number;
};

function combinedMatcher(
	entries: readonly PreparedPronunciation[],
	caseSensitive: boolean,
): RegExp | null {
	if (entries.length === 0) return null;
	const alternatives = entries
		.map((entry) => escapeRegularExpression(entry.written))
		.join("|");
	return new RegExp(
		`(^|[^${TERM_CHARACTER_SOURCE}])(${alternatives})(?=$|[^${TERM_CHARACTER_SOURCE}])`,
		caseSensitive ? "gu" : "giu",
	);
}

function nextPronunciationMatch(
	text: string,
	from: number,
	matcher: RegExp | null,
	entries: readonly PreparedPronunciation[],
): PronunciationMatch | null {
	if (!matcher) return null;
	matcher.lastIndex = from;
	const match = matcher.exec(text);
	const matchedTerm = match?.[2];
	if (!match || !matchedTerm) return null;
	const entry = entries.find((candidate) =>
		candidate.exactMatcher.test(matchedTerm),
	);
	if (!entry) return null;
	const start = match.index + (match[1]?.length ?? 0);
	return { entry, start, end: start + matchedTerm.length };
}

function earlierPronunciationMatch(
	left: PronunciationMatch | null,
	right: PronunciationMatch | null,
): PronunciationMatch | null {
	if (!left) return right;
	if (!right) return left;
	if (left.start !== right.start)
		return left.start < right.start ? left : right;
	if (left.entry.written.length !== right.entry.written.length) {
		return left.entry.written.length > right.entry.written.length
			? left
			: right;
	}
	return left.entry.sourceIndex <= right.entry.sourceIndex ? left : right;
}

/**
 * Apply literal, whole-term pronunciation substitutions to speakable text.
 *
 * Markdown, code, and URL filtering intentionally stay outside this helper so
 * every speech path can run its existing cleanup before pronunciations. The
 * replacements are performed together in one pass, so replacement text is
 * never treated as input for another pronunciation.
 */
export function createSpeechPronunciationReplacer(
	pronunciations: readonly SpeechPronunciation[],
): (text: string) => string {
	const prepared = preparePronunciations(pronunciations);
	if (prepared.length === 0) return (text) => text;
	const caseSensitiveEntries = prepared.filter((entry) => entry.caseSensitive);
	const caseInsensitiveEntries = prepared.filter(
		(entry) => !entry.caseSensitive,
	);
	const caseSensitiveMatcher = combinedMatcher(caseSensitiveEntries, true);
	const caseInsensitiveMatcher = combinedMatcher(caseInsensitiveEntries, false);

	return (text) => {
		if (!text) return text;

		const normalizedText = text.normalize("NFC");
		let result = "";
		let cursor = 0;
		while (cursor < normalizedText.length) {
			const match = earlierPronunciationMatch(
				nextPronunciationMatch(
					normalizedText,
					cursor,
					caseSensitiveMatcher,
					caseSensitiveEntries,
				),
				nextPronunciationMatch(
					normalizedText,
					cursor,
					caseInsensitiveMatcher,
					caseInsensitiveEntries,
				),
			);
			if (!match) break;
			result += normalizedText.slice(cursor, match.start);
			result += match.entry.spoken;
			cursor = match.end;
		}
		return result + normalizedText.slice(cursor);
	};
}

export function applySpeechPronunciations(
	text: string,
	pronunciations: readonly SpeechPronunciation[],
): string {
	return createSpeechPronunciationReplacer(pronunciations)(text);
}
