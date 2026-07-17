import { Ellipsis } from "lucide-react";
import type { RefObject } from "react";
import { useRef, useState } from "react";
import { createPortal } from "react-dom";
import { PrivacyMask } from "#/components/PrivacyMask";
import {
	type AnchoredPopoverPosition,
	useAnchoredPopover,
} from "#/hooks/useAnchoredPopover";
import { useIsDesktop } from "#/hooks/useIsDesktop";
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

export function ActiveSessionsPanel({
	sessions,
	onStop,
	onClose,
	onNavigate,
}: ActiveSessionsPanelProps) {
	const isDesktop = useIsDesktop();
	// Only show sessions that have started a DB chat — filters out vault
	// placeholder and any freshly-created-but-never-used entries.
	const used = sessions
		.filter((s) => s.hasDbSession || s.state !== "idle")
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
	const canNavigate = Boolean(session.db_session_id && onNavigate);
	function dismissActions() {
		setMenuOpen(false);
	}
	const actionPanelProps = {
		agentName: session.agent_name,
		onClose: () => {
			onClose(session.session_id);
			dismissActions();
		},
	};
	return (
		<tr
			className={`border-b border-border/40 hover:bg-accent/30 transition-colors ${canNavigate ? "cursor-pointer" : ""}`}
			onClick={() => {
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
											{...actionPanelProps}
											position={actionPosition}
											panelRef={actionPanelRef}
										/>
									)}
								</>,
								document.body,
							)
						: null}
				</div>
			</td>
		</tr>
	);
}
