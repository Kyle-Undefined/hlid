import { createHash, randomUUID } from "node:crypto";
import {
	type CanonicalRoutineCapability,
	grantsWithIds,
	ROUTINE_PERMISSION_MATCHER_VERSION,
	routineAuthorizationFingerprint,
} from "../lib/routinePermissions";
import { nextRoutineOccurrence } from "../lib/routineSchedule";
import {
	type RoutineDefinition,
	type RoutinePermissionGrantInput,
	type RoutineStatus,
	type RoutineSummary,
	routineDefinitionSchema,
} from "../lib/routines";
import { type Db, getDb } from "./schema";

type RoutineRow = {
	id: string;
	name: string;
	prompt: string;
	enabled: number;
	archived: number;
	revision: number;
	schedule_json: string;
	timezone: string;
	next_run_at: number | null;
	provider_id: string;
	model: string;
	effort: string;
	agent_cwd: string;
	agent_name: string;
	skill_contexts_json: string;
	provider_commands_json: string;
	vault_references_json: string;
	relic_ids_json: string;
	permission_mode: RoutineDefinition["permissionMode"];
	deliveries_json: string;
	catch_up_window_minutes: number;
	no_overlap: number;
	paused_reason: string | null;
	authorization_fingerprint: string;
	created_at: number;
	updated_at: number;
};

export type RoutineRunRow = {
	id: string;
	routine_id: string;
	routine_revision: number;
	profile_id: string | null;
	authorization_fingerprint: string;
	trigger: "scheduled" | "manual";
	scheduled_for: number;
	claimed_at: number | null;
	lease_owner: string | null;
	lease_expires_at: number | null;
	started_at: number | null;
	finished_at: number | null;
	status: RoutineStatus;
	session_id: string | null;
	provider_used: string | null;
	error: string | null;
	action_required: string | null;
	delivery_json: string | null;
	created_at: number;
};

type GrantRow = {
	id: string;
	capability: RoutinePermissionGrantInput["capability"];
	tool: string | null;
	constraints_json: string;
	max_uses_per_run: number | null;
	expires_at: number | null;
	revoked_at: number | null;
};

function parseArray<T>(json: string): T[] {
	try {
		const value = JSON.parse(json);
		return Array.isArray(value) ? (value as T[]) : [];
	} catch {
		return [];
	}
}

function parseObject<T>(json: string): T {
	return JSON.parse(json) as T;
}

function activeProfile(db: Db, routineId: string, revision: number) {
	return db
		.query<
			{
				id: string;
				authorization_fingerprint: string;
				mode: RoutineDefinition["permissionMode"];
				revoked_at: number | null;
				expires_at: number | null;
			},
			[string, number]
		>(
			`SELECT id, authorization_fingerprint, mode, revoked_at, expires_at
			 FROM routine_permission_profiles WHERE routine_id = ? AND revision = ?`,
		)
		.get(routineId, revision);
}

function profileGrants(
	db: Db,
	profileId: string,
): RoutinePermissionGrantInput[] {
	return db
		.query<GrantRow, [string]>(
			`SELECT id, capability, tool, constraints_json, max_uses_per_run,
			        expires_at, revoked_at
			 FROM routine_permission_grants
			 WHERE profile_id = ? ORDER BY created_at, id`,
		)
		.all(profileId)
		.filter((row) => row.revoked_at === null)
		.map((row) => ({
			id: row.id,
			capability: row.capability,
			...(row.tool ? { tool: row.tool } : {}),
			...parseObject<
				Omit<RoutinePermissionGrantInput, "id" | "capability" | "tool">
			>(row.constraints_json),
			...(row.max_uses_per_run ? { maxUsesPerRun: row.max_uses_per_run } : {}),
			...(row.expires_at ? { expiresAt: row.expires_at } : {}),
		}));
}

function toSummary(
	db: Db,
	row: RoutineRow,
	withLastRun = true,
): RoutineSummary {
	const profile = activeProfile(db, row.id, row.revision);
	const lastRun = withLastRun
		? db
				.query<RoutineRunRow, [string]>(
					`SELECT * FROM routine_runs WHERE routine_id = ?
					 ORDER BY scheduled_for DESC, created_at DESC LIMIT 1`,
				)
				.get(row.id)
		: null;
	return {
		id: row.id,
		name: row.name,
		prompt: row.prompt,
		enabled: row.enabled === 1,
		archived: row.archived === 1,
		revision: row.revision,
		schedule: parseObject(row.schedule_json),
		timezone: row.timezone,
		nextRunAt: row.next_run_at,
		providerId: row.provider_id,
		model: row.model,
		effort: row.effort,
		agentCwd: row.agent_cwd,
		agentName: row.agent_name,
		skillContexts: parseArray(row.skill_contexts_json),
		providerCommands: parseArray(row.provider_commands_json),
		vaultReferences: parseArray(row.vault_references_json),
		relicIds: parseArray(row.relic_ids_json),
		permissionMode: row.permission_mode,
		grants: profile ? profileGrants(db, profile.id) : [],
		deliveries: parseArray(row.deliveries_json),
		catchUpWindowMinutes: row.catch_up_window_minutes,
		noOverlap: row.no_overlap === 1,
		pausedReason: row.paused_reason,
		authorizationFingerprint: row.authorization_fingerprint,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
		lastRun: lastRun
			? {
					id: lastRun.id,
					status: lastRun.status,
					scheduledFor: lastRun.scheduled_for,
					startedAt: lastRun.started_at,
					finishedAt: lastRun.finished_at,
					sessionId: lastRun.session_id,
					error: lastRun.error,
					actionRequired: lastRun.action_required,
				}
			: null,
	};
}

function insertProfile(
	db: Db,
	routineId: string,
	revision: number,
	definition: RoutineDefinition,
	fingerprint: string,
): string {
	const profileId = randomUUID();
	db.run(
		`INSERT INTO routine_permission_profiles
		 (id, routine_id, revision, authorization_fingerprint, mode)
		 VALUES (?, ?, ?, ?, ?)`,
		[profileId, routineId, revision, fingerprint, definition.permissionMode],
	);
	for (const grant of grantsWithIds(definition.grants)) {
		const { id, capability, tool, maxUsesPerRun, expiresAt, ...constraints } =
			grant;
		db.run(
			`INSERT INTO routine_permission_grants
			 (id, profile_id, capability, tool, constraints_json, matcher_version,
			  max_uses_per_run, expires_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
			[
				id,
				profileId,
				capability,
				tool ?? null,
				JSON.stringify(constraints),
				ROUTINE_PERMISSION_MATCHER_VERSION,
				maxUsesPerRun ?? null,
				expiresAt ?? null,
			],
		);
	}
	return profileId;
}

function nextAt(definition: RoutineDefinition, now: number): number | null {
	return definition.enabled
		? nextRoutineOccurrence(definition.schedule, definition.timezone, now - 1)
		: null;
}

export async function createRoutine(
	input: RoutineDefinition,
	now = Math.floor(Date.now() / 1_000),
): Promise<RoutineSummary> {
	const definition = routineDefinitionSchema.parse(input);
	const db = await getDb();
	const id = randomUUID();
	const fingerprint = routineAuthorizationFingerprint(definition);
	db.transaction(() => {
		db.run(
			`INSERT INTO routines
			 (id, name, prompt, enabled, schedule_json, timezone, next_run_at,
			  provider_id, model, effort, agent_cwd, agent_name, skill_contexts_json,
			  provider_commands_json,
			  vault_references_json, relic_ids_json, permission_mode, deliveries_json,
			  catch_up_window_minutes, no_overlap, authorization_fingerprint,
			  created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			[
				id,
				definition.name,
				definition.prompt,
				definition.enabled ? 1 : 0,
				JSON.stringify(definition.schedule),
				definition.timezone,
				nextAt(definition, now),
				definition.providerId,
				definition.model,
				definition.effort,
				definition.agentCwd,
				definition.agentName,
				JSON.stringify(definition.skillContexts),
				JSON.stringify(definition.providerCommands),
				JSON.stringify(definition.vaultReferences),
				JSON.stringify(definition.relicIds),
				definition.permissionMode,
				JSON.stringify(definition.deliveries),
				definition.catchUpWindowMinutes,
				definition.noOverlap ? 1 : 0,
				fingerprint,
				now,
				now,
			],
		);
		insertProfile(db, id, 1, definition, fingerprint);
	})();
	const created = await getRoutine(id);
	if (!created) throw new Error("Routine was not persisted");
	return created;
}

export async function updateRoutine(
	id: string,
	input: RoutineDefinition,
	now = Math.floor(Date.now() / 1_000),
): Promise<RoutineSummary> {
	const definition = routineDefinitionSchema.parse(input);
	const db = await getDb();
	const existing = db
		.query<RoutineRow, [string]>(`SELECT * FROM routines WHERE id = ?`)
		.get(id);
	if (!existing) throw new Error("Routine not found");
	const revision = existing.revision + 1;
	const fingerprint = routineAuthorizationFingerprint(definition);
	db.transaction(() => {
		db.run(
			`UPDATE routines SET
			 name = ?, prompt = ?, enabled = ?, revision = ?, schedule_json = ?,
			 timezone = ?, next_run_at = ?, provider_id = ?, model = ?, effort = ?,
				 agent_cwd = ?, agent_name = ?, skill_contexts_json = ?,
				 provider_commands_json = ?,
				 vault_references_json = ?, relic_ids_json = ?, permission_mode = ?,
			 deliveries_json = ?, catch_up_window_minutes = ?, no_overlap = ?,
			 paused_reason = NULL, authorization_fingerprint = ?, updated_at = ?
			 WHERE id = ?`,
			[
				definition.name,
				definition.prompt,
				definition.enabled ? 1 : 0,
				revision,
				JSON.stringify(definition.schedule),
				definition.timezone,
				nextAt(definition, now),
				definition.providerId,
				definition.model,
				definition.effort,
				definition.agentCwd,
				definition.agentName,
				JSON.stringify(definition.skillContexts),
				JSON.stringify(definition.providerCommands),
				JSON.stringify(definition.vaultReferences),
				JSON.stringify(definition.relicIds),
				definition.permissionMode,
				JSON.stringify(definition.deliveries),
				definition.catchUpWindowMinutes,
				definition.noOverlap ? 1 : 0,
				fingerprint,
				now,
				id,
			],
		);
		insertProfile(db, id, revision, definition, fingerprint);
	})();
	const updated = await getRoutine(id);
	if (!updated) throw new Error("Routine disappeared after update");
	return updated;
}

export async function getRoutine(id: string): Promise<RoutineSummary | null> {
	const db = await getDb();
	const row = db
		.query<RoutineRow, [string]>(`SELECT * FROM routines WHERE id = ?`)
		.get(id);
	return row ? toSummary(db, row) : null;
}

export async function listRoutines(
	options: { includeArchived?: boolean; limit?: number } = {},
): Promise<RoutineSummary[]> {
	const db = await getDb();
	const limit = options.limit ?? 100;
	const rows = options.includeArchived
		? db
				.query<RoutineRow, [number]>(
					`SELECT * FROM routines ORDER BY archived, enabled DESC, next_run_at, updated_at DESC LIMIT ?`,
				)
				.all(limit)
		: db
				.query<RoutineRow, [number]>(
					`SELECT * FROM routines WHERE archived = 0 ORDER BY enabled DESC, next_run_at, updated_at DESC LIMIT ?`,
				)
				.all(limit);
	return rows.map((row) => toSummary(db, row));
}

export async function setRoutineEnabled(
	id: string,
	enabled: boolean,
	now = Math.floor(Date.now() / 1_000),
): Promise<RoutineSummary> {
	const routine = await getRoutine(id);
	if (!routine) throw new Error("Routine not found");
	const db = await getDb();
	const next = enabled
		? nextRoutineOccurrence(routine.schedule, routine.timezone, now - 1)
		: null;
	db.run(
		`UPDATE routines SET enabled = ?, next_run_at = ?, paused_reason = NULL,
		 updated_at = ? WHERE id = ? AND archived = 0`,
		[enabled ? 1 : 0, next, now, id],
	);
	const updated = await getRoutine(id);
	if (!updated) throw new Error("Routine not found");
	return updated;
}

export async function archiveRoutine(id: string): Promise<void> {
	const db = await getDb();
	db.run(
		`UPDATE routines SET archived = 1, enabled = 0, next_run_at = NULL,
		 updated_at = unixepoch() WHERE id = ?`,
		[id],
	);
}

export async function pauseRoutine(id: string, reason: string): Promise<void> {
	const db = await getDb();
	db.run(
		`UPDATE routines SET enabled = 0, next_run_at = NULL, paused_reason = ?,
		 updated_at = unixepoch() WHERE id = ?`,
		[reason.slice(0, 4_096), id],
	);
}

function insertClaim(
	db: Db,
	routine: RoutineRow,
	trigger: "scheduled" | "manual",
	scheduledFor: number,
	leaseOwner: string,
	leaseSeconds: number,
	now: number,
): RoutineRunRow | null {
	const profile = activeProfile(db, routine.id, routine.revision);
	if (!profile || profile.revoked_at !== null) return null;
	if (profile.expires_at !== null && profile.expires_at <= now) return null;
	const id = randomUUID();
	try {
		db.run(
			`INSERT INTO routine_runs
			 (id, routine_id, routine_revision, profile_id, authorization_fingerprint,
			  trigger, scheduled_for, claimed_at, lease_owner, lease_expires_at, status)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'claimed')`,
			[
				id,
				routine.id,
				routine.revision,
				profile.id,
				routine.authorization_fingerprint,
				trigger,
				scheduledFor,
				now,
				leaseOwner,
				now + leaseSeconds,
			],
		);
	} catch (error) {
		if (String(error).includes("UNIQUE")) return null;
		throw error;
	}
	return db
		.query<RoutineRunRow, [string]>(`SELECT * FROM routine_runs WHERE id = ?`)
		.get(id);
}

export async function claimDueRoutineRuns(options: {
	now: number;
	leaseOwner: string;
	leaseSeconds: number;
	limit?: number;
}): Promise<RoutineRunRow[]> {
	const db = await getDb();
	const claimed: RoutineRunRow[] = [];
	db.transaction(() => {
		const due = db
			.query<RoutineRow, [number, number]>(
				`SELECT * FROM routines
				 WHERE enabled = 1 AND archived = 0 AND next_run_at IS NOT NULL
				   AND next_run_at <= ?
				 ORDER BY next_run_at, created_at LIMIT ?`,
			)
			.all(options.now, options.limit ?? 8);
		for (const routine of due) {
			const scheduledFor = routine.next_run_at;
			if (scheduledFor === null) continue;
			const next = nextRoutineOccurrence(
				parseObject(routine.schedule_json),
				routine.timezone,
				options.now,
			);
			const active = db
				.query<{ id: string }, [string]>(
					`SELECT id FROM routine_runs WHERE routine_id = ?
					 AND status IN ('claimed', 'running') LIMIT 1`,
				)
				.get(routine.id);
			if (active && routine.no_overlap === 1) {
				db.run(
					`INSERT OR IGNORE INTO routine_runs
					 (id, routine_id, routine_revision, authorization_fingerprint,
					  trigger, scheduled_for, finished_at, status)
					 VALUES (?, ?, ?, ?, 'scheduled', ?, ?, 'skipped_overlap')`,
					[
						randomUUID(),
						routine.id,
						routine.revision,
						routine.authorization_fingerprint,
						scheduledFor,
						options.now,
					],
				);
				db.run(
					`UPDATE routines SET next_run_at = ?, updated_at = ? WHERE id = ?`,
					[next, options.now, routine.id],
				);
				continue;
			}
			if (options.now - scheduledFor > routine.catch_up_window_minutes * 60) {
				db.run(
					`INSERT OR IGNORE INTO routine_runs
					 (id, routine_id, routine_revision, authorization_fingerprint,
					  trigger, scheduled_for, finished_at, status)
					 VALUES (?, ?, ?, ?, 'scheduled', ?, ?, 'missed')`,
					[
						randomUUID(),
						routine.id,
						routine.revision,
						routine.authorization_fingerprint,
						scheduledFor,
						options.now,
					],
				);
				db.run(
					`UPDATE routines SET next_run_at = ?, updated_at = ? WHERE id = ?`,
					[next, options.now, routine.id],
				);
				continue;
			}
			const run = insertClaim(
				db,
				routine,
				"scheduled",
				scheduledFor,
				options.leaseOwner,
				options.leaseSeconds,
				options.now,
			);
			if (run) claimed.push(run);
			db.run(
				`UPDATE routines SET next_run_at = ?, enabled = ?, updated_at = ? WHERE id = ?`,
				[next, next === null ? 0 : 1, options.now, routine.id],
			);
		}
	})();
	return claimed;
}

export async function claimManualRoutineRun(options: {
	routineId: string;
	now: number;
	leaseOwner: string;
	leaseSeconds: number;
}): Promise<RoutineRunRow> {
	const db = await getDb();
	const row = db
		.query<RoutineRow, [string]>(
			`SELECT * FROM routines WHERE id = ? AND archived = 0`,
		)
		.get(options.routineId);
	if (!row) throw new Error("Routine not found");
	const run = insertClaim(
		db,
		row,
		"manual",
		options.now,
		options.leaseOwner,
		options.leaseSeconds,
		options.now,
	);
	if (!run) throw new Error("Routine could not be claimed");
	return run;
}

export async function listRoutineRuns(
	routineId: string,
	limit = 50,
): Promise<RoutineRunRow[]> {
	const db = await getDb();
	return db
		.query<RoutineRunRow, [string, number]>(
			`SELECT * FROM routine_runs WHERE routine_id = ?
			 ORDER BY scheduled_for DESC, created_at DESC LIMIT ?`,
		)
		.all(routineId, limit);
}

export async function markRoutineRunRunning(options: {
	runId: string;
	sessionId: string;
	providerUsed: string;
	now: number;
}): Promise<void> {
	const db = await getDb();
	db.run(
		`UPDATE routine_runs SET status = 'running', session_id = ?, provider_used = ?,
		 started_at = ? WHERE id = ? AND status = 'claimed'`,
		[options.sessionId, options.providerUsed, options.now, options.runId],
	);
}

export async function finishRoutineRun(options: {
	runId: string;
	status: RoutineStatus;
	now: number;
	error?: string;
	actionRequired?: string;
	delivery?: unknown;
}): Promise<void> {
	const db = await getDb();
	db.run(
		`UPDATE routine_runs SET status = ?, finished_at = ?, lease_expires_at = NULL,
		 error = ?, action_required = ?, delivery_json = ? WHERE id = ?`,
		[
			options.status,
			options.now,
			options.error?.slice(0, 8_192) ?? null,
			options.actionRequired?.slice(0, 8_192) ?? null,
			options.delivery === undefined ? null : JSON.stringify(options.delivery),
			options.runId,
		],
	);
}

export async function renewRoutineRunLease(
	runId: string,
	leaseOwner: string,
	now: number,
	leaseSeconds: number,
): Promise<boolean> {
	const db = await getDb();
	return (
		db.run(
			`UPDATE routine_runs SET lease_expires_at = ?
			 WHERE id = ? AND lease_owner = ? AND status IN ('claimed', 'running')`,
			[now + leaseSeconds, runId, leaseOwner],
		).changes > 0
	);
}

export async function interruptStaleRoutineRuns(
	now: number,
	leaseCutoff = now,
): Promise<number> {
	const db = await getDb();
	return db.run(
		`UPDATE routine_runs SET status = 'interrupted', finished_at = ?,
		 error = 'Hlid restarted or the Routine lease expired before completion'
		 WHERE status IN ('claimed', 'running')
		   AND (lease_expires_at IS NULL OR lease_expires_at < ?)`,
		[now, leaseCutoff],
	).changes;
}

export async function recordRoutineGrantUse(options: {
	runId: string;
	grantId: string;
	toolUseId: string;
	request: CanonicalRoutineCapability;
	umbodDecision?: string;
	decision: string;
}): Promise<void> {
	const db = await getDb();
	const requestJson = JSON.stringify(options.request);
	const digest = createHash("sha256").update(requestJson).digest("hex");
	db.run(
		`INSERT INTO routine_grant_uses
		 (run_id, grant_id, tool_use_id, capability, request_json, input_digest,
		  umbod_decision, decision)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		[
			options.runId,
			options.grantId,
			options.toolUseId,
			options.request.capability,
			requestJson,
			digest,
			options.umbodDecision ?? null,
			options.decision,
		],
	);
}
