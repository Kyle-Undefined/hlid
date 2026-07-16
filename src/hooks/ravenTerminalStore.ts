function validSessionId(value: unknown): value is string {
	return (
		typeof value === "string" && value.trim().length > 0 && value.length <= 512
	);
}

// Deliberately process-local rather than persisted browser storage. It survives
// SPA route unmounts, but a full app/server restart cannot resurrect a stale
// "open" view after its PTY was cleaned up.
const openTerminals = new Set<string>();

/** Whether this Raven chat's project terminal should be visible on return. */
export function isRavenTerminalOpen(sessionId: string): boolean {
	return validSessionId(sessionId) && openTerminals.has(sessionId);
}

/** Keep a toggled-on project terminal attached to its chat across navigation. */
export function rememberRavenTerminal(sessionId: string): void {
	if (!validSessionId(sessionId)) return;
	openTerminals.add(sessionId);
}

/** Forget the terminal UI state when it is toggled off or its chat is closed. */
export function forgetRavenTerminal(sessionId: string): void {
	if (!validSessionId(sessionId)) return;
	openTerminals.delete(sessionId);
}

/** @internal Test isolation for the module-scoped SPA navigation cache. */
export function resetRavenTerminalsForTesting(): void {
	openTerminals.clear();
}
