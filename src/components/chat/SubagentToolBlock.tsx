import {
	Bot,
	CheckCircle2,
	ChevronRight,
	CirclePause,
	LoaderCircle,
	XCircle,
} from "lucide-react";
import { useEffect, useState } from "react";
import { PrivacyMask } from "#/components/PrivacyMask";
import type { SubagentSnapshot } from "#/server/agentProvider";

function isActive(status: SubagentSnapshot["status"]): boolean {
	return status === "pending" || status === "running" || status === "paused";
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
}: {
	subagent: SubagentSnapshot;
	open: boolean;
	durationMs: number;
	onToggle: () => void;
}) {
	const title = subagent.name || subagent.label || "Subagent";
	const statusTone =
		subagent.status === "failed" || subagent.status === "interrupted"
			? "text-destructive/75"
			: subagent.status === "completed"
				? "text-green-600/70"
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
			<Bot className="h-3.5 w-3.5 shrink-0 text-primary/60" />
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
			<PrivacyMask className="col-span-2 col-start-3 row-start-3 min-w-0 break-words text-[10px] text-muted-foreground/60 sm:col-auto sm:row-auto sm:flex-1 sm:truncate">
				{subagent.currentStep ?? subagent.description ?? "Working"}
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
						{subagent.lastTool && <span>{subagent.lastTool}</span>}
						{subagent.model && <span>{subagent.model}</span>}
						{subagent.effort && <span>{subagent.effort}</span>}
						{subagent.usage?.toolUses !== undefined && (
							<span>{subagent.usage.toolUses} tools</span>
						)}
						{subagent.usage?.totalTokens !== undefined && (
							<span>{subagent.usage.totalTokens.toLocaleString()} tokens</span>
						)}
					</div>
				</div>
			</div>
		</PrivacyMask>
	);
}

export function SubagentToolBlock({
	subagent,
}: {
	subagent: SubagentSnapshot;
}) {
	const active = isActive(subagent.status);
	const [openOverride, setOpenOverride] = useState<boolean | null>(null);
	const open = openOverride ?? active;
	const durationMs = useSubagentDuration(subagent, active);

	return (
		<div className="my-0.5 min-w-0 max-w-full overflow-hidden">
			<SubagentHeader
				subagent={subagent}
				open={open}
				durationMs={durationMs}
				onToggle={() => setOpenOverride(!open)}
			/>
			{open && <SubagentDetails subagent={subagent} durationMs={durationMs} />}
		</div>
	);
}
