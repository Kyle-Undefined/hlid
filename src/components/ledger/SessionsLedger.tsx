import { ChevronLeft, ChevronRight, Pencil, X } from "lucide-react";
import { type KeyboardEvent, useRef, useState } from "react";
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
	onRename,
}: {
	session: SessionRow;
	onDelete: (id: string) => void;
	onNavigate: (id: string) => void;
	onRename: (id: string, label: string) => void;
}) {
	const [editing, setEditing] = useState(false);
	const [editValue, setEditValue] = useState("");
	const inputRef = useRef<HTMLInputElement>(null);

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
}) {
	const [jumpInput, setJumpInput] = useState("");

	function commitJump() {
		const parsed = parseInt(jumpInput, 10);
		if (Number.isFinite(parsed) && parsed >= 1 && parsed <= totalPages) {
			onPageChange(parsed);
		}
		setJumpInput("");
	}

	function handleJumpKey(e: KeyboardEvent<HTMLInputElement>) {
		if (e.key === "Enter") {
			e.preventDefault();
			commitJump();
		} else if (e.key === "Escape") {
			setJumpInput("");
		}
	}

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
					/>
				))
			)}

			{totalPages > 1 && (
				<div className="px-4 py-2.5 border-t border-border flex items-center justify-between gap-3">
					<button
						type="button"
						disabled={page <= 1 || loading}
						onClick={() => onPageChange(1)}
						className="text-[9px] tracking-widest text-muted-foreground/40 hover:text-foreground disabled:opacity-20 uppercase transition-colors"
						aria-label="First page"
					>
						« first
					</button>
					<button
						type="button"
						disabled={page <= 1 || loading}
						onClick={() => onPageChange(page - 1)}
						className="flex items-center gap-0.5 text-[9px] tracking-widest text-muted-foreground/40 hover:text-foreground disabled:opacity-20 uppercase transition-colors"
					>
						<ChevronLeft size={10} /> prev
					</button>
					<div className="flex items-center gap-2">
						<span className="text-[9px] tabular-nums text-muted-foreground/30">
							{page} / {totalPages}
						</span>
						<label className="flex items-center gap-1 text-[8px] tracking-widest text-muted-foreground/50 uppercase">
							<span className="sr-only">go to page</span>
							<span aria-hidden="true">go</span>
							<input
								type="number"
								min={1}
								max={totalPages}
								value={jumpInput}
								onChange={(e) => setJumpInput(e.target.value)}
								onKeyDown={handleJumpKey}
								onBlur={() => {
									if (jumpInput) commitJump();
								}}
								placeholder="#"
								className="bg-transparent border border-border w-12 px-1.5 py-0.5 text-[9px] tabular-nums text-foreground/70 focus:outline-none focus:border-primary/50 transition-colors placeholder:text-muted-foreground/30 [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
								aria-label={`Jump to page (1 to ${totalPages})`}
							/>
						</label>
					</div>
					<button
						type="button"
						disabled={page >= totalPages || loading}
						onClick={() => onPageChange(page + 1)}
						className="flex items-center gap-0.5 text-[9px] tracking-widest text-muted-foreground/40 hover:text-foreground disabled:opacity-20 uppercase transition-colors"
					>
						next <ChevronRight size={10} />
					</button>
					<button
						type="button"
						disabled={page >= totalPages || loading}
						onClick={() => onPageChange(totalPages)}
						className="text-[9px] tracking-widest text-muted-foreground/40 hover:text-foreground disabled:opacity-20 uppercase transition-colors"
						aria-label="Last page"
					>
						last »
					</button>
				</div>
			)}
		</div>
	);
}
