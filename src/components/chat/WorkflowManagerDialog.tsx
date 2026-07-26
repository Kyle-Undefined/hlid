import {
	CheckCircle2,
	CirclePause,
	FileCode2,
	FolderGit2,
	Globe2,
	LoaderCircle,
	Play,
	Save,
	Trash2,
	Workflow as WorkflowIcon,
	X,
	XCircle,
} from "lucide-react";
import {
	type ReactNode,
	type RefObject,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { createPortal } from "react-dom";
import { PrivacyMask } from "#/components/PrivacyMask";
import { useDialogFocus } from "#/hooks/useDialogFocus";
import {
	collectWorkflowRuns,
	isActiveWorkflowStatus,
	savedWorkflowRunPrompt,
	type WorkflowRun,
	type WorkflowTranscriptMessage,
	workflowDurationMs,
	workflowRerunPrompt,
	workflowResumePrompt,
	workflowTokenTotal,
} from "#/lib/workflowRuns";
import type {
	ProviderSavedWorkflow,
	ProviderWorkflowSaveLocation,
	ProviderWorkflowSaveScope,
	SubagentStatus,
} from "#/server/agentProvider";
import {
	formatSubagentDuration,
	SubagentToolBlock,
	summarizeWorkflowChildren,
} from "./SubagentToolBlock";

function statusLabel(status: SubagentStatus): string {
	switch (status) {
		case "pending":
			return "Starting";
		case "running":
			return "Running";
		case "paused":
			return "Paused";
		case "completed":
			return "Completed";
		case "failed":
			return "Failed";
		case "interrupted":
			return "Interrupted";
	}
}

function WorkflowStatusIcon({ status }: { status: SubagentStatus }) {
	if (status === "pending" || status === "running") {
		return <LoaderCircle className="h-3.5 w-3.5 animate-spin" />;
	}
	if (status === "paused") {
		return <CirclePause className="h-3.5 w-3.5" />;
	}
	if (status === "completed") {
		return <CheckCircle2 className="h-3.5 w-3.5" />;
	}
	return <XCircle className="h-3.5 w-3.5" />;
}

function runTitle(run: WorkflowRun): string {
	return run.workflow.name ?? run.workflow.label ?? "Workflow";
}

function runMetrics(run: WorkflowRun, now: number): string {
	const tokens = workflowTokenTotal(run);
	return [
		`${run.children.length} ${run.children.length === 1 ? "agent" : "agents"}`,
		tokens === null ? null : `${tokens.toLocaleString()} tokens`,
		formatSubagentDuration(workflowDurationMs(run, now)),
	]
		.filter(Boolean)
		.join(" · ");
}

function WorkflowRunRow({
	run,
	selected,
	now,
	onSelect,
}: {
	run: WorkflowRun;
	selected: boolean;
	now: number;
	onSelect: () => void;
}) {
	const active = isActiveWorkflowStatus(run.workflow.status);
	const statusTone =
		run.workflow.status === "failed" || run.workflow.status === "interrupted"
			? "text-destructive/75"
			: run.workflow.status === "completed"
				? "text-status-success/70"
				: "text-primary/70";
	return (
		<button
			type="button"
			role="option"
			aria-selected={selected}
			onClick={onSelect}
			className={`w-full border-b border-border/40 px-3 py-3 text-left transition-colors last:border-b-0 ${
				selected ? "bg-primary/[0.07]" : "hover:bg-primary/[0.03]"
			}`}
		>
			<div className="flex min-w-0 items-center gap-2">
				<WorkflowIcon className="h-3.5 w-3.5 shrink-0 text-primary/60" />
				<PrivacyMask
					inline
					className="min-w-0 flex-1 truncate text-[11px] font-medium tracking-wider text-primary/80"
				>
					{runTitle(run)}
				</PrivacyMask>
				<span
					className={`flex shrink-0 items-center gap-1 text-[9px] font-medium tracking-widest uppercase ${statusTone}`}
				>
					<WorkflowStatusIcon status={run.workflow.status} />
					{statusLabel(run.workflow.status)}
				</span>
			</div>
			<div className="mt-1.5 min-w-0 truncate pl-[1.375rem] text-[10px] text-muted-foreground/60">
				{run.children.length > 0
					? summarizeWorkflowChildren(run.children)
					: active
						? "Waiting for agents"
						: "No agent details recorded"}
			</div>
			<div className="mt-1 min-w-0 truncate pl-[1.375rem] font-mono text-[9px] text-muted-foreground/45">
				{runMetrics(run, now)}
			</div>
		</button>
	);
}

function SavedWorkflowRow({
	workflow,
	selected,
	onSelect,
}: {
	workflow: ProviderSavedWorkflow;
	selected: boolean;
	onSelect: () => void;
}) {
	return (
		<button
			type="button"
			role="option"
			aria-selected={selected}
			onClick={onSelect}
			className={`w-full border-b border-border/40 px-3 py-3 text-left transition-colors last:border-b-0 ${
				selected ? "bg-primary/[0.07]" : "hover:bg-primary/[0.03]"
			}`}
		>
			<div className="flex min-w-0 items-center gap-2">
				{workflow.scope === "project" ? (
					<FolderGit2 className="h-3.5 w-3.5 shrink-0 text-primary/60" />
				) : (
					<Globe2 className="h-3.5 w-3.5 shrink-0 text-primary/60" />
				)}
				<PrivacyMask
					inline
					className="min-w-0 flex-1 truncate text-[11px] font-medium tracking-wider text-primary/80"
				>
					/{workflow.name}
				</PrivacyMask>
				<span className="shrink-0 text-[9px] font-medium tracking-widest text-muted-foreground/55 uppercase">
					{workflow.scopeLabel}
				</span>
			</div>
			<PrivacyMask className="mt-1.5 min-w-0 truncate pl-[1.375rem] text-[10px] text-muted-foreground/60">
				{workflow.description}
			</PrivacyMask>
			{!workflow.availableAsCommand && (
				<div className="mt-1 pl-[1.375rem] text-[9px] tracking-wider text-amber-500/65 uppercase">
					Shadowed by a closer project workflow
				</div>
			)}
		</button>
	);
}

function SavedWorkflowSummary({
	workflow,
}: {
	workflow: ProviderSavedWorkflow;
}) {
	const ScopeIcon = workflow.scope === "project" ? FolderGit2 : Globe2;
	return (
		<>
			<div className="flex min-w-0 items-center gap-2">
				<ScopeIcon className="h-4 w-4 shrink-0 text-primary/60" />
				<PrivacyMask className="min-w-0 flex-1 truncate text-sm font-medium text-primary/80">
					/{workflow.name}
				</PrivacyMask>
				<span className="text-[9px] tracking-widest text-muted-foreground/55 uppercase">
					{workflow.scopeLabel}
				</span>
			</div>
			<PrivacyMask className="mt-3 text-[11px] leading-relaxed text-muted-foreground/65">
				{workflow.description}
			</PrivacyMask>
			<PrivacyMask className="mt-3 break-all border border-border/50 bg-muted/10 p-2 font-mono text-[9px] text-muted-foreground/50">
				{workflow.scriptPath}
			</PrivacyMask>
			{!workflow.availableAsCommand && (
				<p className="mt-2 text-[10px] text-amber-500/70">
					A closer project workflow with this name owns the slash command, but
					this exact script can still be run here.
				</p>
			)}
		</>
	);
}

function WorkflowSourcePreview({
	pending,
	source,
	error,
}: {
	pending: boolean;
	source?: string;
	error?: string;
}) {
	return (
		<section
			aria-label="Workflow definition"
			className="mt-3 overflow-hidden border border-border/50 bg-muted/10"
		>
			<div className="flex items-center gap-2 border-b border-border/40 px-2.5 py-2">
				<FileCode2 className="h-3.5 w-3.5 text-primary/55" />
				<h4 className="text-[9px] font-medium tracking-widest text-primary/65 uppercase">
					Workflow definition
				</h4>
			</div>
			{pending ? (
				<div className="flex min-h-24 items-center justify-center gap-2 px-3 py-4 text-[10px] text-muted-foreground/50">
					<LoaderCircle className="h-3.5 w-3.5 animate-spin" />
					Loading definition
				</div>
			) : error ? (
				<p role="alert" className="px-3 py-4 text-[10px] text-destructive/70">
					{error}
				</p>
			) : source !== undefined ? (
				<PrivacyMask className="max-h-72 overflow-auto whitespace-pre p-3 font-mono text-[10px] leading-relaxed text-foreground/65">
					{source}
				</PrivacyMask>
			) : (
				<p className="px-3 py-4 text-[10px] text-muted-foreground/50">
					Workflow definition unavailable.
				</p>
			)}
		</section>
	);
}

function SavedWorkflowDeleteAction({
	workflow,
	pending,
	succeeded,
	onDelete,
}: {
	workflow: ProviderSavedWorkflow;
	pending: boolean;
	succeeded: boolean;
	onDelete: () => void;
}) {
	const [confirming, setConfirming] = useState(false);
	if (confirming) {
		return (
			<div
				aria-live="polite"
				className="ml-auto flex max-w-sm flex-wrap justify-end gap-2"
			>
				<span className="w-full text-right text-[9px] leading-relaxed text-muted-foreground/50 break-all">
					Delete /{workflow.name} permanently?
				</span>
				<button
					type="button"
					onClick={() => {
						setConfirming(false);
						onDelete();
					}}
					className="text-[9px] tracking-widest text-destructive/60 uppercase transition-colors hover:text-destructive"
				>
					delete
				</button>
				<button
					type="button"
					onClick={() => setConfirming(false)}
					className="text-[9px] tracking-widest text-muted-foreground/50 uppercase transition-colors hover:text-muted-foreground/80"
				>
					cancel
				</button>
			</div>
		);
	}
	return (
		<button
			type="button"
			disabled={pending || succeeded}
			onClick={() => setConfirming(true)}
			className="inline-flex min-h-8 items-center gap-1.5 border border-destructive/25 px-2.5 py-1 text-[9px] font-medium tracking-widest text-destructive/70 uppercase transition-colors hover:bg-destructive/5 disabled:opacity-45"
		>
			{pending ? (
				<LoaderCircle className="h-3 w-3 animate-spin" />
			) : (
				<Trash2 className="h-3 w-3" />
			)}
			{pending ? "Deleting" : succeeded ? "Deleted" : "Delete workflow"}
		</button>
	);
}

function SavedWorkflowControls({
	workflow,
	input,
	deletePending,
	deleteSucceeded,
	onInputChange,
	onRun,
	onDelete,
}: {
	workflow: ProviderSavedWorkflow;
	input: string;
	deletePending: boolean;
	deleteSucceeded: boolean;
	onInputChange: (value: string) => void;
	onRun: () => void;
	onDelete: () => void;
}) {
	return (
		<>
			<label className="mt-4 block">
				<span className="text-[9px] tracking-widest text-muted-foreground/55 uppercase">
					Optional input
				</span>
				<textarea
					value={input}
					onChange={(event) => onInputChange(event.target.value)}
					placeholder="Input for this workflow"
					className="mt-1.5 min-h-20 w-full resize-y border border-border bg-background px-2.5 py-2 text-[11px] text-foreground outline-none focus:border-primary/35"
				/>
			</label>
			<div className="mt-3 flex flex-wrap items-start justify-between gap-3">
				<button
					type="button"
					onClick={onRun}
					className="inline-flex min-h-8 items-center gap-1.5 border border-primary/25 px-2.5 py-1 text-[9px] font-medium tracking-widest text-primary/75 uppercase transition-colors hover:bg-primary/5"
				>
					<Play className="h-3 w-3" />
					Run workflow
				</button>
				<SavedWorkflowDeleteAction
					key={workflow.id}
					workflow={workflow}
					pending={deletePending}
					succeeded={deleteSucceeded}
					onDelete={onDelete}
				/>
			</div>
		</>
	);
}

type WorkflowSaveResult = {
	type?: "workflow_save_result";
	request_id: string;
	workflow?: ProviderSavedWorkflow;
	error?: string;
	error_code?: string;
};

type WorkflowSourceResult = {
	type?: "workflow_source_result";
	request_id: string;
	script_path: string;
	source?: string;
	error?: string;
};

function WorkflowManagerHeader({
	runCount,
	activeCount,
	savedCount,
	onClose,
}: {
	runCount: number;
	activeCount: number;
	savedCount: number;
	onClose: () => void;
}) {
	return (
		<header className="flex shrink-0 items-center gap-3 border-b border-border px-4 py-3">
			<WorkflowIcon className="h-4 w-4 text-primary/65" />
			<div className="min-w-0 flex-1">
				<h2 className="text-[11px] font-medium tracking-[0.18em] text-primary/80 uppercase">
					Claude workflows
				</h2>
				<p className="mt-0.5 text-[9px] tracking-wider text-muted-foreground/50 uppercase">
					{runCount} {runCount === 1 ? "run" : "runs"} · {activeCount} active ·{" "}
					{savedCount} saved
				</p>
			</div>
			<button
				type="button"
				onClick={onClose}
				aria-label="Close workflows"
				className="p-1 text-muted-foreground transition-colors hover:text-foreground"
			>
				<X className="h-4 w-4" />
			</button>
		</header>
	);
}

function WorkflowManagerEmptyState() {
	return (
		<div className="grid min-h-72 place-items-center p-8 text-center">
			<div className="max-w-md space-y-2">
				<WorkflowIcon className="mx-auto h-8 w-8 text-primary/20" />
				<p className="text-sm text-foreground/65">
					No workflow runs in the loaded session history.
				</p>
				<p className="text-[11px] leading-relaxed text-muted-foreground/55">
					Ask Claude to use a workflow, save a completed run, or load older
					history below.
				</p>
			</div>
		</div>
	);
}

function WorkflowListPane({
	listRef,
	runs,
	savedWorkflows,
	selectedKey,
	hasSelection,
	now,
	onSelectRun,
	onSelectSaved,
}: {
	listRef: RefObject<HTMLDivElement | null>;
	runs: WorkflowRun[];
	savedWorkflows: ProviderSavedWorkflow[];
	selectedKey: string | null;
	hasSelection: boolean;
	now: number;
	onSelectRun: (key: string) => void;
	onSelectSaved: (workflow: ProviderSavedWorkflow, key: string) => void;
}) {
	return (
		<div
			ref={listRef}
			role="listbox"
			aria-label="Workflow runs and saved workflows"
			className={`min-h-0 overflow-y-auto overscroll-contain md:max-h-none md:border-r md:border-b-0 ${
				hasSelection
					? "max-h-52 border-b border-border"
					: "max-h-none border-b-0"
			}`}
		>
			{savedWorkflows.length > 0 && (
				<div className="border-b border-border/60 bg-muted/10 px-3 py-1.5 text-[9px] tracking-widest text-muted-foreground/50 uppercase">
					Saved
				</div>
			)}
			{savedWorkflows.map((workflow) => {
				const key = `saved:${workflow.id}`;
				return (
					<SavedWorkflowRow
						key={key}
						workflow={workflow}
						selected={key === selectedKey}
						onSelect={() => onSelectSaved(workflow, key)}
					/>
				);
			})}
			{runs.length > 0 && (
				<div className="border-y border-border/60 bg-muted/10 px-3 py-1.5 text-[9px] tracking-widest text-muted-foreground/50 uppercase">
					Runs
				</div>
			)}
			{runs.map((run) => {
				const key = `run:${run.selectionKey}`;
				return (
					<WorkflowRunRow
						key={key}
						run={run}
						selected={key === selectedKey}
						now={now}
						onSelect={() => onSelectRun(key)}
					/>
				);
			})}
		</div>
	);
}

function WorkflowSavePanel({
	panelRef,
	sourcePending,
	sourceResult,
	locations,
	location,
	pending,
	scope,
	result,
	replaceExisting,
	onSelectScope,
	onSubmit,
	onCancel,
}: {
	panelRef: RefObject<HTMLFieldSetElement | null>;
	sourcePending: boolean;
	sourceResult: WorkflowSourceResult | null;
	locations: ProviderWorkflowSaveLocation[];
	location?: ProviderWorkflowSaveLocation;
	pending: boolean;
	scope: ProviderWorkflowSaveScope;
	result: WorkflowSaveResult | null;
	replaceExisting: boolean;
	onSelectScope: (scope: ProviderWorkflowSaveScope) => void;
	onSubmit: () => void;
	onCancel: () => void;
}) {
	return (
		<fieldset
			ref={panelRef}
			tabIndex={-1}
			aria-label="Save workflow options"
			className="mt-3 border border-border/60 bg-background/35 p-3 outline-none focus:border-primary/35"
		>
			<div className="flex items-center gap-2">
				<Save className="h-3.5 w-3.5 text-primary/60" />
				<h3 className="text-[10px] font-medium tracking-widest text-primary/75 uppercase">
					Save as a Claude command
				</h3>
			</div>
			<p className="mt-2 text-[10px] leading-relaxed text-muted-foreground/60">
				Hlid copies Claude's persisted script into a native workflow command
				location. The script's meta.name becomes the slash command.
			</p>
			<WorkflowSourcePreview
				pending={sourcePending}
				source={sourceResult?.source}
				error={sourceResult?.error}
			/>
			<div className="mt-3 flex flex-wrap gap-2">
				{locations.map((candidate) => (
					<button
						key={candidate.scope}
						type="button"
						disabled={!candidate.available || pending}
						onClick={() => onSelectScope(candidate.scope)}
						className={`border px-2.5 py-1.5 text-[9px] tracking-widest uppercase transition-colors disabled:opacity-40 ${
							scope === candidate.scope
								? "border-primary/35 bg-primary/[0.07] text-primary/80"
								: "border-border text-muted-foreground/60 hover:text-foreground"
						}`}
					>
						{candidate.scopeLabel}
					</button>
				))}
			</div>
			{location ? (
				<PrivacyMask className="mt-2 break-all font-mono text-[9px] text-muted-foreground/50">
					{location.path || location.error || "Location unavailable"}
				</PrivacyMask>
			) : (
				<p className="mt-2 text-[10px] text-muted-foreground/55">
					Workflow locations are still loading.
				</p>
			)}
			{result?.error && (
				<p role="alert" className="mt-2 text-[10px] text-destructive/75">
					{result.error}
				</p>
			)}
			{result?.workflow && (
				<p className="mt-2 text-[10px] text-status-success/75">
					Saved as /{result.workflow.name}.
				</p>
			)}
			<div className="mt-3 flex flex-wrap gap-2">
				<button
					type="button"
					disabled={!location?.available || pending}
					onClick={onSubmit}
					className="inline-flex min-h-8 items-center gap-1.5 border border-primary/25 px-2.5 py-1 text-[9px] font-medium tracking-widest text-primary/75 uppercase transition-colors hover:bg-primary/5 disabled:opacity-45"
				>
					{pending ? (
						<LoaderCircle className="h-3 w-3 animate-spin" />
					) : (
						<Save className="h-3 w-3" />
					)}
					{pending
						? "Saving"
						: replaceExisting
							? "Replace existing"
							: `Save to ${scope}`}
				</button>
				<button
					type="button"
					disabled={pending}
					onClick={onCancel}
					className="min-h-8 border border-border px-2.5 py-1 text-[9px] tracking-widest text-muted-foreground uppercase hover:text-foreground disabled:opacity-45"
				>
					Cancel
				</button>
			</div>
		</fieldset>
	);
}

function WorkflowRunDetails({
	run,
	providerId,
	sessionId,
	savePanel,
	onStop,
	onRunPrompt,
	onBeginSave,
}: {
	run: WorkflowRun;
	providerId?: string;
	sessionId: string;
	savePanel: ReactNode;
	onStop: (run: WorkflowRun) => void;
	onRunPrompt: (prompt: string) => void;
	onBeginSave: (run: WorkflowRun) => void;
}) {
	const matchesProvider = providerId === run.workflow.provider;
	return (
		<>
			<div className="border border-border/60 bg-background/35">
				<SubagentToolBlock
					key={`${run.key}:${run.eventId}`}
					subagent={run.workflow}
					childSubagents={run.children}
					initiallyOpen
					stateScope="workflow-manager"
					onStop={
						matchesProvider && sessionId && run.workflow.taskId
							? () => onStop(run)
							: undefined
					}
					onResume={
						matchesProvider && sessionId && run.workflow.workflowRunId
							? () => onRunPrompt(workflowResumePrompt(run.workflow))
							: undefined
					}
					onRerun={
						matchesProvider && sessionId && run.workflow.workflowScriptPath
							? () => onRunPrompt(workflowRerunPrompt(run.workflow, run.args))
							: undefined
					}
					onSave={
						matchesProvider && run.workflow.workflowScriptPath
							? () => onBeginSave(run)
							: undefined
					}
				/>
			</div>
			{savePanel}
		</>
	);
}

function SavedWorkflowDetails({
	workflow,
	input,
	sourcePending,
	sourceResult,
	deletePending,
	deleteSucceeded,
	deleteError,
	onInputChange,
	onRun,
	onDelete,
}: {
	workflow: ProviderSavedWorkflow;
	input: string;
	sourcePending: boolean;
	sourceResult: WorkflowSourceResult | null;
	deletePending: boolean;
	deleteSucceeded: boolean;
	deleteError?: string;
	onInputChange: (value: string) => void;
	onRun: () => void;
	onDelete: () => void;
}) {
	return (
		<div className="border border-border/60 bg-background/35 p-4">
			<SavedWorkflowSummary workflow={workflow} />
			<WorkflowSourcePreview
				pending={sourcePending}
				source={sourceResult?.source}
				error={sourceResult?.error}
			/>
			{deleteError && (
				<p role="alert" className="mt-2 text-[10px] text-destructive/75">
					{deleteError}
				</p>
			)}
			<SavedWorkflowControls
				workflow={workflow}
				input={input}
				deletePending={deletePending}
				deleteSucceeded={deleteSucceeded}
				onInputChange={onInputChange}
				onRun={onRun}
				onDelete={onDelete}
			/>
		</div>
	);
}

function WorkflowDetailsPane({
	hasSelection,
	children,
}: {
	hasSelection: boolean;
	children: ReactNode;
}) {
	return (
		<div
			className={`min-h-0 overflow-y-auto overscroll-contain p-3 sm:p-4 ${
				hasSelection ? "" : "hidden md:block"
			}`}
		>
			{children}
		</div>
	);
}

function WorkflowSelectionPlaceholder() {
	return (
		<div className="grid min-h-64 place-items-center text-center">
			<div className="max-w-sm space-y-2">
				<WorkflowIcon className="mx-auto h-7 w-7 text-primary/20" />
				<p className="text-sm text-foreground/60">Select a workflow</p>
				<p className="text-[11px] leading-relaxed text-muted-foreground/50">
					Choose a saved workflow or run to inspect its details.
				</p>
			</div>
		</div>
	);
}

function WorkflowManagerFooter({
	hasOlderHistory,
	isLoadingOlderHistory,
	onLoadOlderHistory,
	onRefreshSaved,
}: {
	hasOlderHistory: boolean;
	isLoadingOlderHistory: boolean;
	onLoadOlderHistory?: () => Promise<number>;
	onRefreshSaved?: () => void;
}) {
	return (
		<footer className="flex min-h-11 shrink-0 items-center justify-between gap-3 border-t border-border px-4 py-2">
			<span className="text-[9px] text-muted-foreground/40">
				Current Raven session
			</span>
			<div className="flex flex-wrap items-center gap-2">
				{onRefreshSaved && (
					<button
						type="button"
						onClick={onRefreshSaved}
						className="border border-border px-2.5 py-1.5 text-[9px] tracking-widest text-muted-foreground uppercase transition-colors hover:bg-accent hover:text-foreground"
					>
						Refresh saved
					</button>
				)}
				{hasOlderHistory && onLoadOlderHistory && (
					<button
						type="button"
						disabled={isLoadingOlderHistory}
						onClick={() => void onLoadOlderHistory()}
						className="border border-border px-2.5 py-1.5 text-[9px] tracking-widest text-muted-foreground uppercase transition-colors hover:bg-accent hover:text-foreground disabled:opacity-45"
					>
						{isLoadingOlderHistory ? "Loading older" : "Load older history"}
					</button>
				)}
			</div>
		</footer>
	);
}

export function WorkflowManagerDialog({
	messages,
	sessionId,
	providerId,
	hasOlderHistory = false,
	isLoadingOlderHistory = false,
	savedWorkflows = [],
	saveLocations = [],
	saveResult,
	deleteResult,
	sourceResult,
	onLoadOlderHistory,
	onStop,
	onRunPrompt,
	onSave,
	onDelete,
	onReadSource,
	onRefreshSaved,
	onClose,
}: {
	messages: ReadonlyArray<WorkflowTranscriptMessage>;
	sessionId: string;
	providerId?: string;
	hasOlderHistory?: boolean;
	isLoadingOlderHistory?: boolean;
	savedWorkflows?: ProviderSavedWorkflow[];
	saveLocations?: ProviderWorkflowSaveLocation[];
	saveResult?: {
		type?: "workflow_save_result";
		request_id: string;
		workflow?: ProviderSavedWorkflow;
		error?: string;
		error_code?: string;
	} | null;
	deleteResult?: {
		type?: "workflow_delete_result";
		request_id: string;
		script_path?: string;
		error?: string;
	} | null;
	sourceResult?: {
		type?: "workflow_source_result";
		request_id: string;
		script_path: string;
		source?: string;
		error?: string;
	} | null;
	onLoadOlderHistory?: () => Promise<number>;
	onStop: (run: WorkflowRun) => void;
	onRunPrompt: (prompt: string) => void;
	onSave: (
		run: WorkflowRun,
		scope: ProviderWorkflowSaveScope,
		overwrite: boolean,
	) => string;
	onDelete: (workflow: ProviderSavedWorkflow) => string;
	onReadSource: (
		scriptPath: string,
		scope?: ProviderWorkflowSaveScope,
	) => string;
	onRefreshSaved?: () => void;
	onClose: () => void;
}) {
	const runs = useMemo(() => collectWorkflowRuns(messages), [messages]);
	const [selectedKey, setSelectedKey] = useState<string | null>(null);
	const [savedInput, setSavedInput] = useState("");
	const [saveRunKey, setSaveRunKey] = useState<string | null>(null);
	const [saveScope, setSaveScope] =
		useState<ProviderWorkflowSaveScope>("project");
	const [saveRequestId, setSaveRequestId] = useState<string | null>(null);
	const [deleteRequestId, setDeleteRequestId] = useState<string | null>(null);
	const [sourceRequestId, setSourceRequestId] = useState<string | null>(null);
	const [pendingSavedSelectionId, setPendingSavedSelectionId] = useState<
		string | null
	>(null);
	const listRef = useRef<HTMLDivElement>(null);
	const savePanelRef = useRef<HTMLFieldSetElement>(null);
	const anyActive = runs.some((run) =>
		isActiveWorkflowStatus(run.workflow.status),
	);
	const [now, setNow] = useState(() => Date.now());
	const { dialogRef, onDialogKeyDown } =
		useDialogFocus<HTMLDivElement>(onClose);

	useEffect(() => {
		if (!anyActive) return;
		setNow(Date.now());
		const interval = window.setInterval(() => setNow(Date.now()), 1_000);
		return () => window.clearInterval(interval);
	}, [anyActive]);

	useLayoutEffect(() => {
		if (!selectedKey) return;
		const selected = listRef.current?.querySelector<HTMLElement>(
			'[role="option"][aria-selected="true"]',
		);
		selected?.scrollIntoView?.({ block: "nearest" });
	}, [selectedKey]);

	useEffect(() => {
		if (!selectedKey) return;
		if (
			runs.some((run) => selectedKey === `run:${run.selectionKey}`) ||
			savedWorkflows.some((workflow) => selectedKey === `saved:${workflow.id}`)
		)
			return;
		setSelectedKey(null);
		setSourceRequestId(null);
	}, [runs, savedWorkflows, selectedKey]);

	const selectedRun =
		runs.find((run) => selectedKey === `run:${run.selectionKey}`) ?? null;
	const selectedSaved =
		savedWorkflows.find((workflow) => selectedKey === `saved:${workflow.id}`) ??
		null;
	const hasSelection = Boolean(selectedRun || selectedSaved);
	const activeCount = runs.filter((run) =>
		isActiveWorkflowStatus(run.workflow.status),
	).length;
	const saveLocation = saveLocations.find(
		(location) => location.scope === saveScope,
	);
	const currentSaveResult =
		saveRequestId && saveResult?.request_id === saveRequestId
			? saveResult
			: null;
	const savePending = Boolean(saveRequestId && !currentSaveResult);
	const replaceExisting = currentSaveResult?.error_code === "exists";
	const currentDeleteResult =
		deleteRequestId && deleteResult?.request_id === deleteRequestId
			? deleteResult
			: null;
	const deletePending = Boolean(deleteRequestId && !currentDeleteResult);
	const deleteSucceeded = Boolean(currentDeleteResult?.script_path);
	const currentSourceResult =
		sourceRequestId && sourceResult?.request_id === sourceRequestId
			? sourceResult
			: null;
	const sourcePending = Boolean(sourceRequestId && !currentSourceResult);

	useEffect(() => {
		const saved = currentSaveResult?.workflow;
		if (!saved) return;
		setPendingSavedSelectionId(saved.id);
		setSaveRunKey(null);
		setSaveRequestId(null);
	}, [currentSaveResult]);

	useEffect(() => {
		if (
			!pendingSavedSelectionId ||
			!savedWorkflows.some(
				(workflow) => workflow.id === pendingSavedSelectionId,
			)
		)
			return;
		const saved = savedWorkflows.find(
			(workflow) => workflow.id === pendingSavedSelectionId,
		);
		if (!saved) return;
		setSelectedKey(`saved:${saved.id}`);
		setSourceRequestId(onReadSource(saved.scriptPath, saved.scope));
		setPendingSavedSelectionId(null);
	}, [onReadSource, pendingSavedSelectionId, savedWorkflows]);

	useEffect(() => {
		if (!saveRunKey) return;
		const panel = savePanelRef.current;
		if (!panel) return;
		panel.scrollIntoView?.({ behavior: "smooth", block: "nearest" });
		panel.focus({ preventScroll: true });
	}, [saveRunKey]);

	function beginSave(run: WorkflowRun) {
		setSaveRunKey(run.selectionKey);
		setSaveRequestId(null);
		const scriptPath = run.workflow.workflowScriptPath;
		setSourceRequestId(scriptPath ? onReadSource(scriptPath) : null);
		const firstAvailable =
			saveLocations.find((location) => location.available)?.scope ?? "project";
		setSaveScope(firstAvailable);
	}

	function submitSave(run: WorkflowRun) {
		if (!saveLocation?.available || savePending) return;
		setSaveRequestId(onSave(run, saveScope, replaceExisting));
	}

	function clearSelection() {
		setSelectedKey(null);
		setSavedInput("");
		setSaveRunKey(null);
		setSaveRequestId(null);
		setDeleteRequestId(null);
		setSourceRequestId(null);
	}

	function toggleSavedWorkflow(workflow: ProviderSavedWorkflow, key: string) {
		if (selectedKey === key) {
			clearSelection();
			return;
		}
		setSelectedKey(key);
		setSavedInput("");
		setSaveRunKey(null);
		setSaveRequestId(null);
		setDeleteRequestId(null);
		setSourceRequestId(onReadSource(workflow.scriptPath, workflow.scope));
	}

	function toggleRun(key: string) {
		if (selectedKey === key) {
			clearSelection();
			return;
		}
		setSelectedKey(key);
		setSaveRunKey(null);
		setSaveRequestId(null);
		setDeleteRequestId(null);
		setSourceRequestId(null);
	}

	return createPortal(
		// biome-ignore lint/a11y/useKeyWithClickEvents: Escape is handled by the focused dialog
		// biome-ignore lint/a11y/noStaticElementInteractions: modal backdrop pattern
		<div
			className="fixed inset-0 z-50 flex items-center justify-center bg-background/90 p-3 backdrop-blur-sm sm:p-5"
			onClick={onClose}
		>
			<div
				ref={dialogRef}
				tabIndex={-1}
				role="dialog"
				aria-modal="true"
				aria-label="Claude workflows"
				onClick={(event) => event.stopPropagation()}
				onKeyDown={onDialogKeyDown}
				className="flex max-h-[90vh] w-[96vw] max-w-5xl flex-col overflow-hidden border border-border bg-card shadow-2xl focus:outline-none"
			>
				<WorkflowManagerHeader
					runCount={runs.length}
					activeCount={activeCount}
					savedCount={savedWorkflows.length}
					onClose={onClose}
				/>

				{runs.length === 0 && savedWorkflows.length === 0 ? (
					<WorkflowManagerEmptyState />
				) : (
					<div className="grid min-h-0 flex-1 md:grid-cols-[19rem_minmax(0,1fr)]">
						<WorkflowListPane
							listRef={listRef}
							runs={runs}
							savedWorkflows={savedWorkflows}
							selectedKey={selectedKey}
							hasSelection={hasSelection}
							now={now}
							onSelectRun={toggleRun}
							onSelectSaved={toggleSavedWorkflow}
						/>
						<WorkflowDetailsPane hasSelection={hasSelection}>
							{!selectedRun && !selectedSaved && (
								<WorkflowSelectionPlaceholder />
							)}
							{selectedRun && (
								<WorkflowRunDetails
									run={selectedRun}
									providerId={providerId}
									sessionId={sessionId}
									onStop={onStop}
									onRunPrompt={onRunPrompt}
									onBeginSave={beginSave}
									savePanel={
										saveRunKey === selectedRun.selectionKey ? (
											<WorkflowSavePanel
												panelRef={savePanelRef}
												sourcePending={sourcePending}
												sourceResult={currentSourceResult}
												locations={saveLocations}
												location={saveLocation}
												pending={savePending}
												scope={saveScope}
												result={currentSaveResult}
												replaceExisting={replaceExisting}
												onSelectScope={(scope) => {
													setSaveScope(scope);
													setSaveRequestId(null);
												}}
												onSubmit={() => submitSave(selectedRun)}
												onCancel={() => {
													setSaveRunKey(null);
													setSaveRequestId(null);
													setSourceRequestId(null);
												}}
											/>
										) : null
									}
								/>
							)}
							{selectedSaved && (
								<SavedWorkflowDetails
									workflow={selectedSaved}
									input={savedInput}
									sourcePending={sourcePending}
									sourceResult={currentSourceResult}
									deletePending={deletePending}
									deleteSucceeded={deleteSucceeded}
									deleteError={currentDeleteResult?.error}
									onInputChange={setSavedInput}
									onRun={() =>
										onRunPrompt(
											savedWorkflowRunPrompt(selectedSaved, savedInput),
										)
									}
									onDelete={() => setDeleteRequestId(onDelete(selectedSaved))}
								/>
							)}
						</WorkflowDetailsPane>
					</div>
				)}

				<WorkflowManagerFooter
					hasOlderHistory={hasOlderHistory}
					isLoadingOlderHistory={isLoadingOlderHistory}
					onLoadOlderHistory={onLoadOlderHistory}
					onRefreshSaved={onRefreshSaved}
				/>
			</div>
		</div>,
		document.body,
	);
}
