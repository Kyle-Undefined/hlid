/**
 * Shared control-frame/binary-frame routing for the shell and terminal PTY
 * WS handlers: a JSON resize frame adjusts the PTY, anything else (binary,
 * or non-resize text) is forwarded to the PTY as input.
 */
import { parseTerminalResize } from "./wsSchemas";

export interface PtyControlPool {
	resize(sessionId: string, cols: number, rows: number): void;
	write(sessionId: string, data: Uint8Array | string): void;
}

export function routePtyMessage(
	pool: PtyControlPool,
	sessionId: string,
	data: string | ArrayBuffer | Buffer,
): void {
	if (typeof data === "string") {
		const dimensions = parseTerminalResize(data);
		if (dimensions) {
			pool.resize(sessionId, dimensions.cols, dimensions.rows);
		}
		return;
	}
	const buf = data instanceof ArrayBuffer ? new Uint8Array(data) : data;
	pool.write(sessionId, buf);
}
