import type { ShellWsData } from "./wsHandlers.shell";
import { parseInitialTerminalDimensions } from "./wsSchemas";

type ShellUpgradeOperations = {
	defaultCwd: string;
	resolveCwd: (requestedCwd: string) => string | null;
};

export function createShellUpgradeHandler(operations: ShellUpgradeOperations) {
	return async (
		url: URL,
		upgrade: (data: ShellWsData) => boolean,
	): Promise<Response | undefined> => {
		const sessionId = url.searchParams.get("session_id") ?? "";
		if (!sessionId)
			return new Response("session_id is required", { status: 400 });

		const requestedCwd = url.searchParams.get("cwd") ?? operations.defaultCwd;
		const cwd = operations.resolveCwd(requestedCwd);
		if (!cwd) return new Response("Forbidden", { status: 403 });

		const { cols, rows } = parseInitialTerminalDimensions(
			url.searchParams.get("cols"),
			url.searchParams.get("rows"),
		);

		if (upgrade({ isShell: true, sessionId, cwd, cols, rows })) {
			return undefined;
		}
		return new Response("WebSocket upgrade required", { status: 426 });
	};
}
