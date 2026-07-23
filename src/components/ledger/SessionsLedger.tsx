import {
	ArrowUpDown,
	Ellipsis,
	GitFork,
	LoaderCircle,
	Pencil,
	Pin,
	PinOff,
	Search,
	SlidersHorizontal,
	X,
} from "lucide-react";
import type { ComponentType, RefObject } from "react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { HydrationSafeText } from "#/components/HydrationSafeText";
import { LedgerPaginationBar } from "#/components/ledger/LedgerPagination";
import { sessionEntryDotClass } from "#/components/nav/SystemStatusDot";
import { PrivacyMask } from "#/components/PrivacyMask";
import type { SessionRow } from "#/db";
import {
	type AnchoredPopoverPosition,
	useAnchoredPopover,
} from "#/hooks/useAnchoredPopover";
import { useIsDesktop } from "#/hooks/useIsDesktop";
import type { LiveStats } from "#/hooks/wsLiveStatsStore";
import { formatDisplayCost } from "#/lib/costDisplay";
import { fmt, fmtDate, fmtDateUtc, fmtModel } from "#/lib/formatters";
import type { LedgerAgentOption, SessionSortKey } from "#/lib/ledgerState";
import {
	isClaudeRuntimeProvider,
	isCodexRuntimeProvider,
} from "#/lib/providerRuntime";
import type { SessionStatusEntry } from "#/server/protocol";

const CLEANUP_DAY_OPTIONS = [7, 30, 90] as const;

const SORT_LABELS: Record<SessionSortKey, string> = {
	recent: "recent",
	cost: "cost",
	tokens: "tokens",
};

function importedSourceLabel(source: string | null | undefined): string {
	if (source === "claude-desktop-cowork") return "Claude Desktop Cowork import";
	if (source === "claude-sdk") return "Claude SDK import";
	if (source === "claude-cli") return "Claude CLI import";
	if (source === "codex-cli") return "Codex CLI import";
	if (source === "codex-desktop") return "Codex Desktop/editor import";
	return "imported usage";
}

export function sessionDisplayUsage(
	session: SessionRow,
	isActive: boolean,
	liveStats?: LiveStats,
): { cost: number; tokens: number } {
	const pendingTokens = liveStats
		? liveStats.pending_input_tokens +
			liveStats.pending_output_tokens +
			liveStats.pending_cache_read_tokens +
			liveStats.pending_cache_creation_tokens
		: 0;
	return {
		cost: (session.total_cost ?? 0) + (session.total_estimated_cost ?? 0),
		tokens:
			(session.total_input_tokens ?? 0) +
			(session.total_output_tokens ?? 0) +
			(session.total_cache_read_tokens ?? 0) +
			(session.total_cache_creation_tokens ?? 0) +
			(isActive ? pendingTokens : 0),
	};
}

function SessionActionPanel({
	deleteConfirming,
	renaming,
	renameValue,
	onRenameValueChange,
	onRename,
	onCancelRename,
	onConfirmRename,
	pinned,
	onTogglePin,
	onRequestDelete,
	onCancelDelete,
	onConfirmDelete,
	canFork,
	forkBlocked,
	forking,
	onFork,
	position,
	panelRef,
}: {
	deleteConfirming: boolean;
	renaming: boolean;
	renameValue: string;
	onRenameValueChange: (value: string) => void;
	onRename: () => void;
	onCancelRename: () => void;
	onConfirmRename: () => void;
	pinned: boolean;
	onTogglePin: () => void;
	onRequestDelete: () => void;
	onCancelDelete: () => void;
	onConfirmDelete: () => void;
	canFork: boolean;
	forkBlocked: boolean;
	forking: boolean;
	onFork: () => void;
	position: AnchoredPopoverPosition;
	panelRef: RefObject<HTMLDivElement | null>;
}) {
	return (
		<div
			ref={panelRef}
			className="fixed z-[70] overflow-y-auto border border-border bg-popover p-2 shadow-xl"
			style={{
				left: position.left,
				top: position.top,
				width: position.width,
				maxHeight: position.maxHeight,
			}}
			role="dialog"
			aria-label={
				renaming
					? "Rename session"
					: deleteConfirming
						? "Confirm session deletion"
						: "Session actions"
			}
		>
			{renaming ? (
				<form
					className="space-y-3 p-2"
					onSubmit={(event) => {
						event.preventDefault();
						onConfirmRename();
					}}
				>
					<label className="block">
						<span className="mb-1.5 block text-[9px] tracking-widest text-muted-foreground uppercase">
							Session name
						</span>
						<input
							value={renameValue}
							onChange={(event) => onRenameValueChange(event.target.value)}
							enterKeyHint="done"
							className="min-h-11 w-full border border-border bg-background px-3 text-sm outline-none focus:border-primary/50"
							aria-label="Session name"
						/>
					</label>
					<div className="grid grid-cols-2 gap-2">
						<button
							type="button"
							onClick={onCancelRename}
							className="min-h-11 border border-border text-[9px] tracking-widest uppercase"
						>
							Cancel
						</button>
						<button
							type="submit"
							disabled={!renameValue.trim()}
							className="min-h-11 border border-primary/40 text-[9px] tracking-widest text-primary uppercase disabled:opacity-40"
						>
							Save
						</button>
					</div>
				</form>
			) : deleteConfirming ? (
				<div className="space-y-3 p-2">
					<div className="text-[10px] text-muted-foreground">
						Delete this session permanently?
					</div>
					<div className="grid grid-cols-2 gap-2">
						<button
							type="button"
							onClick={onCancelDelete}
							className="min-h-11 border border-border text-[9px] tracking-widest uppercase"
						>
							Cancel
						</button>
						<button
							type="button"
							onClick={onConfirmDelete}
							className="min-h-11 border border-destructive/40 text-[9px] tracking-widest text-destructive uppercase"
						>
							Delete
						</button>
					</div>
				</div>
			) : (
				<>
					<button
						type="button"
						onClick={onTogglePin}
						className="flex min-h-11 w-full items-center gap-2 px-3 text-[10px] tracking-wider text-foreground/80 hover:bg-accent/40"
					>
						{pinned ? <PinOff size={14} /> : <Pin size={14} />}
						{pinned ? "Unpin" : "Pin to top"}
					</button>
					<button
						type="button"
						onClick={onRename}
						className="flex min-h-11 w-full items-center gap-2 px-3 text-[10px] tracking-wider text-foreground/80 hover:bg-accent/40"
					>
						<Pencil size={14} /> Rename
					</button>
					{canFork && (
						<button
							type="button"
							onClick={onFork}
							disabled={forking || forkBlocked}
							title={
								forkBlocked
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
					)}
					<button
						type="button"
						onClick={onRequestDelete}
						className="flex min-h-11 w-full items-center gap-2 px-3 text-[10px] tracking-wider text-destructive/80 hover:bg-accent/40"
					>
						<X size={14} /> Delete
					</button>
				</>
			)}
		</div>
	);
}

function SessionItem({
	session,
	usageSession,
	onDelete,
	onNavigate,
	onRename,
	onPin,
	onFork,
	isForking = false,
	isActive,
	poolSession,
	liveStats,
	isDesktop,
	forkProviderIds,
}: {
	session: SessionRow;
	usageSession?: SessionRow;
	onDelete: (id: string) => void;
	onNavigate: (id: string) => void;
	onRename: (id: string, label: string) => void;
	onPin: (id: string, pinned: boolean) => void;
	onFork: (id: string) => void;
	isForking?: boolean;
	isActive?: boolean;
	poolSession?: SessionStatusEntry;
	liveStats?: LiveStats;
	isDesktop: boolean;
	forkProviderIds?: ReadonlySet<string>;
}) {
	const [editing, setEditing] = useState(false);
	const [editValue, setEditValue] = useState("");
	const [menuOpen, setMenuOpen] = useState(false);
	const [deleteConfirming, setDeleteConfirming] = useState(false);
	const [mobileRenaming, setMobileRenaming] = useState(false);
	const inputRef = useRef<HTMLInputElement>(null);
	const actionButtonRef = useRef<HTMLButtonElement>(null);
	const actionPanelRef = useRef<HTMLDivElement>(null);
	const importedHistory = session.history_imported === 1;
	const pinned = session.pinned === 1;
	const resumableHistory =
		importedHistory && (session.history_resume_mode ?? "none") !== "none";
	const canNavigate = !importedHistory || resumableHistory;
	// Keep fork availability tied to persisted session identity. A pool entry is
	// transient UI state, so using its mere presence made Fork disappear until a
	// reload closed or repopulated that entry. Idle Claude sessions are safe to
	// fork; only an active turn temporarily blocks the action.
	const providerId = session.provider_id || "claude";
	const canFork =
		(forkProviderIds?.has(providerId) ??
			(isClaudeRuntimeProvider(providerId) ||
				isCodexRuntimeProvider(providerId))) &&
		canNavigate;
	const forkBlocked = poolSession?.state === "running";
	const actionPosition = useAnchoredPopover(
		menuOpen,
		actionButtonRef,
		isDesktop ? 160 : mobileRenaming ? 320 : 208,
		mobileRenaming ? 210 : deleteConfirming ? 170 : 156 + (canFork ? 44 : 0),
		actionPanelRef,
	);
	const usageSource = usageSession?.id === session.id ? usageSession : session;
	const usage = sessionDisplayUsage(usageSource, Boolean(isActive), liveStats);
	const configuredModel = session.selected_model || session.model;
	const providerModel = [
		session.provider_id || "claude",
		configuredModel ? fmtModel(configuredModel) : undefined,
	]
		.filter((part): part is string => Boolean(part))
		.join(" · ");
	const costSummary = {
		cost: usageSource.total_cost ?? 0,
		estimated_cost: usageSource.total_estimated_cost ?? 0,
		unpriced_queries: usageSource.unpriced_query_count ?? 0,
	};

	function startEdit() {
		setEditValue(session.label ?? "");
		setEditing(true);
		setTimeout(() => {
			inputRef.current?.focus();
			inputRef.current?.select();
		}, 0);
	}

	function commitEdit() {
		const trimmed = editValue.trim();
		if (trimmed && trimmed !== session.label) {
			onRename(session.id, trimmed);
		}
		setEditing(false);
	}

	function cancelEdit() {
		setEditing(false);
	}

	function closeMenu() {
		setMenuOpen(false);
		setDeleteConfirming(false);
		setMobileRenaming(false);
	}

	function startMobileEdit() {
		setEditValue(session.label ?? "");
		setMobileRenaming(true);
	}

	function commitMobileEdit() {
		const trimmed = editValue.trim();
		if (trimmed && trimmed !== session.label) {
			onRename(session.id, trimmed);
		}
		closeMenu();
	}

	// Fork can take a few seconds (WSL probe) — keep the menu open showing a
	// spinner instead of closing immediately like the other actions, then
	// close it once this row's fork settles (success or failure). Inlines
	// closeMenu's state resets directly rather than depending on closeMenu
	// itself, which is redefined every render.
	const wasForkingRef = useRef(false);
	useEffect(() => {
		if (wasForkingRef.current && !isForking) {
			setMenuOpen(false);
			setDeleteConfirming(false);
			setMobileRenaming(false);
		}
		wasForkingRef.current = isForking;
	}, [isForking]);

	return (
		<div
			className={`relative flex items-center gap-2 border-b border-border last:border-0 group hover:bg-accent/20 transition-colors ${canNavigate ? "cursor-pointer" : "cursor-default"}`}
		>
			{!editing && canNavigate && (
				<button
					type="button"
					onClick={() => onNavigate(session.id)}
					className="absolute inset-0 z-0 w-full"
					aria-label={`Open ${session.label ?? "untitled"} session`}
				/>
			)}
			{editing ? (
				<>
					<div className="flex-1 min-w-0 px-4 py-2.5">
						<input
							ref={inputRef}
							value={editValue}
							onChange={(e) => setEditValue(e.target.value)}
							onKeyDown={(e) => {
								if (e.key === "Enter") commitEdit();
								else if (e.key === "Escape") cancelEdit();
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
						onClick={cancelEdit}
						className="pr-4 text-muted-foreground/40 hover:text-foreground transition-colors shrink-0"
						aria-label="Cancel rename"
					>
						<X size={12} />
					</button>
				</>
			) : (
				<div className="pointer-events-none relative z-10 flex items-center gap-3 flex-1 min-w-0 px-4 py-2.5 text-left">
					{pinned && (
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
							{session.started_at != null ? (
								<HydrationSafeText
									serverText={fmtDateUtc(session.started_at)}
									clientText={fmtDate(session.started_at)}
								/>
							) : (
								"—"
							)}{" "}
							· {session.query_count}q
							{providerModel ? ` · ${providerModel}` : ""}
							{importedHistory
								? ` · ${importedSourceLabel(session.history_source)}${resumableHistory ? " · resumable" : ""}`
								: ""}
							{session.fork_kind === "exact" ? " · exact fork" : ""}
						</PrivacyMask>
					</div>
					<div className="text-right shrink-0">
						<PrivacyMask className="text-[11px] tabular-nums text-[var(--data)]/70">
							{formatDisplayCost(costSummary)}
						</PrivacyMask>
						<PrivacyMask className="text-[9px] tabular-nums text-muted-foreground/40 mt-0.5">
							{fmt(usage.tokens)} tok
						</PrivacyMask>
					</div>
				</div>
			)}
			<div
				data-session-action-slot
				className={`relative pr-2 shrink-0 ${menuOpen ? "z-[70]" : "z-20"}`}
			>
				<button
					ref={actionButtonRef}
					type="button"
					onClick={() => setMenuOpen((open) => !open)}
					className="w-11 h-11 flex items-center justify-center text-muted-foreground/50 hover:text-foreground md:opacity-0 md:group-hover:opacity-100 md:focus:opacity-100 transition-all"
					aria-label="Session actions"
					aria-expanded={menuOpen}
				>
					<Ellipsis size={17} />
				</button>
				{menuOpen && typeof document !== "undefined"
					? createPortal(
							<>
								<button
									type="button"
									onClick={closeMenu}
									className={`fixed inset-0 z-[60] ${isDesktop ? "bg-transparent" : "bg-black/10"}`}
									aria-label="Dismiss session actions"
								/>
								{actionPosition && (
									<SessionActionPanel
										deleteConfirming={deleteConfirming}
										renaming={!isDesktop && mobileRenaming}
										renameValue={editValue}
										onRenameValueChange={setEditValue}
										onRename={() => {
											if (isDesktop) {
												closeMenu();
												startEdit();
											} else startMobileEdit();
										}}
										onCancelRename={closeMenu}
										onConfirmRename={commitMobileEdit}
										pinned={pinned}
										onTogglePin={() => {
											onPin(session.id, !pinned);
											closeMenu();
										}}
										onRequestDelete={() => setDeleteConfirming(true)}
										onCancelDelete={() => setDeleteConfirming(false)}
										onConfirmDelete={() => {
											onDelete(session.id);
											closeMenu();
										}}
										canFork={canFork}
										forkBlocked={forkBlocked}
										forking={isForking}
										onFork={() => onFork(session.id)}
										position={actionPosition}
										panelRef={actionPanelRef}
									/>
								)}
							</>,
							document.body,
						)
					: null}
			</div>
		</div>
	);
}

// ─── Header controls ──────────────────────────────────────────────────────────

function SessionSearchBox({
	search,
	onSearchChange,
}: {
	search: string;
	onSearchChange: (q: string) => void;
}) {
	const [text, setText] = useState(search);
	// Live search after a typing pause. The callback ref keeps live-stats
	// re-renders (frequent while a session streams) from resetting the timer,
	// which would otherwise delay the search indefinitely.
	const onSearchChangeRef = useRef(onSearchChange);
	onSearchChangeRef.current = onSearchChange;
	// Sync the box when the committed value changes elsewhere (e.g. the empty
	// state's "clear search") — but never while the user is mid-typing, which
	// is why plain `setText(search)` on every prop change won't do.
	const committedRef = useRef(search);
	useEffect(() => {
		if (search !== committedRef.current) {
			committedRef.current = search;
			setText(search);
		}
	}, [search]);
	useEffect(() => {
		const trimmed = text.trim();
		if (trimmed === committedRef.current) return;
		const timer = setTimeout(() => {
			committedRef.current = trimmed;
			onSearchChangeRef.current(trimmed);
		}, 300);
		return () => clearTimeout(timer);
	}, [text]);
	return (
		<div className="flex min-h-10 w-full min-w-0 items-center border border-border md:min-h-0 md:w-auto">
			<Search className="w-2.5 h-2.5 mx-1.5 text-muted-foreground/60" />
			<input
				type="text"
				value={text}
				onChange={(e) => setText(e.target.value)}
				onKeyDown={(e) => {
					// Live search commits after a pause; Enter forces it now.
					if (e.key === "Enter") {
						committedRef.current = text.trim();
						onSearchChange(text.trim());
					}
				}}
				placeholder="label…"
				title="Filters as you type"
				aria-label="Search sessions"
				className="min-w-0 flex-1 bg-transparent py-1 pr-1 text-[10px] focus:outline-none md:w-36 md:flex-none"
			/>
			{(text || search) && (
				<button
					type="button"
					onClick={() => {
						setText("");
						committedRef.current = "";
						onSearchChange("");
					}}
					aria-label="Clear session search"
					className="flex h-10 w-10 shrink-0 items-center justify-center text-muted-foreground/50 hover:text-foreground md:h-auto md:w-auto md:px-1"
				>
					<X className="w-2.5 h-2.5" />
				</button>
			)}
		</div>
	);
}

/**
 * Cleanup dropdown driven by the oldest session overall — not the rows on
 * the current page, which previously hid the control whenever the visible
 * page happened to contain only fresh sessions.
 */
function CleanupControl({
	oldestStartedAt,
	referenceTime,
	onCleanup,
}: {
	oldestStartedAt: number | null;
	referenceTime: number;
	onCleanup: (days: number) => void;
}) {
	const [pendingDays, setPendingDays] = useState<number | null>(null);
	const available = CLEANUP_DAY_OPTIONS.filter(
		(d) =>
			oldestStartedAt != null && referenceTime - oldestStartedAt > d * 86_400,
	);
	if (available.length === 0) return null;

	if (pendingDays != null) {
		return (
			<div
				aria-live="polite"
				className="flex items-center gap-2 text-[8px] tracking-widest uppercase"
			>
				<span className="text-muted-foreground/50">
					delete older than {pendingDays}d?
				</span>
				<button
					type="button"
					onClick={() => {
						onCleanup(pendingDays);
						setPendingDays(null);
					}}
					className="text-destructive/60 hover:text-destructive transition-colors"
				>
					confirm
				</button>
				<button
					type="button"
					onClick={() => setPendingDays(null)}
					className="text-muted-foreground/50 hover:text-muted-foreground/80 transition-colors"
				>
					cancel
				</button>
			</div>
		);
	}

	return (
		<select
			value=""
			onChange={(e) => {
				const days = Number(e.target.value);
				if (Number.isFinite(days) && days > 0) setPendingDays(days);
			}}
			aria-label="Clean up old sessions"
			className="bg-transparent border border-border text-[8px] tracking-widest uppercase text-muted-foreground/50 hover:text-muted-foreground/80 px-1.5 py-0.5 focus:outline-none focus:border-primary/50 transition-colors"
		>
			<option value="">clean up…</option>
			{available.map((d) => (
				<option key={d} value={d}>
					older than {d}d
				</option>
			))}
		</select>
	);
}

function MobileControlButton({
	icon: Icon,
	label,
	active,
	onClick,
}: {
	icon: ComponentType<{ className?: string }>;
	label: string;
	active: boolean;
	onClick: () => void;
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			aria-pressed={active}
			className={`flex min-h-10 flex-1 items-center justify-center gap-1.5 border px-2 text-[9px] tracking-widest uppercase transition-colors ${
				active
					? "border-primary/50 bg-primary/10 text-primary"
					: "border-border text-muted-foreground"
			}`}
		>
			<Icon className="h-3.5 w-3.5" />
			{label}
		</button>
	);
}

function SecondaryActionsMenu({
	open,
	onOpenChange,
	oldestStartedAt,
	cleanupReferenceTime,
	onCleanup,
	onExport,
	onImportClaude,
	claudeImportStatus,
	claudeImportBusy = false,
	compact = false,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	oldestStartedAt: number | null;
	cleanupReferenceTime: number;
	onCleanup: (days: number) => void;
	onExport?: (format: "csv" | "json") => void;
	onImportClaude?: () => void;
	claudeImportStatus?: string | null;
	claudeImportBusy?: boolean;
	compact?: boolean;
}) {
	const buttonRef = useRef<HTMLButtonElement>(null);
	const menuRef = useRef<HTMLDivElement>(null);
	const mobilePosition = useAnchoredPopover(
		open && compact,
		buttonRef,
		320,
		280,
		menuRef,
	);
	const menuContent = (
		<div
			ref={menuRef}
			className={
				compact
					? "fixed z-[70] space-y-3 overflow-y-auto border border-border bg-popover p-3 shadow-xl"
					: "absolute right-0 top-full z-40 mt-1 w-52 space-y-3 border border-border bg-popover p-3 shadow-lg"
			}
			style={
				compact && mobilePosition
					? {
							left: mobilePosition.left,
							top: mobilePosition.top,
							width: mobilePosition.width,
							maxHeight: mobilePosition.maxHeight,
						}
					: undefined
			}
			role="dialog"
			aria-label="Session list actions"
		>
			<div>
				<div className="mb-1.5 text-[8px] tracking-widest text-muted-foreground uppercase">
					Maintenance
				</div>
				<CleanupControl
					oldestStartedAt={oldestStartedAt}
					referenceTime={cleanupReferenceTime}
					onCleanup={onCleanup}
				/>
			</div>
			{onImportClaude && (
				<div>
					<div className="mb-1.5 text-[8px] tracking-widest text-muted-foreground uppercase">
						Provider history
					</div>
					<button
						type="button"
						onClick={onImportClaude}
						disabled={claudeImportBusy}
						className="min-h-9 w-full border border-border px-2 text-[9px] tracking-widest uppercase hover:text-foreground disabled:opacity-40"
					>
						{claudeImportBusy ? "Importing…" : "Import provider history"}
					</button>
					{claudeImportStatus && (
						<div className="mt-1.5 text-[9px] text-muted-foreground">
							{claudeImportStatus}
						</div>
					)}
				</div>
			)}
			{onExport && (
				<div>
					<div className="mb-1.5 text-[8px] tracking-widest text-muted-foreground uppercase">
						Export all sessions
					</div>
					<div className="grid grid-cols-2 gap-2">
						<button
							type="button"
							onClick={() => onExport("csv")}
							className="min-h-9 border border-border text-[9px] tracking-widest uppercase hover:text-foreground"
						>
							CSV
						</button>
						<button
							type="button"
							onClick={() => onExport("json")}
							className="min-h-9 border border-border text-[9px] tracking-widest uppercase hover:text-foreground"
						>
							JSON
						</button>
					</div>
				</div>
			)}
		</div>
	);
	return (
		<div className="relative">
			<button
				ref={buttonRef}
				type="button"
				onClick={() => onOpenChange(!open)}
				aria-label="More session list actions"
				aria-expanded={open}
				className={`${compact ? "h-10 w-10" : "h-7 w-7"} flex items-center justify-center border border-border text-muted-foreground hover:text-foreground`}
			>
				<Ellipsis className="h-4 w-4" />
			</button>
			{open &&
				(compact && typeof document !== "undefined"
					? createPortal(
							<>
								<button
									type="button"
									onClick={() => onOpenChange(false)}
									className="fixed inset-0 z-[60] bg-black/10 md:hidden"
									aria-label="Dismiss session list actions"
								/>
								{mobilePosition && menuContent}
							</>,
							document.body,
						)
					: menuContent)}
		</div>
	);
}

// ─── SessionsLedger ───────────────────────────────────────────────────────────

export function SessionsLedger({
	data,
	page,
	pageSize,
	pageSizeOptions,
	totalPages,
	loading,
	onPageChange,
	onPageSizeChange,
	onDelete,
	onRename,
	onPin,
	onFork,
	forkingIds,
	onNavigate,
	onCleanup,
	activeSessionId,
	activeSession,
	sessionsStatus,
	liveStats,
	search = "",
	onSearchChange,
	agentFilter = "",
	agentOptions = [],
	onAgentFilterChange,
	modelFilter = "",
	modelOptions = [],
	onModelFilterChange,
	onClearFilters,
	sort = "recent",
	onSortChange,
	oldestStartedAt = null,
	cleanupReferenceTime = 0,
	onExport,
	onImportClaude,
	claudeImportStatus,
	claudeImportBusy = false,
	forkProviderIds,
}: {
	data: { sessions: SessionRow[]; total: number };
	page: number;
	pageSize: number;
	pageSizeOptions: readonly number[];
	totalPages: number;
	loading: boolean;
	onPageChange: (p: number) => void;
	onPageSizeChange: (size: number) => void;
	onDelete: (id: string) => void;
	onRename: (id: string, label: string) => void;
	onPin: (id: string, pinned: boolean) => void;
	onFork: (id: string) => void;
	forkingIds?: Set<string>;
	onNavigate: (id: string) => void;
	onCleanup: (days: number) => void;
	activeSessionId?: string | null;
	activeSession?: SessionRow | null;
	sessionsStatus?: SessionStatusEntry[];
	liveStats?: LiveStats;
	search?: string;
	onSearchChange?: (q: string) => void;
	agentFilter?: string;
	agentOptions?: LedgerAgentOption[];
	onAgentFilterChange?: (agent: string) => void;
	modelFilter?: string;
	modelOptions?: string[];
	onModelFilterChange?: (model: string) => void;
	onClearFilters?: () => void;
	sort?: SessionSortKey;
	onSortChange?: (sort: SessionSortKey) => void;
	/** Unix seconds of the oldest session overall; drives cleanup options. */
	oldestStartedAt?: number | null;
	/** Serialized loader time keeps cleanup options identical during hydration. */
	cleanupReferenceTime?: number;
	onExport?: (format: "csv" | "json") => void;
	onImportClaude?: () => void;
	claudeImportStatus?: string | null;
	claudeImportBusy?: boolean;
	forkProviderIds?: ReadonlySet<string>;
}) {
	const isDesktop = useIsDesktop();
	const [mobilePanel, setMobilePanel] = useState<
		"search" | "filter" | "sort" | null
	>(null);
	const [desktopMoreOpen, setDesktopMoreOpen] = useState(false);
	const [mobileMoreOpen, setMobileMoreOpen] = useState(false);
	const hasFilters = Boolean(search || agentFilter || modelFilter);
	const pagination = {
		page,
		pageSize,
		pageSizeOptions,
		totalPages,
		onPageChange,
		onPageSizeChange,
	};
	const runningSessionIds = new Set(
		(sessionsStatus ?? []).flatMap((session) =>
			session.state === "running" && session.db_session_id
				? [session.db_session_id]
				: [],
		),
	);
	const displayedSessions = data.sessions
		.map((session, index) => ({ session, index }))
		.sort((a, b) => {
			const pinnedOrder =
				Number(b.session.pinned === 1) - Number(a.session.pinned === 1);
			const runningOrder =
				sort === "recent"
					? Number(runningSessionIds.has(b.session.id)) -
						Number(runningSessionIds.has(a.session.id))
					: 0;
			return pinnedOrder || runningOrder || a.index - b.index;
		})
		.map(({ session }) => session);

	return (
		<div className="border border-border bg-card">
			<div className="px-4 py-3 border-b border-border flex items-center justify-between gap-3 flex-wrap">
				<div className="flex items-center gap-3">
					<div className="text-[9px] tracking-widest text-muted-foreground uppercase">
						SESSIONS
					</div>
					<span className="text-[9px] tabular-nums text-muted-foreground/40">
						{data.total}
					</span>
				</div>
				<div className="hidden md:flex items-center gap-3 flex-wrap">
					{onAgentFilterChange && (
						<label className="flex items-center gap-1.5 text-[8px] tracking-widest text-muted-foreground/50 uppercase">
							<span>agent</span>
							<select
								value={agentFilter}
								onChange={(e) => onAgentFilterChange(e.target.value)}
								className="max-w-40 bg-transparent border border-border text-[9px] text-foreground/70 px-1.5 py-0.5 focus:outline-none focus:border-primary/50 transition-colors"
								aria-label="Filter sessions by agent"
							>
								<option value="">all</option>
								{agentOptions.map((option) => (
									<option key={option.value} value={option.value}>
										{option.label}
									</option>
								))}
							</select>
						</label>
					)}
					{onModelFilterChange && (
						<label className="flex items-center gap-1.5 text-[8px] tracking-widest text-muted-foreground/50 uppercase">
							<span>model</span>
							<select
								value={modelFilter}
								onChange={(e) => onModelFilterChange(e.target.value)}
								className="max-w-44 bg-transparent border border-border text-[9px] text-foreground/70 px-1.5 py-0.5 focus:outline-none focus:border-primary/50 transition-colors"
								aria-label="Filter sessions by model"
							>
								<option value="">all</option>
								{modelOptions.map((model) => (
									<option key={model} value={model}>
										{model}
									</option>
								))}
							</select>
						</label>
					)}
					{onSearchChange && (
						<SessionSearchBox search={search} onSearchChange={onSearchChange} />
					)}
					{onSortChange && (
						<label className="flex items-center gap-1.5 text-[8px] tracking-widest text-muted-foreground/50 uppercase">
							<span>sort</span>
							<select
								value={sort}
								onChange={(e) => onSortChange(e.target.value as SessionSortKey)}
								className="bg-transparent border border-border text-[9px] text-foreground/70 px-1.5 py-0.5 focus:outline-none focus:border-primary/50 transition-colors"
								aria-label="Sort sessions"
							>
								{(
									Object.entries(SORT_LABELS) as [SessionSortKey, string][]
								).map(([value, label]) => (
									<option key={value} value={value}>
										{label}
									</option>
								))}
							</select>
						</label>
					)}
					<label className="flex items-center gap-1.5 text-[8px] tracking-widest text-muted-foreground/50 uppercase">
						<span>per page</span>
						<select
							value={pageSize}
							onChange={(e) => onPageSizeChange(Number(e.target.value))}
							className="bg-transparent border border-border text-[9px] tabular-nums text-foreground/70 px-1.5 py-0.5 focus:outline-none focus:border-primary/50 transition-colors"
							aria-label="Sessions per page"
						>
							{pageSizeOptions.map((n) => (
								<option key={n} value={n}>
									{n}
								</option>
							))}
						</select>
					</label>
					<SecondaryActionsMenu
						open={desktopMoreOpen}
						onOpenChange={setDesktopMoreOpen}
						oldestStartedAt={oldestStartedAt}
						cleanupReferenceTime={cleanupReferenceTime}
						onCleanup={onCleanup}
						onExport={onExport}
						onImportClaude={onImportClaude}
						claudeImportStatus={claudeImportStatus}
						claudeImportBusy={claudeImportBusy}
					/>
				</div>
				<div className="flex w-full md:hidden items-center gap-1.5">
					<MobileControlButton
						icon={Search}
						label="Search"
						active={mobilePanel === "search"}
						onClick={() =>
							setMobilePanel((p) => (p === "search" ? null : "search"))
						}
					/>
					<MobileControlButton
						icon={SlidersHorizontal}
						label="Filter"
						active={
							mobilePanel === "filter" || Boolean(agentFilter || modelFilter)
						}
						onClick={() =>
							setMobilePanel((p) => (p === "filter" ? null : "filter"))
						}
					/>
					<MobileControlButton
						icon={ArrowUpDown}
						label="Sort"
						active={mobilePanel === "sort" || sort !== "recent"}
						onClick={() =>
							setMobilePanel((p) => (p === "sort" ? null : "sort"))
						}
					/>
				</div>
			</div>
			{mobilePanel && (
				<div className="md:hidden border-b border-border bg-muted/15 p-3">
					{mobilePanel === "search" && onSearchChange && (
						<SessionSearchBox search={search} onSearchChange={onSearchChange} />
					)}
					{mobilePanel === "filter" && (
						<div className="grid grid-cols-2 gap-2">
							<select
								value={agentFilter}
								onChange={(e) => onAgentFilterChange?.(e.target.value)}
								aria-label="Filter sessions by agent"
								className="min-h-10 bg-background border border-border px-2 text-xs"
							>
								<option value="">All agents</option>
								{agentOptions.map((o) => (
									<option key={o.value} value={o.value}>
										{o.label}
									</option>
								))}
							</select>
							<select
								value={modelFilter}
								onChange={(e) => onModelFilterChange?.(e.target.value)}
								aria-label="Filter sessions by model"
								className="min-h-10 bg-background border border-border px-2 text-xs"
							>
								<option value="">All models</option>
								{modelOptions.map((m) => (
									<option key={m} value={m}>
										{m}
									</option>
								))}
							</select>
							<label className="col-span-1">
								<span className="mb-1 block text-[8px] tracking-widest text-muted-foreground uppercase">
									Per page
								</span>
								<select
									value={pageSize}
									onChange={(e) => onPageSizeChange(Number(e.target.value))}
									className="min-h-10 w-full bg-background border border-border px-2 text-xs"
									aria-label="Sessions per page"
								>
									{pageSizeOptions.map((n) => (
										<option key={n} value={n}>
											{n}
										</option>
									))}
								</select>
							</label>
							<div className="col-span-1 flex items-end justify-end">
								<SecondaryActionsMenu
									open={mobileMoreOpen}
									onOpenChange={setMobileMoreOpen}
									oldestStartedAt={oldestStartedAt}
									cleanupReferenceTime={cleanupReferenceTime}
									onCleanup={onCleanup}
									onExport={onExport}
									onImportClaude={onImportClaude}
									claudeImportStatus={claudeImportStatus}
									claudeImportBusy={claudeImportBusy}
									compact
								/>
							</div>
						</div>
					)}
					{mobilePanel === "sort" && (
						<select
							value={sort}
							onChange={(e) => onSortChange?.(e.target.value as SessionSortKey)}
							aria-label="Sort sessions"
							className="min-h-10 w-full bg-background border border-border px-2 text-xs"
						>
							{(Object.entries(SORT_LABELS) as [SessionSortKey, string][]).map(
								([value, label]) => (
									<option key={value} value={value}>
										{label}
									</option>
								),
							)}
						</select>
					)}
				</div>
			)}

			{loading ? (
				<div className="px-4 py-6 text-center text-[9px] tracking-widest text-muted-foreground/50">
					loading…
				</div>
			) : data.sessions.length === 0 ? (
				<div className="px-4 py-6 text-center text-[9px] tracking-widest text-muted-foreground/50">
					{hasFilters ? (
						<>
							no sessions match the current filters ·{" "}
							<button
								type="button"
								onClick={() =>
									onClearFilters ? onClearFilters() : onSearchChange?.("")
								}
								className="text-primary hover:text-primary/80 underline underline-offset-2 normal-case tracking-normal"
							>
								clear filters
							</button>
						</>
					) : (
						"no sessions"
					)}
				</div>
			) : (
				displayedSessions.map((s) => (
					<SessionItem
						key={s.id}
						session={s}
						usageSession={
							activeSessionId === s.id
								? (activeSession ?? undefined)
								: undefined
						}
						onDelete={onDelete}
						onRename={onRename}
						onPin={onPin}
						onFork={onFork}
						isForking={forkingIds?.has(s.id) ?? false}
						onNavigate={onNavigate}
						isActive={activeSessionId != null && s.id === activeSessionId}
						poolSession={sessionsStatus?.find((p) => p.db_session_id === s.id)}
						liveStats={liveStats}
						isDesktop={isDesktop}
						forkProviderIds={forkProviderIds}
					/>
				))
			)}

			{totalPages > 1 && (
				<LedgerPaginationBar pagination={pagination} loading={loading} />
			)}
		</div>
	);
}
