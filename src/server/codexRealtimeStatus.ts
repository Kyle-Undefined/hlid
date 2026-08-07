export type CodexRealtimeBackendStatus = {
	available?: boolean;
	reason?: string;
	observedAt?: number;
};

export const CODEX_REALTIME_ACCOUNT_UNAVAILABLE =
	"Codex realtime voice is not available for this ChatGPT account yet.";

let backendStatus: CodexRealtimeBackendStatus = {};

export function getCodexRealtimeBackendStatus(): CodexRealtimeBackendStatus {
	return { ...backendStatus };
}

export function markCodexRealtimeBackendAccepted(now = Date.now()): void {
	backendStatus = { available: true, observedAt: now };
}

export function markCodexRealtimeBackendError(
	message: string,
	now = Date.now(),
): boolean {
	if (message !== CODEX_REALTIME_ACCOUNT_UNAVAILABLE) return false;
	backendStatus = {
		available: false,
		reason: CODEX_REALTIME_ACCOUNT_UNAVAILABLE,
		observedAt: now,
	};
	return true;
}

export function resetCodexRealtimeBackendStatus(): void {
	backendStatus = {};
}
