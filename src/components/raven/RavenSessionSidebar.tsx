import type { SessionStatusEntry } from "../../server/protocol";

export type RavenSessionSidebarProps = {
	sessions: SessionStatusEntry[];
	subscribedSessionId: string;
	onSubscribe: (sessionId: string) => void;
	onStop: (sessionId: string) => void;
	onClose: (sessionId: string) => void;
	onNewSession: (agentCwd?: string) => void;
	isCollapsed: boolean;
	onToggle: () => void;
};

function StatusDot({ entry }: { entry: SessionStatusEntry }) {
	if (entry.hasPendingPermissions) {
		return (
			<span
				role="img"
				className="w-1.5 h-1.5 rounded-full bg-orange-500 animate-pulse shrink-0"
				aria-label="permission pending"
			/>
		);
	}
	if (entry.state === "running") {
		return (
			<span
				role="img"
				className="w-1.5 h-1.5 rounded-full bg-primary animate-pulse shrink-0"
				aria-label="running"
			/>
		);
	}
	if (entry.state === "error") {
		return (
			<span
				role="img"
				className="w-1.5 h-1.5 rounded-full bg-destructive shrink-0"
				aria-label="error"
			/>
		);
	}
	return (
		<span
			role="img"
			className="w-1.5 h-1.5 rounded-full bg-muted-foreground/30 shrink-0"
			aria-label="idle"
		/>
	);
}

export function RavenSessionSidebar({
	sessions,
	subscribedSessionId,
	onSubscribe,
	onStop,
	onClose,
	onNewSession,
	isCollapsed,
	onToggle,
}: RavenSessionSidebarProps) {
	if (isCollapsed) {
		return (
			<div className="flex flex-col items-center py-2 w-8 shrink-0 border-r border-border">
				<button
					type="button"
					className="p-1 text-muted-foreground hover:text-foreground transition-colors"
					onClick={onToggle}
					aria-label="expand sidebar"
				>
					<svg
						className="w-3 h-3"
						fill="none"
						stroke="currentColor"
						viewBox="0 0 24 24"
						aria-hidden="true"
					>
						<path
							strokeLinecap="round"
							strokeLinejoin="round"
							strokeWidth={2}
							d="M9 5l7 7-7 7"
						/>
					</svg>
				</button>
			</div>
		);
	}

	return (
		<div className="flex flex-col w-52 shrink-0 border-r border-border bg-sidebar overflow-y-auto">
			{/* Header row */}
			<div className="flex items-center justify-between px-3 py-2 border-b border-border">
				<span className="text-[10px] tracking-widest text-muted-foreground/60 uppercase">
					Sessions
				</span>
				<button
					type="button"
					className="p-1 text-muted-foreground hover:text-foreground transition-colors"
					onClick={onToggle}
					aria-label="collapse sidebar"
				>
					<svg
						className="w-3 h-3"
						fill="none"
						stroke="currentColor"
						viewBox="0 0 24 24"
						aria-hidden="true"
					>
						<path
							strokeLinecap="round"
							strokeLinejoin="round"
							strokeWidth={2}
							d="M15 19l-7-7 7-7"
						/>
					</svg>
				</button>
			</div>

			{/* New Session button */}
			<div className="px-2 pt-2 pb-1">
				<button
					type="button"
					className="w-full flex items-center justify-center gap-1.5 px-2 py-1.5 text-[10px] tracking-widest text-muted-foreground hover:text-foreground border border-border hover:border-primary/50 rounded transition-colors"
					onClick={() => onNewSession()}
					aria-label="new session"
				>
					<svg
						className="w-3 h-3"
						fill="none"
						stroke="currentColor"
						viewBox="0 0 24 24"
						aria-hidden="true"
					>
						<path
							strokeLinecap="round"
							strokeLinejoin="round"
							strokeWidth={2}
							d="M12 4v16m8-8H4"
						/>
					</svg>
					NEW SESSION
				</button>
			</div>

			{/* Session list */}
			<div className="flex-1 px-1 py-1 space-y-0.5">
				{sessions.map((session) => {
					const isActive = session.session_id === subscribedSessionId;
					return (
						<div key={session.session_id} className="group relative">
							<button
								type="button"
								className={`w-full flex items-center gap-2 px-2 py-1.5 rounded text-left transition-colors ${
									isActive
										? "bg-primary/10 border border-primary/30 text-foreground"
										: "hover:bg-accent text-muted-foreground hover:text-foreground border border-transparent"
								}`}
								onClick={() => onSubscribe(session.session_id)}
								aria-current={isActive ? "true" : undefined}
								aria-label={session.agent_name}
							>
								<StatusDot entry={session} />
								<div className="flex flex-col min-w-0 flex-1">
									<span className="text-[11px] font-medium truncate leading-tight">
										{session.agent_name}
									</span>
									{session.lastLabel && (
										<span className="text-[9px] text-muted-foreground/60 truncate leading-tight">
											{session.lastLabel}
										</span>
									)}
								</div>
							</button>

							{/* Action buttons — shown on group hover */}
							<div className="absolute right-1 top-1/2 -translate-y-1/2 hidden group-hover:flex items-center gap-0.5">
								<button
									type="button"
									className="p-0.5 text-muted-foreground/60 hover:text-foreground disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
									onClick={(e) => {
										e.stopPropagation();
										onStop(session.session_id);
									}}
									disabled={session.state !== "running"}
									aria-label={`stop ${session.agent_name}`}
									title="Stop"
								>
									<svg
										className="w-3 h-3"
										fill="none"
										stroke="currentColor"
										viewBox="0 0 24 24"
										aria-hidden="true"
									>
										<rect x="6" y="6" width="12" height="12" strokeWidth={2} />
									</svg>
								</button>
								<button
									type="button"
									className="p-0.5 text-muted-foreground/60 hover:text-destructive transition-colors"
									onClick={(e) => {
										e.stopPropagation();
										onClose(session.session_id);
									}}
									aria-label={`close ${session.agent_name}`}
									title="Close"
								>
									<svg
										className="w-3 h-3"
										fill="none"
										stroke="currentColor"
										viewBox="0 0 24 24"
										aria-hidden="true"
									>
										<path
											strokeLinecap="round"
											strokeLinejoin="round"
											strokeWidth={2}
											d="M6 18L18 6M6 6l12 12"
										/>
									</svg>
								</button>
							</div>
						</div>
					);
				})}
			</div>
		</div>
	);
}
