/**
 * Terminal WebSocket handlers — dispatched from index.ts when ws.data.isTerminal.
 *
 * Wire protocol:
 *   Server → Client binary : raw PTY bytes (ANSI/VT100)
 *   Server → Client text   : JSON control frames { type: "ready" } | { type: "exit", code: N }
 *   Client → Server binary : keystrokes / paste data
 *   Client → Server text   : JSON control frames { type: "resize", cols: N, rows: N }
 */
import type { ServerWebSocket } from "bun";
import type { TerminalSessionPool } from "./terminalSessionPool";

export interface TerminalWsData {
	isTerminal: true;
	sessionId: string;
	cwd: string;
	claudeSessionId: string | null;
	label: string | null;
	cols: number;
	rows: number;
}

type TerminalWs = ServerWebSocket<TerminalWsData>;

export function createTerminalWsHandlers(pool: TerminalSessionPool) {
	return {
		open(ws: TerminalWs): void {
			pool.subscribe(ws as never, {
				sessionId: ws.data.sessionId,
				cwd: ws.data.cwd,
				claudeSessionId: ws.data.claudeSessionId,
				label: ws.data.label,
				cols: ws.data.cols,
				rows: ws.data.rows,
			});
		},

		message(ws: TerminalWs, data: string | ArrayBuffer | Buffer): void {
			const { sessionId } = ws.data;

			if (typeof data === "string") {
				// Control frame — parse JSON
				try {
					const msg = JSON.parse(data) as {
						type: string;
						cols?: number;
						rows?: number;
					};
					if (msg.type === "resize" && msg.cols && msg.rows) {
						pool.resize(sessionId, msg.cols, msg.rows);
					}
				} catch {
					// Ignore malformed frames
				}
			} else {
				// Binary frame — raw keystrokes/paste → PTY stdin
				const buf = data instanceof ArrayBuffer ? new Uint8Array(data) : data;
				pool.write(sessionId, buf);
			}
		},

		close(ws: TerminalWs): void {
			pool.unsubscribe(ws as never);
		},
	};
}
