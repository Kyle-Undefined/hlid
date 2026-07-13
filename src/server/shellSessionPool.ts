/**
 * ShellSessionPool — manages live PTY processes for Raven's dev-terminal
 * toggle, mirroring TerminalSessionPool's "keep alive between disconnects"
 * pattern (ring buffer + idle timer, via PtySessionPoolBase) but for a real
 * login shell instead of the `claude` CLI:
 * - No DB row, no claudeSessionId/--resume — these sessions never appear
 *   in Raven's session sidebar.
 * - Executable/args come from resolveShell(cwd) instead of the Claude CLI
 *   resolver.
 * - Separate Map from TerminalSessionPool, so the same sessionId (a Raven
 *   chat's id, reused directly) can't collide with that chat's Claude PTY.
 * - terminate() bypasses the idle timer for the explicit "toggle off" path;
 *   unsubscribe() alone (e.g. navigating away without toggling off) still
 *   idles out after IDLE_TIMEOUT_MS like the terminal pool does.
 */

import { dirname } from "node:path";
import { PtyBridge } from "./ptyBridge";
import type { AnyWs, PtyPoolEntry } from "./ptySessionPoolBase";
import { PtySessionPoolBase } from "./ptySessionPoolBase";
import { resolveShell } from "./resolveShell";
import { RingBuffer } from "./ringBuffer";

type ShellSessionEntry = PtyPoolEntry;

export interface ShellSubscribeOpts {
	sessionId: string;
	cwd: string;
	cols: number;
	rows: number;
}

export class ShellSessionPool extends PtySessionPoolBase<ShellSessionEntry> {
	constructor(private workerPath?: string) {
		super();
	}

	/**
	 * Subscribe a WS client to a shell session. Spawns a new PTY (via
	 * resolveShell) if one doesn't exist for this sessionId; otherwise
	 * reattaches and replays the ring buffer.
	 */
	subscribe(ws: AnyWs, opts: ShellSubscribeOpts): void {
		this.subscribeCore(ws, opts.sessionId, () => {
			const { executable, args } = resolveShell(opts.cwd);
			const bridge = PtyBridge.spawn({
				cwd: opts.cwd,
				cols: opts.cols,
				rows: opts.rows,
				executable,
				args,
				workerPath: this.workerPath,
				workerCwd: this.workerPath ? dirname(this.workerPath) : undefined,
			});

			return {
				sessionId: opts.sessionId,
				bridge,
				buffer: new RingBuffer(),
				subscribers: new Set(),
				idleTimer: null,
				alive: true,
			};
		});
	}

	/** Explicit "toggle off" — kills immediately, bypassing the idle timer. */
	terminate(sessionId: string): void {
		this.close(sessionId);
	}
}
