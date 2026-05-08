import { ChevronLeft, ChevronRight, ExternalLink, X } from "lucide-react";
import { ConfirmAction } from "#/components/ConfirmAction";
import { PrivacyMask } from "#/components/PrivacyMask";
import type { SessionRow } from "#/db";
import { fmt, fmtDate } from "#/lib/formatters";

const THIRTY_DAYS_S = 30 * 86_400;

// ─── SessionItem ──────────────────────────────────────────────────────────────

function SessionItem({
	session,
	onDelete,
	onNavigate,
}: {
	session: SessionRow;
	onDelete: (id: string) => void;
	onNavigate: (id: string) => void;
}) {
	return (
		<div className="flex items-center gap-2 border-b border-border last:border-0 group hover:bg-accent/20 transition-colors">
			<button
				type="button"
				onClick={() => onNavigate(session.id)}
				className="flex items-center gap-3 flex-1 min-w-0 px-4 py-2.5 text-left"
			>
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
						${(session.total_cost ?? 0).toFixed(4)}
					</PrivacyMask>
					<PrivacyMask className="text-[9px] tabular-nums text-muted-foreground/40 mt-0.5">
						{fmt(
							(session.total_input_tokens ?? 0) +
								(session.total_output_tokens ?? 0),
						)}{" "}
						tok
					</PrivacyMask>
				</div>
			</button>
			<ConfirmAction
				confirmText="delete"
				onConfirm={() => onDelete(session.id)}
				className="pr-2 shrink-0"
				trigger={(open) => (
					<div className="flex items-center shrink-0">
						<a
							href={`/raven?session=${encodeURIComponent(session.id)}`}
							target="_blank"
							rel="noreferrer"
							className="w-7 h-full flex items-center justify-center text-muted-foreground/25 hover:text-primary/60 md:opacity-0 md:group-hover:opacity-100 transition-all"
							title="Open in new tab"
							aria-label="Open session in new tab"
						>
							<ExternalLink size={11} />
						</a>
						<button
							type="button"
							onClick={open}
							className="w-7 h-full flex items-center justify-center text-muted-foreground/20 hover:text-destructive/60 md:opacity-0 md:group-hover:opacity-100 transition-all pr-2"
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
	totalPages,
	loading,
	onPageChange,
	onDelete,
	onNavigate,
	onCleanup,
	onBuildSkill,
	connected,
}: {
	data: { sessions: SessionRow[]; total: number };
	page: number;
	totalPages: number;
	loading: boolean;
	onPageChange: (p: number) => void;
	onDelete: (id: string) => void;
	onNavigate: (id: string) => void;
	onCleanup: (days: number) => void;
	onBuildSkill: () => void;
	connected: boolean;
}) {
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
					{connected && (
						<ConfirmAction
							label="send to Claude?"
							variant="primary"
							onConfirm={onBuildSkill}
							trigger={(open) => (
								<button
									type="button"
									onClick={open}
									className="text-[8px] tracking-widest text-muted-foreground/50 hover:text-muted-foreground/80 uppercase transition-colors"
								>
									build skill
								</button>
							)}
						/>
					)}
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
						onNavigate={onNavigate}
					/>
				))
			)}

			{totalPages > 1 && (
				<div className="px-4 py-2.5 border-t border-border flex items-center justify-between">
					<button
						type="button"
						disabled={page <= 1 || loading}
						onClick={() => onPageChange(page - 1)}
						className="flex items-center gap-0.5 text-[9px] tracking-widest text-muted-foreground/40 hover:text-foreground disabled:opacity-20 uppercase transition-colors"
					>
						<ChevronLeft size={10} /> prev
					</button>
					<span className="text-[9px] tabular-nums text-muted-foreground/30">
						{page} / {totalPages}
					</span>
					<button
						type="button"
						disabled={page >= totalPages || loading}
						onClick={() => onPageChange(page + 1)}
						className="flex items-center gap-0.5 text-[9px] tracking-widest text-muted-foreground/40 hover:text-foreground disabled:opacity-20 uppercase transition-colors"
					>
						next <ChevronRight size={10} />
					</button>
				</div>
			)}
		</div>
	);
}
