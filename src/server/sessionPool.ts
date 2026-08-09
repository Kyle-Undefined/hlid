/**
 * SessionPool — manages multiple concurrent SessionManager instances.
 *
 * Pool key = sessionId (UUID). Same agentCwd can have multiple simultaneous
 * entries. Sessions are created lazily on first use and torn down explicitly
 * via close() or closeAll().
 */
import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import type { HlidConfig } from "../config";
import * as db from "../db";
import {
	type DelegatedLifecycleCounts,
	withDelegatedAttentionRollups,
} from "../lib/delegationAttention";
import { expandTilde, samePath } from "../lib/paths";
import { deriveSessionAttention } from "../lib/sessionAttention";
import type { AgentProvider } from "./agentProvider";
import type { SessionAttentionSnapshot, SessionStatusEntry } from "./protocol";
import { SessionRunState } from "./runState";
import { SessionManager } from "./session";

export interface PoolEntry {
	sessionId: string;
	agentCwd: string;
	agentName: string;
	/**
	 * DB chat reserved for this process before SessionManager finishes loading it.
	 * This closes the window where a second prompt can create another manager for
	 * the same persisted chat.
	 */
	claimedDbSessionId?: string | null;
	manager: SessionManager;
	runState: SessionRunState;
}

const DEFAULT_MAX_SIZE = 20;

export class SessionPool {
	private entries: Map<string, PoolEntry> = new Map();
	private config: HlidConfig;
	private providers: Map<string, AgentProvider>;
	private maxSize: number;
	private attentionBySession = new Map<string, SessionAttentionSnapshot>();
	private durableDelegationAttention: SessionStatusEntry[] = [];
	private durableDelegationLineage = new Map<string, string>();
	private durableDelegationLifecycle = new Map<
		string,
		DelegatedLifecycleCounts
	>();
	private durableDelegationRefreshGeneration = 0;
	private detachedPermissionConfigGeneration = 0;
	private detachedPermissionConfigFingerprint: string;
	private statusChangeHandler: (() => void) | null = null;
	private draining = false;
	private drainPromise: Promise<void> | null = null;
	/** Session ID of the vault's lazy singleton entry, or null if not yet created. */
	private _vaultSessionId: string | null = null;

	constructor(
		config: HlidConfig,
		providers: Map<string, AgentProvider>,
		maxSize = DEFAULT_MAX_SIZE,
	) {
		this.config = config;
		this.detachedPermissionConfigFingerprint = JSON.stringify(config);
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
	create(
		agentCwd: string,
		agentName: string,
		useAgentDefaults = true,
	): PoolEntry {
		if (this.draining) {
			throw new Error("Session pool is draining provider processes.");
		}
		if (this.entries.size >= this.maxSize) {
			throw new Error(
				`Session pool at capacity (${this.maxSize}). Close a session before creating a new one.`,
			);
		}

		const sessionId = randomUUID();
		const manager = new SessionManager(
			this.config,
			this.providers,
			useAgentDefaults ? agentCwd : undefined,
		);
		const runState = new SessionRunState(sessionId);
		const entry: PoolEntry = {
			sessionId,
			agentCwd,
			agentName,
			claimedDbSessionId: null,
			manager,
			runState,
		};
		this.entries.set(sessionId, entry);
		manager.setBackgroundActivityChangeHandler(() => {
			this.statusChangeHandler?.();
		});
		return entry;
	}

	/** Notify the host when provider work changes outside a visible chat turn. */
	setStatusChangeHandler(handler: (() => void) | null): void {
		this.statusChangeHandler = handler;
	}

	/** Look up a live session entry by its UUID. Returns undefined if not found. */
	get(sessionId: string): PoolEntry | undefined {
		return this.entries.get(sessionId);
	}

	/** Look up a registered provider by id (e.g. "claude"). Returns undefined if not registered. */
	getProvider(providerId: string): AgentProvider | undefined {
		return this.providers.get(providerId);
	}

	/** Validate an archived Raven selection without reviving a provider session. */
	// fallow-ignore-next-line unused-class-member -- Called by detached WebSocket controls in wsHandlers.
	async validateDetachedPermissionMode(options: {
		agentCwd: string | null;
		providerId?: string | null;
		model?: string | null;
		mode: string;
	}): Promise<number> {
		const configGeneration = this.detachedPermissionConfigGeneration;
		const manager = new SessionManager(
			this.config,
			this.providers,
			options.agentCwd ?? undefined,
		);
		await manager.validatePermissionMode(
			options.mode,
			options.providerId ?? manager.getProviderId(),
			options.model ?? undefined,
			options.mode === "auto",
		);
		if (configGeneration !== this.detachedPermissionConfigGeneration) {
			throw new Error(
				"Permission settings changed while the selection was checked",
			);
		}
		return configGeneration;
	}

	/** Guard an archived-chat write against policy/config drift after validation. */
	// fallow-ignore-next-line unused-class-member -- Called by detached WebSocket persistence guards in wsHandlers.
	isDetachedPermissionValidationCurrent(generation: number): boolean {
		return generation === this.detachedPermissionConfigGeneration;
	}

	// fallow-ignore-next-line unused-class-member -- Captured by detached WebSocket controls before validation.
	getDetachedPermissionValidationGeneration(): number {
		return this.detachedPermissionConfigGeneration;
	}

	/**
	 * Resolve an orchestration cwd only when it is the configured vault or one
	 * exact registered agent workspace. Returning the canonical path prevents
	 * aliases and symlinks from bypassing the live workspace catalog.
	 */
	resolveDelegationWorkspace(candidate: string): string | null {
		let resolvedCandidate: string;
		try {
			resolvedCandidate = realpathSync(resolve(expandTilde(candidate)));
		} catch {
			return null;
		}
		const configured = [
			this.config.vault.path,
			...(this.config.agents ?? []).map((agent) => agent.path),
		].filter((path) => path.trim().length > 0);
		for (const path of configured) {
			try {
				const resolvedConfigured = realpathSync(resolve(expandTilde(path)));
				if (samePath(resolvedConfigured, resolvedCandidate)) {
					return resolvedConfigured;
				}
			} catch {
				// Missing configured paths are unavailable until a config refresh.
			}
		}
		return null;
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
		entry.manager.setBackgroundActivityChangeHandler(null);
		this.entries.delete(sessionId);
		this.attentionBySession.delete(sessionId);
		if (this._vaultSessionId === sessionId) {
			this._vaultSessionId = null;
		}
	}

	/**
	 * Suspend and remove all sessions for process shutdown. Provider work is
	 * stopped while durable pre-dispatch turns remain available after restart.
	 */
	// fallow-ignore-next-line unused-class-member -- Retained as the synchronous pool lifecycle API for non-process-owning callers.
	closeAll(): void {
		for (const entry of this.entries.values()) {
			entry.manager.suspendForRestart();
			entry.manager.setBackgroundActivityChangeHandler(null);
		}
		this.entries.clear();
		this.attentionBySession.clear();
		this._vaultSessionId = null;
	}

	/** Shutdown variant that waits for provider-owned process trees to exit. */
	closeAllAndWait(): Promise<void> {
		if (this.drainPromise) return this.drainPromise;
		this.draining = true;
		const entries = [...this.entries.values()];
		this.entries.clear();
		this.attentionBySession.clear();
		this._vaultSessionId = null;
		for (const entry of entries) {
			entry.manager.setBackgroundActivityChangeHandler(null);
		}
		const pending = Promise.all(
			entries.map((entry) => entry.manager.suspendForRestartAndWait()),
		)
			.then(() => undefined)
			.finally(() => {
				if (this.drainPromise === pending) {
					this.drainPromise = null;
					this.draining = false;
				}
			});
		this.drainPromise = pending;
		return pending;
	}

	/** Recreate every durable pre-dispatch Raven queue after process startup. */
	async restoreDurableTurns(
		onStatusChange?: () => void,
	): Promise<{ restored: number; discarded: number }> {
		const discarded = await db.discardDispatchingSessionTurnsAfterRestart();
		const rows = await db.listRecoverablePendingSessionTurns();
		const bySession = new Map<string, db.PendingSessionTurnRow[]>();
		for (const row of rows) {
			const grouped = bySession.get(row.session_id) ?? [];
			grouped.push(row);
			bySession.set(row.session_id, grouped);
		}
		let restored = 0;
		for (const [sessionId, turns] of bySession) {
			const session = await db.getSessionById(sessionId);
			if (!session || session.archived_at != null) continue;
			let entry: PoolEntry;
			try {
				const cwd = session.agent_cwd ?? this.config.vault.path;
				const created = this.create(cwd, session.label ?? "Restored session");
				entry = this.claimDbSessionId(created, sessionId);
				if (entry !== created) this.close(created.sessionId);
			} catch (error) {
				console.warn(
					`[sessionPool] could not restore durable queue for ${sessionId}:`,
					error,
				);
				continue;
			}
			const count = entry.manager.restoreDurableTurns(turns, (message) => {
				entry.runState.broadcast(message);
				onStatusChange?.();
			});
			restored += count;
			if (count === 0) this.close(entry.sessionId);
		}
		return { restored, discarded };
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
		const entry = this.create(vaultCwd, vaultName, false);
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
			const { state, model, effort, permission_mode, approvals_reviewer } =
				entry.manager.getStatus();
			const currentDbSessionId = entry.manager.getCurrentSessionId();
			if (currentDbSessionId) {
				entry.claimedDbSessionId = currentDbSessionId;
			}
			const dbSessionId =
				currentDbSessionId ?? entry.claimedDbSessionId ?? null;
			const pendingPerms = entry.manager.getPendingPermissionRequests();
			const pendingQuestions = entry.manager.getPendingAskUserQuestions();
			const pendingPlans = entry.manager.getPendingPlanModeExits();
			const queueCount = entry.manager.getQueueState().pending_turn_ids.length;
			const sleepState = entry.manager.getSleepState();
			const sessionLabel = entry.manager.getSessionLabel();
			const presentation = entry.manager.getSessionPresentation();
			const backgroundActivities = entry.manager.getBackgroundActivities();
			const attention = deriveSessionAttention(
				{
					state,
					permissionCount: pendingPerms.length,
					questionCount: pendingQuestions.length,
					planReviewCount: pendingPlans.length,
					queueCount,
					goalStatus: entry.manager.getCurrentGoal()?.status,
					routine: entry.manager.getActiveRoutine() !== null,
					sleepState,
					backgroundRunningCount: backgroundActivities.filter(
						(activity) => activity.status === "running",
					).length,
					backgroundFailedCount: backgroundActivities.filter(
						(activity) => activity.status === "failed",
					).length,
					backgroundCompletedCount: backgroundActivities.filter(
						(activity) => activity.status === "completed",
					).length,
				},
				this.attentionBySession.get(entry.sessionId),
			);
			this.attentionBySession.set(entry.sessionId, attention);
			statuses.push({
				session_id: entry.sessionId,
				agent_cwd: entry.agentCwd,
				agent_name: entry.agentName,
				state,
				provider_id: entry.manager.getProviderId(),
				model,
				effort,
				permission_mode,
				...(approvals_reviewer ? { approvals_reviewer } : {}),
				...(backgroundActivities.length > 0
					? { background_activities: backgroundActivities }
					: {}),
				hasPendingPermissions:
					pendingPerms.length > 0 ||
					pendingQuestions.length > 0 ||
					pendingPlans.length > 0,
				attention,
				hasDbSession: dbSessionId !== null,
				db_session_id: dbSessionId,
				...(sessionLabel !== null ? { lastLabel: sessionLabel } : {}),
				pinned: presentation.pinned,
				fork_parent_session_id: presentation.forkParentSessionId,
				fork_parent_label: presentation.forkParentLabel,
				fork_kind: presentation.forkKind,
				delegation_parent_session_id: presentation.delegationParentSessionId,
				delegation_parent_label: presentation.delegationParentLabel,
				delegation_parent_turn_id: presentation.delegationParentTurnId,
				delegation_depth: presentation.delegationDepth,
			});
		}
		const liveDbSessionIds = new Set(
			statuses
				.map((status) => status.db_session_id)
				.filter((id): id is string => id !== null),
		);
		for (const durable of this.durableDelegationAttention) {
			if (!liveDbSessionIds.has(durable.db_session_id ?? "")) {
				statuses.push(durable);
			}
		}
		return withDelegatedAttentionRollups(
			statuses,
			this.durableDelegationLineage,
			this.durableDelegationLifecycle,
		);
	}

	/**
	 * Project restart-interrupted children into the shared attention feed without
	 * starting provider processes. A newer refresh always wins if DB reads overlap.
	 */
	async refreshDurableDelegationAttention(): Promise<void> {
		const generation = ++this.durableDelegationRefreshGeneration;
		const [delegations, lifecycle] = await Promise.all([
			db.listResumableInterruptedHlidDelegations(),
			db.listHlidDelegationLifecycleRollups(),
		]);
		const lineageSessionIds = new Set(
			delegations.map((delegation) => delegation.child_session_id),
		);
		for (const entry of this.entries.values()) {
			const currentDbSessionId = entry.manager.getCurrentSessionId();
			if (currentDbSessionId) {
				entry.claimedDbSessionId = currentDbSessionId;
			}
			const dbSessionId =
				currentDbSessionId ?? entry.claimedDbSessionId ?? null;
			if (dbSessionId) {
				lineageSessionIds.add(dbSessionId);
			}
		}
		const lineage = await db.listHlidDelegationAncestorLineage([
			...lineageSessionIds,
		]);
		const projected: Array<SessionStatusEntry | null> = await Promise.all(
			delegations.map(async (delegation) => {
				const session = await db.getSessionById(delegation.child_session_id);
				if (!session || session.archived_at !== null) return null;
				const timestamp = delegation.updated_at * 1_000;
				return {
					session_id: delegation.child_session_id,
					agent_cwd: session.agent_cwd ?? this.config.vault.path,
					agent_name: `${delegation.provider_id} delegate`,
					state: "idle" as const,
					provider_id: delegation.provider_id,
					model: delegation.model ?? "",
					...(delegation.effort ? { effort: delegation.effort } : {}),
					permission_mode: delegation.permission_mode,
					hasPendingPermissions: false,
					attention: {
						bucket: "needs_attention" as const,
						reason: "delegation_interrupted" as const,
						since: timestamp,
						last_activity_at: timestamp,
						queue_count: 0,
						pending_count: 0,
					},
					hasDbSession: true,
					db_session_id: delegation.child_session_id,
					lastLabel: session.label ?? delegation.task,
					pinned: session.pinned === 1,
					delegation_parent_session_id: delegation.parent_session_id,
					delegation_parent_label: delegation.parent_label,
					delegation_parent_turn_id: delegation.parent_turn_id,
					delegation_depth: delegation.depth,
					delegation_id: delegation.id,
					delegation_status: "interrupted" as const,
					delegation_resumable: true,
					durable_only: true,
				} satisfies SessionStatusEntry;
			}),
		);
		if (generation === this.durableDelegationRefreshGeneration) {
			this.durableDelegationAttention = projected.filter(
				(status): status is SessionStatusEntry => status !== null,
			);
			this.durableDelegationLineage = new Map(
				lineage.map((row) => [row.child_session_id, row.parent_session_id]),
			);
			this.durableDelegationLifecycle = new Map(
				lifecycle.map((rollup) => [rollup.parent_session_id, rollup]),
			);
		}
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
			const currentDbSessionId = entry.manager.getCurrentSessionId();
			if (!currentDbSessionId) continue;
			entry.claimedDbSessionId = currentDbSessionId;
			if (currentDbSessionId === dbSessionId) return entry;
		}
		for (const entry of this.entries.values()) {
			if (entry.claimedDbSessionId === dbSessionId) return entry;
		}
		return undefined;
	}

	/**
	 * Reserve a persisted chat for a newly created pool entry before its async
	 * SessionManager initialization begins. Returns the existing owner if another
	 * request already reserved or loaded the same chat.
	 */
	claimDbSessionId(entry: PoolEntry, dbSessionId: string): PoolEntry {
		const existing = this.findByDbSessionId(dbSessionId);
		if (existing) return existing;
		entry.claimedDbSessionId = dbSessionId;
		return entry;
	}

	/** Update future and already-open sessions during hot reload. */
	syncConfig(config: HlidConfig): void {
		const nextFingerprint = JSON.stringify(config);
		if (nextFingerprint !== this.detachedPermissionConfigFingerprint) {
			this.detachedPermissionConfigGeneration += 1;
			this.detachedPermissionConfigFingerprint = nextFingerprint;
		}
		this.config = config;
		for (const entry of this.entries.values()) {
			entry.manager.syncConfig(config);
		}
	}

	/** Retire live provider-native sessions after a runtime provider is removed. */
	retireProviderSessions(providerIds: Iterable<string>): void {
		const retired = new Set(providerIds);
		if (retired.size === 0) return;
		for (const entry of this.entries.values()) {
			entry.manager.retireProviderSessions(retired);
		}
	}
}
