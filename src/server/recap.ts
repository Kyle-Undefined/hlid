import { query } from "@anthropic-ai/claude-agent-sdk";
import * as db from "../db";
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
): Promise<void> {
	const userExcerpt = userMessage.slice(0, 300).replace(/\n+/g, " ").trim();
	const assistantExcerpt = assistantText
		.slice(0, 1200)
		.replace(/\n+/g, " ")
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

	const prompt = [
		"A coding assistant just completed a turn. Summarize what was accomplished in ONE concise sentence (≤20 words, present tense, active voice). Reply with only the sentence, no preamble.",
		"",
		`User request: ${userExcerpt}`,
		"",
		`Tools used:\n${toolLines}`,
		"",
		`Assistant response excerpt: ${assistantExcerpt}`,
	].join("\n");
	const ac = new AbortController();
	const timeout = setTimeout(() => ac.abort(), 30_000);
	try {
		const conv = query({
			prompt,
			options: {
				cwd: vaultPath,
				model: "claude-haiku-4-5",
				effort: "low" as const,
				maxTurns: 1,
				persistSession: false,
				abortController: ac,
				settingSources: ["user"],
				allowDangerouslySkipPermissions: false,
				canUseTool: () =>
					Promise.resolve({ behavior: "deny" as const, message: "no tools" }),
				...(claudeExecutable !== undefined && {
					pathToClaudeCodeExecutable: claudeExecutable,
				}),
			},
		});
		let summary = "";
		for await (const msg of conv) {
			if (msg.type === "assistant") {
				for (const block of msg.message.content) {
					if (block.type === "text") summary += block.text;
				}
			}
			if (
				msg.type === "result" &&
				msg.subtype === "success" &&
				!summary &&
				msg.result
			) {
				summary = msg.result;
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
