import type {
	TaskActivity,
	TaskActivityItem,
	TaskActivityStatus,
} from "./agentProvider";

const MAX_ITEMS = 100;
const MAX_TEXT = 4_000;
const MAX_ID = 256;

function record(value: unknown): Record<string, unknown> | null {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function text(value: unknown, max = MAX_TEXT): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	if (!trimmed) return undefined;
	return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max - 1)}…`;
}

function strings(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const values = value
		.slice(0, MAX_ITEMS)
		.map((entry) => text(entry, MAX_ID))
		.filter((entry): entry is string => Boolean(entry));
	return values.length > 0 ? values : undefined;
}

function status(value: unknown): TaskActivityStatus | undefined {
	return value === "pending" ||
		value === "in_progress" ||
		value === "completed" ||
		value === "deleted"
		? value
		: undefined;
}

function itemFromTask(value: unknown): TaskActivityItem | null {
	const task = record(value);
	if (!task) return null;
	const id = text(task.id ?? task.taskId, MAX_ID);
	const subject = text(task.subject ?? task.content);
	if (!subject && !id) return null;
	const description = text(task.description);
	const activeForm = text(task.activeForm);
	const taskStatus = status(task.status);
	const owner = text(task.owner, MAX_ID);
	const blockedBy = strings(task.blockedBy);
	const blocks = strings(task.blocks);
	return {
		...(id ? { id } : {}),
		subject: subject ?? `Task ${id}`,
		...(description ? { description } : {}),
		...(activeForm ? { activeForm } : {}),
		...(taskStatus ? { status: taskStatus } : {}),
		...(owner ? { owner } : {}),
		...(blockedBy ? { blockedBy } : {}),
		...(blocks ? { blocks } : {}),
	};
}

function itemsFrom(value: unknown): TaskActivityItem[] {
	if (!Array.isArray(value)) return [];
	return value
		.slice(0, MAX_ITEMS)
		.map(itemFromTask)
		.filter((item): item is TaskActivityItem => item !== null);
}

function taskArray(value: unknown): unknown[] | undefined {
	const root = record(value);
	if (!root) return undefined;
	if (Array.isArray(root.tasks)) return root.tasks;
	if (Array.isArray(root.todos)) return root.todos;
	if (Array.isArray(root.newTodos)) return root.newTodos;
	const nested =
		record(root.result) ?? record(root.output) ?? record(root.content);
	return nested ? taskArray(nested) : undefined;
}

function taskObject(value: unknown): Record<string, unknown> | null {
	const root = record(value);
	if (!root) return null;
	const task = record(root.task);
	if (task) return task;
	const nested =
		record(root.result) ?? record(root.output) ?? record(root.content);
	return nested ? taskObject(nested) : null;
}

/** Parse Codex's provider-native update_plan input without name heuristics. */
export function codexPlanActivity(input: unknown): TaskActivity | undefined {
	const root = record(input);
	if (!root || !Array.isArray(root.plan)) return undefined;
	const items = root.plan
		.slice(0, MAX_ITEMS)
		.flatMap((value): TaskActivityItem[] => {
			const step = record(value);
			const subject = text(step?.step);
			const taskStatus = status(step?.status);
			return subject
				? [{ subject, ...(taskStatus ? { status: taskStatus } : {}) }]
				: [];
		});
	const explanation = text(root.explanation);
	return {
		kind: "tasks",
		source: "codex-plan",
		operation: "snapshot",
		...(explanation ? { explanation } : {}),
		items,
	};
}

/** Parse Claude's native task/todo tool input at tool start. */
export function claudeTaskActivityStart(
	name: string,
	input: unknown,
): TaskActivity | undefined {
	const root = record(input) ?? {};
	if (name === "TodoWrite") {
		if (!Array.isArray(root.todos)) return undefined;
		return {
			kind: "tasks",
			source: "claude-todo",
			operation: "snapshot",
			items: itemsFrom(root.todos),
		};
	}
	if (name === "TaskList") {
		return {
			kind: "tasks",
			source: "claude-task-store",
			operation: "list",
			items: [],
		};
	}
	if (name === "TaskCreate") {
		const item = itemFromTask({ ...root, status: "pending" });
		if (!item) return undefined;
		return {
			kind: "tasks",
			source: "claude-task-store",
			operation: "create",
			items: [item],
		};
	}
	if (name === "TaskUpdate") {
		const taskId = text(root.taskId, MAX_ID);
		if (!taskId) return undefined;
		const item = itemFromTask({
			...root,
			id: taskId,
			blockedBy: root.addBlockedBy,
			blocks: root.addBlocks,
		});
		if (!item) return undefined;
		return {
			kind: "tasks",
			source: "claude-task-store",
			operation: "update",
			items: [item],
		};
	}
	if (name === "TaskGet") {
		const taskId = text(root.taskId, MAX_ID);
		if (!taskId) return undefined;
		return {
			kind: "tasks",
			source: "claude-task-store",
			operation: "get",
			items: [{ id: taskId, subject: `Task ${taskId}` }],
		};
	}
	return undefined;
}

/** Parse Claude's structured tool output when it contains richer task state. */
export function claudeTaskActivityResult(
	name: string,
	input: unknown,
	result: unknown,
): TaskActivity | undefined {
	const started = claudeTaskActivityStart(name, input);
	if (!started) return undefined;
	if (name === "TodoWrite" || name === "TaskList") {
		const tasks = taskArray(result);
		return tasks ? { ...started, items: itemsFrom(tasks) } : started;
	}
	if (name === "TaskCreate" || name === "TaskGet") {
		const parsed = itemFromTask(taskObject(result));
		if (!parsed) return started;
		return { ...started, items: [{ ...started.items[0], ...parsed }] };
	}
	return started;
}
