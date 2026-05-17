import type { SessionStatusEntry } from "../../server/protocol";

export type ActiveSessionsPanelProps = {
	sessions: SessionStatusEntry[];
	onStop: (sessionId: string) => void;
	onClose: (sessionId: string) => void;
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
}: ActiveSessionsPanelProps) {
	// Only show sessions that have started a DB chat — filters out vault
	// placeholder and any freshly-created-but-never-used entries.
	const used = sessions.filter((s) => s.hasDbSession || s.state !== "idle");

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
		<div className="overflow-auto">
			<table className="w-full text-[11px]">
				<thead>
					<tr className="border-b border-border text-left">
						<th className="px-4 py-2 text-[9px] tracking-widest text-muted-foreground/50 uppercase font-normal">
							Session / Agent
						</th>
						<th className="px-4 py-2 text-[9px] tracking-widest text-muted-foreground/50 uppercase font-normal hidden sm:table-cell">
							CWD
						</th>
						<th className="px-4 py-2 text-[9px] tracking-widest text-muted-foreground/50 uppercase font-normal">
							State
						</th>
						<th className="px-4 py-2 text-[9px] tracking-widest text-muted-foreground/50 uppercase font-normal">
							Stop
						</th>
						<th className="px-4 py-2 text-[9px] tracking-widest text-muted-foreground/50 uppercase font-normal">
							Close
						</th>
					</tr>
				</thead>
				<tbody>
					{used.map((session) => (
						<tr
							key={session.session_id}
							className="border-b border-border/40 hover:bg-accent/30 transition-colors"
						>
							<td className="px-4 py-2.5">
								<div className="font-medium text-foreground/90">
									{session.agent_name}
								</div>
								{session.lastLabel && (
									<div className="text-[9px] text-muted-foreground/50 uppercase tracking-widest mt-0.5">
										{session.lastLabel}
									</div>
								)}
								<div className="text-[9px] text-muted-foreground/30 font-mono mt-0.5">
									#{shortId(session.session_id)}
								</div>
								<div className="text-[9px] text-muted-foreground/40 font-mono sm:hidden">
									{session.agent_cwd}
								</div>
							</td>
							<td className="px-4 py-2.5 hidden sm:table-cell font-mono text-muted-foreground/60 text-[10px]">
								{session.agent_cwd}
							</td>
							<td
								className={`px-4 py-2.5 font-mono uppercase tracking-widest text-[9px] ${stateClass(
									session.state,
								)}`}
							>
								{stateLabel(session)}
							</td>
							<td className="px-4 py-2.5">
								<button
									type="button"
									onClick={() => onStop(session.session_id)}
									disabled={session.state !== "running"}
									aria-label={`stop ${session.agent_name}`}
									className="text-[9px] tracking-widest uppercase px-2 py-1 border border-border hover:border-destructive/50 hover:text-destructive text-muted-foreground/60 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
								>
									STOP
								</button>
							</td>
							<td className="px-4 py-2.5">
								<button
									type="button"
									onClick={() => onClose(session.session_id)}
									aria-label={`close ${session.agent_name}`}
									className="text-[9px] tracking-widest uppercase px-2 py-1 border border-border hover:border-destructive/50 hover:text-destructive text-muted-foreground/60 transition-colors"
								>
									CLOSE
								</button>
							</td>
						</tr>
					))}
				</tbody>
			</table>
		</div>
	);
}
