import * as db from "../db";
import type { AgentEvent, AgentProvider } from "./agentProvider";
import { bumpDataRevision } from "./dataRevision";
import type { ServerMessage } from "./protocol";

export type GenerateTurnRecapOptions = {
	sessionId: string | null;
	assistantSeq: number;
	userMessage: string;
	toolEvents: { name: string; input: unknown }[];
	assistantText: string;
	emit: (msg: ServerMessage) => void;
	vaultPath: string;
	executable?: string;
	sdkSummary?: string | null;
	provider?: AgentProvider;
	recapModel?: string;
	agentCwd?: string | null;
};

async function recordRecapUsage(
	sessionId: string,
	provider: AgentProvider,
	recapModel: string,
	agentCwd: string | null | undefined,
	event: Extract<AgentEvent, { type: "done" }>,
	actualModel: string | null,
	contextWindow: number | null,
): Promise<void> {
	const primaryModelId = event.modelUsage
		? Object.keys(event.modelUsage)[0]
		: undefined;
	const primaryModel = event.modelUsage
		? Object.values(event.modelUsage)[0]
		: undefined;
	const inputTokens = event.usage?.inputTokens ?? 0;
	const cacheReadTokens = event.usage?.cacheReadTokens ?? 0;
	const cacheCreationTokens = event.usage?.cacheCreationTokens ?? 0;
	await db.recordQuery(
		sessionId,
		{
			cost: event.cost ?? 0,
			cost_known:
				event.costKnown ??
				(typeof event.cost === "number" ||
					typeof event.estimatedCost === "number"),
			estimated_cost: event.estimatedCost ?? null,
			input_tokens: inputTokens,
			output_tokens: event.usage?.outputTokens ?? 0,
			cache_read_tokens: cacheReadTokens,
			cache_creation_tokens: cacheCreationTokens,
			duration_ms: event.durationMs,
			turns: event.turns,
			context_window: primaryModel?.contextWindow ?? contextWindow,
			// Recaps are real provider calls, but remain auxiliary accounting facts:
			// persistSession=false keeps them out of Raven/provider history and this
			// sentinel keeps their ephemeral context from replacing the chat context.
			stop_reason: "turn_recap",
			tokens_in_context: inputTokens + cacheReadTokens + cacheCreationTokens,
			model: actualModel ?? primaryModelId ?? recapModel,
			agent_cwd: agentCwd ?? null,
		},
		provider.providerId,
	);
	bumpDataRevision("stats", "sessions");
}

export async function generateTurnRecap({
	sessionId,
	assistantSeq,
	userMessage,
	toolEvents,
	assistantText,
	emit,
	vaultPath,
	executable,
	sdkSummary = null,
	provider,
	recapModel = "claude-haiku-4-5",
	agentCwd,
}: GenerateTurnRecapOptions): Promise<void> {
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
			cwd: vaultPath,
			model: recapModel,
			effort: "low",
			maxTurns: 1,
			persistSession: false,
			signal: ac.signal,
			settingSources: ["user"],
			executable,
			canUseTool: () =>
				Promise.resolve({ behavior: "deny" as const, message: "no tools" }),
		});
		// Streaming-input mode: push the recap prompt then close the input so
		// the SDK process sees EOF after this turn and exits instead of waiting
		// indefinitely for more messages.
		await session.send(prompt);
		session.closeInput?.();
		let summary = "";
		let usageRecorded = false;
		let actualModel: string | null = null;
		let contextWindow: number | null = null;
		for await (const event of session) {
			if (event.type === "text_delta") {
				summary += event.text;
			} else if (event.type === "usage") {
				if (event.model) actualModel = event.model;
				if (event.contextWindow) contextWindow = event.contextWindow;
			} else if (event.type === "done" && sessionId && !usageRecorded) {
				// Some provider adapters can surface duplicate terminal notifications.
				// The recap call is one inference, so account its first successfully
				// persisted completion once. A duplicate done may retry a transient DB
				// failure without charging twice after the atomic recordQuery succeeds.
				try {
					await recordRecapUsage(
						sessionId,
						provider,
						recapModel,
						agentCwd,
						event,
						actualModel,
						contextWindow,
					);
					usageRecorded = true;
				} catch (e) {
					console.error("[db] record recap usage failed:", e);
				}
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
		const isAbort =
			e instanceof Error &&
			(e.name === "AbortError" || e.message.includes("aborted by user"));
		if (!isAbort) {
			console.error("[recap] generateTurnRecap failed:", e);
		}
	} finally {
		clearTimeout(timeout);
	}
}
