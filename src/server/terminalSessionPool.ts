/**
 * TerminalSessionPool — manages live PTY processes across WS connects/disconnects.
 *
 * Mirrors SessionPool's "keep alive between disconnects" pattern for terminal
 * sessions. Each sessionId maps to one TerminalSessionEntry holding:
 * - A PtyBridge (the running claude CLI process)
 * - A ring buffer of recent output (for reconnect replay)
 * - A set of currently subscribed WS clients
 * - An idle timer that kills the PTY after 30 min with no subscribers
 *
 * This lets users switch between sessions in the Raven sidebar without
 * killing their terminal sessions — reconnecting replays the buffer so
 * recent output is visible immediately.
 */

import { dirname } from "node:path";
import type { ServerWebSocket } from "bun";
import { resolveClaudeExecutable } from "../lib/claudePath";
import type { SessionStatusEntry } from "./protocol";
import { PtyBridge } from "./ptyBridge";

/** Capacity of the per-session output ring buffer (bytes). */
const RING_BUFFER_BYTES = 100 * 1024; // 100 KB

/** Idle timeout: kill PTY after this many ms with no WS subscribers. */
const IDLE_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

// biome-ignore lint/suspicious/noExplicitAny: Bun WS data shape varies
type AnyWs = ServerWebSocket<any>;

export class RingBuffer {
	private buf: Buffer;
	private len = 0; // total bytes written (for pointer math)
	private cap: number;

	constructor(capacity = RING_BUFFER_BYTES) {
		this.cap = capacity;
		this.buf = Buffer.allocUnsafe(capacity);
	}

	// Shared with ShellSessionPool; Fallow does not resolve that cross-module use.
	// fallow-ignore-next-line unused-class-member
	push(data: Buffer): void {
		const src = data;
		if (src.length >= this.cap) {
			// Incoming chunk is larger than capacity — keep only the tail.
			src.copy(this.buf, 0, src.length - this.cap);
			this.len = this.cap;
			return;
		}
		const pos = this.len % this.cap;
		const tail = this.cap - pos;
		if (src.length <= tail) {
			src.copy(this.buf, pos);
		} else {
			// Wrap around: copy front portion to end, remainder to start.
			src.copy(this.buf, pos, 0, tail);
			src.copy(this.buf, 0, tail);
		}
		this.len += src.length;
	}

	/**
	 * Return the current buffer contents in order (oldest → newest).
	 * Returns a Buffer of at most `capacity` bytes.
	 */
	// Shared with ShellSessionPool; Fallow does not resolve that cross-module use.
	// fallow-ignore-next-line unused-class-member
	snapshot(): Buffer {
		if (this.len === 0) return Buffer.alloc(0);
		const used = Math.min(this.len, this.cap);
		const start = this.len % this.cap;
		if (this.len < this.cap) {
			// Buffer not yet full — data lives at [0, len)
			return Buffer.from(this.buf.subarray(0, used));
		}
		// Buffer full / wrapped — data starts at `start`
		const out = Buffer.allocUnsafe(this.cap);
		this.buf.copy(out, 0, start);
		this.buf.copy(out, this.cap - start, 0, start);
		return out;
	}
}

interface TerminalSessionEntry {
	sessionId: string;
	cwd: string;
	claudeSessionId: string | null;
	label: string;
	bridge: PtyBridge;
	buffer: RingBuffer;
	subscribers: Set<AnyWs>;
	idleTimer: ReturnType<typeof setTimeout> | null;
	/** True while the PTY process is still running. */
	alive: boolean;
}

export interface TerminalSubscribeOpts {
	sessionId: string;
	cwd: string;
	claudeSessionId: string | null;
	label?: string | null;
	cols: number;
	rows: number;
}

export class TerminalSessionPool {
	private entries: Map<string, TerminalSessionEntry> = new Map();
	/** Reverse lookup: WS → sessionId (for unsubscribe). */
	private wsToSession: Map<AnyWs, string> = new Map();

	constructor(
		private workerPath?: string,
		private onChange?: () => void,
	) {}

	/**
	 * Subscribe a WS client to a terminal session.
	 * Creates a new PTY if one doesn't exist; otherwise reattaches and
	 * replays the ring buffer so recent output is immediately visible.
	 */
	subscribe(ws: AnyWs, opts: TerminalSubscribeOpts): void {
		let entry = this.entries.get(opts.sessionId);

		if (!entry || !entry.alive) {
			// Spawn a new PTY for this session.
			const executable = resolveClaudeExecutable() ?? "claude";
			const bridge = PtyBridge.spawn({
				claudeSessionId: opts.claudeSessionId ?? undefined,
				cwd: opts.cwd,
				cols: opts.cols,
				rows: opts.rows,
				executable,
				workerPath: this.workerPath,
				workerCwd: this.workerPath ? dirname(this.workerPath) : undefined,
			});

			entry = {
				sessionId: opts.sessionId,
				cwd: opts.cwd,
				claudeSessionId: opts.claudeSessionId,
				label: opts.label ?? "Terminal session",
				bridge,
				buffer: new RingBuffer(),
				subscribers: new Set(),
				idleTimer: null,
				alive: true,
			};

			this.entries.set(opts.sessionId, entry);
			this.onChange?.();

			// Pipe PTY output → ring buffer + all subscribers.
			bridge.onData((chunk) => {
				if (!entry) return;
				entry.buffer.push(chunk);
				for (const sub of entry.subscribers) {
					sub.sendBinary(chunk);
				}
			});

			// When the PTY exits: notify subscribers and mark dead.
			bridge.onExit((code) => {
				if (!entry) return;
				entry.alive = false;
				this.onChange?.();
				const frame = JSON.stringify({ type: "exit", code });
				for (const sub of entry.subscribers) {
					sub.send(frame);
				}
				// Give subscribers a moment to read the exit frame, then clean up.
				this.scheduleCleanup(opts.sessionId, 5000);
			});
		} else {
			// Reattach: cancel any pending idle timer.
			if (entry.idleTimer !== null) {
				clearTimeout(entry.idleTimer);
				entry.idleTimer = null;
			}
			// Replay buffer so the client sees recent output immediately.
			const snapshot = entry.buffer.snapshot();
			if (snapshot.length > 0) {
				ws.sendBinary(snapshot);
			}
		}

		entry.subscribers.add(ws);
		this.wsToSession.set(ws, opts.sessionId);

		// Send ready signal.
		ws.send(JSON.stringify({ type: "ready" }));
	}

	/**
	 * Remove a WS client from its session.
	 * If no subscribers remain, starts the idle timer.
	 */
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

	/** Kill a session's PTY and remove it from the pool. */
	close(sessionId: string): void {
		const entry = this.entries.get(sessionId);
		if (!entry) return;
		if (entry.idleTimer !== null) {
			clearTimeout(entry.idleTimer);
			entry.idleTimer = null;
		}
		entry.bridge.kill();
		this.entries.delete(sessionId);
		this.onChange?.();
		// Clean up any ws→session mappings that still point here.
		for (const [ws, sid] of this.wsToSession) {
			if (sid === sessionId) this.wsToSession.delete(ws);
		}
	}

	/** Kill all PTYs — called on server shutdown (SIGTERM/SIGINT). */
	closeAll(): void {
		for (const sessionId of this.entries.keys()) {
			this.close(sessionId);
		}
	}

	setSessionLabel(sessionId: string, label: string): void {
		const entry = this.entries.get(sessionId);
		if (!entry) return;
		entry.label = label;
		this.onChange?.();
	}

	/**
	 * Status snapshot for every live terminal session.
	 * Merged with SessionPool.getSessionsStatus() for `sessions_status` broadcasts.
	 */
	getSessionsStatus(): SessionStatusEntry[] {
		const out: SessionStatusEntry[] = [];
		for (const entry of this.entries.values()) {
			if (!entry.alive) continue;
			out.push({
				session_id: entry.sessionId,
				agent_cwd: entry.cwd,
				agent_name: entry.label || "Terminal session",
				state: "running",
				model: "claude-cli",
				hasPendingPermissions: false,
				// Terminal sessions pre-create their DB row (via ensureSessionFn) using
				// the same UUID as the pool entry — so sessionId IS the DB session ID.
				hasDbSession: true,
				db_session_id: entry.sessionId,
				mode: "terminal",
			});
		}
		return out;
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
