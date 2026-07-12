import { Pencil, X } from "lucide-react";
import { useRef, useState } from "react";
import { ConfirmAction } from "#/components/ConfirmAction";
import { LedgerPaginationBar } from "#/components/ledger/LedgerPagination";
import { sessionEntryDotClass } from "#/components/nav/SystemStatusDot";
import { PrivacyMask } from "#/components/PrivacyMask";
import type { SessionRow } from "#/db";
import type { LiveStats } from "#/hooks/wsStore";
import { formatDisplayCost } from "#/lib/costDisplay";
import { fmt, fmtDate } from "#/lib/formatters";
import type { SessionStatusEntry } from "#/server/protocol";

const THIRTY_DAYS_S = 30 * 86_400;

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
							{session.started_at != null ? fmtDate(session.started_at) : "—"} ·{" "}
							{session.query_count}q
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
			<div className="px-4 py-3 border-b border-border flex items-center justify-between">
				<div className="flex items-center gap-3">
					<div className="text-[9px] tracking-widest text-muted-foreground uppercase">
						SESSIONS
					</div>
					<span className="text-[9px] tabular-nums text-muted-foreground/40">
						{data.total}
					</span>
				</div>
				<div className="flex items-center gap-3">
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
					{data.sessions.some(
						(s) =>
							s.started_at != null &&
							Date.now() / 1000 - s.started_at > THIRTY_DAYS_S,
					) && (
						<ConfirmAction
							label="delete older than 30d?"
							onConfirm={() => onCleanup(30)}
							trigger={(open) => (
								<button
									type="button"
									onClick={open}
									className="text-[8px] tracking-widest text-muted-foreground/50 hover:text-muted-foreground/80 uppercase transition-colors"
								>
									clean up
								</button>
							)}
						/>
					)}
				</div>
			</div>

			{loading ? (
				<div className="px-4 py-6 text-center text-[9px] tracking-widest text-muted-foreground/50">
					loading…
				</div>
			) : data.sessions.length === 0 ? (
				<div className="px-4 py-6 text-center text-[9px] tracking-widest text-muted-foreground/50">
					no sessions
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
