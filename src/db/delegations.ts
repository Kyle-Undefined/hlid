import type {
	HlidDelegationContinuationMode,
	HlidDelegationHandoffSummary,
	HlidDelegationSnapshot,
	HlidDelegationStatus,
} from "../lib/hlidDelegation";
import {
	HLID_DELEGATION_MAX_ATTEMPTS,
	HLID_DELEGATION_MAX_ERROR_CHARS,
	HLID_DELEGATION_MAX_PROGRESS_CHARS,
	HLID_DELEGATION_MAX_RESULT_CHARS,
	HLID_DELEGATION_MAX_TASK_PREVIEW_CHARS,
	isResumableHlidDelegation,
	isTerminalHlidDelegationStatus,
} from "../lib/hlidDelegation";
import { getDb } from "./schema";

type HlidDelegationRow = Omit<
	HlidDelegationSnapshot,
	"open_url" | "complete" | "resumable" | "handoff"
> & {
	handoff_json: string;
	child_resumable: number;
};

const EMPTY_HANDOFF: HlidDelegationHandoffSummary = {
	visible_transcript_chars: 0,
	selected_skills: 0,
	selected_relics: 0,
	vault_references: 0,
	workspace_references: 0,
};

const DELEGATION_SELECT = `
	SELECT id, parent_session_id, parent_turn_id, parent_label,
	       parent_delegation_id, routine_run_id, child_session_id, depth, task,
	       target_provider_id AS provider_id,
	       selected_model AS model, selected_effort AS effort,
	       selected_service_tier AS service_tier,
	       selected_workspace AS workspace,
	       workspace_mode, execution_workspace, worktree_branch,
	       worktree_base_commit, worktree_state,
	       selected_permission_mode AS permission_mode,
		       timeout_seconds, token_budget, tokens_used,
		       cost_budget, cost_used, attempt_count,
		       continuation_mode, handoff_json, status, started_at, updated_at,
		       ended_at, result_text, error, progress_text,
		       CASE WHEN EXISTS (
		         SELECT 1
		         FROM sessions child
		         WHERE child.id = session_delegations.child_session_id
		           AND child.archived_at IS NULL
		       ) THEN 1 ELSE 0 END AS child_resumable
	FROM session_delegations`;

function bounded(
	value: string | null | undefined,
	maxChars: number,
): string | null {
	if (!value) return null;
	return value.length <= maxChars ? value : `${value.slice(0, maxChars - 1)}…`;
}

function nonNegativeInteger(value: unknown): number {
	return typeof value === "number" && Number.isInteger(value) && value >= 0
		? value
		: 0;
}

function parseHandoff(raw: string): HlidDelegationHandoffSummary {
	try {
		const value = JSON.parse(raw) as Partial<HlidDelegationHandoffSummary>;
		return {
			visible_transcript_chars: nonNegativeInteger(
				value.visible_transcript_chars,
			),
			selected_skills: nonNegativeInteger(value.selected_skills),
			selected_relics: nonNegativeInteger(value.selected_relics),
			vault_references: nonNegativeInteger(value.vault_references),
			workspace_references: nonNegativeInteger(value.workspace_references),
		};
	} catch {
		return { ...EMPTY_HANDOFF };
	}
}

function snapshot(row: HlidDelegationRow): HlidDelegationSnapshot {
	const {
		handoff_json: handoffJson,
		child_resumable: childResumable,
		...persisted
	} = row;
	return {
		...persisted,
		task: bounded(row.task, HLID_DELEGATION_MAX_TASK_PREVIEW_CHARS) ?? row.task,
		result_text: bounded(row.result_text, HLID_DELEGATION_MAX_RESULT_CHARS),
		error: bounded(row.error, HLID_DELEGATION_MAX_ERROR_CHARS),
		progress_text: bounded(
			row.progress_text,
			HLID_DELEGATION_MAX_PROGRESS_CHARS,
		),
		handoff: parseHandoff(handoffJson),
		open_url: `/raven?session=${encodeURIComponent(row.child_session_id)}`,
		complete: isTerminalHlidDelegationStatus(row.status),
		resumable:
			childResumable === 1 &&
			row.routine_run_id === null &&
			isResumableHlidDelegation(row.status, row.attempt_count),
	};
}

export async function createHlidDelegation(input: {
	id: string;
	parentSessionId: string;
	parentTurnId: string | null;
	parentLabel: string | null;
	parentDelegationId?: string | null;
	routineRunId?: string | null;
	childSessionId: string;
	depth: number;
	task: string;
	providerId: string;
	model: string | null;
	effort: string | null;
	serviceTier: string | null;
	workspace: string;
	workspaceMode?: "shared" | "worktree";
	executionWorkspace?: string;
	worktreeBranch?: string | null;
	worktreeBaseCommit?: string | null;
	worktreeState?: "none" | "active" | "retained" | "cleaned";
	permissionMode: string;
	timeoutSeconds: number;
	handoff?: HlidDelegationHandoffSummary;
}): Promise<HlidDelegationSnapshot> {
	const db = await getDb();
	db.run(
		`INSERT INTO session_delegations
		 (id, parent_session_id, parent_turn_id, parent_label,
		  parent_delegation_id, routine_run_id, child_session_id, depth, task,
		  target_provider_id, selected_model, selected_effort,
		  selected_service_tier, selected_workspace, workspace_mode,
		  execution_workspace, worktree_branch, worktree_base_commit,
		  worktree_state,
		  selected_permission_mode, timeout_seconds, token_budget, cost_budget,
		  handoff_json, status, started_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, 'pending',
		         unixepoch(), unixepoch())`,
		[
			input.id,
			input.parentSessionId,
			input.parentTurnId,
			input.parentLabel,
			input.parentDelegationId ?? null,
			input.routineRunId ?? null,
			input.childSessionId,
			input.depth,
			input.task,
			input.providerId,
			input.model,
			input.effort,
			input.serviceTier,
			input.workspace,
			input.workspaceMode ?? "shared",
			input.executionWorkspace ?? input.workspace,
			input.worktreeBranch ?? null,
			input.worktreeBaseCommit ?? null,
			input.worktreeState ?? "none",
			input.permissionMode,
			input.timeoutSeconds,
			JSON.stringify(input.handoff ?? EMPTY_HANDOFF),
		],
	);
	const created = await getHlidDelegation(input.id);
	if (!created) throw new Error("Failed to persist delegated child session");
	return created;
}

export async function getHlidDelegation(
	id: string,
): Promise<HlidDelegationSnapshot | null> {
	const db = await getDb();
	const row = db
		.query<HlidDelegationRow, [string]>(
			`${DELEGATION_SELECT}
			 WHERE id = ?`,
		)
		.get(id);
	return row ? snapshot(row) : null;
}

export async function listHlidDelegationsForParent(
	parentSessionId: string,
	limit = 50,
): Promise<HlidDelegationSnapshot[]> {
	const db = await getDb();
	return db
		.query<HlidDelegationRow, [string, number]>(
			`${DELEGATION_SELECT}
			 WHERE parent_session_id = ?
			 ORDER BY started_at DESC, id DESC
			 LIMIT ?`,
		)
		.all(parentSessionId, Math.max(1, Math.min(100, limit)))
		.map(snapshot);
}

export async function listHlidDelegationsForRoutineRun(
	routineRunId: string,
): Promise<HlidDelegationSnapshot[]> {
	const db = await getDb();
	return db
		.query<HlidDelegationRow, [string]>(
			`${DELEGATION_SELECT}
			 WHERE routine_run_id = ?
			 ORDER BY depth, started_at, id`,
		)
		.all(routineRunId)
		.map(snapshot);
}

export async function listHlidDelegationsByParentDelegation(
	parentDelegationId: string,
): Promise<HlidDelegationSnapshot[]> {
	const db = await getDb();
	return db
		.query<HlidDelegationRow, [string]>(
			`${DELEGATION_SELECT}
			 WHERE parent_delegation_id = ?
			 ORDER BY depth DESC, started_at DESC, id DESC`,
		)
		.all(parentDelegationId)
		.map(snapshot);
}

export async function listResumableInterruptedHlidDelegations(): Promise<
	HlidDelegationSnapshot[]
> {
	const db = await getDb();
	return db
		.query<HlidDelegationRow, [number]>(
			`${DELEGATION_SELECT}
			 WHERE status = 'interrupted'
			   AND routine_run_id IS NULL
			   AND attempt_count < ?
			   AND child_session_id IN (
			     SELECT id FROM sessions WHERE archived_at IS NULL
			   )
			 ORDER BY updated_at DESC, id DESC`,
		)
		.all(HLID_DELEGATION_MAX_ATTEMPTS)
		.map(snapshot);
}

export type HlidDelegationLineage = {
	child_session_id: string;
	parent_session_id: string;
};

export type HlidDelegationLifecycleRollup = {
	parent_session_id: string;
	direct_count: number;
	descendant_count: number;
	waiting_count: number;
	completed_count: number;
	failed_count: number;
	total_tokens: number;
	total_cost: number;
	elapsed_duration_seconds: number;
	last_activity_at: number;
};

/**
 * Aggregate durable descendant lifecycle without projecting every closed child
 * into the live-session payload. Explicit roots are deduplicated and bounded;
 * no roots returns one fixed-size aggregate for every durable parent session.
 */
export async function listHlidDelegationLifecycleRollups(
	rootSessionIds: readonly string[] = [],
): Promise<HlidDelegationLifecycleRollup[]> {
	const roots = [...new Set(rootSessionIds.filter(Boolean))].slice(0, 100);
	const db = await getDb();
	const rootsSql =
		roots.length > 0
			? `VALUES ${roots.map(() => "(?)").join(", ")}`
			: "SELECT DISTINCT parent_session_id FROM session_delegations";
	return db
		.query<HlidDelegationLifecycleRollup, string[]>(`
			WITH RECURSIVE
			roots(parent_session_id) AS (
				${rootsSql}
			),
			descendants(
				root_session_id, id, status, attempt_count, routine_run_id,
				child_resumable, tokens_used, cost_used, started_at, updated_at,
				ended_at, direct, path
			) AS (
				SELECT roots.parent_session_id, child.id, child.status,
				       child.attempt_count, child.routine_run_id,
				       CASE WHEN EXISTS (
				         SELECT 1 FROM sessions session
				         WHERE session.id = child.child_session_id
				           AND session.archived_at IS NULL
				       ) THEN 1 ELSE 0 END,
				       child.tokens_used, child.cost_used, child.started_at,
				       child.updated_at, child.ended_at, 1,
				       ',' || child.id || ','
				FROM roots
				JOIN session_delegations child
				  ON child.parent_session_id = roots.parent_session_id
				UNION ALL
				SELECT parent.root_session_id, child.id, child.status,
				       child.attempt_count, child.routine_run_id,
				       CASE WHEN EXISTS (
				         SELECT 1 FROM sessions session
				         WHERE session.id = child.child_session_id
				           AND session.archived_at IS NULL
				       ) THEN 1 ELSE 0 END,
				       child.tokens_used, child.cost_used, child.started_at,
				       child.updated_at, child.ended_at, 0,
				       parent.path || child.id || ','
				FROM descendants parent
				JOIN session_delegations child
				  ON child.parent_delegation_id = parent.id
				WHERE instr(parent.path, ',' || child.id || ',') = 0
			)
			SELECT root_session_id AS parent_session_id,
			       SUM(direct) AS direct_count,
			       COUNT(*) AS descendant_count,
			       SUM(CASE
			             WHEN status = 'pending' THEN 1
			             WHEN status = 'interrupted'
			              AND routine_run_id IS NULL
			              AND attempt_count < ${HLID_DELEGATION_MAX_ATTEMPTS}
			              AND child_resumable = 1 THEN 1
			             ELSE 0
			           END) AS waiting_count,
			       SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END)
			         AS completed_count,
			       SUM(CASE
			             WHEN status IN ('failed', 'timed_out', 'budget_exhausted')
			               THEN 1
			             WHEN status = 'interrupted'
			              AND (
			                routine_run_id IS NOT NULL
			                OR attempt_count >= ${HLID_DELEGATION_MAX_ATTEMPTS}
			                OR child_resumable = 0
			              ) THEN 1
			             ELSE 0
			           END) AS failed_count,
			       SUM(tokens_used) AS total_tokens,
			       SUM(cost_used) AS total_cost,
			       MAX(
			         0,
			         CASE
			           WHEN SUM(CASE
			             WHEN status IN ('pending', 'running') THEN 1
			             ELSE 0
			           END) > 0 THEN unixepoch()
			           ELSE MAX(COALESCE(ended_at, updated_at))
			         END - MIN(started_at)
			       ) AS elapsed_duration_seconds,
			       MAX(updated_at) * 1000 AS last_activity_at
			FROM descendants
			GROUP BY root_session_id
		`)
		.all(...roots);
}

/**
 * Load only the persisted ancestor chain needed to roll durable child
 * attention through delegated sessions that do not have a live process.
 */
export async function listHlidDelegationAncestorLineage(
	childSessionIds: readonly string[],
): Promise<HlidDelegationLineage[]> {
	const uniqueIds = [...new Set(childSessionIds)];
	if (uniqueIds.length === 0) return [];
	const db = await getDb();
	const placeholders = uniqueIds.map(() => "?").join(", ");
	return db
		.query<HlidDelegationLineage, string[]>(`
			WITH RECURSIVE lineage(
				id, child_session_id, parent_session_id, parent_delegation_id
			) AS (
				SELECT id, child_session_id, parent_session_id, parent_delegation_id
				FROM session_delegations
				WHERE child_session_id IN (${placeholders})
				UNION
				SELECT parent.id, parent.child_session_id, parent.parent_session_id,
				       parent.parent_delegation_id
				FROM session_delegations parent
				JOIN lineage child
				  ON parent.id = child.parent_delegation_id
			)
			SELECT DISTINCT child_session_id, parent_session_id
			FROM lineage
		`)
		.all(...uniqueIds);
}

export async function getHlidDelegationForParent(
	id: string,
	parentSessionId: string,
): Promise<HlidDelegationSnapshot | null> {
	const db = await getDb();
	const row = db
		.query<HlidDelegationRow, [string, string]>(
			`${DELEGATION_SELECT}
			 WHERE id = ? AND parent_session_id = ?`,
		)
		.get(id, parentSessionId);
	return row ? snapshot(row) : null;
}

export async function getHlidDelegationByChildSession(
	childSessionId: string,
): Promise<HlidDelegationSnapshot | null> {
	const db = await getDb();
	const row = db
		.query<HlidDelegationRow, [string]>(
			`${DELEGATION_SELECT}
			 WHERE child_session_id = ?`,
		)
		.get(childSessionId);
	return row ? snapshot(row) : null;
}

export async function listManagedDelegationWorkspaces(): Promise<
	Array<{
		delegation_id: string;
		source_workspace: string;
		execution_workspace: string;
		state: "active" | "retained";
	}>
> {
	const db = await getDb();
	return db
		.query<
			{
				delegation_id: string;
				source_workspace: string;
				execution_workspace: string;
				state: "active" | "retained";
			},
			[]
		>(
			`SELECT id AS delegation_id, selected_workspace AS source_workspace,
			        execution_workspace, worktree_state AS state
			 FROM session_delegations
			 WHERE workspace_mode = 'worktree'
			   AND worktree_state IN ('active', 'retained')
			   AND execution_workspace <> ''`,
		)
		.all();
}

export async function updateHlidDelegationWorktreeState(
	id: string,
	state: "active" | "retained" | "cleaned",
): Promise<HlidDelegationSnapshot | null> {
	const db = await getDb();
	db.run(
		`UPDATE session_delegations
		 SET worktree_state = ?, updated_at = unixepoch()
		 WHERE id = ? AND workspace_mode = 'worktree'`,
		[state, id],
	);
	return getHlidDelegation(id);
}

export async function markHlidDelegationRunning(
	id: string,
): Promise<HlidDelegationSnapshot | null> {
	const db = await getDb();
	let claimed = false;
	db.transaction(() => {
		const result = db.run(
			`UPDATE session_delegations
			 SET status = 'running', updated_at = unixepoch()
			 WHERE id = ?
			   AND status = 'pending'
			   AND EXISTS (
			     SELECT 1
			     FROM sessions child
			     WHERE child.id = session_delegations.child_session_id
			       AND child.archived_at IS NULL
			   )`,
			[id],
		);
		claimed = result.changes > 0;
		if (!claimed) {
			db.run(
				`UPDATE session_delegations
				 SET status = 'cancelled', ended_at = unixepoch(),
				     updated_at = unixepoch(),
				     error = 'The delegated child was removed or archived before it could start.',
				     worktree_state = CASE
				       WHEN worktree_state = 'active' THEN 'retained'
				       ELSE worktree_state
				     END
				 WHERE id = ?
				   AND status = 'pending'
				   AND NOT EXISTS (
				     SELECT 1
				     FROM sessions child
				     WHERE child.id = session_delegations.child_session_id
				       AND child.archived_at IS NULL
				   )`,
				[id],
			);
		}
	})();
	return claimed ? getHlidDelegation(id) : null;
}

export async function updateHlidDelegationTokens(
	id: string,
	tokensUsed: number,
): Promise<HlidDelegationSnapshot | null> {
	const db = await getDb();
	db.run(
		`UPDATE session_delegations
		 SET tokens_used = MAX(tokens_used, ?), updated_at = unixepoch()
		 WHERE id = ?`,
		[Math.max(0, Math.trunc(tokensUsed)), id],
	);
	return getHlidDelegation(id);
}

export async function updateHlidDelegationCost(
	id: string,
	costUsed: number,
): Promise<HlidDelegationSnapshot | null> {
	const db = await getDb();
	const safeCost = Number.isFinite(costUsed) && costUsed >= 0 ? costUsed : 0;
	db.run(
		`UPDATE session_delegations
		 SET cost_used = MAX(cost_used, ?), updated_at = unixepoch()
		 WHERE id = ?`,
		[safeCost, id],
	);
	return getHlidDelegation(id);
}

export async function updateHlidDelegationProgress(
	id: string,
	progressText: string | null,
): Promise<HlidDelegationSnapshot | null> {
	const db = await getDb();
	db.run(
		`UPDATE session_delegations
		 SET progress_text = ?, updated_at = unixepoch()
		 WHERE id = ? AND status IN ('pending', 'running')`,
		[bounded(progressText, HLID_DELEGATION_MAX_PROGRESS_CHARS), id],
	);
	return getHlidDelegation(id);
}

export async function countActiveHlidDelegations(
	parentSessionId?: string,
): Promise<number> {
	const db = await getDb();
	if (parentSessionId) {
		return (
			db
				.query<{ count: number }, [string]>(
					`SELECT COUNT(*) AS count
					 FROM session_delegations
					 WHERE status IN ('pending', 'running')
					   AND parent_session_id = ?`,
				)
				.get(parentSessionId)?.count ?? 0
		);
	}
	return (
		db
			.query<{ count: number }, []>(
				`SELECT COUNT(*) AS count
				 FROM session_delegations
				 WHERE status IN ('pending', 'running')`,
			)
			.get()?.count ?? 0
	);
}

export async function resumeHlidDelegation(
	id: string,
	input: {
		continuationMode: Exclude<HlidDelegationContinuationMode, "initial">;
		timeoutSeconds: number;
		permissionMode: string;
		handoff: HlidDelegationHandoffSummary;
	},
): Promise<HlidDelegationSnapshot | null> {
	const db = await getDb();
	let result: { changes: number } = { changes: 0 };
	db.transaction(() => {
		result = db.run(
			`UPDATE session_delegations
			 SET status = 'pending', ended_at = NULL, result_text = NULL,
			     error = NULL, progress_text = NULL,
			     attempt_count = attempt_count + 1, continuation_mode = ?,
			     timeout_seconds = ?, token_budget = NULL, cost_budget = NULL,
			     selected_permission_mode = ?, handoff_json = ?,
			     updated_at = unixepoch()
			 WHERE id = ?
			   AND status = 'interrupted'
			   AND routine_run_id IS NULL
			   AND attempt_count < ?
			   AND EXISTS (
			     SELECT 1
			     FROM sessions child
			     WHERE child.id = session_delegations.child_session_id
			       AND child.archived_at IS NULL
			   )`,
			[
				input.continuationMode,
				input.timeoutSeconds,
				input.permissionMode,
				JSON.stringify(input.handoff),
				id,
				HLID_DELEGATION_MAX_ATTEMPTS,
			],
		);
		if (result.changes > 0) {
			db.run(
				`UPDATE sessions
				 SET provider_id = (
				       SELECT target_provider_id
				       FROM session_delegations
				       WHERE id = ?
				     ),
				     model = COALESCE((
				       SELECT selected_model
				       FROM session_delegations
				       WHERE id = ?
				     ), ''),
				     selected_model = COALESCE((
				       SELECT selected_model
				       FROM session_delegations
				       WHERE id = ?
				     ), ''),
				     selected_effort = (
				       SELECT selected_effort
				       FROM session_delegations
				       WHERE id = ?
				     ),
				     selected_permission_mode = ?
				 WHERE id = (
				   SELECT child_session_id
				   FROM session_delegations
				   WHERE id = ?
				 )`,
				[id, id, id, id, input.permissionMode, id],
			);
		}
	})();
	return result.changes > 0 ? getHlidDelegation(id) : null;
}

/**
 * Restore the exact interrupted attempt when its parent turn ends after the
 * continuation CAS but before the child provider can launch.
 */
export async function rollbackHlidDelegationResume(
	id: string,
	previous: HlidDelegationSnapshot,
): Promise<HlidDelegationSnapshot | null> {
	const db = await getDb();
	let result: { changes: number } = { changes: 0 };
	db.transaction(() => {
		result = db.run(
			`UPDATE session_delegations
			 SET status = 'interrupted', ended_at = ?, result_text = ?,
			     error = ?, progress_text = ?, attempt_count = ?,
			     continuation_mode = ?, timeout_seconds = ?, token_budget = ?,
			     cost_budget = ?, selected_permission_mode = ?, handoff_json = ?,
			     updated_at = unixepoch()
			 WHERE id = ?
			   AND status = 'pending'
			   AND attempt_count = ?`,
			[
				previous.ended_at,
				previous.result_text,
				previous.error,
				previous.progress_text,
				previous.attempt_count,
				previous.continuation_mode,
				previous.timeout_seconds,
				previous.token_budget,
				previous.cost_budget,
				previous.permission_mode,
				JSON.stringify(previous.handoff),
				id,
				previous.attempt_count + 1,
			],
		);
		if (result.changes > 0) {
			db.run(
				`UPDATE sessions
				 SET provider_id = ?, model = ?, selected_model = ?,
				     selected_effort = ?, selected_permission_mode = ?
				 WHERE id = ?`,
				[
					previous.provider_id,
					previous.model ?? "",
					previous.model ?? "",
					previous.effort,
					previous.permission_mode,
					previous.child_session_id,
				],
			);
		}
	})();
	return result.changes > 0 ? getHlidDelegation(id) : null;
}

/**
 * Remove delegation roots whose ordinary child session no longer exists, plus
 * every delegation descendant that would otherwise retain a dangling lineage.
 * Startup runs this before changing active lifecycle states.
 */
export async function reconcileOrphanedHlidDelegationsAfterRestart(): Promise<number> {
	const db = await getDb();
	const result = db.run(`
		WITH RECURSIVE orphaned(id) AS (
			SELECT delegation.id
			FROM session_delegations delegation
			WHERE NOT EXISTS (
				SELECT 1
				FROM sessions child
				WHERE child.id = delegation.child_session_id
			)
			UNION
			SELECT child.id
			FROM session_delegations child
			JOIN orphaned parent
			  ON child.parent_delegation_id = parent.id
		)
		DELETE FROM session_delegations
		WHERE id IN (SELECT id FROM orphaned)
	`);
	return result.changes;
}

export async function finishHlidDelegation(
	id: string,
	input: {
		status: Extract<
			HlidDelegationStatus,
			| "completed"
			| "failed"
			| "timed_out"
			| "interrupted"
			| "cancelled"
			| "budget_exhausted"
		>;
		resultText?: string | null;
		error?: string | null;
	},
): Promise<HlidDelegationSnapshot | null> {
	const db = await getDb();
	db.run(
		`UPDATE session_delegations
		 SET status = ?, ended_at = unixepoch(), updated_at = unixepoch(),
		     result_text = ?, error = ?, progress_text = NULL,
		     worktree_state = CASE
		       WHEN worktree_state = 'active' THEN 'retained'
		       ELSE worktree_state
		     END
		 WHERE id = ? AND status IN ('pending', 'running')`,
		[
			input.status,
			bounded(input.resultText, HLID_DELEGATION_MAX_RESULT_CHARS),
			bounded(input.error, HLID_DELEGATION_MAX_ERROR_CHARS),
			id,
		],
	);
	return getHlidDelegation(id);
}

/**
 * Explicitly abandon a restart-interrupted child that would otherwise remain
 * eligible for continuation. The child transcript and delegation provenance
 * stay durable; only the continuation claim is released.
 */
export async function abandonInterruptedHlidDelegation(
	id: string,
	error: string,
): Promise<HlidDelegationSnapshot | null> {
	const db = await getDb();
	db.run(
		`UPDATE session_delegations
		 SET status = 'cancelled', ended_at = unixepoch(),
		     updated_at = unixepoch(), error = ?, progress_text = NULL,
		     worktree_state = CASE
		       WHEN worktree_state = 'active' THEN 'retained'
		       ELSE worktree_state
		     END
		 WHERE id = ?
		   AND status = 'interrupted'
		   AND routine_run_id IS NULL
		   AND attempt_count < ?
		   AND EXISTS (
		     SELECT 1
		     FROM sessions child
		     WHERE child.id = session_delegations.child_session_id
		       AND child.archived_at IS NULL
		   )`,
		[
			bounded(error, HLID_DELEGATION_MAX_ERROR_CHARS),
			id,
			HLID_DELEGATION_MAX_ATTEMPTS,
		],
	);
	return getHlidDelegation(id);
}

export async function recordHlidDelegationPartialResult(
	id: string,
	resultText: string | null,
): Promise<HlidDelegationSnapshot | null> {
	const db = await getDb();
	const boundedResult = bounded(resultText, HLID_DELEGATION_MAX_RESULT_CHARS);
	if (!boundedResult) return getHlidDelegation(id);
	db.run(
		`UPDATE session_delegations
		 SET result_text = COALESCE(result_text, ?), updated_at = unixepoch()
		 WHERE id = ?
		   AND status IN (
		     'completed', 'failed', 'timed_out', 'interrupted',
		     'cancelled', 'budget_exhausted'
		   )`,
		[boundedResult, id],
	);
	return getHlidDelegation(id);
}

export async function interruptActiveHlidDelegationsAfterRestart(): Promise<number> {
	const db = await getDb();
	const result = db.run(
		`UPDATE session_delegations
		 SET status = 'interrupted', ended_at = unixepoch(),
		     updated_at = unixepoch(),
		     error = 'Hlid restarted before this delegated child finished.'
		 WHERE status IN ('pending', 'running')`,
	);
	return result.changes;
}
