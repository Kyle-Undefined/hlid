import { Pencil, Search, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { ConfirmAction } from "#/components/ConfirmAction";
import { HydrationSafeText } from "#/components/HydrationSafeText";
import { LedgerPaginationBar } from "#/components/ledger/LedgerPagination";
import { sessionEntryDotClass } from "#/components/nav/SystemStatusDot";
import { PrivacyMask } from "#/components/PrivacyMask";
import type { SessionRow } from "#/db";
import type { LiveStats } from "#/hooks/wsLiveStatsStore";
import { formatDisplayCost } from "#/lib/costDisplay";
import { fmt, fmtDate, fmtDateUtc } from "#/lib/formatters";
import type { SessionSortKey } from "#/lib/ledgerState";
import type { SessionStatusEntry } from "#/server/protocol";

const CLEANUP_DAY_OPTIONS = [7, 30, 90] as const;

const SORT_LABELS: Record<SessionSortKey, string> = {
	recent: "recent",
	cost: "cost",
	tokens: "tokens",
};

export function sessionDisplayUsage(
	session: SessionRow,
	isActive: boolean,
	liveStats?: LiveStats,
): { cost: number; tokens: number } {
	if (isActive && liveStats && liveStats.queries > 0) {
		return {
			cost: liveStats.cost + (liveStats.estimated_cost ?? 0),
			tokens:
				liveStats.input_tokens +
				liveStats.output_tokens +
				liveStats.cache_read_tokens +
				liveStats.cache_creation_tokens,
		};
	}
	return {
		cost: (session.total_cost ?? 0) + (session.total_estimated_cost ?? 0),
		tokens:
			(session.total_input_tokens ?? 0) +
			(session.total_output_tokens ?? 0) +
			(session.total_cache_read_tokens ?? 0) +
			(session.total_cache_creation_tokens ?? 0),
	};
}

function SessionItem({
	session,
	onDelete,
	onNavigate,
	onRename,
	isActive,
	poolSession,
	liveStats,
}: {
	session: SessionRow;
	onDelete: (id: string) => void;
	onNavigate: (id: string) => void;
	onRename: (id: string, label: string) => void;
	isActive?: boolean;
	poolSession?: SessionStatusEntry;
	liveStats?: LiveStats;
}) {
	const [editing, setEditing] = useState(false);
	const [editValue, setEditValue] = useState("");
	const inputRef = useRef<HTMLInputElement>(null);
	const usage = sessionDisplayUsage(session, Boolean(isActive), liveStats);
	const costSummary =
		isActive && liveStats && liveStats.queries > 0
			? liveStats
			: {
					cost: session.total_cost ?? 0,
					estimated_cost: session.total_estimated_cost ?? 0,
					unpriced_queries: session.unpriced_query_count ?? 0,
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

	return (
		<div className="flex items-center gap-2 border-b border-border last:border-0 group hover:bg-accent/20 transition-colors">
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
				<button
					type="button"
					onClick={() => onNavigate(session.id)}
					className="flex items-center gap-3 flex-1 min-w-0 px-4 py-2.5 text-left"
				>
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
				</button>
			)}
			<ConfirmAction
				confirmText="delete"
				onConfirm={() => onDelete(session.id)}
				className="pr-2 shrink-0"
				trigger={(open) => (
					<div className="flex items-center shrink-0">
						<button
							type="button"
							onClick={startEdit}
							className="w-9 h-9 flex items-center justify-center text-muted-foreground/20 hover:text-primary/60 md:opacity-0 md:group-hover:opacity-100 transition-all"
							title="Rename session"
							aria-label="Rename session"
						>
							<Pencil size={11} />
						</button>
						<button
							type="button"
							onClick={open}
							className="w-9 h-9 flex items-center justify-center text-muted-foreground/20 hover:text-destructive/60 md:opacity-0 md:group-hover:opacity-100 transition-all pr-1"
							title="Delete session"
							aria-label="Delete session"
						>
							<X size={11} />
						</button>
					</div>
				)}
			/>
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
		<div className="flex items-center border border-border">
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
				className="bg-transparent text-[10px] py-1 pr-1 w-24 md:w-36 focus:outline-none"
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
					className="px-1 text-muted-foreground/50 hover:text-foreground"
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
	onNavigate,
	onCleanup,
	activeSessionId,
	sessionsStatus,
	liveStats,
	search = "",
	onSearchChange,
	sort = "recent",
	onSortChange,
	oldestStartedAt = null,
	cleanupReferenceTime = 0,
	onExport,
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
	onNavigate: (id: string) => void;
	onCleanup: (days: number) => void;
	activeSessionId?: string | null;
	sessionsStatus?: SessionStatusEntry[];
	liveStats?: LiveStats;
	search?: string;
	onSearchChange?: (q: string) => void;
	sort?: SessionSortKey;
	onSortChange?: (sort: SessionSortKey) => void;
	/** Unix seconds of the oldest session overall; drives cleanup options. */
	oldestStartedAt?: number | null;
	/** Serialized loader time keeps cleanup options identical during hydration. */
	cleanupReferenceTime?: number;
	onExport?: (format: "csv" | "json") => void;
}) {
	const pagination = {
		page,
		pageSize,
		pageSizeOptions,
		totalPages,
		onPageChange,
		onPageSizeChange,
	};

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
				<div className="flex items-center gap-3 flex-wrap">
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
					<CleanupControl
						oldestStartedAt={oldestStartedAt}
						referenceTime={cleanupReferenceTime}
						onCleanup={onCleanup}
					/>
					{onExport && (
						<div className="flex items-center gap-1.5 text-[8px] tracking-widest uppercase text-muted-foreground/50">
							<span>export</span>
							<button
								type="button"
								onClick={() => onExport("csv")}
								className="border border-border px-1.5 py-0.5 hover:text-foreground transition-colors"
							>
								csv
							</button>
							<button
								type="button"
								onClick={() => onExport("json")}
								className="border border-border px-1.5 py-0.5 hover:text-foreground transition-colors"
							>
								json
							</button>
						</div>
					)}
				</div>
			</div>

			{loading ? (
				<div className="px-4 py-6 text-center text-[9px] tracking-widest text-muted-foreground/50">
					loading…
				</div>
			) : data.sessions.length === 0 ? (
				<div className="px-4 py-6 text-center text-[9px] tracking-widest text-muted-foreground/50">
					{search ? (
						<>
							no sessions match “{search}” ·{" "}
							<button
								type="button"
								onClick={() => onSearchChange?.("")}
								className="text-primary hover:text-primary/80 underline underline-offset-2 normal-case tracking-normal"
							>
								clear search
							</button>
						</>
					) : (
						"no sessions"
					)}
				</div>
			) : (
				data.sessions.map((s) => (
					<SessionItem
						key={s.id}
						session={s}
						onDelete={onDelete}
						onRename={onRename}
						onNavigate={onNavigate}
						isActive={activeSessionId != null && s.id === activeSessionId}
						poolSession={sessionsStatus?.find((p) => p.db_session_id === s.id)}
						liveStats={liveStats}
					/>
				))
			)}

			{totalPages > 1 && (
				<LedgerPaginationBar pagination={pagination} loading={loading} />
			)}
		</div>
	);
}
