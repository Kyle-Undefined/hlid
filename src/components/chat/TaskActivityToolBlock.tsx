import {
	Check,
	CheckCircle2,
	ChevronRight,
	Circle,
	CircleDot,
	ListTodo,
	LoaderCircle,
	XCircle,
} from "lucide-react";
import { type ReactNode, useState } from "react";
import { PrivacyMask } from "#/components/PrivacyMask";
import type {
	TaskActivity,
	TaskActivityItem,
	TaskActivityStatus,
} from "#/server/agentProvider";
import type { ToolEventMessage } from "#/server/protocol";

const taskActivityGroupOpenOverrides = new Map<string, boolean>();

function sourceLabel(source: TaskActivity["source"]): string {
	switch (source) {
		case "codex-plan":
			return "Plan";
		case "claude-todo":
			return "Todo";
		case "claude-task-store":
			return "Tasks";
	}
}

function itemLabel(item: TaskActivityItem): string {
	return item.status === "in_progress" && item.activeForm
		? item.activeForm
		: item.subject;
}

export function summarizeTaskActivity(activity: TaskActivity): string {
	if (activity.items.length === 0) {
		if (activity.operation === "list") return "Reading task list";
		if (activity.operation === "get") return "Reading task";
		return "No tasks";
	}
	const completed = activity.items.filter(
		(item) => item.status === "completed",
	).length;
	const active = activity.items.find((item) => item.status === "in_progress");
	const deleted = activity.items.filter(
		(item) => item.status === "deleted",
	).length;
	const parts = [
		`${completed}/${activity.items.length} done`,
		...(deleted > 0 ? [`${deleted} deleted`] : []),
		...(active ? [itemLabel(active)] : []),
	];
	return parts.join(" · ");
}

function statusPresentation(
	event: ToolEventMessage,
	settled: boolean,
): {
	label: string;
	tone: string;
	icon: ReactNode;
} {
	if (event.isError) {
		return {
			label: "FAILED",
			tone: "text-destructive/75",
			icon: <XCircle className="h-2.5 w-2.5" />,
		};
	}
	if (event.result === undefined && !settled) {
		return {
			label: "UPDATING",
			tone: "text-primary/65",
			icon: <LoaderCircle className="h-2.5 w-2.5 animate-spin" />,
		};
	}
	if (event.result === undefined) {
		return {
			label: "ENDED",
			tone: "text-muted-foreground/55",
			icon: <CircleDot className="h-2.5 w-2.5" />,
		};
	}
	const items = event.taskActivity?.items ?? [];
	if (
		items.length > 0 &&
		items.every(
			(item) => item.status === "completed" || item.status === "deleted",
		)
	) {
		return {
			label: "COMPLETE",
			tone: "text-status-success/65",
			icon: <CheckCircle2 className="h-2.5 w-2.5" />,
		};
	}
	return {
		label:
			event.taskActivity?.operation === "list" ||
			event.taskActivity?.operation === "get"
				? "CHECKED"
				: event.taskActivity?.operation === "create"
					? "CREATED"
					: "UPDATED",
		tone: "text-status-success/65",
		icon: <Check className="h-2.5 w-2.5" />,
	};
}

function TaskStatusIcon({
	status,
	live,
}: {
	status?: TaskActivityStatus;
	live: boolean;
}) {
	if (status === "completed") {
		return <CheckCircle2 className="h-3.5 w-3.5 text-status-success/65" />;
	}
	if (status === "in_progress") {
		return live ? (
			<LoaderCircle className="h-3.5 w-3.5 animate-spin text-primary/65" />
		) : (
			<CircleDot className="h-3.5 w-3.5 text-primary/55" />
		);
	}
	if (status === "deleted") {
		return <XCircle className="h-3.5 w-3.5 text-muted-foreground/40" />;
	}
	return <Circle className="h-3.5 w-3.5 text-muted-foreground/45" />;
}

function TaskItem({ item, live }: { item: TaskActivityItem; live: boolean }) {
	const dependencies = [
		...(item.blockedBy?.length
			? [`blocked by ${item.blockedBy.join(", ")}`]
			: []),
		...(item.blocks?.length ? [`blocks ${item.blocks.join(", ")}`] : []),
	];
	return (
		<li className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-2 border-t border-border/45 px-3 py-2 first:border-t-0">
			<span className="pt-0.5">
				<TaskStatusIcon status={item.status} live={live} />
			</span>
			<PrivacyMask className="min-w-0">
				<div
					className={`break-words text-[11px] text-foreground/75 ${
						item.status === "deleted" ? "line-through opacity-60" : ""
					}`}
				>
					{item.subject}
				</div>
				{item.status === "in_progress" && item.activeForm && (
					<div className="mt-0.5 break-words text-[9px] text-primary/60">
						{item.activeForm}
					</div>
				)}
				{item.description && (
					<div className="mt-1 whitespace-pre-wrap break-words text-[9px] leading-relaxed text-muted-foreground/55">
						{item.description}
					</div>
				)}
				{(item.id || item.owner || dependencies.length > 0) && (
					<div className="mt-1 flex min-w-0 flex-wrap gap-x-2 gap-y-0.5 font-mono text-[8px] text-muted-foreground/45">
						{item.id && <span>#{item.id}</span>}
						{item.owner && <span>owner {item.owner}</span>}
						{dependencies.map((dependency) => (
							<span key={dependency}>{dependency}</span>
						))}
					</div>
				)}
			</PrivacyMask>
		</li>
	);
}

export function TaskActivityToolBlock({
	event,
	permissionLabel,
	open,
	onToggle,
	settled = false,
	children,
}: {
	event: ToolEventMessage & { taskActivity: TaskActivity };
	permissionLabel?: string;
	open: boolean;
	onToggle: () => void;
	settled?: boolean;
	children?: ReactNode;
}) {
	const activity = event.taskActivity;
	const status = statusPresentation(event, settled);
	const summary = summarizeTaskActivity(activity);
	const live = !settled && event.result === undefined && !event.isError;
	return (
		<div className="my-0.5 min-w-0 max-w-full overflow-hidden">
			<button
				type="button"
				aria-expanded={open}
				aria-label={`${sourceLabel(activity.source)} task activity details`}
				onClick={onToggle}
				className="group grid min-h-11 w-full min-w-0 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-2 gap-y-1 px-3 py-2 text-left transition-colors hover:bg-primary/[0.03]"
			>
				<span className="flex shrink-0 items-center gap-1">
					<ChevronRight
						className={`h-3 w-3 text-primary/45 transition-transform duration-150 group-hover:text-primary/75 ${
							open ? "rotate-90" : ""
						}`}
					/>
					<ListTodo className="h-3.5 w-3.5 text-primary/60" />
				</span>
				<span className="min-w-0">
					<span className="block text-[10px] font-medium tracking-wider text-primary/70">
						{sourceLabel(activity.source)}
					</span>
					<PrivacyMask
						inline
						className="mt-0.5 block truncate text-[9px] text-muted-foreground/55"
					>
						{summary}
					</PrivacyMask>
				</span>
				<output
					aria-label={`${sourceLabel(activity.source)} ${status.label.toLowerCase()}`}
					className={`flex shrink-0 items-center gap-1 text-[8px] tracking-widest ${status.tone}`}
				>
					{status.icon}
					{status.label}
				</output>
			</button>
			{permissionLabel && (
				<div className="flex items-center gap-1.5 px-8 pb-1 text-[9px] uppercase tracking-widest text-muted-foreground/55">
					<Check className="h-2.5 w-2.5 text-status-success/55" />
					<span>{permissionLabel}</span>
				</div>
			)}
			{open && (
				<div className="mx-3 mb-1.5 border border-[var(--tool-panel-border)] bg-[var(--tool-panel)]">
					{activity.explanation && (
						<PrivacyMask className="whitespace-pre-wrap break-words border-b border-border/45 px-3 py-2 text-[10px] leading-relaxed text-muted-foreground/65">
							{activity.explanation}
						</PrivacyMask>
					)}
					{activity.items.length > 0 ? (
						<ul>
							{activity.items.map((item, index) => (
								<TaskItem
									key={item.id ?? `${index}:${item.subject}`}
									item={item}
									live={live}
								/>
							))}
						</ul>
					) : (
						<div className="px-3 py-2 text-[10px] text-muted-foreground/55">
							No task rows returned.
						</div>
					)}
					{children && (
						<details className="border-t border-border/45">
							<summary className="cursor-pointer px-3 py-2 text-[9px] uppercase tracking-widest text-muted-foreground/55 hover:text-muted-foreground/80">
								Tool details
							</summary>
							<div className="pb-1">{children}</div>
						</details>
					)}
				</div>
			)}
		</div>
	);
}

function replaceItems(
	orderedIds: string[],
	itemsById: Map<string, TaskActivityItem>,
	items: readonly TaskActivityItem[],
): void {
	orderedIds.length = 0;
	itemsById.clear();
	for (const [index, item] of items.entries()) {
		const id = item.id ?? `anonymous:${index}:${item.subject}`;
		orderedIds.push(id);
		itemsById.set(id, item);
	}
}

function upsertItems(
	orderedIds: string[],
	itemsById: Map<string, TaskActivityItem>,
	items: readonly TaskActivityItem[],
	operation: TaskActivity["operation"],
): void {
	for (const [index, item] of items.entries()) {
		const id = item.id ?? `anonymous:${index}:${item.subject}`;
		const previous = itemsById.get(id);
		const placeholder = item.id ? `Task ${item.id}` : null;
		const next =
			operation === "update" && previous
				? {
						...previous,
						...item,
						...(placeholder === item.subject
							? { subject: previous.subject }
							: {}),
					}
				: { ...previous, ...item };
		if (!itemsById.has(id)) orderedIds.push(id);
		itemsById.set(id, next);
	}
}

export function aggregateTaskActivityEvents(
	events: readonly ToolEventMessage[],
): TaskActivity | null {
	const activities = events.flatMap((event) =>
		event.taskActivity ? [event.taskActivity] : [],
	);
	const first = activities[0];
	if (!first) return null;
	const orderedIds: string[] = [];
	const itemsById = new Map<string, TaskActivityItem>();
	let latest = first;
	for (const activity of activities) {
		latest = activity;
		if (activity.operation === "snapshot" || activity.operation === "list") {
			replaceItems(orderedIds, itemsById, activity.items);
		} else {
			upsertItems(orderedIds, itemsById, activity.items, activity.operation);
		}
	}
	return {
		...latest,
		items: orderedIds.flatMap((id) => {
			const item = itemsById.get(id);
			return item ? [item] : [];
		}),
	};
}

export function TaskActivityGroupToolBlock({
	events,
	sessionId,
	responseSettled = false,
	children,
}: {
	events: readonly ToolEventMessage[];
	sessionId?: string;
	responseSettled?: boolean;
	children?: ReactNode;
}) {
	const activity = aggregateTaskActivityEvents(events);
	const first = events[0];
	const latest = events.at(-1);
	const stateKey = `${sessionId ?? latest?.detailSessionId ?? "unknown"}:${first?.id ?? "empty"}`;
	const [open, setOpen] = useState(
		() => taskActivityGroupOpenOverrides.get(stateKey) ?? false,
	);
	if (!activity || !first || !latest) return null;
	const eventsSettled = events.every(
		(event) => event.result !== undefined || event.isError === true,
	);
	const event: ToolEventMessage & { taskActivity: TaskActivity } = {
		...latest,
		id: `task-group:${first.id}`,
		name: "Tasks",
		input: {},
		...(eventsSettled
			? { result: latest.result ?? "" }
			: { result: undefined }),
		isError: events.some((candidate) => candidate.isError === true),
		taskActivity: activity,
	};
	return (
		<TaskActivityToolBlock
			event={event}
			open={open}
			settled={responseSettled || eventsSettled}
			onToggle={() => {
				const nextOpen = !open;
				setOpen(nextOpen);
				taskActivityGroupOpenOverrides.set(stateKey, nextOpen);
			}}
		>
			{children}
		</TaskActivityToolBlock>
	);
}
