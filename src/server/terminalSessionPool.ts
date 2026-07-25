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
import { resolveClaudeExecutable } from "../lib/claudePath";
import type { SessionStatusEntry } from "./protocol";
import { PtyBridge } from "./ptyBridge";
import type { AnyWs, PtyPoolEntry } from "./ptySessionPoolBase";
import { PtySessionPoolBase } from "./ptySessionPoolBase";
import { RingBuffer } from "./ringBuffer";

interface TerminalSessionEntry extends PtyPoolEntry {
	cwd: string;
	claudeSessionId: string | null;
	label: string;
	pinned: boolean;
	forkParentSessionId: string | null;
	forkParentLabel: string | null;
	forkKind: "exact" | "recap" | null;
	attentionStartedAt: number;
}

export interface TerminalSubscribeOpts {
	sessionId: string;
	cwd: string;
	claudeSessionId: string | null;
	label?: string | null;
	pinned?: boolean;
	forkParentSessionId?: string | null;
	forkParentLabel?: string | null;
	forkKind?: "exact" | "recap" | null;
	cols: number;
	rows: number;
}

export class TerminalSessionPool extends PtySessionPoolBase<TerminalSessionEntry> {
	constructor(
		private workerPath?: string,
		private onChange?: () => void,
	) {
		super();
	}

	/**
	 * Subscribe a WS client to a terminal session.
	 * Creates a new PTY if one doesn't exist; otherwise reattaches and
	 * replays the ring buffer so recent output is immediately visible.
	 */
	subscribe(ws: AnyWs, opts: TerminalSubscribeOpts): void {
		this.subscribeCore(ws, opts.sessionId, () => {
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

			return {
				sessionId: opts.sessionId,
				cwd: opts.cwd,
				claudeSessionId: opts.claudeSessionId,
				label: opts.label ?? "Terminal session",
				pinned: opts.pinned ?? false,
				forkParentSessionId: opts.forkParentSessionId ?? null,
				forkParentLabel: opts.forkParentLabel ?? null,
				forkKind: opts.forkKind ?? null,
				attentionStartedAt: Date.now(),
				bridge,
				buffer: new RingBuffer(),
				subscribers: new Set(),
				idleTimer: null,
				alive: true,
			};
		});
	}

	setSessionLabel(sessionId: string, label: string): void {
		const entry = this.entries.get(sessionId);
		if (!entry) return;
		entry.label = label;
		this.onChange?.();
	}

	setSessionPinned(sessionId: string, pinned: boolean): void {
		const entry = this.entries.get(sessionId);
		if (!entry) return;
		entry.pinned = pinned;
		this.onChange?.();
	}

	setForkParentLabel(parentSessionId: string, label: string): void {
		let changed = false;
		for (const entry of this.entries.values()) {
			if (entry.forkParentSessionId !== parentSessionId) continue;
			entry.forkParentLabel = label;
			changed = true;
		}
		if (changed) this.onChange?.();
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
				provider_id: "claude",
				model: "claude-cli",
				hasPendingPermissions: false,
				attention: {
					bucket: "working",
					reason: "terminal",
					since: entry.attentionStartedAt,
					last_activity_at: entry.attentionStartedAt,
					queue_count: 0,
					pending_count: 0,
				},
				// Terminal sessions pre-create their DB row (via ensureSessionFn) using
				// the same UUID as the pool entry — so sessionId IS the DB session ID.
				hasDbSession: true,
				db_session_id: entry.sessionId,
				pinned: entry.pinned,
				fork_parent_session_id: entry.forkParentSessionId,
				fork_parent_label: entry.forkParentLabel,
				fork_kind: entry.forkKind,
				mode: "terminal",
			});
		}
		return out;
	}

	protected override onCreated(): void {
		this.onChange?.();
	}

	protected override onClosed(): void {
		this.onChange?.();
	}

	protected override onExited(): void {
		this.onChange?.();
	}
}
