import {
	Archive,
	ArchiveRestore,
	Ellipsis,
	GitFork,
	LoaderCircle,
	Pencil,
	Pin,
	PinOff,
	X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { HydrationSafeText } from "#/components/HydrationSafeText";
import { sessionEntryDotClass } from "#/components/nav/SystemStatusDot";
import { PrivacyMask } from "#/components/PrivacyMask";
import type { SessionRow } from "#/db";
import { useAnchoredPopover } from "#/hooks/useAnchoredPopover";
import type { LiveStats } from "#/hooks/wsLiveStatsStore";
import { formatDisplayCost } from "#/lib/costDisplay";
import { fmt, fmtDate, fmtDateUtc, fmtModel } from "#/lib/formatters";
import {
	liveDelegationRollupLabel,
	liveDelegationUsageLabel,
} from "#/lib/liveSessionSwitcher";
import {
	isClaudeRuntimeProvider,
	isCodexRuntimeProvider,
} from "#/lib/providerRuntime";
import type { SessionStatusEntry } from "#/server/protocol";

const IMPORTED_SOURCE_LABELS: Record<string, string> = {
	"claude-desktop-cowork": "Claude Desktop Cowork import",
	"claude-sdk": "Claude SDK import",
	"claude-cli": "Claude CLI import",
	"codex-cli": "Codex CLI import",
	"codex-desktop": "Codex Desktop/editor import",
};

function importedSourceLabel(source: string | null | undefined): string {
	return IMPORTED_SOURCE_LABELS[source ?? ""] ?? "imported usage";
}

function sumUsage(values: readonly (number | null | undefined)[]): number {
	return values.reduce<number>((total, value) => total + (value ?? 0), 0);
}

export function sessionDisplayUsage(
	session: SessionRow,
	isActive: boolean,
	liveStats?: LiveStats,
): { cost: number; tokens: number } {
	const pendingTokens = liveStats
		? sumUsage([
				liveStats.pending_input_tokens,
				liveStats.pending_output_tokens,
				liveStats.pending_cache_read_tokens,
				liveStats.pending_cache_creation_tokens,
			])
		: 0;
	const persistedCost = sumUsage([
		session.total_cost,
		session.total_estimated_cost,
		isActive ? liveStats?.pending_estimated_cost : 0,
	]);
	const persistedTokens = sumUsage([
		session.total_input_tokens,
		session.total_output_tokens,
		session.total_cache_read_tokens,
		session.total_cache_creation_tokens,
		isActive ? pendingTokens : 0,
	]);
	return {
		cost: Math.max(persistedCost, session.delegation_cost_used ?? 0),
		tokens: Math.max(persistedTokens, session.delegation_tokens_used ?? 0),
	};
}

export type SessionLedgerRowProps = {
	session: SessionRow;
	usageSession?: SessionRow;
	onDelete: (id: string) => void;
	onNavigate: (id: string) => void;
	onRename: (id: string, label: string) => void;
	onPin: (id: string, pinned: boolean) => void;
	onArchive: (id: string, archived: boolean) => void;
	onFork: (id: string) => void;
	archived?: boolean;
	isForking?: boolean;
	isActive?: boolean;
	poolSession?: SessionStatusEntry;
	liveStats?: LiveStats;
	isDesktop: boolean;
	forkProviderIds?: ReadonlySet<string>;
};

function sessionMetadataDetails(
	session: SessionRow,
	toolCallCount: number,
	importedHistory: boolean,
	resumableHistory: boolean,
	providerModel: string,
	delegationRollup: string | null,
): string[] {
	const imported = importedHistory
		? `${importedSourceLabel(session.history_source)}${resumableHistory ? " · resumable" : ""}`
		: "";
	const delegatedFrom = session.delegation_parent_session_id
		? `delegated from ${session.delegation_parent_label ?? "parent session"}`
		: "";
	return [
		`${session.query_count}q`,
		`${toolCallCount} ${toolCallCount === 1 ? "tool" : "tools"}`,
		providerModel,
		imported,
		session.fork_kind === "exact" ? "exact fork" : "",
		delegatedFrom,
		delegationRollup ?? "",
	].filter(Boolean);
}

function deriveSessionCapabilities(
	session: SessionRow,
	poolSession: SessionStatusEntry | undefined,
	forkProviderIds: ReadonlySet<string> | undefined,
) {
	const importedHistory = session.history_imported === 1;
	const resumableHistory =
		importedHistory && (session.history_resume_mode ?? "none") !== "none";
	const canNavigate = !importedHistory || resumableHistory;
	const providerId = session.provider_id || "claude";
	const providerCanFork =
		forkProviderIds?.has(providerId) ??
		(isClaudeRuntimeProvider(providerId) || isCodexRuntimeProvider(providerId));
	return {
		importedHistory,
		resumableHistory,
		canNavigate,
		canFork: providerCanFork && canNavigate,
		forkBlocked: poolSession?.state === "running",
		providerId,
	};
}

type SessionCapabilities = ReturnType<typeof deriveSessionCapabilities>;

function deriveSessionUsage(
	session: SessionRow,
	usageSession: SessionRow | undefined,
	isActive: boolean,
	liveStats: LiveStats | undefined,
	capabilities: SessionCapabilities,
) {
	const usageSource = usageSession?.id === session.id ? usageSession : session;
	const usage = sessionDisplayUsage(usageSource, isActive, liveStats);
	const toolCallCount =
		usageSource.tool_call_count ?? session.tool_call_count ?? 0;
	const configuredModel = session.selected_model || session.model;
	const providerModel = [
		capabilities.providerId,
		configuredModel ? fmtModel(configuredModel) : undefined,
	]
		.filter((part): part is string => Boolean(part))
		.join(" · ");
	const reportedCost = usageSource.total_cost ?? 0;
	const estimatedCost = sumUsage([
		usageSource.total_estimated_cost,
		isActive ? liveStats?.pending_estimated_cost : 0,
	]);
	return {
		usage,
		toolCallCount,
		providerModel,
		costSummary: {
			cost: reportedCost,
			estimated_cost: Math.max(estimatedCost, usage.cost - reportedCost),
			unpriced_queries: usageSource.unpriced_query_count ?? 0,
		},
	};
}

function deriveSessionRowPresentation({
	session,
	usageSession,
	isActive = false,
	poolSession,
	liveStats,
	forkProviderIds,
}: Pick<
	SessionLedgerRowProps,
	| "session"
	| "usageSession"
	| "isActive"
	| "poolSession"
	| "liveStats"
	| "forkProviderIds"
>) {
	const capabilities = deriveSessionCapabilities(
		session,
		poolSession,
		forkProviderIds,
	);
	const usage = deriveSessionUsage(
		session,
		usageSession,
		isActive,
		liveStats,
		capabilities,
	);
	const delegationRollup = poolSession
		? liveDelegationRollupLabel(poolSession)
		: null;

	return {
		pinned: session.pinned === 1,
		canNavigate: capabilities.canNavigate,
		canFork: capabilities.canFork,
		forkBlocked: capabilities.forkBlocked,
		usage: usage.usage,
		costSummary: usage.costSummary,
		metadata: sessionMetadataDetails(
			session,
			usage.toolCallCount,
			capabilities.importedHistory,
			capabilities.resumableHistory,
			usage.providerModel,
			delegationRollup,
		),
		delegationUsage: poolSession ? liveDelegationUsageLabel(poolSession) : null,
	};
}

type SessionRowPresentation = ReturnType<typeof deriveSessionRowPresentation>;

function actionPanelHeight({
	renaming,
	deleteConfirming,
	canFork,
	archived,
}: {
	renaming: boolean;
	deleteConfirming: boolean;
	canFork: boolean;
	archived: boolean;
}): number {
	if (renaming) return 210;
	if (deleteConfirming) return 170;
	return 156 + (canFork ? 44 : 0) + (archived ? 0 : 44);
}

function useSessionRowInteraction(
	props: SessionLedgerRowProps,
	presentation: SessionRowPresentation,
) {
	const {
		session,
		onDelete,
		onRename,
		onPin,
		onArchive,
		onFork,
		archived = false,
		isForking = false,
		isDesktop,
	} = props;
	const [editing, setEditing] = useState(false);
	const [editValue, setEditValue] = useState("");
	const [menuOpen, setMenuOpen] = useState(false);
	const [deleteConfirming, setDeleteConfirming] = useState(false);
	const [mobileRenaming, setMobileRenaming] = useState(false);
	const inputRef = useRef<HTMLInputElement>(null);
	const actionButtonRef = useRef<HTMLButtonElement>(null);
	const actionPanelRef = useRef<HTMLDivElement>(null);
	const wasForkingRef = useRef(false);
	const mobileRenameActive = !isDesktop && mobileRenaming;
	const actionPosition = useAnchoredPopover(
		menuOpen,
		actionButtonRef,
		isDesktop ? 160 : mobileRenameActive ? 320 : 208,
		actionPanelHeight({
			renaming: mobileRenameActive,
			deleteConfirming,
			canFork: presentation.canFork,
			archived,
		}),
		actionPanelRef,
	);

	function closeMenu() {
		setMenuOpen(false);
		setDeleteConfirming(false);
		setMobileRenaming(false);
	}

	function saveRename(close: () => void) {
		const trimmed = editValue.trim();
		if (trimmed && trimmed !== session.label) onRename(session.id, trimmed);
		close();
	}

	function startDesktopRename() {
		setEditValue(session.label ?? "");
		setEditing(true);
		setTimeout(() => {
			inputRef.current?.focus();
			inputRef.current?.select();
		}, 0);
	}

	function startRename() {
		if (isDesktop) {
			closeMenu();
			startDesktopRename();
			return;
		}
		setEditValue(session.label ?? "");
		setMobileRenaming(true);
	}

	useEffect(() => {
		if (wasForkingRef.current && !isForking) {
			setMenuOpen(false);
			setDeleteConfirming(false);
			setMobileRenaming(false);
		}
		wasForkingRef.current = isForking;
	}, [isForking]);

	return {
		editing,
		editValue,
		setEditValue,
		menuOpen,
		deleteConfirming,
		mobileRenameActive,
		inputRef,
		actionButtonRef,
		actionPanelRef,
		actionPosition,
		toggleMenu: () => setMenuOpen((open) => !open),
		closeMenu,
		startRename,
		cancelDesktopRename: () => setEditing(false),
		commitDesktopRename: () => saveRename(() => setEditing(false)),
		commitMobileRename: () => saveRename(closeMenu),
		requestDelete: () => setDeleteConfirming(true),
		cancelDelete: () => setDeleteConfirming(false),
		confirmDelete: () => {
			onDelete(session.id);
			closeMenu();
		},
		togglePin: () => {
			onPin(session.id, !presentation.pinned);
			closeMenu();
		},
		toggleArchived: () => {
			onArchive(session.id, !archived);
			closeMenu();
		},
		fork: () => onFork(session.id),
	};
}

type SessionRowInteraction = ReturnType<typeof useSessionRowInteraction>;

function SessionInlineRename({
	interaction,
}: {
	interaction: SessionRowInteraction;
}) {
	return (
		<>
			<div className="flex-1 min-w-0 px-4 py-2.5">
				<input
					ref={interaction.inputRef}
					value={interaction.editValue}
					onChange={(event) => interaction.setEditValue(event.target.value)}
					onKeyDown={(event) => {
						if (event.key === "Enter") interaction.commitDesktopRename();
						else if (event.key === "Escape") interaction.cancelDesktopRename();
					}}
					className="w-full bg-transparent border-b border-border text-[11px] tracking-wider text-foreground/80 outline-none placeholder:text-muted-foreground/40"
					placeholder="session name"
					aria-label="Session name"
				/>
				<div className="text-[9px] tracking-wider text-muted-foreground/40 mt-0.5">
					Enter to save · Esc to cancel
				</div>
			</div>
			<button
				type="button"
				onClick={interaction.cancelDesktopRename}
				className="pr-4 text-muted-foreground/40 hover:text-foreground transition-colors shrink-0"
				aria-label="Cancel rename"
			>
				<X size={12} />
			</button>
		</>
	);
}

function SessionRowDate({ startedAt }: { startedAt: number | null }) {
	return startedAt != null ? (
		<HydrationSafeText
			serverText={fmtDateUtc(startedAt)}
			clientText={fmtDate(startedAt)}
		/>
	) : (
		"—"
	);
}

function SessionRowDisplay({
	session,
	poolSession,
	presentation,
}: {
	session: SessionRow;
	poolSession?: SessionStatusEntry;
	presentation: SessionRowPresentation;
}) {
	return (
		<div className="pointer-events-none relative z-10 flex items-center gap-3 flex-1 min-w-0 px-4 py-2.5 text-left">
			{presentation.pinned && (
				<Pin
					size={12}
					className="shrink-0 text-primary/70"
					aria-label="Pinned session"
				/>
			)}
			{poolSession && (
				<div
					className={`w-1.5 h-1.5 rounded-full shrink-0 ${sessionEntryDotClass(poolSession)}`}
					role="img"
					aria-label={`${poolSession.state} subprocess`}
				/>
			)}
			<div className="flex-1 min-w-0">
				<PrivacyMask className="text-[11px] tracking-wider text-foreground/80 truncate">
					{session.label ?? "untitled"}
				</PrivacyMask>
				<PrivacyMask className="text-[9px] tracking-wider text-muted-foreground/40 mt-0.5 truncate">
					<SessionRowDate startedAt={session.started_at} />
					{" · "}
					{presentation.metadata.join(" · ")}
				</PrivacyMask>
				{presentation.delegationUsage && (
					<div
						title="Tokens and cost are cumulative across all delegated descendants. Elapsed time spans the first descendant start through the last stop, or now while work is active."
						className="mt-0.5 truncate font-mono text-[8px] text-primary/40"
					>
						<PrivacyMask>{presentation.delegationUsage}</PrivacyMask>
					</div>
				)}
			</div>
			<div className="text-right shrink-0">
				<PrivacyMask className="text-[11px] tabular-nums text-[var(--data)]/70">
					{formatDisplayCost(presentation.costSummary)}
				</PrivacyMask>
				<PrivacyMask className="text-[9px] tabular-nums text-muted-foreground/40 mt-0.5">
					{fmt(presentation.usage.tokens)} tok
				</PrivacyMask>
			</div>
		</div>
	);
}

function SessionRenamePanel({
	interaction,
}: {
	interaction: SessionRowInteraction;
}) {
	return (
		<form
			className="space-y-3 p-2"
			onSubmit={(event) => {
				event.preventDefault();
				interaction.commitMobileRename();
			}}
		>
			<label className="block">
				<span className="mb-1.5 block text-[9px] tracking-widest text-muted-foreground uppercase">
					Session name
				</span>
				<input
					value={interaction.editValue}
					onChange={(event) => interaction.setEditValue(event.target.value)}
					enterKeyHint="done"
					className="min-h-11 w-full border border-border bg-background px-3 text-sm outline-none focus:border-primary/50"
					aria-label="Session name"
				/>
			</label>
			<div className="grid grid-cols-2 gap-2">
				<button
					type="button"
					onClick={interaction.closeMenu}
					className="min-h-11 border border-border text-[9px] tracking-widest uppercase"
				>
					Cancel
				</button>
				<button
					type="submit"
					disabled={!interaction.editValue.trim()}
					className="min-h-11 border border-primary/40 text-[9px] tracking-widest text-primary uppercase disabled:opacity-40"
				>
					Save
				</button>
			</div>
		</form>
	);
}

function SessionDeletePanel({
	interaction,
}: {
	interaction: SessionRowInteraction;
}) {
	return (
		<div className="space-y-3 p-2">
			<div className="text-[10px] text-muted-foreground">
				Delete this session permanently?
			</div>
			<div className="grid grid-cols-2 gap-2">
				<button
					type="button"
					onClick={interaction.cancelDelete}
					className="min-h-11 border border-border text-[9px] tracking-widest uppercase"
				>
					Cancel
				</button>
				<button
					type="button"
					onClick={interaction.confirmDelete}
					className="min-h-11 border border-destructive/40 text-[9px] tracking-widest text-destructive uppercase"
				>
					Delete
				</button>
			</div>
		</div>
	);
}

function SessionPinAction({
	pinned,
	onClick,
}: {
	pinned: boolean;
	onClick: () => void;
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			className="flex min-h-11 w-full items-center gap-2 px-3 text-[10px] tracking-wider text-foreground/80 hover:bg-accent/40"
		>
			{pinned ? <PinOff size={14} /> : <Pin size={14} />}
			{pinned ? "Unpin" : "Pin to top"}
		</button>
	);
}

function SessionForkAction({
	blocked,
	forking,
	onClick,
}: {
	blocked: boolean;
	forking: boolean;
	onClick: () => void;
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			disabled={forking || blocked}
			title={
				blocked
					? "Stop the active turn before forking this session"
					: "Fork this session into a new one"
			}
			className="flex min-h-11 w-full items-center gap-2 px-3 text-[10px] tracking-wider text-foreground/80 hover:bg-accent/40 disabled:opacity-60"
		>
			{forking ? (
				<LoaderCircle size={14} className="animate-spin" />
			) : (
				<GitFork size={14} />
			)}
			{forking ? "Forking…" : "Fork"}
		</button>
	);
}

function SessionArchiveAction({
	archived,
	blocked,
	onClick,
}: {
	archived: boolean;
	blocked: boolean;
	onClick: () => void;
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			disabled={blocked}
			title={
				blocked
					? "Stop the active turn before archiving this session"
					: archived
						? "Restore this session to the active list"
						: "Hide this session without deleting its history"
			}
			className="flex min-h-11 w-full items-center gap-2 px-3 text-[10px] tracking-wider text-foreground/80 hover:bg-accent/40 disabled:opacity-60"
		>
			{archived ? <ArchiveRestore size={14} /> : <Archive size={14} />}
			{archived ? "Restore" : "Archive"}
		</button>
	);
}

function SessionActionChoices({
	interaction,
	presentation,
	archived,
	isForking,
}: {
	interaction: SessionRowInteraction;
	presentation: SessionRowPresentation;
	archived: boolean;
	isForking: boolean;
}) {
	return (
		<>
			{!archived && (
				<SessionPinAction
					pinned={presentation.pinned}
					onClick={interaction.togglePin}
				/>
			)}
			<button
				type="button"
				onClick={interaction.startRename}
				className="flex min-h-11 w-full items-center gap-2 px-3 text-[10px] tracking-wider text-foreground/80 hover:bg-accent/40"
			>
				<Pencil size={14} /> Rename
			</button>
			{presentation.canFork && (
				<SessionForkAction
					blocked={presentation.forkBlocked}
					forking={isForking}
					onClick={interaction.fork}
				/>
			)}
			<SessionArchiveAction
				archived={archived}
				blocked={presentation.forkBlocked}
				onClick={interaction.toggleArchived}
			/>
			<button
				type="button"
				onClick={interaction.requestDelete}
				className="flex min-h-11 w-full items-center gap-2 px-3 text-[10px] tracking-wider text-destructive/80 hover:bg-accent/40"
			>
				<X size={14} /> Delete
			</button>
		</>
	);
}

function SessionActionPanel({
	interaction,
	presentation,
	archived,
	isForking,
}: {
	interaction: SessionRowInteraction;
	presentation: SessionRowPresentation;
	archived: boolean;
	isForking: boolean;
}) {
	const label = interaction.mobileRenameActive
		? "Rename session"
		: interaction.deleteConfirming
			? "Confirm session deletion"
			: "Session actions";
	return (
		<div
			ref={interaction.actionPanelRef}
			className="fixed z-[70] overflow-y-auto border border-border bg-popover p-2 shadow-xl"
			style={
				interaction.actionPosition
					? {
							left: interaction.actionPosition.left,
							top: interaction.actionPosition.top,
							width: interaction.actionPosition.width,
							maxHeight: interaction.actionPosition.maxHeight,
						}
					: undefined
			}
			role="dialog"
			aria-label={label}
		>
			{interaction.mobileRenameActive ? (
				<SessionRenamePanel interaction={interaction} />
			) : interaction.deleteConfirming ? (
				<SessionDeletePanel interaction={interaction} />
			) : (
				<SessionActionChoices
					interaction={interaction}
					presentation={presentation}
					archived={archived}
					isForking={isForking}
				/>
			)}
		</div>
	);
}

function SessionActionsPortal({
	interaction,
	presentation,
	archived,
	isForking,
	isDesktop,
}: {
	interaction: SessionRowInteraction;
	presentation: SessionRowPresentation;
	archived: boolean;
	isForking: boolean;
	isDesktop: boolean;
}) {
	return createPortal(
		<>
			<button
				type="button"
				onClick={interaction.closeMenu}
				className={`fixed inset-0 z-[60] ${isDesktop ? "bg-transparent" : "bg-black/10"}`}
				aria-label="Dismiss session actions"
			/>
			{interaction.actionPosition && (
				<SessionActionPanel
					interaction={interaction}
					presentation={presentation}
					archived={archived}
					isForking={isForking}
				/>
			)}
		</>,
		document.body,
	);
}

function SessionActions({
	interaction,
	presentation,
	archived,
	isForking,
	isDesktop,
}: {
	interaction: SessionRowInteraction;
	presentation: SessionRowPresentation;
	archived: boolean;
	isForking: boolean;
	isDesktop: boolean;
}) {
	return (
		<div
			data-session-action-slot
			className={`relative pr-2 shrink-0 ${interaction.menuOpen ? "z-[70]" : "z-20"}`}
		>
			<button
				ref={interaction.actionButtonRef}
				type="button"
				onClick={interaction.toggleMenu}
				className="w-11 h-11 flex items-center justify-center text-muted-foreground/50 hover:text-foreground md:opacity-0 md:group-hover:opacity-100 md:focus:opacity-100 transition-all"
				aria-label="Session actions"
				aria-expanded={interaction.menuOpen}
			>
				<Ellipsis size={17} />
			</button>
			{interaction.menuOpen && typeof document !== "undefined" && (
				<SessionActionsPortal
					interaction={interaction}
					presentation={presentation}
					archived={archived}
					isForking={isForking}
					isDesktop={isDesktop}
				/>
			)}
		</div>
	);
}

export function SessionLedgerRow(props: SessionLedgerRowProps) {
	const {
		session,
		onNavigate,
		poolSession,
		archived = false,
		isForking = false,
		isDesktop,
	} = props;
	const presentation = deriveSessionRowPresentation(props);
	const interaction = useSessionRowInteraction(props, presentation);

	return (
		<div
			className={`relative flex items-center gap-2 border-b border-border last:border-0 group hover:bg-accent/20 transition-colors ${presentation.canNavigate ? "cursor-pointer" : "cursor-default"}`}
		>
			{!interaction.editing && presentation.canNavigate && (
				<button
					type="button"
					onClick={() => onNavigate(session.id)}
					className="absolute inset-0 z-0 w-full"
					aria-label={`Open ${session.label ?? "untitled"} session`}
				/>
			)}
			{interaction.editing ? (
				<SessionInlineRename interaction={interaction} />
			) : (
				<SessionRowDisplay
					session={session}
					poolSession={poolSession}
					presentation={presentation}
				/>
			)}
			<SessionActions
				interaction={interaction}
				presentation={presentation}
				archived={archived}
				isForking={isForking}
				isDesktop={isDesktop}
			/>
		</div>
	);
}
