import type { TerminalWsData } from "./wsHandlers.terminal";
import { parseInitialTerminalDimensions } from "./wsSchemas";

type TerminalUpgradeOperations = {
	defaultCwd: string;
	resolveCwd: (requestedCwd: string) => string | null;
	createSession: (sessionId: string) => Promise<void>;
	getSessionLabel: (sessionId: string) => Promise<string | null>;
	getResumeId: (sessionId: string) => Promise<string | null>;
};

export function createTerminalUpgradeHandler(
	operations: TerminalUpgradeOperations,
) {
	return async (
		url: URL,
		upgrade: (data: TerminalWsData) => boolean,
	): Promise<Response | undefined> => {
		const sessionId = url.searchParams.get("session_id") ?? "";
		const requestedCwd = url.searchParams.get("cwd") ?? operations.defaultCwd;
		const cwd = operations.resolveCwd(requestedCwd);
		if (!cwd) return new Response("Forbidden", { status: 403 });

		let label: string | null = null;
		if (sessionId) {
			await operations.createSession(sessionId);
			label =
				(await operations.getSessionLabel(sessionId)) ?? "Terminal session";
		}
		const { cols, rows } = parseInitialTerminalDimensions(
			url.searchParams.get("cols"),
			url.searchParams.get("rows"),
		);
		let claudeSessionId: string | null = null;
		if (sessionId) {
			try {
				claudeSessionId = await operations.getResumeId(sessionId);
			} catch {
				// A corrupt or unavailable resume id must not prevent a new terminal.
			}
		}

		if (
			upgrade({
				isTerminal: true,
				sessionId,
				cwd,
				label,
				cols,
				rows,
				claudeSessionId,
			})
		) {
			return undefined;
		}
		return new Response("WebSocket upgrade required", { status: 426 });
	};
}
