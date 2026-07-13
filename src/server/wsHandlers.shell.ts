/**
 * Shell WebSocket handlers — dispatched from index.ts when ws.data.isShell.
 *
 * Wire protocol:
 *   Server → Client binary : raw PTY bytes (ANSI/VT100)
 *   Server → Client text   : JSON control frames { type: "ready" } | { type: "exit", code: N }
 *   Client → Server binary : keystrokes / paste data
 *   Client → Server text   : JSON control frames
 *     { type: "resize", cols: N, rows: N }
 *     { type: "terminate" }  — explicit "toggle off", kills the PTY immediately
 */
import type { ServerWebSocket } from "bun";
import type { ShellSessionPool } from "./shellSessionPool";
import { routePtyMessage } from "./wsHandlers.pty";
import { parseTerminalTerminate } from "./wsSchemas";

export interface ShellWsData {
	isShell: true;
	sessionId: string;
	cwd: string;
	cols: number;
	rows: number;
}

type ShellWs = ServerWebSocket<ShellWsData>;

export function createShellWsHandlers(pool: ShellSessionPool) {
	return {
		open(ws: ShellWs): void {
			pool.subscribe(ws as never, {
				sessionId: ws.data.sessionId,
				cwd: ws.data.cwd,
				cols: ws.data.cols,
				rows: ws.data.rows,
			});
		},

		message(ws: ShellWs, data: string | ArrayBuffer | Buffer): void {
			const { sessionId } = ws.data;

			if (typeof data === "string" && parseTerminalTerminate(data)) {
				pool.terminate(sessionId);
				return;
			}
			routePtyMessage(pool, sessionId, data);
		},

		close(ws: ShellWs): void {
			pool.unsubscribe(ws as never);
		},
	};
}
