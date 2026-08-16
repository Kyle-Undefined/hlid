import {
	appendMessage,
	appendToolEvent,
	createSession,
	getDb,
	recordQuery,
	setCurrentSessionId,
	setMessageQueryId,
	setSessionAgentCwd,
	setSessionProviderId,
	setSessionProviderSession,
	setToolEventResult,
} from "../../src/db";
import type {
	SubagentSnapshot,
	TaskActivity,
} from "../../src/server/agentProvider";

export const PERF_SESSION_ID = "perf-session";
export const PERF_READY_SENTINEL = "PERF_READY_SENTINEL";
export const PERF_OLDER_TOOL_PAYLOAD_SENTINEL =
	"PERF_OLDER_TOOL_PAYLOAD_SENTINEL";
export const PERF_CONTEXT_PAYLOAD_SENTINEL = "PERF_CONTEXT_PAYLOAD_SENTINEL";

const root = process.cwd();
const messageCount = 240;
const latestToolCount = 260;
const olderMixedToolCount = 260;
const largeMarkdownChars = 58_000;
const initialHistoryMessageCount = 20;
const initialAssistantCount = initialHistoryMessageCount / 2;
const recentContextManifestSeq = messageCount - 2;

function realisticMarkdownResponse({
	response,
	targetChars,
	ready,
}: {
	response: number;
	targetChars: number;
	ready: boolean;
}): string {
	const suffix = ready ? `\n\n${PERF_READY_SENTINEL}` : "";
	const bodyTarget = targetChars - suffix.length;
	const sections = [
		`## Performance investigation ${response}`,
		[
			"The session loader restored the newest transcript window and correlated its persisted tool activity.",
			"This response deliberately resembles a long engineering update: prose, headings, tables, lists, inline code, and fenced source all share one Markdown tree.",
		].join(" "),
		[
			"| Stage | Evidence | Expected behavior |",
			"| --- | --- | --- |",
			"| History query | bounded cursor window | newest messages appear first |",
			"| Tool hydration | persisted summaries | collapsed activity remains available |",
			"| Render | Markdown plus controls | composer becomes interactive |",
		].join("\n"),
		[
			"```ts",
			`const responseId = "perf-response-${response}";`,
			'const stages = ["query", "hydrate", "render"] as const;',
			"const ready = stages.every((stage) => stage.length > 0);",
			"```",
		].join("\n"),
	];
	let body = sections.join("\n\n");
	let check = 1;
	while (true) {
		const next = [
			`### Check ${response}.${check}`,
			[
				`The trace for \`message-${response}-${check}\` keeps ordering stable while the assistant response is parsed.`,
				"A settled chunk can contain ordinary explanation beside compact tool summaries, so the fixture retains both textual and structural work instead of repeating one plain paragraph.",
				"The visible result should arrive without waiting for older cursor pages, provider discovery, or delayed interaction-card metadata.",
			].join(" "),
			[
				`- verify cursor continuity for segment ${check}`,
				"- preserve collapsed activity placement",
				"- keep the newest response and composer usable",
				"- record the first visible transcript paint separately from full readiness",
			].join("\n"),
		].join("\n\n");
		if (body.length + 2 + next.length > bodyTarget - 240) break;
		body += `\n\n${next}`;
		check++;
	}

	const remaining = bodyTarget - body.length;
	if (remaining > 0) {
		const separator = remaining >= 2 ? "\n\n" : "";
		const observation =
			"Additional observation: the transcript remains readable while Raven restores durable history and keeps expensive details collapsed. ";
		const fillerLength = remaining - separator.length;
		const filler = observation
			.repeat(Math.ceil(Math.max(0, fillerLength) / observation.length))
			.slice(0, Math.max(0, fillerLength));
		body += separator + filler;
	}
	return `${body}${suffix}`;
}

await createSession(PERF_SESSION_ID, "Performance gate", "fake-fast", {
	effort: "medium",
	permissionMode: "default",
});
await setSessionAgentCwd(PERF_SESSION_ID, root);
await setSessionProviderId(PERF_SESSION_ID, "acp:opencode");
await setSessionProviderSession(
	PERF_SESSION_ID,
	"acp:opencode",
	"perf-provider-session",
);

let seededMarkdownChars = 0;
const firstLargeAssistantSeq = messageCount - initialHistoryMessageCount + 1;
for (let seq = 0; seq < messageCount; seq++) {
	if (seq % 2 === 0) {
		const contextManifestJson =
			seq === recentContextManifestSeq
				? JSON.stringify({
						contractVersion: 1,
						payloadSentinel: PERF_CONTEXT_PAYLOAD_SENTINEL,
						entries: [
							{
								kind: "workspace",
								path: "/tmp/performance-fixture",
								content: "context-receipt-payload ".repeat(3_200),
							},
						],
					})
				: undefined;
		await appendMessage(
			PERF_SESSION_ID,
			seq,
			"user",
			`Synthetic prompt ${seq / 2}: inspect the performance fixture without changing behavior.`,
			undefined,
			undefined,
			contextManifestJson,
		);
		continue;
	}
	const isLast = seq === messageCount - 1;
	const isLargeInitialResponse = seq >= firstLargeAssistantSeq;
	const largeResponseIndex = isLargeInitialResponse
		? (seq - firstLargeAssistantSeq) / 2
		: -1;
	const largeResponseTarget =
		Math.floor(largeMarkdownChars / initialAssistantCount) +
		(largeResponseIndex >= 0 &&
		largeResponseIndex < largeMarkdownChars % initialAssistantCount
			? 1
			: 0);
	const text = isLargeInitialResponse
		? realisticMarkdownResponse({
				response: Math.ceil(seq / 2),
				targetChars: largeResponseTarget,
				ready: isLast,
			})
		: [
				`## Synthetic response ${Math.ceil(seq / 2)}`,
				"",
				"This fixture exercises **Markdown**, stable historical rows, and bounded transcript rendering.",
				"",
				"- one reusable performance sample",
				"- one code path kept behaviorally identical",
				"",
				"```ts",
				`const sample = ${seq};`,
				"```",
			].join("\n");
	if (isLargeInitialResponse) seededMarkdownChars += text.length;
	await appendMessage(PERF_SESSION_ID, seq, "assistant", text);
}

if (seededMarkdownChars !== largeMarkdownChars) {
	throw new Error(
		`Expected ${largeMarkdownChars} visible Markdown characters, seeded ${seededMarkdownChars}`,
	);
}

async function markAssistantSettled(assistantSeq: number): Promise<void> {
	const settledQuery = await recordQuery(
		PERF_SESSION_ID,
		{
			cost: 0,
			cost_known: true,
			estimated_cost: null,
			input_tokens: 1_200,
			output_tokens: 600,
			cache_read_tokens: 0,
			cache_creation_tokens: 0,
			duration_ms: 1_000,
			turns: 1,
			context_window: 200_000,
			stop_reason: "end_turn",
			tokens_in_context: 1_800,
			model: "fake-fast",
			agent_cwd: root,
		},
		"acp:opencode",
	);
	await setMessageQueryId(PERF_SESSION_ID, assistantSeq, settledQuery.queryId);
}

// Keep the newest response eligible for SQL paging so the existing activity
// reveal continues to exercise server-backed pagination.
const latestToolAssistantSeq = messageCount - 1;
await markAssistantSettled(latestToolAssistantSeq);
for (let index = 0; index < latestToolCount; index++) {
	const toolId = `perf-tool-${index}`;
	await appendToolEvent(
		PERF_SESSION_ID,
		latestToolAssistantSeq,
		toolId,
		index % 3 === 0 ? "Read" : index % 3 === 1 ? "Bash" : "Edit",
		{
			path: `/tmp/perf-fixture-${index}.txt`,
			command: `printf performance-${index}`,
		},
	);
	await setToolEventResult(
		PERF_SESSION_ID,
		toolId,
		`performance result ${index}`,
		false,
	);
}

// This response is the 21st lookahead row. Its mixed metadata makes the whole
// response ineligible for per-response SQL paging. Compact history must retain
// the row for has-older detection without enriching or serializing its tools.
const olderToolAssistantSeq = messageCount - initialHistoryMessageCount - 1;
await markAssistantSettled(olderToolAssistantSeq);
for (let index = 0; index < olderMixedToolCount; index++) {
	const toolId = `perf-older-tool-${index}`;
	const fixtureKind = index % 4;
	const isSubagent = fixtureKind <= 1;
	const isTaskActivity = fixtureKind === 2;
	const subagent: SubagentSnapshot | undefined = isSubagent
		? {
				provider: "codex",
				agentId: `perf-older-child-${index}`,
				name: `fixture-auditor-${index}`,
				prompt: "Inspect one bounded portion of the performance fixture.",
				model: "fake-fast",
				effort: "medium",
				status: "completed",
				currentStep: "Reported findings",
				resultPreview: "The assigned fixture segment is internally consistent.",
				startedAtMs: 1_000 + index * 10,
				endedAtMs: 1_005 + index * 10,
			}
		: undefined;
	const taskActivity: TaskActivity | undefined = isTaskActivity
		? {
				kind: "tasks",
				source: "codex-plan",
				operation: "snapshot",
				explanation:
					"Persist representative task metadata in the large response.",
				items: [
					{
						id: `perf-older-task-${index}-1`,
						subject: "Inspect transcript window",
						status: "completed",
					},
					{
						id: `perf-older-task-${index}-2`,
						subject: "Correlate tool summaries",
						status: "completed",
					},
				],
			}
		: undefined;
	const name = isSubagent
		? "spawn_agent"
		: isTaskActivity
			? "update_plan"
			: index % 3 === 0
				? "Read"
				: index % 3 === 1
					? "Bash"
					: "Edit";
	await appendToolEvent(
		PERF_SESSION_ID,
		olderToolAssistantSeq,
		toolId,
		name,
		{
			path: `/tmp/perf-older-fixture-${index}.txt`,
			command: `printf older-performance-${index}`,
			...(index === 0
				? { payloadSentinel: PERF_OLDER_TOOL_PAYLOAD_SENTINEL }
				: {}),
		},
		subagent,
		undefined,
		taskActivity,
	);
	await setToolEventResult(
		PERF_SESSION_ID,
		toolId,
		index === 0
			? `${PERF_OLDER_TOOL_PAYLOAD_SENTINEL}: older performance result`
			: `older performance result ${index}`,
		false,
	);
}

await setCurrentSessionId(PERF_SESSION_ID);
const db = await getDb();
db.run("PRAGMA wal_checkpoint(TRUNCATE)");
db.close();

console.log(
	`Seeded ${messageCount} messages, ${seededMarkdownChars} visible Markdown characters, ${latestToolCount} latest pageable tool calls, and ${olderMixedToolCount} older mixed tool calls in ${root}`,
);
