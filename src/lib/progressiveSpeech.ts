import {
	isNonTerminalSpeechPeriod,
	readableTextFromMarkdown,
} from "./readAloud";
import {
	createSpeechPronunciationReplacer,
	type SpeechPronunciation,
} from "./speechPronunciations";

export type ProgressiveSpeechChunk = {
	text: string;
	/** UTF-16 offset of this delta within the current assistant response. */
	offset?: number;
	/** The text is the authoritative full assistant response. */
	replace?: boolean;
};

export type ProgressiveSpeechBoundary =
	| "sentence"
	| "paragraph"
	| "tool"
	| "message"
	| "done";

export type ProgressiveSpeechSegment = {
	id: string;
	text: string;
	/** UTF-16 source range within the current assistant response. */
	sourceStart: number;
	sourceEnd: number;
	boundary: ProgressiveSpeechBoundary;
};

export type ProgressiveSpeechUpdate = {
	enqueue: ProgressiveSpeechSegment[];
	/** Queued segment IDs that must be cancelled or ignored before playback. */
	invalidate: string[];
};

export type ProgressiveSpeechSegmenter = {
	pushChunk(chunk: ProgressiveSpeechChunk): ProgressiveSpeechUpdate;
	flush(
		boundary: Extract<ProgressiveSpeechBoundary, "tool" | "message" | "done">,
	): ProgressiveSpeechUpdate;
	/** Call immediately before audio playback starts. */
	markStarted(segmentId: string): void;
	/** Start a new assistant response and invalidate speech not yet playing. */
	reset(scopeId?: string): ProgressiveSpeechUpdate;
};

type StableBoundary = {
	end: number;
	kind: Extract<ProgressiveSpeechBoundary, "sentence" | "paragraph">;
};

type SpeakableRange = {
	start: number;
	end: number;
	text: string;
};

export const MAX_PROGRESSIVE_SPEECH_SEGMENT_CHARS = 240;

const EMPTY_UPDATE: ProgressiveSpeechUpdate = {
	enqueue: [],
	invalidate: [],
};

const MARKDOWN_CLOSERS = new Set([
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
const LIST_ITEM_PREFIX = /^\s*(?:>\s*)*(?:[-+*]|\d+[.)])\s+(?:\[[ x]\]\s+)?/iu;
const LIST_ITEM_MARKER = /^\s*(?:>\s*)*(?:[-+*]|\d+[.)])(?=[ \t]|$)/iu;

const ISO_TIMESTAMP_SOURCE = String.raw`\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})`;
const MARKDOWN_METADATA_PREFIX_SOURCE = String.raw`\s*(?:>\s*)?(?:[-+*]\s+)?`;
const ISO_METADATA_LINE = new RegExp(
	`^${MARKDOWN_METADATA_PREFIX_SOURCE}(?:(?:Time|Timestamp):\\s*)?\`?${ISO_TIMESTAMP_SOURCE}\`?\\s*[.,;]?\\s*$`,
	"iu",
);
const LEADING_ISO_TIMESTAMP = new RegExp(
	`^(${MARKDOWN_METADATA_PREFIX_SOURCE})(?:\\[${ISO_TIMESTAMP_SOURCE}\\]|\`${ISO_TIMESTAMP_SOURCE}\`|${ISO_TIMESTAMP_SOURCE})(?:\\s*[-\u2013\u2014|:]\\s*|\\s+)(?=\\S)`,
	"iu",
);
const VITEST_START_LINE = new RegExp(
	`^${MARKDOWN_METADATA_PREFIX_SOURCE}Start at\\s+\\d{1,2}:\\d{2}:\\d{2}(?:\\.\\d+)?(?:\\s*[AP]M)?\\s*[.;]?\\s*$`,
	"iu",
);
const VITEST_DURATION_LINE = new RegExp(
	`^${MARKDOWN_METADATA_PREFIX_SOURCE}Duration\\s+\\d+(?:\\.\\d+)?\\s*(?:ms|s)(?:\\s+\\([^)]*\\))?\\s*[.;]?\\s*$`,
	"iu",
);

function emptyUpdate(): ProgressiveSpeechUpdate {
	return { ...EMPTY_UPDATE, enqueue: [], invalidate: [] };
}

function maskCharacters(
	characters: string[],
	start: number,
	end: number,
): void {
	for (let index = start; index < end; index += 1) {
		if (characters[index] !== "\n" && characters[index] !== "\r") {
			characters[index] = " ";
		}
	}
}

/**
 * Preserve source offsets while hiding content that should never be narrated.
 * Open fences/comments are masked through the current end of the stream so a
 * forced tool boundary cannot leak their partial contents.
 */
function maskUnspeakableMarkdown(markdown: string): string {
	// String offsets in the wire protocol are UTF-16 code units, so preserve
	// that indexing here rather than iterating Unicode code points.
	const characters = markdown.split("");
	let fence: { character: "`" | "~"; length: number } | null = null;
	let lineStart = 0;

	while (lineStart < markdown.length) {
		const newline = markdown.indexOf("\n", lineStart);
		const lineEnd = newline === -1 ? markdown.length : newline + 1;
		const line = markdown.slice(lineStart, newline === -1 ? lineEnd : newline);
		if (fence) {
			const closing = line.match(/^\s{0,3}(`{3,}|~{3,})\s*$/u)?.[1];
			maskCharacters(characters, lineStart, lineEnd);
			if (closing?.[0] === fence.character && closing.length >= fence.length) {
				fence = null;
			}
		} else {
			const opening = line.match(/^\s{0,3}(`{3,}|~{3,})(?:\s*\S.*)?$/u)?.[1];
			if (opening) {
				fence = {
					character: opening[0] as "`" | "~",
					length: opening.length,
				};
				maskCharacters(characters, lineStart, lineEnd);
			} else if (/^(?: {4,}|\t+)\S/u.test(line)) {
				maskCharacters(characters, lineStart, lineEnd);
			}
		}
		lineStart = lineEnd;
	}

	let cursor = 0;
	while (cursor < markdown.length) {
		const opening = markdown.indexOf("<!--", cursor);
		if (opening === -1) break;
		const closing = markdown.indexOf("-->", opening + 4);
		const end = closing === -1 ? markdown.length : closing + 3;
		maskCharacters(characters, opening, end);
		cursor = end;
	}

	for (let index = 0; index < markdown.length; index += 1) {
		if (characters[index] !== "<") continue;
		const next = markdown[index + 1] ?? "";
		if (!/[A-Za-z!/?]/u.test(next)) continue;
		const closing = markdown.indexOf(">", index + 1);
		const end = closing === -1 ? markdown.length : closing + 1;
		maskCharacters(characters, index, end);
		index = end - 1;
	}

	return characters.join("");
}

function isWindowsPathStart(text: string, index: number): boolean {
	const previous = text[index - 1] ?? "";
	if (/[\p{L}\p{N}_]/u.test(previous)) return false;
	if (
		/[A-Za-z]/u.test(text[index] ?? "") &&
		text[index + 1] === ":" &&
		(text[index + 2] === "\\" || text[index + 2] === "/")
	) {
		return true;
	}
	return text[index] === "\\" && text[index + 1] === "\\";
}

function windowsPathEnd(text: string, start: number): number {
	const opening = text[start - 1] ?? "";
	if (opening === "`" || opening === '"' || opening === "'") {
		const closing = text.indexOf(opening, start);
		if (closing !== -1) return closing;
	}

	let end =
		/[A-Za-z]/u.test(text[start] ?? "") && text[start + 1] === ":"
			? start + 3
			: start + 2;
	while (
		end < text.length &&
		!/[\s`"'<>|?*,;!:()[\]{}]/u.test(text[end] ?? "")
	) {
		end += 1;
	}
	return end;
}

/**
 * Hide machine-oriented speech noise while retaining UTF-16 source offsets.
 * This stays Local Conversation-specific so manual Read Aloud remains literal.
 */
function maskLocalConversationNoise(markdown: string): string {
	const characters = markdown.split("");
	let lineStart = 0;
	while (lineStart < markdown.length) {
		const newline = markdown.indexOf("\n", lineStart);
		const lineEnd = newline === -1 ? markdown.length : newline + 1;
		const contentEnd = newline === -1 ? lineEnd : newline;
		const line = markdown.slice(lineStart, contentEnd);

		if (
			ISO_METADATA_LINE.test(line) ||
			VITEST_START_LINE.test(line) ||
			VITEST_DURATION_LINE.test(line)
		) {
			maskCharacters(characters, lineStart, lineEnd);
		} else {
			const prefix = line.match(LEADING_ISO_TIMESTAMP);
			if (prefix) {
				const markdownPrefixLength = prefix[1]?.length ?? 0;
				maskCharacters(
					characters,
					lineStart + markdownPrefixLength,
					lineStart + prefix[0].length,
				);
			}
		}
		lineStart = lineEnd;
	}

	for (let index = 0; index < markdown.length; index += 1) {
		if (!isWindowsPathStart(markdown, index)) continue;
		const end = windowsPathEnd(markdown, index);
		let componentEnd = end;
		while (
			componentEnd > index &&
			(markdown[componentEnd - 1] === "\\" ||
				markdown[componentEnd - 1] === "/")
		) {
			componentEnd -= 1;
		}
		let lastSeparator = -1;
		for (let cursor = index; cursor < componentEnd; cursor += 1) {
			if (markdown[cursor] === "\\" || markdown[cursor] === "/") {
				lastSeparator = cursor;
			}
		}
		if (lastSeparator >= index) {
			maskCharacters(characters, index, lastSeparator + 1);
			maskCharacters(characters, componentEnd, end);
		}
		index = Math.max(index, end - 1);
	}

	return characters.join("");
}

function maskInlineCode(text: string): string {
	const characters = text.split("");
	for (let index = 0; index < text.length; index += 1) {
		if (text[index] !== "`" || text[index - 1] === "\\") continue;
		let runLength = 1;
		while (text[index + runLength] === "`") runLength += 1;
		const marker = "`".repeat(runLength);
		const closing = text.indexOf(marker, index + runLength);
		const end = closing === -1 ? text.length : closing + runLength;
		maskCharacters(characters, index, end);
		index = end - 1;
	}
	return characters.join("");
}

function maskLinkDestinationsAndUrls(text: string): string {
	const characters = text.split("");
	for (let index = 0; index < text.length - 1; index += 1) {
		if (text[index] !== "]" || text[index + 1] !== "(") continue;
		let depth = 1;
		let cursor = index + 2;
		for (; cursor < text.length && depth > 0; cursor += 1) {
			if (text[cursor] === "(" && text[cursor - 1] !== "\\") depth += 1;
			if (text[cursor] === ")" && text[cursor - 1] !== "\\") depth -= 1;
		}
		maskCharacters(characters, index + 1, cursor);
		index = cursor - 1;
	}
	for (const match of text.matchAll(/https?:\/\/\S+/gu)) {
		const start = match.index;
		if (characters[start] !== text[start]) continue;
		const url = match[0].replace(/[.,!?;:'")\]}]+$/u, "");
		maskCharacters(characters, start, start + url.length);
	}
	return characters.join("");
}

function maskListItemPrefixes(text: string): string {
	const characters = text.split("");
	let lineStart = 0;
	while (lineStart < text.length) {
		const newline = text.indexOf("\n", lineStart);
		const lineEnd = newline === -1 ? text.length : newline;
		const line = text.slice(lineStart, lineEnd);
		const prefix =
			line.match(LIST_ITEM_PREFIX)?.[0] ?? line.match(LIST_ITEM_MARKER)?.[0];
		if (prefix) {
			maskCharacters(characters, lineStart, lineStart + prefix.length);
		}
		lineStart = newline === -1 ? text.length : newline + 1;
	}
	return characters.join("");
}

function boundaryText(markdown: string): string {
	return maskListItemPrefixes(
		maskLinkDestinationsAndUrls(maskInlineCode(markdown)),
	);
}

function isParagraphBoundary(text: string, index: number): number | null {
	if (text[index] !== "\n") return null;
	let cursor = index + 1;
	while (
		text[cursor] === " " ||
		text[cursor] === "\t" ||
		text[cursor] === "\r"
	) {
		cursor += 1;
	}
	return text[cursor] === "\n" ? cursor + 1 : null;
}

function hasUnclosedSquareBracket(text: string): boolean {
	let depth = 0;
	for (let index = 0; index < text.length; index += 1) {
		if (text[index - 1] === "\\") continue;
		if (text[index] === "[") depth += 1;
		if (text[index] === "]" && depth > 0) depth -= 1;
	}
	return depth > 0;
}

function isListItemBoundary(
	text: string,
	index: number,
	segmentStart: number,
): boolean {
	if (text[index] !== "\n") return false;
	const nextLineStart = index + 1;
	const nextNewline = text.indexOf("\n", nextLineStart);
	const nextLineEnd = nextNewline === -1 ? text.length : nextNewline;
	if (!LIST_ITEM_PREFIX.test(text.slice(nextLineStart, nextLineEnd)))
		return false;
	return Boolean(text.slice(segmentStart, index).trim());
}

function findStableBoundary(
	text: string,
	sourceText: string,
	start: number,
): StableBoundary | null {
	for (let index = start; index < text.length; index += 1) {
		const paragraphEnd = isParagraphBoundary(text, index);
		if (paragraphEnd !== null) {
			return { end: paragraphEnd, kind: "paragraph" };
		}
		if (isListItemBoundary(sourceText, index, start)) {
			return { end: index + 1, kind: "sentence" };
		}
		if (text[index] !== "." && text[index] !== "!" && text[index] !== "?") {
			continue;
		}

		let punctuationEnd = index + 1;
		while (
			text[punctuationEnd] === "." ||
			text[punctuationEnd] === "!" ||
			text[punctuationEnd] === "?"
		) {
			punctuationEnd += 1;
		}
		if (isNonTerminalSpeechPeriod(text, index, punctuationEnd)) continue;
		let end = punctuationEnd;
		while (MARKDOWN_CLOSERS.has(text[end] ?? "")) end += 1;
		const following = text[end];
		if (following !== undefined && !/\s/u.test(following)) continue;
		if (hasUnclosedSquareBracket(sourceText.slice(start, end))) continue;
		return { end, kind: "sentence" };
	}
	return null;
}

function stripUnclosedLinkDestination(markdown: string): string {
	const opening = markdown.lastIndexOf("](");
	if (opening === -1 || markdown.indexOf(")", opening + 2) !== -1) {
		return markdown;
	}
	return markdown.slice(0, opening + 1);
}

function speakableText(
	markdown: string,
	pronounce: (text: string) => string,
): string {
	const withoutReferenceDefinitions = stripUnclosedLinkDestination(
		markdown,
	).replace(/^\s*\[[^\]]+\]:\s+\S.*$/gmu, "");
	return pronounce(readableTextFromMarkdown(withoutReferenceDefinitions))
		.replace(/\[([^\]]+)\]/gu, "$1")
		.replace(/\s+([,.:;!?])/gu, "$1")
		.trim();
}

function avoidsSplitSurrogate(
	text: string,
	start: number,
	end: number,
): number {
	if (end <= start || end >= text.length) return end;
	const previous = text.charCodeAt(end - 1);
	const next = text.charCodeAt(end);
	if (
		previous >= 0xd800 &&
		previous <= 0xdbff &&
		next >= 0xdc00 &&
		next <= 0xdfff
	) {
		return end - 1 > start ? end - 1 : end + 1;
	}
	return end;
}

function largestBoundedSourceEnd(
	markdown: string,
	start: number,
	end: number,
	pronounce: (text: string) => string,
): number {
	let low = start + 1;
	let high = end;
	let best = start + 1;
	while (low <= high) {
		const candidate = Math.floor((low + high) / 2);
		if (
			speakableText(markdown.slice(start, candidate), pronounce).length <=
			MAX_PROGRESSIVE_SPEECH_SEGMENT_CHARS
		) {
			best = candidate;
			low = candidate + 1;
		} else {
			high = candidate - 1;
		}
	}
	return Math.min(end, avoidsSplitSurrogate(markdown, start, best));
}

function preferredSourceEnd(
	markdown: string,
	start: number,
	hardEnd: number,
): number {
	const minimum = start + Math.floor((hardEnd - start) * 0.6);
	for (let index = hardEnd; index > minimum; index -= 1) {
		const previous = markdown[index - 1] ?? "";
		if (/\s/u.test(previous) || /[,;:]/u.test(previous)) return index;
	}
	return hardEnd;
}

/**
 * Bound synthesis text while retaining the exact source ranges that replacement
 * updates use for invalidation. The hard source cut also handles unbroken hashes
 * and base64 without relying on a later controller-only text split.
 */
function splitSpeakableRange(
	markdown: string,
	start: number,
	end: number,
	pronounce: (text: string) => string,
): SpeakableRange[] {
	const ranges: SpeakableRange[] = [];
	let cursor = start;
	while (cursor < end) {
		const remaining = speakableText(markdown.slice(cursor, end), pronounce);
		if (!remaining) break;
		if (remaining.length <= MAX_PROGRESSIVE_SPEECH_SEGMENT_CHARS) {
			ranges.push({ start: cursor, end, text: remaining });
			break;
		}

		const hardEnd = largestBoundedSourceEnd(markdown, cursor, end, pronounce);
		let splitEnd = preferredSourceEnd(markdown, cursor, hardEnd);
		let text = speakableText(markdown.slice(cursor, splitEnd), pronounce);
		if (!text || text.length > MAX_PROGRESSIVE_SPEECH_SEGMENT_CHARS) {
			splitEnd = hardEnd;
			text = speakableText(markdown.slice(cursor, splitEnd), pronounce);
		}
		if (splitEnd <= cursor) {
			splitEnd = Math.min(end, cursor + 1);
			text = speakableText(markdown.slice(cursor, splitEnd), pronounce);
		}
		if (text) ranges.push({ start: cursor, end: splitEnd, text });
		cursor = splitEnd;
	}
	return ranges;
}

function commonPrefixLength(left: string, right: string): number {
	const length = Math.min(left.length, right.length);
	let index = 0;
	while (index < length && left[index] === right[index]) index += 1;
	return index;
}

function stableHash(value: string): string {
	let hash = 0x811c9dc5;
	for (let index = 0; index < value.length; index += 1) {
		hash ^= value.charCodeAt(index);
		hash = Math.imul(hash, 0x01000193);
	}
	return (hash >>> 0).toString(36);
}

function createSegmentId(
	scopeId: string,
	start: number,
	end: number,
	text: string,
): string {
	return `speech-${stableHash(scopeId)}-${start}-${end}-${stableHash(text)}`;
}

export function createProgressiveSpeechSegmenter(
	initialScopeId = "assistant",
	pronunciations: readonly SpeechPronunciation[] = [],
): ProgressiveSpeechSegmenter {
	const pronounce = createSpeechPronunciationReplacer(pronunciations);
	let scopeId = initialScopeId;
	let rawText = "";
	let scanOffset = 0;
	let startedThrough = 0;
	const queued = new Map<string, ProgressiveSpeechSegment>();

	const emitRange = (
		start: number,
		end: number,
		boundary: ProgressiveSpeechBoundary,
	): ProgressiveSpeechSegment[] => {
		const masked = maskLinkDestinationsAndUrls(
			maskLocalConversationNoise(maskUnspeakableMarkdown(rawText)),
		);
		const segments: ProgressiveSpeechSegment[] = [];
		for (const range of splitSpeakableRange(masked, start, end, pronounce)) {
			const segment: ProgressiveSpeechSegment = {
				id: createSegmentId(scopeId, range.start, range.end, range.text),
				text: range.text,
				sourceStart: range.start,
				sourceEnd: range.end,
				boundary,
			};
			if (queued.has(segment.id)) continue;
			queued.set(segment.id, segment);
			segments.push(segment);
		}
		return segments;
	};

	const drainStable = (): ProgressiveSpeechSegment[] => {
		const masked = maskLocalConversationNoise(maskUnspeakableMarkdown(rawText));
		const boundaries = boundaryText(masked);
		const enqueue: ProgressiveSpeechSegment[] = [];
		while (scanOffset < rawText.length) {
			const boundary = findStableBoundary(boundaries, masked, scanOffset);
			if (!boundary) break;
			enqueue.push(...emitRange(scanOffset, boundary.end, boundary.kind));
			scanOffset = boundary.end;
		}
		return enqueue;
	};

	const replaceText = (text: string): ProgressiveSpeechUpdate => {
		if (text === rawText) return emptyUpdate();
		if (text.startsWith(rawText)) {
			rawText = text;
			return { enqueue: drainStable(), invalidate: [] };
		}

		const prefixLength = commonPrefixLength(rawText, text);
		const invalidated: ProgressiveSpeechSegment[] = [];
		for (const segment of queued.values()) {
			if (segment.sourceEnd <= prefixLength) continue;
			invalidated.push(segment);
			queued.delete(segment.id);
		}
		const earliestInvalidated = invalidated.reduce(
			(earliest, segment) => Math.min(earliest, segment.sourceStart),
			Number.POSITIVE_INFINITY,
		);
		rawText = text;
		if (prefixLength < startedThrough) {
			// Audio cannot be unsaid. If authoritative text revises speech that has
			// already started, resume only from later deltas instead of narrating a
			// contradictory replacement or a word fragment.
			scanOffset = text.length;
		} else {
			const affectedStart = Number.isFinite(earliestInvalidated)
				? earliestInvalidated
				: Math.min(scanOffset, prefixLength);
			scanOffset = Math.min(
				text.length,
				Math.max(startedThrough, affectedStart),
			);
		}
		return {
			enqueue: drainStable(),
			invalidate: invalidated.map((segment) => segment.id),
		};
	};

	return {
		pushChunk(chunk) {
			if (chunk.replace) return replaceText(chunk.text);
			if (chunk.offset === undefined) {
				rawText += chunk.text;
			} else {
				const consumed = rawText.length - chunk.offset;
				if (consumed >= chunk.text.length) return emptyUpdate();
				rawText += chunk.text.slice(Math.max(0, consumed));
			}
			return { enqueue: drainStable(), invalidate: [] };
		},

		flush(boundary) {
			if (scanOffset >= rawText.length) return emptyUpdate();
			const start = scanOffset;
			scanOffset = rawText.length;
			return {
				enqueue: emitRange(start, rawText.length, boundary),
				invalidate: [],
			};
		},

		markStarted(segmentId) {
			const segment = queued.get(segmentId);
			if (!segment) return;
			queued.delete(segmentId);
			startedThrough = Math.max(startedThrough, segment.sourceEnd);
		},

		reset(nextScopeId) {
			const invalidate = [...queued.keys()];
			queued.clear();
			rawText = "";
			scanOffset = 0;
			startedThrough = 0;
			if (nextScopeId !== undefined) scopeId = nextScopeId;
			return { enqueue: [], invalidate };
		},
	};
}
