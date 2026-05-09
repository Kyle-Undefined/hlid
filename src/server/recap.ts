import * as db from "../db";
import type { AgentProvider } from "./agentProvider";
import type { ServerMessage } from "./protocol";

export async function generateTurnRecap(
	sessionId: string | null,
	assistantSeq: number,
	userMessage: string,
	toolEvents: { name: string; input: unknown }[],
	assistantText: string,
	emit: (msg: ServerMessage) => void,
	vaultPath: string,
	claudeExecutable: string | undefined,
	sdkSummary: string | null = null,
	provider?: AgentProvider, // required in practice; optional for legacy call sites
	recapModel = "claude-haiku-4-5",
): Promise<void> {
	const userExcerpt = userMessage
		.slice(0, 600)
		.replace(/\n{3,}/g, "\n\n")
		.trim();
	const assistantExcerpt = assistantText
		.slice(0, 2400)
		.replace(/\n{3,}/g, "\n\n")
		.trim();

	// Build a compact tool summary: name + key input field (path, command, etc.)
	const toolLines = toolEvents
		.map((te) => {
			const inp = te.input as Record<string, unknown> | null;
			const detail =
				typeof inp?.path === "string"
					? inp.path
					: typeof inp?.command === "string"
						? inp.command.slice(0, 80)
						: typeof inp?.file_path === "string"
							? inp.file_path
							: null;
			return detail ? `  - ${te.name}(${detail})` : `  - ${te.name}`;
		})
		.join("\n");

	const parts = [
		"A coding assistant just completed a turn. Summarize in ONE concise sentence (≤20 words, past tense) what was accomplished. Reply with only the sentence, no preamble.",
		"",
		`User: ${userExcerpt}`,
		"",
		`Assistant: ${assistantExcerpt}`,
	];

	if (sdkSummary) {
		parts.push("", `Claude's recap: ${sdkSummary}`);
	}

	if (toolLines) {
		parts.push("", `Tools used:\n${toolLines}`);
	}

	const prompt = parts.join("\n");
	if (!provider) return;
	const ac = new AbortController();
	const timeout = setTimeout(() => ac.abort(), 30_000);
	try {
		const session = provider.query({
			prompt,
			cwd: vaultPath,
			model: recapModel,
			effort: "low",
			maxTurns: 1,
			persistSession: false,
			signal: ac.signal,
			settingSources: ["user"],
			executable: claudeExecutable,
			canUseTool: () =>
				Promise.resolve({ behavior: "deny" as const, message: "no tools" }),
		});
		let summary = "";
		for await (const event of session) {
			if (event.type === "text_delta") {
				summary += event.text;
			}
		}
		const trimmed = summary.trim();
		if (trimmed) {
			if (sessionId && assistantSeq >= 0) {
				await db
					.setMessageRecap(sessionId, assistantSeq, trimmed)
					.catch((e) => {
						console.error("[db] setMessageRecap failed:", e);
					});
			}
			emit({ type: "tool_use_summary", summary: trimmed });
		}
	} catch (e) {
		if (e instanceof Error && e.name === "AbortError") {
			// expected: 30s timeout fired
		} else {
			console.error("[recap] generateTurnRecap failed:", e);
		}
	} finally {
		clearTimeout(timeout);
	}
}
