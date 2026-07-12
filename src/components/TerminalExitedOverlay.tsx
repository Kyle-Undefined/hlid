/** Overlay shown when the terminal's PTY process or WS connection has ended. */
export function TerminalExitedOverlay({
	exited,
	onNewSession,
}: {
	exited: { code?: number; wsError?: boolean };
	onNewSession?: () => void;
}) {
	return (
		<div className="absolute inset-0 flex items-center justify-center bg-black/60">
			<div className="rounded-lg border border-stone-700 bg-stone-900 px-6 py-4 text-center">
				<p className="text-sm text-stone-300">Session ended</p>
				<p className="mt-1 text-xs text-stone-500">
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
						className="mt-3 rounded border border-stone-600 bg-stone-800 px-3 py-1.5 text-xs text-stone-300 hover:border-stone-500 hover:bg-stone-700 hover:text-stone-100 transition-colors"
					>
						New Session
					</button>
				)}
			</div>
		</div>
	);
}
