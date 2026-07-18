import { ChevronDown, ChevronUp, Ellipsis } from "lucide-react";
import type { RefObject } from "react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { PrivacyMask } from "#/components/PrivacyMask";
import {
	type AnchoredPopoverPosition,
	useAnchoredPopover,
} from "#/hooks/useAnchoredPopover";
import { useIsDesktop } from "#/hooks/useIsDesktop";
import { isLedgerOpenSession } from "#/lib/ledgerSessions";
import type { SessionStatusEntry } from "../../server/protocol";

export type ActiveSessionsPanelProps = {
	sessions: SessionStatusEntry[];
	onStop: (sessionId: string) => void;
	onClose: (sessionId: string) => void;
	onNavigate?: (sessionId: string) => void;
};

function stateLabel(session: SessionStatusEntry): string {
	if (session.hasPendingPermissions) return "WAITING";
	return session.state.toUpperCase();
}

function stateClass(state: SessionStatusEntry["state"]): string {
	if (state === "running") return "text-primary";
	if (state === "error") return "text-destructive";
	return "text-muted-foreground/50";
}

/** Short 8-char hex suffix of the pool UUID for quick visual identification. */
function shortId(sessionId: string): string {
	return sessionId.replace(/-/g, "").slice(-8);
}

function permissionLabel(mode: string): string {
	if (mode === "acceptEdits") return "accept edits";
	if (mode === "bypassPermissions") return "bypass approvals";
	if (mode === "plan") return "plan mode";
	return mode === "default" ? "default approvals" : mode;
}

function sessionConfigLabel(session: SessionStatusEntry): string {
	return [
		session.provider_id,
		session.model,
		session.effort ? `${session.effort} effort` : undefined,
		session.permission_mode
			? permissionLabel(session.permission_mode)
			: undefined,
		session.mode === "terminal" ? "terminal" : undefined,
	]
		.filter((part): part is string => Boolean(part))
		.join(" · ");
}

export function ActiveSessionsPanel({
	sessions,
	onStop,
	onClose,
	onNavigate,
}: ActiveSessionsPanelProps) {
	const isDesktop = useIsDesktop();
	const [mobileOpen, setMobileOpen] = useState(false);
	// Only show sessions that have started a DB chat — filters out vault
	// placeholder and any freshly-created-but-never-used entries.
	const used = sessions
		.filter(isLedgerOpenSession)
		.sort(
			(a, b) => Number(b.state === "running") - Number(a.state === "running"),
		);

	if (used.length === 0) {
		return (
			<div className="flex flex-col items-center justify-center py-16 gap-2">
				<p className="text-[10px] tracking-widest text-muted-foreground/40 uppercase">
					No active sessions — all quiet.
				</p>
			</div>
		);
	}
	if (!isDesktop) {
		return (
			<MobileActiveSessionsPanel
				sessions={used}
				onStop={onStop}
				onClose={onClose}
				onNavigate={onNavigate}
				open={mobileOpen}
				onOpenChange={setMobileOpen}
			/>
		);
	}

	return (
		<div className="overflow-hidden bg-background/95">
			<table className="w-full table-fixed text-[11px] md:table-auto">
				<thead>
					<tr className="border-b border-border text-left">
						<th className="px-3 py-2 text-[9px] tracking-widest text-muted-foreground/50 uppercase font-normal md:px-4">
							Session / Agent
						</th>
						<th className="px-4 py-2 text-[9px] tracking-widest text-muted-foreground/50 uppercase font-normal hidden md:table-cell">
							CWD
						</th>
						<th className="w-16 px-2 py-2 text-[9px] tracking-widest text-muted-foreground/50 uppercase font-normal md:w-auto md:px-4">
							State
						</th>
						<th className="w-24 px-2 py-2 text-[9px] tracking-widest text-muted-foreground/50 uppercase font-normal md:w-auto md:px-4">
							Actions
						</th>
					</tr>
				</thead>
				<tbody>
					{used.map((session) => (
						<ActiveSessionRow
							key={session.session_id}
							session={session}
							onStop={onStop}
							onClose={onClose}
							onNavigate={onNavigate}
							isDesktop={isDesktop}
						/>
					))}
				</tbody>
			</table>
		</div>
	);
}

function mobileSessionPriority(session: SessionStatusEntry): number {
	if (session.hasPendingPermissions) return 0;
	if (session.state === "error") return 1;
	if (session.state === "running") return 2;
	return 3;
}

function mobileSessionSummary(sessions: SessionStatusEntry[]): string {
	const waiting = sessions.filter(
		(session) => session.hasPendingPermissions,
	).length;
	const running = sessions.filter(
		(session) => session.state === "running" && !session.hasPendingPermissions,
	).length;
	const errors = sessions.filter((session) => session.state === "error").length;
	const idle = sessions.filter((session) => session.state === "idle").length;
	return [
		waiting > 0 ? `${waiting} waiting` : undefined,
		running > 0 ? `${running} running` : undefined,
		errors > 0 ? `${errors} error${errors === 1 ? "" : "s"}` : undefined,
		idle > 0 ? `${idle} idle` : undefined,
	]
		.filter((part): part is string => Boolean(part))
		.join(" · ");
}

function MobileActiveSessionsPanel({
	sessions,
	onStop,
	onClose,
	onNavigate,
	open,
	onOpenChange,
}: ActiveSessionsPanelProps & {
	open: boolean;
	onOpenChange: (open: boolean) => void;
}) {
	const toggleRef = useRef<HTMLButtonElement>(null);
	const sheetRef = useRef<HTMLDivElement>(null);
	const position = useAnchoredPopover(
		open,
		toggleRef,
		Number.MAX_SAFE_INTEGER,
		480,
		sheetRef,
	);
	const ordered = [...sessions].sort(
		(a, b) => mobileSessionPriority(a) - mobileSessionPriority(b),
	);
	const sessionWord = sessions.length === 1 ? "session" : "sessions";
	const summary = mobileSessionSummary(sessions);

	useEffect(() => {
		if (!open) return;
		function onKeyDown(event: KeyboardEvent) {
			if (event.key === "Escape") onOpenChange(false);
		}
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, [onOpenChange, open]);

	return (
		<div className="bg-background/95">
			<button
				ref={toggleRef}
				type="button"
				onClick={() => onOpenChange(!open)}
				aria-expanded={open}
				aria-controls="mobile-active-sessions-sheet"
				aria-haspopup="dialog"
				aria-label={`${open ? "Hide" : "Show"} ${sessions.length} live ${sessionWord}`}
				className="flex min-h-12 w-full items-center gap-3 px-3 text-left"
			>
				<span className="shrink-0 text-[9px] tracking-widest text-foreground/80 uppercase">
					Live sessions
				</span>
				<span className="h-1.5 w-1.5 shrink-0 rounded-full bg-primary" />
				<span className="min-w-0 flex-1 truncate font-mono text-[9px] text-muted-foreground/70">
					{summary}
				</span>
				{open ? (
					<ChevronUp className="h-4 w-4 shrink-0 text-muted-foreground" />
				) : (
					<ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
				)}
			</button>
			{open && typeof document !== "undefined"
				? createPortal(
						<>
							<button
								type="button"
								onClick={() => onOpenChange(false)}
								className="fixed inset-0 z-40 bg-black/15"
								aria-label="Dismiss live sessions"
							/>
							{position && (
								<div
									ref={sheetRef}
									id="mobile-active-sessions-sheet"
									className="fixed z-50 flex flex-col overflow-hidden border border-border bg-popover shadow-xl"
									style={{
										left: position.left,
										top: position.top,
										width: position.width,
										maxHeight: Math.max(96, position.maxHeight - 64),
									}}
									role="dialog"
									aria-modal="true"
									aria-label="Live sessions"
								>
									<div className="flex min-h-11 shrink-0 items-center justify-between border-b border-border px-3">
										<div>
											<div className="text-[9px] tracking-widest text-foreground/80 uppercase">
												Live sessions
											</div>
											<div className="font-mono text-[8px] text-muted-foreground/60">
												{summary}
											</div>
										</div>
										<button
											type="button"
											onClick={() => onOpenChange(false)}
											aria-label="Collapse live sessions"
											className="flex h-10 w-10 items-center justify-center text-muted-foreground hover:text-foreground"
										>
											<ChevronUp className="h-4 w-4" />
										</button>
									</div>
									<div className="min-h-0 overflow-y-auto overscroll-contain">
										{ordered.map((session) => (
											<MobileActiveSessionRow
												key={session.session_id}
												session={session}
												onStop={onStop}
												onClose={onClose}
												onNavigate={
													onNavigate
														? (id) => {
																onOpenChange(false);
																onNavigate(id);
															}
														: undefined
												}
											/>
										))}
									</div>
								</div>
							)}
						</>,
						document.body,
					)
				: null}
		</div>
	);
}

function ActiveSessionActionPanel({
	agentName,
	onClose,
	position,
	panelRef,
}: {
	agentName: string;
	onClose: () => void;
	position: AnchoredPopoverPosition;
	panelRef: RefObject<HTMLDivElement | null>;
}) {
	return (
		<div
			ref={panelRef}
			className="fixed z-[70] overflow-y-auto border border-border bg-popover p-3 shadow-xl"
			style={{
				left: position.left,
				top: position.top,
				width: position.width,
				maxHeight: position.maxHeight,
			}}
			role="dialog"
			aria-label="Active session actions"
		>
			<button
				type="button"
				onClick={onClose}
				aria-label={`close ${agentName}`}
				className="min-h-11 w-full px-2 text-left text-[9px] tracking-widest uppercase text-destructive/80 hover:bg-accent/40"
			>
				Close session
			</button>
		</div>
	);
}

function ActiveSessionControls({
	session,
	onStop,
	onClose,
	isDesktop,
}: {
	session: SessionStatusEntry;
	onStop: (sessionId: string) => void;
	onClose: (sessionId: string) => void;
	isDesktop: boolean;
}) {
	const [menuOpen, setMenuOpen] = useState(false);
	const actionButtonRef = useRef<HTMLButtonElement>(null);
	const actionPanelRef = useRef<HTMLDivElement>(null);
	const actionPosition = useAnchoredPopover(
		menuOpen,
		actionButtonRef,
		isDesktop ? 176 : 208,
		112,
		actionPanelRef,
	);
	function dismissActions() {
		setMenuOpen(false);
	}

	return (
		<div
			className={`relative flex min-w-0 shrink-0 items-center justify-end gap-1 ${menuOpen ? "z-[70]" : "z-20"}`}
		>
			<button
				type="button"
				onClick={() => onStop(session.session_id)}
				disabled={session.state !== "running"}
				aria-label={`stop ${session.agent_name}`}
				className="min-h-10 px-2 text-[9px] tracking-widest uppercase border border-border hover:border-destructive/50 hover:text-destructive text-muted-foreground/60 disabled:opacity-30 disabled:cursor-not-allowed transition-colors md:px-3"
			>
				STOP
			</button>
			<button
				ref={actionButtonRef}
				type="button"
				onClick={() => setMenuOpen((open) => !open)}
				aria-label={`more actions for ${session.agent_name}`}
				aria-expanded={menuOpen}
				className="flex h-10 w-10 items-center justify-center border border-border text-muted-foreground hover:text-foreground"
			>
				<Ellipsis className="h-4 w-4" />
			</button>
			{menuOpen && typeof document !== "undefined"
				? createPortal(
						<>
							<button
								type="button"
								onClick={dismissActions}
								className={`fixed inset-0 z-[60] ${isDesktop ? "bg-transparent" : "bg-black/10"}`}
								aria-label="Dismiss active session actions"
							/>
							{actionPosition && (
								<ActiveSessionActionPanel
									agentName={session.agent_name}
									onClose={() => {
										onClose(session.session_id);
										dismissActions();
									}}
									position={actionPosition}
									panelRef={actionPanelRef}
								/>
							)}
						</>,
						document.body,
					)
				: null}
		</div>
	);
}

function MobileActiveSessionRow({
	session,
	onStop,
	onClose,
	onNavigate,
}: {
	session: SessionStatusEntry;
	onStop: (sessionId: string) => void;
	onClose: (sessionId: string) => void;
	onNavigate?: (sessionId: string) => void;
}) {
	const canNavigate = Boolean(session.db_session_id && onNavigate);
	const configLabel = sessionConfigLabel(session);
	const primaryLabel = session.lastLabel || session.agent_name;

	return (
		<div className="flex min-h-16 items-center gap-2 border-b border-border/50 px-3 py-2 last:border-b-0">
			<button
				type="button"
				disabled={!canNavigate}
				onClick={() => {
					if (session.db_session_id) onNavigate?.(session.db_session_id);
				}}
				aria-label={
					canNavigate ? `Open ${session.agent_name} session` : undefined
				}
				className="min-w-0 flex-1 text-left disabled:cursor-default"
			>
				<PrivacyMask className="block truncate text-[10px] font-medium text-foreground/90 uppercase tracking-wider">
					{primaryLabel}
				</PrivacyMask>
				<div className="mt-1 flex min-w-0 items-center gap-2">
					{session.lastLabel && (
						<PrivacyMask className="shrink-0 text-[9px] text-muted-foreground/60">
							{session.agent_name}
						</PrivacyMask>
					)}
					{configLabel && (
						<span className="min-w-0 truncate font-mono text-[8px] text-muted-foreground/50">
							{configLabel}
						</span>
					)}
				</div>
			</button>
			<span
				className={`w-14 shrink-0 text-center font-mono text-[8px] tracking-widest uppercase ${stateClass(session.state)}`}
			>
				{stateLabel(session)}
			</span>
			<ActiveSessionControls
				session={session}
				onStop={onStop}
				onClose={onClose}
				isDesktop={false}
			/>
		</div>
	);
}

function ActiveSessionRow({
	session,
	onStop,
	onClose,
	onNavigate,
	isDesktop,
}: {
	session: SessionStatusEntry;
	onStop: (sessionId: string) => void;
	onClose: (sessionId: string) => void;
	onNavigate?: (sessionId: string) => void;
	isDesktop: boolean;
}) {
	const canNavigate = Boolean(session.db_session_id && onNavigate);
	const configLabel = sessionConfigLabel(session);
	return (
		<tr
			className={`border-b border-border/40 hover:bg-accent/30 transition-colors ${canNavigate ? "cursor-pointer" : ""}`}
			onClick={() => {
				if (window.getSelection()?.toString()) return;
				if (session.db_session_id) onNavigate?.(session.db_session_id);
			}}
			onKeyDown={(event) => {
				if (canNavigate && (event.key === "Enter" || event.key === " ")) {
					event.preventDefault();
					onNavigate?.(session.db_session_id as string);
				}
			}}
			tabIndex={canNavigate ? 0 : undefined}
			aria-label={
				canNavigate ? `Open ${session.agent_name} session` : undefined
			}
		>
			<td className="w-full min-w-0 max-w-0 px-3 py-2.5 md:px-4">
				<PrivacyMask className="font-medium text-foreground/90">
					{session.agent_name}
				</PrivacyMask>
				{session.lastLabel && (
					<div className="text-[9px] text-muted-foreground/50 uppercase tracking-widest mt-0.5">
						{session.lastLabel}
					</div>
				)}
				{configLabel && (
					<div
						className="mt-0.5 max-w-full truncate font-mono text-[9px] text-muted-foreground/60"
						title={configLabel}
					>
						{configLabel}
					</div>
				)}
				<div className="text-[9px] text-muted-foreground/30 font-mono mt-0.5">
					#{shortId(session.session_id)}
				</div>
				<span title={session.agent_cwd}>
					<PrivacyMask className="block max-w-full truncate text-[9px] text-muted-foreground/40 font-mono md:hidden">
						{session.agent_cwd}
					</PrivacyMask>
				</span>
			</td>
			<td className="max-w-[18rem] px-4 py-2.5 hidden md:table-cell font-mono text-muted-foreground/60 text-[10px]">
				<span title={session.agent_cwd}>
					<PrivacyMask className="block truncate">
						{session.agent_cwd}
					</PrivacyMask>
				</span>
			</td>
			<td
				className={`px-2 py-2.5 text-center font-mono uppercase tracking-widest text-[9px] md:px-4 md:text-left ${stateClass(
					session.state,
				)}`}
			>
				{stateLabel(session)}
			</td>
			<td
				className="px-2 md:px-4 py-2.5"
				onClick={(e) => e.stopPropagation()}
				onKeyDown={(e) => e.stopPropagation()}
			>
				<ActiveSessionControls
					session={session}
					onStop={onStop}
					onClose={onClose}
					isDesktop={isDesktop}
				/>
			</td>
		</tr>
	);
}
