import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, it } from "bun:test";
import {
	HLID_DELEGATION_MAX_ERROR_CHARS,
	HLID_DELEGATION_MAX_PROGRESS_CHARS,
	HLID_DELEGATION_MAX_RESULT_CHARS,
} from "../lib/hlidDelegation";
import {
	abandonInterruptedHlidDelegation,
	countActiveHlidDelegations,
	createHlidDelegation,
	finishHlidDelegation,
	getHlidDelegation,
	getHlidDelegationByChildSession,
	getHlidDelegationForParent,
	interruptActiveHlidDelegationsAfterRestart,
	listHlidDelegationAncestorLineage,
	listHlidDelegationLifecycleRollups,
	listHlidDelegationsByParentDelegation,
	listHlidDelegationsForParent,
	listHlidDelegationsForRoutineRun,
	listResumableInterruptedHlidDelegations,
	markHlidDelegationRunning,
	reconcileOrphanedHlidDelegationsAfterRestart,
	recordHlidDelegationPartialResult,
	resumeHlidDelegation,
	rollbackHlidDelegationResume,
	updateHlidDelegationCost,
	updateHlidDelegationProgress,
	updateHlidDelegationTokens,
} from "./delegations";
import { initializeSchema, setDbForTest } from "./schema";
import {
	createSession,
	deleteSession,
	deleteSessionsOlderThan,
	getSessionById,
	renameSession,
	rollbackHlidDelegationSetup,
	SessionDelegationOwnershipError,
	SessionHasDelegationDescendantsError,
	setSessionArchived,
} from "./sessions";

const delegationInput = {
	id: "delegation-1",
	parentSessionId: "parent-1",
	parentTurnId: "turn-1",
	parentLabel: "Parent task",
	childSessionId: "child-1",
	depth: 1,
	task: "Review the provider boundary",
	providerId: "codex",
	model: "gpt-5.6-sol",
	effort: "high",
	serviceTier: null,
	workspace: "/workspace",
	permissionMode: "plan",
	timeoutSeconds: 600,
	parentDelegationId: null,
	handoff: {
		visible_transcript_chars: 0,
		selected_skills: 0,
		selected_relics: 0,
		vault_references: 0,
		workspace_references: 0,
	},
};

describe("durable Hlid delegation provenance", () => {
	let database: Database;

	beforeEach(() => {
		database = new Database(":memory:");
		setDbForTest(database);
	});

	it("projects parent and turn provenance onto the ordinary child session", async () => {
		await createSession("parent-1", "Parent task", "gpt-5.6-sol");
		await createSession("child-1", "Child task", "gpt-5.6-sol");

		const created = await createHlidDelegation(delegationInput);

		expect(created).toMatchObject({
			id: "delegation-1",
			parent_session_id: "parent-1",
			parent_turn_id: "turn-1",
			child_session_id: "child-1",
			status: "pending",
			complete: false,
			open_url: "/raven?session=child-1",
		});
		expect(created).not.toHaveProperty("handoff_json");
		expect(
			await getHlidDelegationForParent("delegation-1", "other-parent"),
		).toBeNull();
		expect(await getHlidDelegationByChildSession("child-1")).toMatchObject({
			id: "delegation-1",
		});
		expect(await getSessionById("child-1")).toMatchObject({
			delegation_parent_session_id: "parent-1",
			delegation_parent_label: "Parent task",
			delegation_parent_turn_id: "turn-1",
			delegation_depth: 1,
			delegation_control_owned: 1,
		});

		await renameSession("parent-1", "Renamed parent");
		expect(await getSessionById("child-1")).toMatchObject({
			delegation_parent_label: "Renamed parent",
		});
	});

	it("atomically rolls back an exact pending delegated child setup", async () => {
		await createSession("parent-1", "Parent task", "gpt-5.6-sol");
		await createSession("child-1", "Child task", "gpt-5.6-sol");
		await createHlidDelegation(delegationInput);

		await rollbackHlidDelegationSetup("delegation-1", "child-1");

		expect(await getHlidDelegation("delegation-1")).toBeNull();
		expect(await getSessionById("child-1")).toBeNull();
		expect(await getSessionById("parent-1")).not.toBeNull();
	});

	it("refuses setup rollback after the delegated provider launch claim", async () => {
		await createSession("child-1", "Child task", "gpt-5.6-sol");
		await createHlidDelegation(delegationInput);
		await markHlidDelegationRunning("delegation-1");

		await expect(
			rollbackHlidDelegationSetup("delegation-1", "child-1"),
		).rejects.toThrow("no longer owns an exact pending child");
		expect(await getHlidDelegation("delegation-1")).toMatchObject({
			status: "running",
		});
		expect(await getSessionById("child-1")).not.toBeNull();
	});

	it("restores an interrupted attempt after a parent-turn continuation race", async () => {
		await createSession("child-1", "Child task", "gpt-5.6-sol", {
			effort: "high",
			permissionMode: "plan",
			agentCwd: "/workspace",
			providerId: "codex",
		});
		await createHlidDelegation(delegationInput);
		await finishHlidDelegation("delegation-1", {
			status: "interrupted",
			resultText: "Retain this partial result",
			error: "Hlid restarted",
		});
		database.run(
			`UPDATE session_delegations
			 SET token_budget = 500, cost_budget = 2
			 WHERE id = 'delegation-1'`,
		);
		const interrupted = await getHlidDelegation("delegation-1");
		expect(interrupted).not.toBeNull();
		if (!interrupted) throw new Error("Expected interrupted delegation");
		expect(interrupted).toMatchObject({
			token_budget: 500,
			cost_budget: 2,
		});
		const resumed = await resumeHlidDelegation("delegation-1", {
			continuationMode: "explicit_new_turn",
			timeoutSeconds: 120,
			permissionMode: "default",
			handoff: {
				...delegationInput.handoff,
				visible_transcript_chars: 40,
			},
		});
		expect(resumed).toMatchObject({
			status: "pending",
			attempt_count: 2,
			result_text: null,
			permission_mode: "default",
			token_budget: null,
			cost_budget: null,
		});

		const rolledBack = await rollbackHlidDelegationResume(
			"delegation-1",
			interrupted,
		);

		expect(rolledBack).toMatchObject({
			status: "interrupted",
			attempt_count: 1,
			continuation_mode: "initial",
			timeout_seconds: 600,
			token_budget: 500,
			cost_budget: 2,
			permission_mode: "plan",
			result_text: "Retain this partial result",
			error: "Hlid restarted",
		});
		expect(await getSessionById("child-1")).toMatchObject({
			provider_id: "codex",
			selected_model: "gpt-5.6-sol",
			selected_effort: "high",
			selected_permission_mode: "plan",
		});
	});

	it("keeps Routine ownership durable and fails closed after restart", async () => {
		await createSession("child-1", "Child task", "gpt-5.6-sol");
		await createHlidDelegation({
			...delegationInput,
			routineRunId: "routine-run-1",
		});
		await markHlidDelegationRunning("delegation-1");

		expect(await listHlidDelegationsForRoutineRun("routine-run-1")).toEqual([
			expect.objectContaining({
				id: "delegation-1",
				routine_run_id: "routine-run-1",
			}),
		]);
		expect(await interruptActiveHlidDelegationsAfterRestart()).toBe(1);
		expect(await getHlidDelegation("delegation-1")).toMatchObject({
			status: "interrupted",
			resumable: false,
		});
		expect(await listResumableInterruptedHlidDelegations()).toEqual([]);
	});

	it("bounds current progress, counts active children, and retains terminal partial work", async () => {
		await createSession("child-1", "Child", "gpt-5.6-sol");
		await createSession("child-2", "Child 2", "gpt-5.6-sol");
		await createHlidDelegation(delegationInput);
		await createHlidDelegation({
			...delegationInput,
			id: "delegation-2",
			parentSessionId: "parent-2",
			childSessionId: "child-2",
		});

		expect(await countActiveHlidDelegations()).toBe(2);
		expect(await countActiveHlidDelegations("parent-1")).toBe(1);
		await updateHlidDelegationProgress(
			"delegation-1",
			`Using ${"x".repeat(HLID_DELEGATION_MAX_PROGRESS_CHARS + 100)}`,
		);
		expect(
			(await getHlidDelegation("delegation-1"))?.progress_text,
		).toHaveLength(HLID_DELEGATION_MAX_PROGRESS_CHARS);

		await finishHlidDelegation("delegation-1", {
			status: "cancelled",
			error: "Cancelled",
		});
		await recordHlidDelegationPartialResult(
			"delegation-1",
			"Useful partial work",
		);

		expect(await getHlidDelegation("delegation-1")).toMatchObject({
			status: "cancelled",
			progress_text: null,
			result_text: "Useful partial work",
		});
		expect(await countActiveHlidDelegations()).toBe(1);
		expect(await countActiveHlidDelegations("parent-1")).toBe(0);
	});

	it("aggregates mixed durable lifecycle and wall-clock span through nested children without expanding cycles", async () => {
		for (const id of ["child-1", "child-2", "child-3"]) {
			await createSession(id, id, "gpt-5.6-sol");
		}
		await createHlidDelegation(delegationInput);
		await createHlidDelegation({
			...delegationInput,
			id: "delegation-2",
			childSessionId: "child-2",
		});
		await createHlidDelegation({
			...delegationInput,
			id: "delegation-3",
			parentSessionId: "child-1",
			parentDelegationId: "delegation-1",
			childSessionId: "child-3",
			depth: 2,
		});
		await finishHlidDelegation("delegation-1", { status: "completed" });
		await finishHlidDelegation("delegation-2", {
			status: "timed_out",
			error: "Timed out",
		});
		await interruptActiveHlidDelegationsAfterRestart();
		database.run(
			`UPDATE session_delegations
			 SET parent_delegation_id = 'delegation-3'
			 WHERE id = 'delegation-1'`,
		);
		database.run(
			`UPDATE session_delegations
			 SET tokens_used = 100, cost_used = 0.25,
			     started_at = 100, updated_at = 110, ended_at = 110
			 WHERE id = 'delegation-1'`,
		);
		database.run(
			`UPDATE session_delegations
			 SET tokens_used = 200, cost_used = 0.5,
			     started_at = 200, updated_at = 230, ended_at = 230
			 WHERE id = 'delegation-2'`,
		);
		database.run(
			`UPDATE session_delegations
			 SET tokens_used = 300, cost_used = 1.25,
			     started_at = 300, updated_at = 305, ended_at = 305
			 WHERE id = 'delegation-3'`,
		);

		expect(await listHlidDelegationLifecycleRollups(["parent-1"])).toEqual([
			{
				parent_session_id: "parent-1",
				direct_count: 2,
				descendant_count: 3,
				waiting_count: 1,
				completed_count: 1,
				failed_count: 1,
				total_tokens: 600,
				total_cost: 2,
				elapsed_duration_seconds: 205,
				last_activity_at: 305_000,
			},
		]);
		database.run(
			`UPDATE session_delegations
			 SET attempt_count = 3
			 WHERE id = 'delegation-3'`,
		);
		expect(
			(await listHlidDelegationLifecycleRollups(["parent-1"]))[0],
		).toMatchObject({
			waiting_count: 0,
			failed_count: 2,
		});
		expect(await listHlidDelegationLifecycleRollups()).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					parent_session_id: "child-1",
					direct_count: 1,
					descendant_count: 2,
				}),
			]),
		);
	});

	it("uses current query time for an active descendant despite a stale end timestamp", async () => {
		await createSession("child-1", "Child", "gpt-5.6-sol");
		await createHlidDelegation(delegationInput);
		await markHlidDelegationRunning("delegation-1");
		database.run(
			`UPDATE session_delegations
			 SET tokens_used = 800, cost_used = 1.25,
			     started_at = unixepoch() - 10,
			     updated_at = unixepoch() - 2,
			     ended_at = unixepoch() + 600
			 WHERE id = 'delegation-1'`,
		);

		const [rollup] = await listHlidDelegationLifecycleRollups(["parent-1"]);
		expect(rollup).toMatchObject({
			total_tokens: 800,
			total_cost: 1.25,
		});
		expect(rollup?.elapsed_duration_seconds).toBeGreaterThanOrEqual(10);
		expect(rollup?.elapsed_duration_seconds).toBeLessThanOrEqual(12);
	});

	it("classifies interrupted Routine children as failed instead of waiting", async () => {
		await createSession("child-1", "Routine child", "gpt-5.6-sol");
		await createHlidDelegation({
			...delegationInput,
			routineRunId: "routine-run-1",
		});
		await interruptActiveHlidDelegationsAfterRestart();

		expect(await listHlidDelegationLifecycleRollups(["parent-1"])).toEqual([
			{
				parent_session_id: "parent-1",
				direct_count: 1,
				descendant_count: 1,
				waiting_count: 0,
				completed_count: 0,
				failed_count: 1,
				total_tokens: 0,
				total_cost: 0,
				elapsed_duration_seconds: expect.any(Number),
				last_activity_at: expect.any(Number),
			},
		]);
	});

	it("lists only resumable interrupted delegations with unarchived child sessions", async () => {
		await createSession("child-1", "Child", "gpt-5.6-sol");
		await createSession("child-2", "Archived child", "gpt-5.6-sol");
		await createHlidDelegation(delegationInput);
		await createHlidDelegation({
			...delegationInput,
			id: "delegation-2",
			childSessionId: "child-2",
		});
		await interruptActiveHlidDelegationsAfterRestart();
		await setSessionArchived("child-2", true);

		expect(await getHlidDelegation("delegation-2")).toMatchObject({
			status: "interrupted",
			resumable: false,
		});
		expect(
			await resumeHlidDelegation("delegation-2", {
				continuationMode: "explicit_new_turn",
				timeoutSeconds: 300,
				permissionMode: "plan",
				handoff: delegationInput.handoff,
			}),
		).toBeNull();
		expect(await listResumableInterruptedHlidDelegations()).toEqual([
			expect.objectContaining({
				id: "delegation-1",
				status: "interrupted",
				resumable: true,
			}),
		]);

		await resumeHlidDelegation("delegation-1", {
			continuationMode: "explicit_new_turn",
			timeoutSeconds: 300,
			permissionMode: "plan",
			handoff: delegationInput.handoff,
		});
		await interruptActiveHlidDelegationsAfterRestart();
		await resumeHlidDelegation("delegation-1", {
			continuationMode: "explicit_new_turn",
			timeoutSeconds: 300,
			permissionMode: "plan",
			handoff: delegationInput.handoff,
		});
		await interruptActiveHlidDelegationsAfterRestart();

		expect(await listResumableInterruptedHlidDelegations()).toEqual([]);
	});

	it("preserves first-slice rows while applying the v1-to-v2 migration", async () => {
		const legacyResult = "r".repeat(HLID_DELEGATION_MAX_RESULT_CHARS + 500);
		const legacyError = "e".repeat(HLID_DELEGATION_MAX_ERROR_CHARS + 500);
		database.run(`DROP TABLE session_delegations`);
		database.run(`
			CREATE TABLE session_delegations (
				id TEXT PRIMARY KEY,
				parent_session_id TEXT NOT NULL,
				parent_turn_id TEXT,
				parent_label TEXT,
				child_session_id TEXT NOT NULL UNIQUE,
				depth INTEGER NOT NULL CHECK(depth >= 1),
				task TEXT NOT NULL,
				target_provider_id TEXT NOT NULL,
				selected_model TEXT,
				selected_effort TEXT,
				selected_permission_mode TEXT NOT NULL,
				timeout_seconds INTEGER NOT NULL,
				status TEXT NOT NULL CHECK(status IN (
					'pending', 'running', 'completed', 'failed',
					'timed_out', 'interrupted'
				)),
				started_at INTEGER NOT NULL DEFAULT (unixepoch()),
				ended_at INTEGER,
				result_text TEXT,
				error TEXT
			)
		`);
		database.run(
			`DELETE FROM settings WHERE key = '_migrated_session_delegations_v2'`,
		);
		database.run(
			`DELETE FROM settings WHERE key = '_migrated_session_delegations_v3'`,
		);
		database.run(
			`DELETE FROM settings WHERE key = '_migrated_session_delegations_v4'`,
		);
		database.run(
			`DELETE FROM settings WHERE key = '_migrated_session_delegations_v5'`,
		);
		database.run(
			`DELETE FROM settings WHERE key = '_migrated_session_delegations_v6'`,
		);
		database.run(
			`INSERT INTO session_delegations (
				id, parent_session_id, parent_turn_id, parent_label,
				child_session_id, depth, task, target_provider_id,
				selected_model, selected_effort, selected_permission_mode,
				timeout_seconds, status, started_at, ended_at, result_text, error
			 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			[
				"legacy-delegation",
				"legacy-parent",
				"legacy-turn",
				"Legacy parent",
				"legacy-child",
				7,
				"Legacy task",
				"claude",
				"claude-sonnet",
				"high",
				"plan",
				420,
				"completed",
				100,
				200,
				legacyResult,
				legacyError,
			],
		);

		initializeSchema(database);

		const migrated = await getHlidDelegation("legacy-delegation");
		expect(migrated).toMatchObject({
			id: "legacy-delegation",
			parent_session_id: "legacy-parent",
			parent_turn_id: "legacy-turn",
			parent_label: "Legacy parent",
			parent_delegation_id: null,
			child_session_id: "legacy-child",
			depth: 3,
			task: "Legacy task",
			provider_id: "claude",
			model: "claude-sonnet",
			effort: "high",
			permission_mode: "plan",
			timeout_seconds: 420,
			token_budget: null,
			tokens_used: 0,
			attempt_count: 1,
			continuation_mode: "initial",
			status: "completed",
			started_at: 100,
			updated_at: 200,
			ended_at: 200,
			complete: true,
			resumable: false,
		});
		expect(migrated?.result_text).toHaveLength(
			HLID_DELEGATION_MAX_RESULT_CHARS,
		);
		expect(migrated?.result_text?.endsWith("…")).toBe(true);
		expect(migrated?.error).toHaveLength(HLID_DELEGATION_MAX_ERROR_CHARS);
		expect(migrated?.error?.endsWith("…")).toBe(true);
		expect(
			database
				.query<{ result_length: number; error_length: number }, []>(
					`SELECT length(result_text) AS result_length,
						        length(error) AS error_length
						 FROM session_delegations
						 WHERE id = 'legacy-delegation'`,
				)
				.get(),
		).toEqual({
			result_length: HLID_DELEGATION_MAX_RESULT_CHARS,
			error_length: HLID_DELEGATION_MAX_ERROR_CHARS,
		});
		expect(
			database
				.query<{ value: string }, [string]>(
					`SELECT value FROM settings WHERE key = ?`,
				)
				.get("_migrated_session_delegations_v2"),
		).toEqual({ value: "1" });
		expect(
			database
				.query<{ name: string }, []>(
					`SELECT name FROM pragma_table_info('session_delegations')`,
				)
				.all()
				.map((column) => column.name),
		).toEqual(
			expect.arrayContaining([
				"parent_delegation_id",
				"token_budget",
				"tokens_used",
				"attempt_count",
				"continuation_mode",
				"handoff_json",
				"updated_at",
			]),
		);
	});

	it("bounds terminal results and interrupts unfinished work after restart", async () => {
		await createSession("child-1", "Child task", "gpt-5.6-sol");
		const created = await createHlidDelegation({
			...delegationInput,
			task: "t".repeat(5_000),
		});
		expect(created.task).toHaveLength(2_000);
		expect(created.task.endsWith("…")).toBe(true);
		expect(await markHlidDelegationRunning("delegation-1")).toMatchObject({
			status: "running",
		});
		expect(await markHlidDelegationRunning("delegation-1")).toBeNull();

		const completed = await finishHlidDelegation("delegation-1", {
			status: "completed",
			resultText: "x".repeat(20_000),
		});
		expect(completed).toMatchObject({
			status: "completed",
			complete: true,
		});
		expect(completed?.result_text).toHaveLength(12_000);
		expect(completed?.result_text?.endsWith("…")).toBe(true);

		await createSession("child-2", "Other child", "gpt-5.6-sol");
		await createHlidDelegation({
			...delegationInput,
			id: "delegation-2",
			childSessionId: "child-2",
		});
		expect(await interruptActiveHlidDelegationsAfterRestart()).toBe(1);
		expect(await getHlidDelegation("delegation-2")).toMatchObject({
			status: "interrupted",
			complete: true,
			error: "Hlid restarted before this delegated child finished.",
		});
	});

	it("does not claim or strand a pending delegation whose child was archived first", async () => {
		await createSession("child-1", "Child task", "gpt-5.6-sol");
		await setSessionArchived("child-1", true);
		await createHlidDelegation(delegationInput);

		expect(await markHlidDelegationRunning("delegation-1")).toBeNull();
		expect(await getHlidDelegation("delegation-1")).toMatchObject({
			status: "cancelled",
			complete: true,
			resumable: false,
			error:
				"The delegated child was removed or archived before it could start.",
		});
	});

	it("protects active and resumable delegation-owned children from archive or delete", async () => {
		await createSession("child-1", "Child task", "gpt-5.6-sol");
		await createHlidDelegation(delegationInput);
		expect(await getSessionById("child-1")).toMatchObject({
			delegation_control_owned: 1,
		});

		await expect(setSessionArchived("child-1", true)).rejects.toBeInstanceOf(
			SessionDelegationOwnershipError,
		);
		await expect(deleteSession("child-1")).rejects.toBeInstanceOf(
			SessionDelegationOwnershipError,
		);

		await finishHlidDelegation("delegation-1", {
			status: "interrupted",
			error: "Restarted",
		});
		expect(await getSessionById("child-1")).toMatchObject({
			delegation_control_owned: 1,
		});
		await expect(deleteSession("child-1")).rejects.toBeInstanceOf(
			SessionDelegationOwnershipError,
		);

		await setSessionArchived("child-1", true);
		expect(await getSessionById("child-1")).toMatchObject({
			delegation_control_owned: 0,
		});
		expect(await getHlidDelegation("delegation-1")).toMatchObject({
			status: "interrupted",
			resumable: false,
		});
		await deleteSession("child-1");
		expect(await getHlidDelegation("delegation-1")).toBeNull();
	});

	it("abandons a restart-interrupted child without deleting its durable session", async () => {
		await createSession("child-1", "Child task", "gpt-5.6-sol");
		await createHlidDelegation(delegationInput);
		await finishHlidDelegation("delegation-1", {
			status: "interrupted",
			error: "Hlid restarted before this delegated child finished.",
		});

		const abandoned = await abandonInterruptedHlidDelegation(
			"delegation-1",
			"The user closed this restart-interrupted child without continuing it.",
		);

		expect(abandoned).toMatchObject({
			status: "cancelled",
			resumable: false,
			complete: true,
			error:
				"The user closed this restart-interrupted child without continuing it.",
		});
		expect(await getSessionById("child-1")).toMatchObject({
			delegation_control_owned: 0,
		});
		expect(await listResumableInterruptedHlidDelegations()).toEqual([]);
		expect(await getSessionById("child-1")).not.toBeNull();
	});

	it("releases interrupted Routine-owned children for direct deletion", async () => {
		await createSession("child-1", "Routine child", "gpt-5.6-sol");
		await createHlidDelegation({
			...delegationInput,
			routineRunId: "routine-run-1",
		});
		expect(await getSessionById("child-1")).toMatchObject({
			delegation_control_owned: 1,
		});

		await interruptActiveHlidDelegationsAfterRestart();

		expect(await getSessionById("child-1")).toMatchObject({
			delegation_control_owned: 0,
		});
		await deleteSession("child-1");
		expect(await getSessionById("child-1")).toBeNull();
		expect(await getHlidDelegation("delegation-1")).toBeNull();
	});

	it("removes delegation metadata when the child session is deleted", async () => {
		await createSession("child-1", "Child task", "gpt-5.6-sol");
		await createHlidDelegation(delegationInput);
		await finishHlidDelegation("delegation-1", {
			status: "completed",
			resultText: "Done",
		});

		await deleteSession("child-1");

		expect(await getHlidDelegation("delegation-1")).toBeNull();
	});

	it("reconciles a missing child and its delegation descendants before startup interruption", async () => {
		await createSession("child-1", "Missing child", "gpt-5.6-sol");
		await createSession("child-2", "Descendant", "gpt-5.6-sol");
		await createSession("child-3", "Unrelated", "gpt-5.6-sol");
		await createHlidDelegation(delegationInput);
		await createHlidDelegation({
			...delegationInput,
			id: "delegation-2",
			parentSessionId: "child-1",
			parentDelegationId: "delegation-1",
			childSessionId: "child-2",
			depth: 2,
		});
		await createHlidDelegation({
			...delegationInput,
			id: "delegation-3",
			childSessionId: "child-3",
		});
		database.run(`DELETE FROM sessions WHERE id = 'child-1'`);

		expect(await getHlidDelegation("delegation-1")).toMatchObject({
			resumable: false,
		});
		expect(await reconcileOrphanedHlidDelegationsAfterRestart()).toBe(2);
		expect(await getHlidDelegation("delegation-1")).toBeNull();
		expect(await getHlidDelegation("delegation-2")).toBeNull();
		expect(await getSessionById("child-2")).not.toBeNull();
		expect(await interruptActiveHlidDelegationsAfterRestart()).toBe(1);
		expect(await getHlidDelegation("delegation-3")).toMatchObject({
			status: "interrupted",
		});
	});

	it("blocks deleting a delegated parent until its descendants are deleted", async () => {
		await createSession("child-1", "Child", "gpt-5.6-sol");
		await createSession("child-2", "Grandchild", "gpt-5.6-sol");
		await createHlidDelegation(delegationInput);
		await createHlidDelegation({
			...delegationInput,
			id: "delegation-2",
			parentSessionId: "child-1",
			parentDelegationId: "delegation-1",
			childSessionId: "child-2",
			depth: 2,
		});
		await finishHlidDelegation("delegation-1", {
			status: "completed",
			resultText: "Parent done",
		});
		await finishHlidDelegation("delegation-2", {
			status: "completed",
			resultText: "Child done",
		});

		await expect(deleteSession("child-1")).rejects.toBeInstanceOf(
			SessionHasDelegationDescendantsError,
		);
		expect(await getSessionById("child-1")).not.toBeNull();
		expect(await getHlidDelegation("delegation-1")).not.toBeNull();
		expect(await getHlidDelegation("delegation-2")).not.toBeNull();

		await deleteSession("child-2");
		await deleteSession("child-1");
		expect(await getHlidDelegation("delegation-1")).toBeNull();
		expect(await getHlidDelegation("delegation-2")).toBeNull();
	});

	it("blocks deleting an ordinary root until its delegated child is deleted", async () => {
		await createSession("parent-1", "Root", "gpt-5.6-sol");
		await createSession("child-1", "Child", "gpt-5.6-sol");
		await createHlidDelegation(delegationInput);
		await finishHlidDelegation("delegation-1", {
			status: "completed",
			resultText: "Done",
		});

		await expect(deleteSession("parent-1")).rejects.toBeInstanceOf(
			SessionHasDelegationDescendantsError,
		);
		expect(await getSessionById("parent-1")).not.toBeNull();
		expect(await getHlidDelegation("delegation-1")).not.toBeNull();

		await deleteSession("child-1");
		await deleteSession("parent-1");
		expect(await getSessionById("parent-1")).toBeNull();
	});

	it("keeps an old terminal lineage until every descendant is selected for cleanup", async () => {
		const oldStartedAt = Math.floor(Date.now() / 1_000) - 10 * 86_400;
		await createSession("parent-1", "Old root", "gpt-5.6-sol");
		await createSession("child-1", "Old child", "gpt-5.6-sol");
		await createSession("child-2", "Fresh grandchild", "gpt-5.6-sol");
		await createSession("independent", "Old independent", "gpt-5.6-sol");
		database.run(
			`UPDATE sessions SET started_at = ?
				 WHERE id IN ('parent-1', 'child-1', 'independent')`,
			[oldStartedAt],
		);
		await createHlidDelegation(delegationInput);
		await createHlidDelegation({
			...delegationInput,
			id: "delegation-2",
			parentSessionId: "child-1",
			parentDelegationId: "delegation-1",
			childSessionId: "child-2",
			depth: 2,
		});
		await finishHlidDelegation("delegation-1", {
			status: "completed",
			resultText: "Parent done",
		});
		await finishHlidDelegation("delegation-2", {
			status: "completed",
			resultText: "Child done",
		});

		const firstCleanup = await deleteSessionsOlderThan(1);
		expect(firstCleanup.sessionIds).toEqual(["independent"]);
		expect(await getSessionById("child-1")).not.toBeNull();
		expect(await getHlidDelegation("delegation-1")).not.toBeNull();
		expect(await getHlidDelegation("delegation-2")).not.toBeNull();

		database.run(`UPDATE sessions SET started_at = ? WHERE id = 'child-2'`, [
			oldStartedAt,
		]);
		const secondCleanup = await deleteSessionsOlderThan(1);
		expect(new Set(secondCleanup.sessionIds)).toEqual(
			new Set(["parent-1", "child-1", "child-2"]),
		);
		expect(await getHlidDelegation("delegation-1")).toBeNull();
		expect(await getHlidDelegation("delegation-2")).toBeNull();
	});

	it("never bulk-cleans active or resumable delegation ownership and propagates the block to ancestors", async () => {
		const oldStartedAt = Math.floor(Date.now() / 1_000) - 10 * 86_400;
		for (const [rootId, childId] of [
			["pending-root", "pending-child"],
			["running-root", "running-child"],
		] as const) {
			await createSession(rootId, rootId, "gpt-5.6-sol");
			await createSession(childId, childId, "gpt-5.6-sol");
		}
		await createSession("nested-root", "Nested root", "gpt-5.6-sol");
		await createSession("nested-middle", "Nested middle", "gpt-5.6-sol");
		await createSession("nested-leaf", "Nested leaf", "gpt-5.6-sol");
		await createSession("independent", "Independent", "gpt-5.6-sol");
		database.run(`UPDATE sessions SET started_at = ?`, [oldStartedAt]);

		await createHlidDelegation({
			...delegationInput,
			id: "pending-delegation",
			parentSessionId: "pending-root",
			childSessionId: "pending-child",
		});
		await createHlidDelegation({
			...delegationInput,
			id: "running-delegation",
			parentSessionId: "running-root",
			childSessionId: "running-child",
		});
		await markHlidDelegationRunning("running-delegation");
		await createHlidDelegation({
			...delegationInput,
			id: "ancestor-delegation",
			parentSessionId: "nested-root",
			childSessionId: "nested-middle",
		});
		await finishHlidDelegation("ancestor-delegation", {
			status: "completed",
			resultText: "Ancestor done",
		});
		await createHlidDelegation({
			...delegationInput,
			id: "resumable-delegation",
			parentSessionId: "nested-middle",
			parentDelegationId: "ancestor-delegation",
			childSessionId: "nested-leaf",
			depth: 2,
		});
		await finishHlidDelegation("resumable-delegation", {
			status: "interrupted",
			error: "Restarted",
		});
		expect(await getHlidDelegation("resumable-delegation")).toMatchObject({
			status: "interrupted",
			resumable: true,
		});

		const cleanup = await deleteSessionsOlderThan(1);

		expect(cleanup.sessionIds).toEqual(["independent"]);
		for (const sessionId of [
			"pending-root",
			"pending-child",
			"running-root",
			"running-child",
			"nested-root",
			"nested-middle",
			"nested-leaf",
		]) {
			expect(await getSessionById(sessionId)).not.toBeNull();
		}
		expect(await getHlidDelegation("pending-delegation")).not.toBeNull();
		expect(await getHlidDelegation("running-delegation")).not.toBeNull();
		expect(await getHlidDelegation("ancestor-delegation")).not.toBeNull();
		expect(await getHlidDelegation("resumable-delegation")).not.toBeNull();
	});

	it("bulk-cleans terminal and attempt-exhausted interrupted lineages once old", async () => {
		const oldStartedAt = Math.floor(Date.now() / 1_000) - 10 * 86_400;
		for (const [rootId, childId] of [
			["terminal-root", "terminal-child"],
			["exhausted-root", "exhausted-child"],
		] as const) {
			await createSession(rootId, rootId, "gpt-5.6-sol");
			await createSession(childId, childId, "gpt-5.6-sol");
		}
		database.run(`UPDATE sessions SET started_at = ?`, [oldStartedAt]);

		await createHlidDelegation({
			...delegationInput,
			id: "terminal-delegation",
			parentSessionId: "terminal-root",
			childSessionId: "terminal-child",
		});
		await finishHlidDelegation("terminal-delegation", {
			status: "completed",
			resultText: "Done",
		});
		await createHlidDelegation({
			...delegationInput,
			id: "exhausted-delegation",
			parentSessionId: "exhausted-root",
			childSessionId: "exhausted-child",
		});
		await finishHlidDelegation("exhausted-delegation", {
			status: "interrupted",
			error: "Restart one",
		});
		for (let attempt = 2; attempt <= 3; attempt += 1) {
			expect(
				await resumeHlidDelegation("exhausted-delegation", {
					continuationMode: "explicit_new_turn",
					timeoutSeconds: 300,
					permissionMode: "plan",
					handoff: delegationInput.handoff,
				}),
			).toMatchObject({ status: "pending", attempt_count: attempt });
			expect(await interruptActiveHlidDelegationsAfterRestart()).toBe(1);
		}
		expect(await getHlidDelegation("exhausted-delegation")).toMatchObject({
			status: "interrupted",
			attempt_count: 3,
			resumable: false,
		});

		const cleanup = await deleteSessionsOlderThan(1);

		expect(new Set(cleanup.sessionIds)).toEqual(
			new Set([
				"terminal-root",
				"terminal-child",
				"exhausted-root",
				"exhausted-child",
			]),
		);
		expect(await getHlidDelegation("terminal-delegation")).toBeNull();
		expect(await getHlidDelegation("exhausted-delegation")).toBeNull();
	});

	it("bulk-cleans old interrupted Routine lineages as non-resumable", async () => {
		const oldStartedAt = Math.floor(Date.now() / 1_000) - 10 * 86_400;
		await createSession("parent-1", "Old Routine root", "gpt-5.6-sol");
		await createSession("child-1", "Old Routine child", "gpt-5.6-sol");
		database.run(`UPDATE sessions SET started_at = ?`, [oldStartedAt]);
		await createHlidDelegation({
			...delegationInput,
			routineRunId: "routine-run-1",
		});
		await interruptActiveHlidDelegationsAfterRestart();

		const cleanup = await deleteSessionsOlderThan(1);

		expect(new Set(cleanup.sessionIds)).toEqual(
			new Set(["parent-1", "child-1"]),
		);
		expect(await getSessionById("parent-1")).toBeNull();
		expect(await getSessionById("child-1")).toBeNull();
		expect(await getHlidDelegation("delegation-1")).toBeNull();
	});

	it("persists nested lineage, passive usage, atomic cancellation, and bounded restart continuation", async () => {
		await createSession("parent-1", "Parent", "gpt-5.6-sol");
		await createSession("child-1", "Child", "gpt-5.6-sol");
		await createSession("child-2", "Grandchild", "gpt-5.6-sol");
		await createHlidDelegation({
			...delegationInput,
			handoff: {
				visible_transcript_chars: 1_200,
				selected_skills: 1,
				selected_relics: 1,
				vault_references: 1,
				workspace_references: 1,
			},
		});
		await createHlidDelegation({
			...delegationInput,
			id: "delegation-2",
			parentSessionId: "child-1",
			parentDelegationId: "delegation-1",
			childSessionId: "child-2",
			depth: 2,
		});

		expect(await listHlidDelegationsForParent("parent-1")).toHaveLength(1);
		expect(await listHlidDelegationsByParentDelegation("delegation-1")).toEqual(
			[
				expect.objectContaining({
					id: "delegation-2",
					parent_delegation_id: "delegation-1",
					depth: 2,
				}),
			],
		);
		const lineage = await listHlidDelegationAncestorLineage(["child-2"]);
		expect(lineage).toHaveLength(2);
		expect(lineage).toEqual(
			expect.arrayContaining([
				{
					child_session_id: "child-1",
					parent_session_id: "parent-1",
				},
				{
					child_session_id: "child-2",
					parent_session_id: "child-1",
				},
			]),
		);
		expect(await getHlidDelegation("delegation-1")).toMatchObject({
			token_budget: null,
			tokens_used: 0,
			cost_budget: null,
			cost_used: 0,
			service_tier: null,
			workspace: "/workspace",
			handoff: {
				visible_transcript_chars: 1_200,
				selected_relics: 1,
			},
		});
		await updateHlidDelegationTokens("delegation-1", 800);
		await updateHlidDelegationTokens("delegation-1", 700);
		expect(await getHlidDelegation("delegation-1")).toMatchObject({
			tokens_used: 800,
		});
		await updateHlidDelegationCost("delegation-1", 1.25);
		await updateHlidDelegationCost("delegation-1", 0.75);
		expect(await getHlidDelegation("delegation-1")).toMatchObject({
			cost_used: 1.25,
		});

		await markHlidDelegationRunning("delegation-1");
		await finishHlidDelegation("delegation-1", {
			status: "cancelled",
			error: "Cancelled by parent",
		});
		await finishHlidDelegation("delegation-1", {
			status: "completed",
			resultText: "Late completion",
		});
		expect(await getHlidDelegation("delegation-1")).toMatchObject({
			status: "cancelled",
			result_text: null,
		});

		expect(await interruptActiveHlidDelegationsAfterRestart()).toBe(1);
		expect(await getHlidDelegation("delegation-2")).toMatchObject({
			status: "interrupted",
			resumable: true,
		});
		const attemptTwo = await resumeHlidDelegation("delegation-2", {
			continuationMode: "explicit_new_turn",
			timeoutSeconds: 300,
			permissionMode: "plan",
			handoff: {
				visible_transcript_chars: 500,
				selected_skills: 0,
				selected_relics: 0,
				vault_references: 0,
				workspace_references: 0,
			},
		});
		expect(attemptTwo).toMatchObject({
			status: "pending",
			attempt_count: 2,
			continuation_mode: "explicit_new_turn",
			timeout_seconds: 300,
			token_budget: null,
			cost_budget: null,
		});
		expect(await getSessionById("child-2")).toMatchObject({
			provider_id: "codex",
			selected_model: "gpt-5.6-sol",
			selected_effort: "high",
			selected_permission_mode: "plan",
		});
		expect(await interruptActiveHlidDelegationsAfterRestart()).toBe(1);
		const attemptThree = await resumeHlidDelegation("delegation-2", {
			continuationMode: "explicit_new_turn",
			timeoutSeconds: 300,
			permissionMode: "plan",
			handoff: delegationInput.handoff,
		});
		expect(attemptThree).toMatchObject({
			attempt_count: 3,
			cost_budget: null,
			resumable: false,
		});
		expect(await interruptActiveHlidDelegationsAfterRestart()).toBe(1);
		expect(
			await resumeHlidDelegation("delegation-2", {
				continuationMode: "explicit_new_turn",
				timeoutSeconds: 300,
				permissionMode: "plan",
				handoff: delegationInput.handoff,
			}),
		).toBeNull();
	});
});
