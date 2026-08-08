import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { compareProviderBackgroundActivity } from "../lib/providerBackgroundActivity";
import type { ProviderBackgroundActivity } from "./agentProvider";

const MAX_RECENT_OUTPUT_CHARS = 8_192;

type ClaudeToolMetadata = {
	name: string;
	input: Record<string, unknown>;
};

type ClaudeBackgroundTask = {
	taskId: string;
	toolUseId?: string;
	sessionId: string;
	description?: string;
	taskType?: string;
	backgrounded: boolean;
	startedAtMs: number;
	updatedAtMs: number;
	recentOutput?: string;
};

function record(value: unknown): Record<string, unknown> | null {
	return typeof value === "object" && value !== null
		? (value as Record<string, unknown>)
		: null;
}

function nonEmptyString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value : undefined;
}

function boundedRecentOutput(value: string | undefined): string | undefined {
	if (!value) return undefined;
	return value.length <= MAX_RECENT_OUTPUT_CHARS
		? value
		: value.slice(-MAX_RECENT_OUTPUT_CHARS);
}

function backgroundTaskId(
	result: Record<string, unknown> | null,
): string | undefined {
	return nonEmptyString(result?.backgroundTaskId ?? result?.background_task_id);
}

function resultOutput(
	result: Record<string, unknown> | null,
): string | undefined {
	if (!result) return undefined;
	return boundedRecentOutput(
		[
			nonEmptyString(result.stdout),
			nonEmptyString(result.stderr),
			nonEmptyString(result.output),
		]
			.filter((value): value is string => Boolean(value))
			.join("\n"),
	);
}

function taskKind(
	task: ClaudeBackgroundTask,
	tool: ClaudeToolMetadata | undefined,
): ProviderBackgroundActivity["kind"] {
	if (
		task.taskType === "local_workflow" ||
		task.taskType === "remote_agent" ||
		tool?.name === "Workflow"
	) {
		return "workflow";
	}
	if (
		task.taskType === "subagent" ||
		task.taskType === "local_agent" ||
		task.taskType === "in_process_teammate" ||
		tool?.name === "Agent" ||
		tool?.name === "Task"
	) {
		return "agent";
	}
	if (task.taskType === "local_bash" || tool?.name === "Bash") return "shell";
	return "task";
}

/**
 * Event-backed projection of Claude's native background task registry.
 * `background_tasks_changed` replaces background membership, while task
 * lifecycle messages and structured results enrich entries with tool metadata
 * and output.
 */
export class ClaudeBackgroundActivityTracker {
	private sessionId = "";
	private tools = new Map<string, ClaudeToolMetadata>();
	private tasks = new Map<string, ClaudeBackgroundTask>();
	private observedMessages: SDKMessage[] = [];
	private retractedProviderFrames = new Set<string>();

	constructor(
		private readonly providerId: string,
		private readonly cwd: string,
	) {}

	reset(): void {
		this.observedMessages = [];
		this.retractedProviderFrames.clear();
		this.resetProjection();
	}

	private resetProjection(): void {
		this.sessionId = "";
		this.tools.clear();
		this.tasks.clear();
	}

	observe(message: SDKMessage): void {
		if (message.type === "system" && message.subtype === "init") {
			this.reset();
		}
		const frameKey = this.providerFrameKey(message);
		if (frameKey && this.retractedProviderFrames.has(frameKey)) return;
		this.observedMessages.push(message);
		this.apply(message);
	}

	retractProviderFrame(providerSessionId: string, providerUuid: string): void {
		if (!providerSessionId || !providerUuid) return;
		const key = `${providerSessionId}\0${providerUuid}`;
		if (this.retractedProviderFrames.has(key)) return;
		this.retractedProviderFrames.add(key);
		this.resetProjection();
		for (const message of this.observedMessages) {
			const frameKey = this.providerFrameKey(message);
			if (frameKey && this.retractedProviderFrames.has(frameKey)) continue;
			this.apply(message);
		}
	}

	private providerFrameKey(message: SDKMessage): string | null {
		if (message.type !== "assistant" && message.type !== "user") return null;
		const providerSessionId = nonEmptyString(
			(message as { session_id?: unknown }).session_id,
		);
		const providerUuid = nonEmptyString((message as { uuid?: unknown }).uuid);
		return providerSessionId && providerUuid
			? `${providerSessionId}\0${providerUuid}`
			: null;
	}

	private apply(message: SDKMessage): void {
		this.sessionId =
			nonEmptyString((message as { session_id?: unknown }).session_id) ??
			this.sessionId;
		if (message.type === "assistant") this.observeAssistant(message);
		if (message.type === "user") this.observeUser(message);
		if (message.type === "system") this.observeSystem(message);
		if (
			message.type === "result" &&
			message.terminal_reason === "background_requested"
		) {
			this.markBackgrounded();
		}
	}

	markBackgrounded(toolUseId?: string): number {
		let marked = 0;
		const now = Date.now();
		for (const [taskId, task] of this.tasks) {
			if (toolUseId && task.toolUseId !== toolUseId) continue;
			if (!task.backgrounded) marked++;
			this.tasks.set(taskId, {
				...task,
				backgrounded: true,
				updatedAtMs: now,
			});
		}
		return marked;
	}

	stop(taskId: string): void {
		this.removeTask(taskId);
	}

	list(): ProviderBackgroundActivity[] {
		return [...this.tasks.values()]
			.filter((task) => task.backgrounded)
			.map((task): ProviderBackgroundActivity => {
				const tool = task.toolUseId
					? this.tools.get(task.toolUseId)
					: undefined;
				const command = nonEmptyString(tool?.input.command);
				const description =
					task.description ??
					nonEmptyString(tool?.input.description) ??
					nonEmptyString(tool?.input.prompt);
				return {
					providerId: this.providerId,
					providerSessionId: task.sessionId || this.sessionId,
					activityId: task.taskId,
					kind: taskKind(task, tool),
					status: "running",
					...(command ? { command } : {}),
					...(description ? { description } : {}),
					...(this.cwd ? { cwd: this.cwd } : {}),
					...(task.recentOutput ? { recentOutput: task.recentOutput } : {}),
					startedAtMs: task.startedAtMs,
					updatedAtMs: task.updatedAtMs,
					capabilities: { stop: true },
				};
			})
			.sort(compareProviderBackgroundActivity);
	}

	private observeAssistant(
		message: Extract<SDKMessage, { type: "assistant" }>,
	): void {
		for (const block of message.message.content) {
			if (block.type !== "tool_use") continue;
			this.tools.set(block.id, {
				name: block.name,
				input: record(block.input) ?? {},
			});
		}
	}

	private observeUser(message: Extract<SDKMessage, { type: "user" }>): void {
		const content = record(message.message)?.content;
		if (!Array.isArray(content)) return;
		const structuredResult = record(message.tool_use_result);
		for (const rawBlock of content) {
			const block = record(rawBlock);
			if (block?.type !== "tool_result") continue;
			const toolUseId = nonEmptyString(block.tool_use_id);
			const result = record(block.content) ?? structuredResult;
			const taskId = backgroundTaskId(result);
			if (!taskId) {
				if (
					toolUseId &&
					![...this.tasks.values()].some((task) => task.toolUseId === toolUseId)
				) {
					this.tools.delete(toolUseId);
				}
				continue;
			}
			const now = Date.now();
			const current = this.tasks.get(taskId);
			const recentOutput = resultOutput(result);
			this.tasks.set(taskId, {
				taskId,
				...(toolUseId ? { toolUseId } : {}),
				sessionId: message.session_id || current?.sessionId || this.sessionId,
				...(current?.description ? { description: current.description } : {}),
				...(current?.taskType ? { taskType: current.taskType } : {}),
				backgrounded: true,
				startedAtMs: current?.startedAtMs ?? now,
				updatedAtMs: now,
				...(recentOutput
					? { recentOutput }
					: current?.recentOutput
						? { recentOutput: current.recentOutput }
						: {}),
			});
		}
	}

	private observeSystem(
		message: Extract<SDKMessage, { type: "system" }>,
	): void {
		if (message.subtype === "background_tasks_changed") {
			this.replaceBackgroundTasks(message);
			return;
		}
		const taskMessage = message as Extract<SDKMessage, { type: "system" }> &
			Record<string, unknown>;
		const subtype = nonEmptyString(taskMessage.subtype);
		const taskId = nonEmptyString(taskMessage.task_id);
		if (!taskId) return;
		if (subtype === "task_notification") {
			this.removeTask(taskId);
			return;
		}
		const now = Date.now();
		const current = this.tasks.get(taskId);
		if (subtype === "task_started") {
			const toolUseId = nonEmptyString(taskMessage.tool_use_id);
			this.tasks.set(taskId, {
				taskId,
				...(toolUseId ? { toolUseId } : {}),
				sessionId: message.session_id || current?.sessionId || this.sessionId,
				...(nonEmptyString(taskMessage.description)
					? { description: nonEmptyString(taskMessage.description) }
					: {}),
				...(nonEmptyString(taskMessage.task_type)
					? { taskType: nonEmptyString(taskMessage.task_type) }
					: {}),
				backgrounded: current?.backgrounded ?? false,
				startedAtMs: current?.startedAtMs ?? now,
				updatedAtMs: now,
				...(current?.recentOutput
					? { recentOutput: current.recentOutput }
					: {}),
			});
			return;
		}
		if (!current) return;
		if (subtype === "task_progress") {
			const summary =
				nonEmptyString(taskMessage.summary) ??
				nonEmptyString(taskMessage.last_tool_name);
			this.tasks.set(taskId, {
				...current,
				...(nonEmptyString(taskMessage.description)
					? { description: nonEmptyString(taskMessage.description) }
					: {}),
				...(summary ? { recentOutput: boundedRecentOutput(summary) } : {}),
				updatedAtMs: now,
			});
			return;
		}
		if (subtype !== "task_updated") return;
		const update = record(taskMessage.patch) ?? {};
		const status = nonEmptyString(update.status);
		if (status === "completed" || status === "failed" || status === "killed") {
			this.removeTask(taskId);
			return;
		}
		this.tasks.set(taskId, {
			...current,
			...(typeof update.is_backgrounded === "boolean"
				? { backgrounded: update.is_backgrounded }
				: {}),
			...(nonEmptyString(update.description)
				? { description: nonEmptyString(update.description) }
				: {}),
			...(nonEmptyString(update.error)
				? { recentOutput: boundedRecentOutput(nonEmptyString(update.error)) }
				: {}),
			updatedAtMs: now,
		});
	}

	private replaceBackgroundTasks(
		message: Extract<
			SDKMessage,
			{ type: "system"; subtype: "background_tasks_changed" }
		>,
	): void {
		const now = Date.now();
		const nextTasks = new Map<string, ClaudeBackgroundTask>();
		for (const [taskId, task] of this.tasks) {
			if (!task.backgrounded) nextTasks.set(taskId, task);
		}
		for (const task of message.tasks) {
			const taskId = nonEmptyString(task.task_id);
			if (!taskId) continue;
			const current = this.tasks.get(taskId);
			const description =
				nonEmptyString(task.description) ?? current?.description;
			const taskType = nonEmptyString(task.task_type) ?? current?.taskType;
			const sessionId =
				message.session_id || current?.sessionId || this.sessionId;
			const changed =
				!current ||
				!current.backgrounded ||
				current.sessionId !== sessionId ||
				current.description !== description ||
				current.taskType !== taskType;
			nextTasks.set(taskId, {
				taskId,
				...(current?.toolUseId ? { toolUseId: current.toolUseId } : {}),
				sessionId,
				...(description ? { description } : {}),
				...(taskType ? { taskType } : {}),
				backgrounded: true,
				startedAtMs: current?.startedAtMs ?? now,
				updatedAtMs: changed ? now : (current?.updatedAtMs ?? now),
				...(current?.recentOutput
					? { recentOutput: current.recentOutput }
					: {}),
			});
		}

		const retainedToolUseIds = new Set(
			[...nextTasks.values()]
				.map((task) => task.toolUseId)
				.filter((toolUseId): toolUseId is string => Boolean(toolUseId)),
		);
		for (const [taskId, task] of this.tasks) {
			if (nextTasks.has(taskId)) continue;
			if (task.toolUseId && !retainedToolUseIds.has(task.toolUseId)) {
				this.tools.delete(task.toolUseId);
			}
		}
		this.tasks = nextTasks;
	}

	private removeTask(taskId: string): void {
		const toolUseId = this.tasks.get(taskId)?.toolUseId;
		this.tasks.delete(taskId);
		if (toolUseId) this.tools.delete(toolUseId);
	}
}
