import {
	appendMessage,
	appendToolEvent,
	createSession,
	getDb,
	setCurrentSessionId,
	setSessionAgentCwd,
	setSessionProviderId,
	setSessionProviderSession,
	setToolEventResult,
} from "../../src/db";

export const PERF_SESSION_ID = "perf-session";
export const PERF_READY_SENTINEL = "PERF_READY_SENTINEL";

const root = process.cwd();
const messageCount = 240;
const toolCount = 260;

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

for (let seq = 0; seq < messageCount; seq++) {
	if (seq % 2 === 0) {
		await appendMessage(
			PERF_SESSION_ID,
			seq,
			"user",
			`Synthetic prompt ${seq / 2}: inspect the performance fixture without changing behavior.`,
		);
		continue;
	}
	const isLast = seq === messageCount - 1;
	await appendMessage(
		PERF_SESSION_ID,
		seq,
		"assistant",
		[
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
			isLast ? PERF_READY_SENTINEL : "",
		].join("\n"),
	);
}

const toolAssistantSeq = messageCount - 1;
for (let index = 0; index < toolCount; index++) {
	const toolId = `perf-tool-${index}`;
	await appendToolEvent(
		PERF_SESSION_ID,
		toolAssistantSeq,
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

await setCurrentSessionId(PERF_SESSION_ID);
const db = await getDb();
db.run("PRAGMA wal_checkpoint(TRUNCATE)");
db.close();

console.log(
	`Seeded ${messageCount} messages and ${toolCount} tool calls in ${root}`,
);
