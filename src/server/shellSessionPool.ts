/**
 * ShellSessionPool — manages live PTY processes for Raven's dev-terminal
 * toggle, mirroring TerminalSessionPool's "keep alive between disconnects"
 * pattern (ring buffer + idle timer) but for a real login shell instead of
 * the `claude` CLI:
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
import type { ServerWebSocket } from "bun";
import { PtyBridge } from "./ptyBridge";
import { resolveShell } from "./resolveShell";
import { RingBuffer } from "./terminalSessionPool";

const IDLE_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

// biome-ignore lint/suspicious/noExplicitAny: Bun WS data shape varies
type AnyWs = ServerWebSocket<any>;

interface ShellSessionEntry {
	sessionId: string;
	cwd: string;
	bridge: PtyBridge;
	buffer: RingBuffer;
	subscribers: Set<AnyWs>;
	idleTimer: ReturnType<typeof setTimeout> | null;
	alive: boolean;
}

export interface ShellSubscribeOpts {
	sessionId: string;
	cwd: string;
	cols: number;
	rows: number;
}

export class ShellSessionPool {
	private entries: Map<string, ShellSessionEntry> = new Map();
	private wsToSession: Map<AnyWs, string> = new Map();

	constructor(private workerPath?: string) {}

	/**
	 * Subscribe a WS client to a shell session. Spawns a new PTY (via
	 * resolveShell) if one doesn't exist for this sessionId; otherwise
	 * reattaches and replays the ring buffer.
	 */
	subscribe(ws: AnyWs, opts: ShellSubscribeOpts): void {
		let entry = this.entries.get(opts.sessionId);

		if (!entry || !entry.alive) {
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

			entry = {
				sessionId: opts.sessionId,
				cwd: opts.cwd,
				bridge,
				buffer: new RingBuffer(),
				subscribers: new Set(),
				idleTimer: null,
				alive: true,
			};

			this.entries.set(opts.sessionId, entry);

			bridge.onData((chunk) => {
				if (!entry) return;
				entry.buffer.push(chunk);
				for (const sub of entry.subscribers) {
					sub.sendBinary(chunk);
				}
			});

			bridge.onExit((code) => {
				if (!entry) return;
				entry.alive = false;
				const frame = JSON.stringify({ type: "exit", code });
				for (const sub of entry.subscribers) {
					sub.send(frame);
				}
				this.scheduleCleanup(opts.sessionId, 5000);
			});
		} else {
			if (entry.idleTimer !== null) {
				clearTimeout(entry.idleTimer);
				entry.idleTimer = null;
			}
			const snapshot = entry.buffer.snapshot();
			if (snapshot.length > 0) {
				ws.sendBinary(snapshot);
			}
		}

		entry.subscribers.add(ws);
		this.wsToSession.set(ws, opts.sessionId);

		ws.send(JSON.stringify({ type: "ready" }));
	}

	/** Remove a WS client from its session; starts the idle timer once empty. */
	unsubscribe(ws: AnyWs): void {
		const sessionId = this.wsToSession.get(ws);
		if (!sessionId) return;
		this.wsToSession.delete(ws);

		const entry = this.entries.get(sessionId);
		if (!entry) return;

		entry.subscribers.delete(ws);

		if (entry.subscribers.size === 0 && entry.alive) {
			entry.idleTimer = setTimeout(() => {
				this.close(sessionId);
			}, IDLE_TIMEOUT_MS);
		}
	}

	/** Write bytes to a session's PTY stdin. No-op for unknown sessionId. */
	write(sessionId: string, data: Uint8Array | string): void {
		this.entries.get(sessionId)?.bridge.write(data);
	}

	/** Resize a session's PTY. No-op for unknown sessionId. */
	resize(sessionId: string, cols: number, rows: number): void {
		this.entries.get(sessionId)?.bridge.resize(cols, rows);
	}

	/** Kill a session's PTY and remove it from the pool immediately. */
	close(sessionId: string): void {
		const entry = this.entries.get(sessionId);
		if (!entry) return;
		if (entry.idleTimer !== null) {
			clearTimeout(entry.idleTimer);
			entry.idleTimer = null;
		}
		entry.bridge.kill();
		this.entries.delete(sessionId);
		for (const [ws, sid] of this.wsToSession) {
			if (sid === sessionId) this.wsToSession.delete(ws);
		}
	}

	/** Explicit "toggle off" — kills immediately, bypassing the idle timer. */
	terminate(sessionId: string): void {
		this.close(sessionId);
	}

	/** Kill all PTYs — called on server shutdown (SIGTERM/SIGINT). */
	closeAll(): void {
		for (const sessionId of this.entries.keys()) {
			this.close(sessionId);
		}
	}

	private scheduleCleanup(sessionId: string, delayMs: number): void {
		setTimeout(() => {
			const entry = this.entries.get(sessionId);
			if (entry && !entry.alive) {
				this.entries.delete(sessionId);
				for (const [ws, sid] of this.wsToSession) {
					if (sid === sessionId) this.wsToSession.delete(ws);
				}
			}
		}, delayMs);
	}
}
