import type { SubagentSnapshot, SubagentStatus } from "#/server/agentProvider";
import type { ToolEventMessage } from "#/server/protocol";

export type WorkflowTranscriptMessage = {
	id: string;
	role: string;
	toolEvents?: ToolEventMessage[];
};

export type WorkflowRun = {
	/** Stable transcript identity for UI selection while provider metadata evolves. */
	selectionKey: string;
	/** Provider run identity used to deduplicate native resume events. */
	key: string;
	eventId: string;
	messageId: string;
	workflow: SubagentSnapshot;
	args?: unknown;
	children: SubagentSnapshot[];
	order: number;
};

export function isActiveWorkflowStatus(status: SubagentStatus): boolean {
	return status === "pending" || status === "running" || status === "paused";
}

function workflowKey(
	messageId: string,
	eventId: string,
	workflow: SubagentSnapshot,
): string {
	return (
		workflow.workflowRunId ??
		workflow.taskId ??
		workflow.agentId ??
		`${messageId}:${eventId}`
	);
}

/**
 * Build a current-session workflow index from Raven's hydrated transcript.
 *
 * A native resume can create a new parent tool event for the same run id, so
 * parents are deduplicated by run identity while every historical parent id is
 * retained for child correlation. The newest parent/child snapshot wins.
 */
export function collectWorkflowRuns(
	messages: ReadonlyArray<WorkflowTranscriptMessage>,
): WorkflowRun[] {
	const runs = new Map<string, WorkflowRun>();
	const runKeyByParentId = new Map<string, string>();
	let order = 0;

	for (const message of messages) {
		if (message.role !== "assistant") continue;
		for (const event of message.toolEvents ?? []) {
			order += 1;
			const workflow = event.subagent;
			if (workflow?.kind !== "workflow") continue;
			const key = workflowKey(message.id, event.id, workflow);
			const previous = runs.get(key);
			const input =
				typeof event.input === "object" && event.input !== null
					? (event.input as Record<string, unknown>)
					: null;
			runs.set(key, {
				selectionKey: `${message.id}:${event.id}`,
				key,
				eventId: event.id,
				messageId: message.id,
				workflow,
				...(input && Object.hasOwn(input, "args")
					? { args: input.args }
					: previous && Object.hasOwn(previous, "args")
						? { args: previous.args }
						: {}),
				children: previous?.children ?? [],
				order,
			});
			runKeyByParentId.set(workflow.agentId, key);
			if (workflow.taskId) runKeyByParentId.set(workflow.taskId, key);
		}
	}

	const childSnapshots = new Map<
		string,
		Map<string, { snapshot: SubagentSnapshot; order: number }>
	>();
	order = 0;
	for (const message of messages) {
		if (message.role !== "assistant") continue;
		for (const event of message.toolEvents ?? []) {
			order += 1;
			const child = event.subagent;
			if (!child || child.kind === "workflow" || !child.parentActivityId) {
				continue;
			}
			const key = runKeyByParentId.get(child.parentActivityId);
			if (!key) continue;
			const children = childSnapshots.get(key) ?? new Map();
			children.set(`${child.provider}:${child.agentId}`, {
				snapshot: child,
				order,
			});
			childSnapshots.set(key, children);
		}
	}

	for (const [key, children] of childSnapshots) {
		const run = runs.get(key);
		if (!run) continue;
		run.children = [...children.values()]
			.sort(
				(a, b) =>
					a.snapshot.startedAtMs - b.snapshot.startedAtMs || a.order - b.order,
			)
			.map(({ snapshot }) => snapshot);
	}

	return [...runs.values()].sort((a, b) => {
		const activeDifference =
			Number(isActiveWorkflowStatus(b.workflow.status)) -
			Number(isActiveWorkflowStatus(a.workflow.status));
		return activeDifference || b.order - a.order;
	});
}

export function workflowTokenTotal(run: WorkflowRun): number | null {
	if (run.workflow.usage?.totalTokens !== undefined) {
		return run.workflow.usage.totalTokens;
	}
	const childTokens = run.children.reduce(
		(total, child) => total + (child.usage?.totalTokens ?? 0),
		0,
	);
	return childTokens > 0 ? childTokens : null;
}

export function workflowDurationMs(run: WorkflowRun, now = Date.now()): number {
	return (
		run.workflow.usage?.durationMs ??
		Math.max(
			0,
			(isActiveWorkflowStatus(run.workflow.status)
				? now
				: (run.workflow.endedAtMs ?? now)) - run.workflow.startedAtMs,
		)
	);
}

export function workflowResumePrompt(subagent: SubagentSnapshot): string {
	const runId = subagent.workflowRunId ?? "";
	const workflowName = subagent.name ?? subagent.label ?? "workflow";
	const priorTaskId = subagent.taskId ?? subagent.agentId;
	const stopContext = subagent.workflowStopConfirmed
		? [
				`Hlid requested the stop and observed native workflow task ${JSON.stringify(priorTaskId)} enter the stopped state.`,
			]
		: [
				`Hlid's last recorded workflow status is ${JSON.stringify(subagent.status)}.`,
			];
	return [
		`Resume the native Claude Workflow ${JSON.stringify(workflowName)}.`,
		...stopContext,
		`Invoke the Workflow tool with resumeFromRunId set to ${JSON.stringify(runId)}.`,
		...(subagent.workflowScriptPath
			? [
					`Reuse the persisted scriptPath ${JSON.stringify(subagent.workflowScriptPath)}.`,
				]
			: []),
		"Continue that workflow rather than starting a new one.",
	].join(" ");
}

function argsInstruction(args: unknown): string[] {
	if (args === undefined) return [];
	const serialized = JSON.stringify(args);
	return serialized
		? [`Pass args exactly as this JSON value: ${serialized}.`]
		: [];
}

export function workflowRerunPrompt(
	subagent: SubagentSnapshot,
	args?: unknown,
): string {
	const workflowName = subagent.name ?? subagent.label ?? "workflow";
	if (!subagent.workflowScriptPath) {
		return `Run a fresh native Claude Workflow ${JSON.stringify(workflowName)}. Recreate it from the workflow already visible in this conversation. Do not resume the prior run.`;
	}
	return [
		`Run a fresh native Claude Workflow ${JSON.stringify(workflowName)}.`,
		`Invoke the Workflow tool with scriptPath set to ${JSON.stringify(subagent.workflowScriptPath)}.`,
		...argsInstruction(args),
		"Do not pass resumeFromRunId. Start a new run from the persisted script.",
	].join(" ");
}

export function savedWorkflowRunPrompt(
	workflow: { name: string; scriptPath: string },
	input?: string,
): string {
	const userInput = input?.trim();
	return [
		`Run the saved native Claude Workflow ${JSON.stringify(workflow.name)}.`,
		`Invoke the Workflow tool with scriptPath set to ${JSON.stringify(workflow.scriptPath)}.`,
		...(userInput
			? [
					`Use this user input to populate the workflow's args in the form its script expects: ${JSON.stringify(userInput)}.`,
				]
			: []),
		"Do not pass resumeFromRunId. Start a fresh run.",
	].join(" ");
}
