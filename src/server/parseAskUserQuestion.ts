import type { AskQuestion } from "./protocol";

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
	// ── SDK format: array of question objects ──────────────────────────────────
	if (Array.isArray(input.questions) && input.questions.length > 0) {
		const out: AskQuestion[] = [];
		for (const raw of input.questions) {
			if (raw === null || typeof raw !== "object") continue;
			const q = raw as Record<string, unknown>;
			const question =
				typeof q.question === "string"
					? q.question
					: (title ?? "Question from Claude");
			const options = extractOptionLabels(q.options);
			if (options.length === 0) continue;
			out.push({
				question,
				options,
				multiSelect: q.multiSelect === true,
			});
		}
		if (out.length > 0) return { questions: out };
	}

	// ── Legacy/plain format ────────────────────────────────────────────────────
	const question =
		typeof input.question === "string"
			? input.question
			: (title ?? "Question from Claude");
	const options = extractOptionLabels(input.options);
	return {
		questions: [{ question, options, multiSelect: false }],
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
