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
	sdkSummary: string | null = null,
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
