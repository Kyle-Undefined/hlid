/**
 * Parses the raw input from Claude Code's AskUserQuestion tool into the
 * question text and string options that Raven's UI expects.
 *
 * SDK format (current):
 *   { questions: [{ question, header, options: [{ label, description }], multiSelect }] }
 *
 * Legacy/plain format (backwards compat):
 *   { question: string, options: string[] }
 *
 * When multiple questions are present, only the first is surfaced. Multi-question
 * UI support is a future enhancement.
 */
export function parseAskUserQuestion(
	input: Record<string, unknown>,
	title?: string,
): { question: string; options: string[] } {
	// ── Resolve the first question object (SDK format) ─────────────────────────
	const firstQ =
		Array.isArray(input.questions) && input.questions.length > 0
			? (input.questions[0] as Record<string, unknown>)
			: null;

	// ── Extract question text ──────────────────────────────────────────────────
	const question =
		typeof firstQ?.question === "string"
			? firstQ.question
			: typeof input.question === "string"
				? input.question
				: (title ?? "Question from Claude");

	// ── Extract options as string labels ───────────────────────────────────────
	const rawOptions: unknown[] = Array.isArray(firstQ?.options)
		? (firstQ.options as unknown[])
		: Array.isArray(input.options)
			? (input.options as unknown[])
			: [];

	const options = rawOptions.flatMap((o) => {
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

	return { question, options };
}
