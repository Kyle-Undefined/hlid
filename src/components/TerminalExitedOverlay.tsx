/** Overlay shown when the terminal's PTY process or WS connection has ended. */
export function TerminalExitedOverlay({
	exited,
	onNewSession,
}: {
	exited: { code?: number; wsError?: boolean };
	onNewSession?: () => void;
}) {
	return (
		<div className="absolute inset-0 flex items-center justify-center bg-background/75 backdrop-blur-[1px]">
			<div className="rounded-lg border border-border bg-card px-6 py-4 text-center text-card-foreground shadow-2xl">
				<p className="text-sm">Session ended</p>
				<p className="mt-1 text-xs text-muted-foreground">
					{exited.wsError
						? "Could not connect to terminal server."
						: exited.code !== undefined
							? `Claude CLI exited (code ${exited.code}).`
							: "The Claude CLI process has exited."}
				</p>
				{onNewSession && (
					<button
						type="button"
						onClick={onNewSession}
						className="mt-3 rounded border border-border bg-secondary px-3 py-1.5 text-xs text-secondary-foreground hover:border-primary/50 hover:bg-accent hover:text-accent-foreground transition-colors"
					>
						New Session
					</button>
				)}
			</div>
		</div>
	);
}
