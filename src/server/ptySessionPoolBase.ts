/**
 * Shared "keep PTY alive across WS disconnects" bookkeeping for
 * ShellSessionPool and TerminalSessionPool: entry/subscriber maps, idle
 * timer, write/resize/close/closeAll, and delayed post-exit cleanup.
 * Subclasses own spawning + entry construction in their own subscribe().
 */
import type { ServerWebSocket } from "bun";
import type { PtyBridge } from "./ptyBridge";
import type { RingBuffer } from "./ringBuffer";

/** Idle timeout: kill PTY after this many ms with no WS subscribers. */
export const IDLE_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

// biome-ignore lint/suspicious/noExplicitAny: Bun WS data shape varies
export type AnyWs = ServerWebSocket<any>;

export interface PtyPoolEntry {
	sessionId: string;
	bridge: PtyBridge;
	buffer: RingBuffer;
	subscribers: Set<AnyWs>;
	idleTimer: ReturnType<typeof setTimeout> | null;
	alive: boolean;
}

export abstract class PtySessionPoolBase<TEntry extends PtyPoolEntry> {
	protected entries: Map<string, TEntry> = new Map();
	/** Reverse lookup: WS → sessionId (for unsubscribe). */
	protected wsToSession: Map<AnyWs, string> = new Map();

	/** Override with null for PTYs whose owning session controls their lifetime. */
	protected idleTimeoutMs(): number | null {
		return IDLE_TIMEOUT_MS;
	}

	/** Remove a WS client from its session; starts the idle timer once empty. */
	unsubscribe(ws: AnyWs): void {
		const sessionId = this.wsToSession.get(ws);
		if (!sessionId) return;
		this.wsToSession.delete(ws);

		const entry = this.entries.get(sessionId);
		if (!entry) return;

		entry.subscribers.delete(ws);

		const idleTimeoutMs = this.idleTimeoutMs();
		if (entry.subscribers.size === 0 && entry.alive && idleTimeoutMs !== null) {
			entry.idleTimer = setTimeout(() => {
				this.close(sessionId);
			}, idleTimeoutMs);
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
		this.forgetWsMappingsFor(sessionId);
		this.onClosed(sessionId);
	}

	/** Kill all PTYs — called on server shutdown (SIGTERM/SIGINT). */
	closeAll(): void {
		for (const sessionId of this.entries.keys()) {
			this.close(sessionId);
		}
	}

	/** Hook for subclasses that need to react to a session closing (e.g. onChange). */
	protected onClosed(_sessionId: string): void {}

	/** Hook for subclasses that need to react to a new entry being created. */
	protected onCreated(_sessionId: string): void {}

	/** Hook for subclasses that need to react to the PTY process exiting. */
	protected onExited(_sessionId: string): void {}

	/**
	 * Wire a freshly spawned bridge into `entry`: pipe output to the ring
	 * buffer + subscribers, and on exit mark the entry dead, notify
	 * subscribers, and schedule cleanup.
	 */
	protected wireBridge(
		bridge: PtyBridge,
		entry: TEntry,
		sessionId: string,
	): void {
		bridge.onData((chunk) => {
			entry.buffer.push(chunk);
			for (const sub of entry.subscribers) {
				sub.sendBinary(chunk);
			}
		});

		bridge.onExit((code) => {
			entry.alive = false;
			this.onExited(sessionId);
			const frame = JSON.stringify({ type: "exit", code });
			for (const sub of entry.subscribers) {
				sub.send(frame);
			}
			this.scheduleCleanup(sessionId, 5000);
		});
	}

	/**
	 * Subscribe glue shared by both pools: reuse the live entry for
	 * `sessionId` (reattaching `ws` to it), or build a fresh one via
	 * `spawnEntry` when none exists yet. Either way, registers `ws` as a
	 * subscriber and sends the "ready" frame.
	 */
	protected subscribeCore(
		ws: AnyWs,
		sessionId: string,
		spawnEntry: () => TEntry,
	): void {
		let entry = this.entries.get(sessionId);

		if (!entry || !entry.alive) {
			entry = spawnEntry();
			this.entries.set(sessionId, entry);
			this.onCreated(sessionId);
			this.wireBridge(entry.bridge, entry, sessionId);
		} else {
			this.reattach(entry, ws);
		}

		entry.subscribers.add(ws);
		this.wsToSession.set(ws, sessionId);
		ws.send(JSON.stringify({ type: "ready" }));
	}

	/**
	 * Reattach path for an existing, still-alive entry: cancel any pending
	 * idle timer and replay the ring buffer so the client sees recent output
	 * immediately.
	 */
	protected reattach(entry: TEntry, ws: AnyWs): void {
		if (entry.idleTimer !== null) {
			clearTimeout(entry.idleTimer);
			entry.idleTimer = null;
		}
		const snapshot = entry.buffer.snapshot();
		if (snapshot.length > 0) {
			ws.sendBinary(snapshot);
		}
	}

	protected forgetWsMappingsFor(sessionId: string): void {
		for (const [ws, sid] of this.wsToSession) {
			if (sid === sessionId) this.wsToSession.delete(ws);
		}
	}

	/** Give subscribers a moment to read the exit frame, then clean up. */
	protected scheduleCleanup(sessionId: string, delayMs: number): void {
		setTimeout(() => {
			const entry = this.entries.get(sessionId);
			if (entry && !entry.alive) {
				this.entries.delete(sessionId);
				this.forgetWsMappingsFor(sessionId);
			}
		}, delayMs);
	}
}
