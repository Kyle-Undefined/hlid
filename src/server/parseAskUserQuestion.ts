import type { AskQuestion } from "./protocol";

const DEFAULT_QUESTION = "Question from Claude";

function questionText(
	input: Record<string, unknown>,
	title: string | undefined,
): string {
	return typeof input.question === "string"
		? input.question
		: (title ?? DEFAULT_QUESTION);
}

function parseSdkQuestion(
	raw: unknown,
	title: string | undefined,
): AskQuestion | null {
	if (raw === null || typeof raw !== "object") return null;
	const input = raw as Record<string, unknown>;
	const options = extractOptionLabels(input.options);
	const freeText = input.freeText === true;
	if (options.length === 0 && !freeText) return null;
	return {
		question: questionText(input, title),
		options,
		multiSelect: input.multiSelect === true,
		...(freeText ? { freeText: true } : {}),
		...(input.inputType === "number" ? { inputType: "number" as const } : {}),
		...(typeof input.placeholder === "string"
			? { placeholder: input.placeholder }
			: {}),
		...(input.optional === true ? { optional: true } : {}),
	};
}

function parseSdkQuestions(
	raw: unknown,
	title: string | undefined,
): AskQuestion[] {
	if (!Array.isArray(raw)) return [];
	const questions: AskQuestion[] = [];
	for (const candidate of raw) {
		const question = parseSdkQuestion(candidate, title);
		if (question) questions.push(question);
	}
	return questions;
}

/**
 * Parses the raw input from Claude Code's AskUserQuestion tool into the
 * structured questions array that Raven's UI expects.
 *
 * SDK format (current):
 *   { questions: [{ question, header, options: [{ label, description }], multiSelect }] }
 *
 * Legacy/plain format (backwards compat):
 *   { question: string, options: string[] }
 */
export function parseAskUserQuestion(
	input: Record<string, unknown>,
	title?: string,
): { questions: AskQuestion[] } {
	const sdkQuestions = parseSdkQuestions(input.questions, title);
	if (sdkQuestions.length > 0) return { questions: sdkQuestions };

	// ── Legacy/plain format ────────────────────────────────────────────────────
	const options = extractOptionLabels(input.options);
	return {
		questions: [
			{ question: questionText(input, title), options, multiSelect: false },
		],
	};
}

function extractOptionLabels(raw: unknown): string[] {
	if (!Array.isArray(raw)) return [];
	return raw.flatMap((o) => {
		if (typeof o === "string") return [o];
		if (
			o !== null &&
			typeof o === "object" &&
			typeof (o as Record<string, unknown>).label === "string"
		) {
			return [(o as Record<string, unknown>).label as string];
		}
		return [];
	});
}
