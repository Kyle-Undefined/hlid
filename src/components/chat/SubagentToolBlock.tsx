import {
	Bot,
	CheckCircle2,
	ChevronRight,
	CirclePause,
	LoaderCircle,
	RefreshCw,
	RotateCcw,
	Save,
	Square,
	Workflow as WorkflowIcon,
	XCircle,
} from "lucide-react";
import { useEffect, useState } from "react";
import { PrivacyMask } from "#/components/PrivacyMask";
import type { SubagentSnapshot } from "#/server/agentProvider";
import type { PermissionMessage } from "./chatReducer";
import {
	PermissionCard,
	type PermissionDecisionHandler,
} from "./PermissionCard";

const subagentOpenOverrides = new Map<string, boolean>();

function subagentStateKey(
	subagent: SubagentSnapshot,
	stateScope: string,
): string {
	return `${stateScope}:${subagent.provider}:${subagent.agentId}`;
}

function isActive(status: SubagentSnapshot["status"]): boolean {
	return status === "pending" || status === "running" || status === "paused";
}

function isTerminal(status: SubagentSnapshot["status"]): boolean {
	return (
		status === "completed" || status === "failed" || status === "interrupted"
	);
}

export function summarizeWorkflowChildren(
	children: ReadonlyArray<SubagentSnapshot>,
): string {
	const running = children.filter(
		(child) => child.status === "pending" || child.status === "running",
	).length;
	const waiting = children.filter((child) => child.status === "paused").length;
	const done = children.filter((child) => child.status === "completed").length;
	const failed = children.filter(
		(child) => child.status === "failed" || child.status === "interrupted",
	).length;
	if (children.length === 0) return "Waiting for agents";
	return [
		`${running} running`,
		...(waiting > 0 ? [`${waiting} waiting`] : []),
		`${done} done`,
		`${failed} failed`,
	].join(" / ");
}

export function formatSubagentDuration(durationMs: number): string {
	const totalSeconds = Math.max(0, Math.floor(durationMs / 1000));
	const hours = Math.floor(totalSeconds / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);
	const seconds = totalSeconds % 60;
	if (hours > 0) return `${hours}h ${minutes}m`;
	if (minutes > 0) return `${minutes}m ${seconds}s`;
	return `${seconds}s`;
}

function statusLabel(status: SubagentSnapshot["status"]): string {
	switch (status) {
		case "pending":
			return "STARTING";
		case "running":
			return "RUNNING";
		case "paused":
			return "PAUSED";
		case "completed":
			return "COMPLETED";
		case "failed":
			return "FAILED";
		case "interrupted":
			return "INTERRUPTED";
	}
}

function StatusIcon({ status }: { status: SubagentSnapshot["status"] }) {
	if (status === "pending" || status === "running") {
		return <LoaderCircle className="w-3 h-3 shrink-0 animate-spin" />;
	}
	if (status === "paused") {
		return <CirclePause className="w-3 h-3 shrink-0" />;
	}
	if (status === "completed") {
		return <CheckCircle2 className="w-3 h-3 shrink-0" />;
	}
	return <XCircle className="w-3 h-3 shrink-0" />;
}

function useSubagentDuration(
	subagent: SubagentSnapshot,
	active: boolean,
): number {
	const [now, setNow] = useState(() => Date.now());

	useEffect(() => {
		if (!active) return;
		setNow(Date.now());
		const interval = window.setInterval(() => setNow(Date.now()), 1000);
		return () => window.clearInterval(interval);
	}, [active]);

	return (
		subagent.usage?.durationMs ??
		Math.max(
			0,
			(active ? now : (subagent.endedAtMs ?? now)) - subagent.startedAtMs,
		)
	);
}

function SubagentHeader({
	subagent,
	open,
	durationMs,
	onToggle,
	summary,
}: {
	subagent: SubagentSnapshot;
	open: boolean;
	durationMs: number;
	onToggle: () => void;
	summary?: string;
}) {
	const title = subagent.name || subagent.label || "Subagent";
	const statusTone =
		subagent.status === "failed" || subagent.status === "interrupted"
			? "text-destructive/75"
			: subagent.status === "completed"
				? "text-status-success/70"
				: "text-primary/65";

	return (
		<button
			type="button"
			onClick={onToggle}
			aria-expanded={open}
			aria-label={`${title} ${statusLabel(subagent.status).toLowerCase()}`}
			className="grid min-h-11 w-full min-w-0 max-w-full grid-cols-[auto_auto_minmax(0,1fr)_auto] items-center gap-x-2 gap-y-1 overflow-hidden px-3 py-2 text-left transition-colors hover:bg-primary/[0.03] sm:flex sm:gap-2"
		>
			<ChevronRight
				className={`h-3 w-3 shrink-0 text-primary/50 transition-transform duration-150 ${open ? "rotate-90" : ""}`}
			/>
			{subagent.kind === "workflow" ? (
				<WorkflowIcon className="h-3.5 w-3.5 shrink-0 text-primary/60" />
			) : (
				<Bot className="h-3.5 w-3.5 shrink-0 text-primary/60" />
			)}
			<PrivacyMask
				inline
				className="col-start-3 row-start-1 min-w-0 break-all text-[11px] font-medium tracking-wider text-primary/75 sm:col-auto sm:row-auto sm:shrink-0 sm:whitespace-nowrap"
			>
				{title}
			</PrivacyMask>
			<div className="col-span-2 col-start-3 row-start-2 flex min-w-0 flex-wrap items-center gap-1 sm:contents">
				<span
					className={`flex shrink-0 items-center gap-1 text-[9px] font-medium tracking-widest ${statusTone}`}
				>
					<StatusIcon status={subagent.status} />
					{statusLabel(subagent.status)}
				</span>
				{(subagent.model || subagent.effort) && (
					<span className="flex min-w-0 shrink flex-wrap items-center gap-1 font-mono text-[9px] text-primary/50 sm:flex-nowrap sm:overflow-hidden">
						{subagent.model && (
							<span
								className="max-w-full break-all border border-primary/15 px-1 py-0.5 sm:max-w-32 sm:truncate"
								title={`Model: ${subagent.model}`}
							>
								{subagent.model}
							</span>
						)}
						{subagent.effort && (
							<span
								className="shrink-0 border border-primary/15 px-1 py-0.5"
								title={`Effort: ${subagent.effort}`}
							>
								{subagent.effort}
							</span>
						)}
					</span>
				)}
			</div>
			<PrivacyMask className="col-span-2 col-start-3 row-start-3 min-w-0 truncate text-[10px] text-muted-foreground/60 sm:col-auto sm:row-auto sm:flex-1">
				{summary ?? subagent.currentStep ?? subagent.description ?? "Working"}
			</PrivacyMask>
			<span className="col-start-4 row-start-1 shrink-0 font-mono text-[10px] tabular-nums text-muted-foreground/55 sm:col-auto sm:row-auto">
				{formatSubagentDuration(durationMs)}
			</span>
		</button>
	);
}

function SubagentDetails({
	subagent,
	durationMs,
}: {
	subagent: SubagentSnapshot;
	durationMs: number;
}) {
	return (
		<PrivacyMask className="mx-3 mb-2 min-w-0 max-w-[calc(100%_-_1.5rem)] overflow-hidden border border-[var(--tool-panel-border)] bg-[var(--tool-panel)]">
			<div className="grid min-w-0 gap-3 p-3 text-[11px] leading-relaxed sm:grid-cols-2">
				{subagent.phase && (
					<div className="min-w-0">
						<div className="mb-1 text-[9px] uppercase tracking-widest text-muted-foreground/50">
							Phase
						</div>
						<div className="break-words text-primary/75">{subagent.phase}</div>
					</div>
				)}
				{subagent.attempt !== undefined && (
					<div className="min-w-0">
						<div className="mb-1 text-[9px] uppercase tracking-widest text-muted-foreground/50">
							Attempt
						</div>
						<div className="font-mono text-[10px] text-primary/65">
							{subagent.attempt}
						</div>
					</div>
				)}
				<div className="min-w-0 sm:col-span-2">
					<div className="mb-1 text-[9px] uppercase tracking-widest text-muted-foreground/50">
						Current step
					</div>
					<div className="break-words text-primary/75">
						{subagent.currentStep ?? subagent.description ?? "Working"}
					</div>
				</div>
				{subagent.prompt && (
					<div className="min-w-0 sm:col-span-2">
						<div className="mb-1 text-[9px] uppercase tracking-widest text-muted-foreground/50">
							Prompt
						</div>
						<div className="max-h-40 overflow-y-auto whitespace-pre-wrap break-words font-mono text-[10px] text-primary/65">
							{subagent.prompt}
						</div>
					</div>
				)}
				{subagent.resultPreview && (
					<div className="min-w-0 sm:col-span-2">
						<div className="mb-1 text-[9px] uppercase tracking-widest text-muted-foreground/50">
							Result preview
						</div>
						<div className="max-h-48 overflow-y-auto whitespace-pre-wrap break-words font-mono text-[10px] text-primary/65">
							{subagent.resultPreview}
						</div>
					</div>
				)}
				<div className="min-w-0">
					<div className="mb-1 text-[9px] uppercase tracking-widest text-muted-foreground/50">
						Agent
					</div>
					<div className="break-all font-mono text-[10px] text-primary/60">
						{subagent.agentId}
					</div>
					{subagent.name &&
						subagent.label &&
						subagent.name !== subagent.label && (
							<div className="break-words font-mono text-[10px] text-primary/50">
								{subagent.label}
							</div>
						)}
				</div>
				<div className="min-w-0">
					<div className="mb-1 text-[9px] uppercase tracking-widest text-muted-foreground/50">
						Runtime
					</div>
					<div className="flex flex-wrap gap-x-3 gap-y-1 font-mono text-[10px] text-primary/60">
						<span>{formatSubagentDuration(durationMs)}</span>
						{subagent.lastTool && <span>tool {subagent.lastTool}</span>}
						{subagent.model && <span>model {subagent.model}</span>}
						{subagent.effort && <span>effort {subagent.effort}</span>}
						{subagent.usage?.toolUses !== undefined && (
							<span>{subagent.usage.toolUses} tools</span>
						)}
						{subagent.usage?.totalTokens !== undefined && (
							<span>{subagent.usage.totalTokens.toLocaleString()} tokens</span>
						)}
					</div>
				</div>
				{subagent.kind === "workflow" && (
					<div className="min-w-0 sm:col-span-2">
						<div className="mb-1 text-[9px] uppercase tracking-widest text-muted-foreground/50">
							Workflow
						</div>
						<div className="flex min-w-0 flex-wrap gap-x-3 gap-y-1 font-mono text-[10px] text-primary/60">
							{subagent.activityType && <span>{subagent.activityType}</span>}
							{subagent.workflowRunId && (
								<span className="break-all">run {subagent.workflowRunId}</span>
							)}
							{subagent.workflowScriptPath && (
								<span className="break-all">{subagent.workflowScriptPath}</span>
							)}
						</div>
					</div>
				)}
			</div>
		</PrivacyMask>
	);
}

function WorkflowActions({
	subagent,
	stopRequested,
	onStop,
	onResume,
	onRerun,
	onSave,
}: {
	subagent: SubagentSnapshot;
	stopRequested: boolean;
	onStop?: () => void;
	onResume?: () => void;
	onRerun?: () => void;
	onSave?: () => void;
}) {
	const canStop =
		isActive(subagent.status) && Boolean(subagent.taskId) && Boolean(onStop);
	const canResume =
		subagent.status === "interrupted" &&
		Boolean(subagent.workflowRunId) &&
		Boolean(onResume);
	const canRerun =
		isTerminal(subagent.status) &&
		Boolean(subagent.workflowScriptPath) &&
		Boolean(onRerun);
	const canSave = Boolean(subagent.workflowScriptPath) && Boolean(onSave);
	if (!canStop && !canResume && !canRerun && !canSave) return null;
	return (
		<div className="mx-3 mb-2 flex flex-wrap items-center gap-2">
			{canStop && (
				<button
					type="button"
					onClick={onStop}
					disabled={stopRequested}
					className="inline-flex min-h-8 items-center gap-1.5 border border-destructive/25 px-2.5 py-1 text-[9px] font-medium tracking-widest text-destructive/75 uppercase transition-colors hover:bg-destructive/5 disabled:opacity-45"
				>
					{stopRequested ? (
						<LoaderCircle className="h-3 w-3 animate-spin" />
					) : (
						<Square className="h-3 w-3" />
					)}
					{stopRequested ? "Stopping" : "Stop workflow"}
				</button>
			)}
			{canResume && (
				<button
					type="button"
					onClick={onResume}
					className="inline-flex min-h-8 items-center gap-1.5 border border-primary/20 px-2.5 py-1 text-[9px] font-medium tracking-widest text-primary/70 uppercase transition-colors hover:bg-primary/5"
				>
					<RotateCcw className="h-3 w-3" />
					Resume workflow
				</button>
			)}
			{canRerun && (
				<button
					type="button"
					onClick={onRerun}
					className="inline-flex min-h-8 items-center gap-1.5 border border-primary/20 px-2.5 py-1 text-[9px] font-medium tracking-widest text-primary/70 uppercase transition-colors hover:bg-primary/5"
				>
					<RefreshCw className="h-3 w-3" />
					Rerun workflow
				</button>
			)}
			{canSave && (
				<button
					type="button"
					onClick={onSave}
					className="inline-flex min-h-8 items-center gap-1.5 border border-primary/20 px-2.5 py-1 text-[9px] font-medium tracking-widest text-primary/70 uppercase transition-colors hover:bg-primary/5"
				>
					<Save className="h-3 w-3" />
					Save workflow
				</button>
			)}
		</div>
	);
}

export function SubagentToolBlock({
	subagent,
	childSubagents = [],
	nested = false,
	initiallyOpen = false,
	stateScope = "transcript",
	onStop,
	onResume,
	onRerun,
	onSave,
	pendingPermissions = [],
	onDecidePermission,
}: {
	subagent: SubagentSnapshot;
	childSubagents?: ReadonlyArray<SubagentSnapshot>;
	nested?: boolean;
	initiallyOpen?: boolean;
	stateScope?: string;
	onStop?: () => void;
	onResume?: () => void;
	onRerun?: () => void;
	onSave?: () => void;
	pendingPermissions?: ReadonlyArray<PermissionMessage>;
	onDecidePermission?: PermissionDecisionHandler;
}) {
	const active = isActive(subagent.status);
	const stateKey = subagentStateKey(subagent, stateScope);
	const [openOverride, setOpenOverride] = useState<boolean | null>(
		() => subagentOpenOverrides.get(stateKey) ?? (initiallyOpen ? true : null),
	);
	const [stopRequestedKey, setStopRequestedKey] = useState<string | null>(null);
	const currentStopKey = `${stateKey}:${subagent.status}`;
	const stopRequested = stopRequestedKey === currentStopKey;
	const open =
		openOverride ?? (active && subagent.kind !== "workflow" && !nested);
	const durationMs = useSubagentDuration(subagent, active);
	const workflowAgentSummary =
		subagent.kind === "workflow"
			? childSubagents.length > 0
				? summarizeWorkflowChildren(childSubagents)
				: active
					? "Waiting for agents"
					: undefined
			: undefined;
	const approvalSummary =
		pendingPermissions.length > 0
			? `${pendingPermissions.length} ${
					pendingPermissions.length === 1 ? "approval" : "approvals"
				} needed`
			: undefined;
	const workflowSummaryParts = [workflowAgentSummary, approvalSummary].filter(
		(value): value is string => Boolean(value),
	);
	const workflowSummary =
		workflowSummaryParts.length > 0
			? workflowSummaryParts.join(" / ")
			: undefined;
	const childSubagentsById = new Map(
		childSubagents.map((child) => [
			`${child.provider}:${child.agentId}`,
			child,
		]),
	);

	useEffect(() => {
		setOpenOverride(
			subagentOpenOverrides.get(stateKey) ?? (initiallyOpen ? true : null),
		);
	}, [stateKey, initiallyOpen]);

	useEffect(() => {
		if (!stopRequestedKey) return;
		const timeout = window.setTimeout(() => setStopRequestedKey(null), 10_000);
		return () => window.clearTimeout(timeout);
	}, [stopRequestedKey]);

	function toggleOpen() {
		const next = !open;
		subagentOpenOverrides.set(stateKey, next);
		setOpenOverride(next);
	}

	function stopWorkflow() {
		if (!onStop || stopRequested) return;
		setStopRequestedKey(currentStopKey);
		onStop();
	}

	return (
		<div
			className={`my-0.5 min-w-0 max-w-full overflow-hidden ${
				nested ? "ml-3 border-l border-primary/10" : ""
			}`}
		>
			<SubagentHeader
				subagent={subagent}
				open={open}
				durationMs={durationMs}
				onToggle={toggleOpen}
				summary={workflowSummary}
			/>
			{onDecidePermission &&
				pendingPermissions.map((permission) => (
					<PermissionCard
						key={permission.id}
						message={permission}
						onDecide={onDecidePermission}
						requesterSubagent={
							permission.requester
								? childSubagentsById.get(
										`${permission.requester.providerId}:${permission.requester.agentId}`,
									)
								: undefined
						}
						embedded
					/>
				))}
			{open && (
				<>
					<SubagentDetails subagent={subagent} durationMs={durationMs} />
					{subagent.kind === "workflow" && (
						<WorkflowActions
							subagent={subagent}
							stopRequested={stopRequested}
							onStop={onStop ? stopWorkflow : undefined}
							onResume={onResume}
							onRerun={onRerun}
							onSave={onSave}
						/>
					)}
					{childSubagents.length > 0 && (
						<ul
							aria-label="Workflow agents"
							className="mx-3 mb-2 max-h-80 list-none overflow-y-auto overscroll-contain border border-[var(--tool-panel-border)] bg-[var(--tool-panel)] py-1 sm:max-h-96"
						>
							{childSubagents.map((child) => (
								<li key={`${child.provider}:${child.agentId}`}>
									<SubagentToolBlock
										subagent={child}
										nested
										stateScope={stateScope}
									/>
								</li>
							))}
						</ul>
					)}
				</>
			)}
		</div>
	);
}

/** Test-only reset for module-level navigation state. */
// fallow-ignore-next-line unused-export -- test-only reset
export function resetSubagentOpenStateForTest(): void {
	subagentOpenOverrides.clear();
}
