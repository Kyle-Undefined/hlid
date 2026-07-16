/**
 * SessionPool — manages multiple concurrent SessionManager instances.
 *
 * Pool key = sessionId (UUID). Same agentCwd can have multiple simultaneous
 * entries. Sessions are created lazily on first use and torn down explicitly
 * via close() or closeAll().
 */
import { randomUUID } from "node:crypto";
import type { HlidConfig } from "../config";
import type { AgentProvider } from "./agentProvider";
import type { SessionStatusEntry } from "./protocol";
import { SessionRunState } from "./runState";
import { SessionManager } from "./session";

export interface PoolEntry {
	sessionId: string;
	agentCwd: string;
	agentName: string;
	manager: SessionManager;
	runState: SessionRunState;
}

const DEFAULT_MAX_SIZE = 20;

export class SessionPool {
	private entries: Map<string, PoolEntry> = new Map();
	private config: HlidConfig;
	private providers: Map<string, AgentProvider>;
	private maxSize: number;
	/** Session ID of the vault's lazy singleton entry, or null if not yet created. */
	private _vaultSessionId: string | null = null;

	constructor(
		config: HlidConfig,
		providers: Map<string, AgentProvider>,
		maxSize = DEFAULT_MAX_SIZE,
	) {
		this.config = config;
		this.providers = providers;
		this.maxSize = maxSize;
	}

	/**
	 * Create a new session entry for the given agentCwd/agentName.
	 * Multiple calls with the same agentCwd are supported — each produces
	 * an independent SessionManager with a distinct UUID.
	 *
	 * Throws if the pool has reached its capacity limit.
	 */
	create(agentCwd: string, agentName: string): PoolEntry {
		if (this.entries.size >= this.maxSize) {
			throw new Error(
				`Session pool at capacity (${this.maxSize}). Close a session before creating a new one.`,
			);
		}

		const sessionId = randomUUID();
		const manager = new SessionManager(this.config, this.providers);
		const runState = new SessionRunState(sessionId);
		const entry: PoolEntry = {
			sessionId,
			agentCwd,
			agentName,
			manager,
			runState,
		};
		this.entries.set(sessionId, entry);
		return entry;
	}

	/** Look up a live session entry by its UUID. Returns undefined if not found. */
	get(sessionId: string): PoolEntry | undefined {
		return this.entries.get(sessionId);
	}

	/**
	 * Abort and remove a session from the pool.
	 * Calls manager.abort() to terminate any in-flight subprocess.
	 * No-op if the sessionId is not in the pool.
	 */
	close(sessionId: string): void {
		const entry = this.entries.get(sessionId);
		if (!entry) return;
		entry.manager.abort();
		this.entries.delete(sessionId);
		if (this._vaultSessionId === sessionId) {
			this._vaultSessionId = null;
		}
	}

	/**
	 * Abort and remove all sessions.
	 * Intended for graceful server shutdown (SIGTERM / SIGINT).
	 */
	closeAll(): void {
		for (const entry of this.entries.values()) {
			entry.manager.abort();
		}
		this.entries.clear();
		this._vaultSessionId = null;
	}

	/**
	 * Returns (or lazily creates) the vault session entry.
	 * The vault entry uses the vault path and name from config.
	 * Calling vaultEntry() multiple times returns the same entry
	 * until it is explicitly closed.
	 */
	vaultEntry(): PoolEntry {
		if (this._vaultSessionId !== null) {
			const existing = this.entries.get(this._vaultSessionId);
			if (existing) return existing;
			// Session was closed externally — recreate
			this._vaultSessionId = null;
		}
		const vaultCwd = this.config.vault.path;
		const vaultName = this.config.vault.name ?? "Vault";
		const entry = this.create(vaultCwd, vaultName);
		this._vaultSessionId = entry.sessionId;
		return entry;
	}

	/** Returns the UUID of the vault singleton entry, creating it if needed. */
	vaultSessionId(): string {
		return this.vaultEntry().sessionId;
	}

	/**
	 * Returns true if the given session ID is the current vault singleton.
	 * Unlike vaultSessionId(), this never creates the vault session as a side effect.
	 */
	isVaultSession(id: string): boolean {
		return this._vaultSessionId === id;
	}

	/**
	 * Returns a status snapshot for every live session in the pool.
	 * Used for the `sessions_status` WS broadcast and the LEDGER ACTIVE tab.
	 */
	getSessionsStatus(): SessionStatusEntry[] {
		const statuses: SessionStatusEntry[] = [];
		for (const entry of this.entries.values()) {
			const { state, model, effort, permission_mode } =
				entry.manager.getStatus();
			const pendingPerms = entry.manager.getPendingPermissionRequests();
			const pendingQuestions = entry.manager.getPendingAskUserQuestions();
			const pendingPlans = entry.manager.getPendingPlanModeExits();
			const sessionLabel = entry.manager.getSessionLabel();
			statuses.push({
				session_id: entry.sessionId,
				agent_cwd: entry.agentCwd,
				agent_name: entry.agentName,
				state,
				model,
				effort,
				permission_mode,
				hasPendingPermissions:
					pendingPerms.length > 0 ||
					pendingQuestions.length > 0 ||
					pendingPlans.length > 0,
				hasDbSession: entry.manager.getCurrentSessionId() !== null,
				db_session_id: entry.manager.getCurrentSessionId(),
				...(sessionLabel !== null ? { lastLabel: sessionLabel } : {}),
			});
		}
		return statuses;
	}

	/** Iterate all live pool entries. */
	getAllEntries(): IterableIterator<PoolEntry> {
		return this.entries.values();
	}

	/** Number of live sessions currently in the pool. */
	getSize(): number {
		return this.entries.size;
	}

	/**
	 * Find a pool entry by its DB session ID (the persistent UUID stored in the
	 * sessions table). Returns the first entry whose manager.getCurrentSessionId()
	 * matches, or undefined if none is found.
	 */
	findByDbSessionId(dbSessionId: string): PoolEntry | undefined {
		for (const entry of this.entries.values()) {
			if (entry.manager.getCurrentSessionId() === dbSessionId) {
				return entry;
			}
		}
		return undefined;
	}

	/** Update the config reference (called on hot-reload). */
	syncConfig(config: HlidConfig): void {
		this.config = config;
	}
}
