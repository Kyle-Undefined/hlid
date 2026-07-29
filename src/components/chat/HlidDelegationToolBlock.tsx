import {
	AlertTriangle,
	Bot,
	Check,
	ChevronRight,
	LoaderCircle,
} from "lucide-react";
import type { ReactNode } from "react";
import { PrivacyMask } from "#/components/PrivacyMask";
import type { ToolEventMessage } from "#/server/protocol";

type HlidDelegationAction =
	| "delegate"
	| "list"
	| "inspect"
	| "wait"
	| "steer"
	| "cancel"
	| "resume";

const ACTION_PRESENTATION: Record<
	HlidDelegationAction,
	{ label: string; completeLabel: string }
> = {
	delegate: { label: "Delegate child", completeLabel: "CREATED" },
	list: { label: "List children", completeLabel: "CHECKED" },
	inspect: { label: "Inspect child", completeLabel: "CHECKED" },
	wait: { label: "Wait for child", completeLabel: "CHECKED" },
	steer: { label: "Steer child", completeLabel: "SENT" },
	cancel: { label: "Cancel child", completeLabel: "REQUESTED" },
	resume: { label: "Resume child", completeLabel: "STARTED" },
};

function actionFor(name: string): HlidDelegationAction | null {
	for (const action of Object.keys(
		ACTION_PRESENTATION,
	) as HlidDelegationAction[]) {
		if (name.endsWith(`${action}_hlid_agent`)) return action;
	}
	return name.endsWith("list_hlid_agents") ? "list" : null;
}

export function isHlidDelegationToolEvent(event: ToolEventMessage): boolean {
	return actionFor(event.name) !== null;
}

function record(value: unknown): Record<string, unknown> | null {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function stringValue(
	value: Record<string, unknown> | null,
	key: string,
): string | undefined {
	const candidate = value?.[key];
	return typeof candidate === "string" && candidate ? candidate : undefined;
}

function parsedResult(result: string | undefined): unknown {
	if (!result) return null;
	try {
		return JSON.parse(result);
	} catch {
		return null;
	}
}

function compactId(id: string | undefined): string | null {
	if (!id) return null;
	return id.length > 12 ? `${id.slice(0, 8)}…` : id;
}

function bounded(value: string | undefined, limit = 240): string | null {
	if (!value) return null;
	return value.length <= limit ? value : `${value.slice(0, limit - 1)}…`;
}

function actionSummary(
	action: HlidDelegationAction,
	event: ToolEventMessage,
	result: unknown,
): string | null {
	const input = record(event.input);
	if (action === "delegate") {
		return bounded(stringValue(input, "task"));
	}
	if (action === "steer" || action === "resume") {
		return bounded(stringValue(input, "instruction"));
	}
	if (action === "list" && Array.isArray(result)) {
		return `${result.length} ${result.length === 1 ? "child" : "children"}`;
	}
	const id = stringValue(input, "id") ?? stringValue(record(result), "id");
	return compactId(id);
}

export function HlidDelegationToolBlock({
	event,
	permissionLabel,
	open,
	onToggle,
	children,
}: {
	event: ToolEventMessage;
	permissionLabel?: string;
	open: boolean;
	onToggle: () => void;
	children?: ReactNode;
}) {
	const action = actionFor(event.name);
	if (!action) return null;
	const presentation = ACTION_PRESENTATION[action];
	const result = parsedResult(event.result);
	const summary = actionSummary(action, event, result);
	const provider =
		action === "delegate"
			? stringValue(record(event.input), "provider")
			: undefined;
	const pending = !event.isError && event.result === undefined;
	const statusLabel = event.isError
		? "FAILED"
		: pending
			? "RUNNING"
			: presentation.completeLabel;
	const error = event.isError
		? bounded(event.result ?? "The Hlid orchestration action failed.")
		: null;

	return (
		<div className="my-0.5 min-w-0 max-w-full overflow-hidden">
			<button
				type="button"
				aria-expanded={open}
				aria-label={`${presentation.label} details`}
				onClick={onToggle}
				className="group grid min-h-11 w-full min-w-0 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-2 gap-y-1 px-3 py-2 text-left transition-colors hover:bg-primary/[0.03]"
			>
				<span className="flex shrink-0 items-center gap-1">
					<ChevronRight
						className={`h-3 w-3 text-primary/45 transition-transform duration-150 group-hover:text-primary/75 ${
							open ? "rotate-90" : ""
						}`}
					/>
					<Bot className="h-3.5 w-3.5 text-primary/60" />
				</span>
				<span className="min-w-0">
					<span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
						<span className="shrink-0 text-[10px] font-medium tracking-wider text-primary/70">
							{presentation.label}
						</span>
						{provider && (
							<span className="max-w-full truncate border border-primary/15 px-1 py-0.5 font-mono text-[8px] text-primary/45">
								{provider}
							</span>
						)}
					</span>
					{summary && (
						<PrivacyMask
							inline
							className="mt-0.5 block truncate text-[9px] text-muted-foreground/55"
						>
							{summary}
						</PrivacyMask>
					)}
				</span>
				<output
					aria-label={`${presentation.label} ${statusLabel.toLowerCase()}`}
					className={`flex shrink-0 items-center gap-1 text-[8px] tracking-widest ${
						event.isError
							? "text-destructive/75"
							: pending
								? "text-primary/55"
								: "text-status-success/65"
					}`}
				>
					{event.isError ? (
						<AlertTriangle className="h-2.5 w-2.5" />
					) : pending ? (
						<LoaderCircle className="h-2.5 w-2.5 animate-spin" />
					) : (
						<Check className="h-2.5 w-2.5" />
					)}
					{statusLabel}
				</output>
			</button>
			{permissionLabel && (
				<div className="flex min-w-0 items-center gap-1 px-3 pb-1 pl-10 text-[8px] tracking-widest text-muted-foreground/45 uppercase">
					<Check className="h-2.5 w-2.5 shrink-0 text-status-success/55" />
					<span className="truncate">{permissionLabel}</span>
				</div>
			)}
			{error && !open && (
				<PrivacyMask className="min-w-0 break-words px-3 pb-1 pl-10 text-[9px] text-destructive/70">
					{error}
				</PrivacyMask>
			)}
			{open && (
				<div className="px-3 pb-1 pl-10 text-[8px] tracking-widest text-muted-foreground/45 uppercase">
					Recorded tool call · response at call time
				</div>
			)}
			{children}
		</div>
	);
}
