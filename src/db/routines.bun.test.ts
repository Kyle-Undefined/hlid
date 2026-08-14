import { beforeEach, describe, expect, it } from "bun:test";
import { freshDb } from "./db.test-utils";
import {
	claimDueRoutineRuns,
	claimManualRoutineRun,
	createRoutine,
	finishRoutineRun,
	getRoutine,
	getRoutineRun,
	interruptStaleRoutineRuns,
	listRoutineRuns,
	listRoutineRunsNeedingNotification,
	listRoutines,
	markRoutineRunNotificationRecorded,
	routineRunNotificationPolicy,
	setRoutineEnabled,
	updateRoutine,
} from "./routines";
import { getDb, initializeSchema } from "./schema";

const definition = {
	name: "Claude daily review",
	prompt: "Review the project and report any regressions.",
	enabled: true,
	schedule: { kind: "daily" as const, time: "09:00" },
	timezone: "UTC",
	providerId: "claude",
	model: "claude-sonnet-4-5",
	effort: "high",
	agentCwd: "/workspace/project",
	agentName: "Project",
	skillContexts: [],
	providerCommands: ["research"],
	vaultReferences: [],
	relicIds: [],
	permissionMode: "preapproved" as const,
	grants: [
		{
			capability: "shell.exec" as const,
			command: "bun test",
			maxUsesPerRun: 1,
		},
	],
	deliveries: [{ kind: "relic" as const }],
	notificationPolicy: {
		success: "default" as const,
		actionRequired: "default" as const,
		failure: "default" as const,
		targets: { kind: "all" as const },
	},
	catchUpWindowMinutes: 360,
	noOverlap: true,
};

describe("routines database", () => {
	beforeEach(freshDb);

	it("persists a frozen Claude definition and reviewed grants", async () => {
		const created = await createRoutine(definition, 1_753_185_600);
		expect(created.providerId).toBe("claude");
		expect(created.model).toBe("claude-sonnet-4-5");
		expect(created.providerCommands).toEqual(["research"]);
		expect(typeof created.grants[0]?.id).toBe("string");
		expect(created.authorizationFingerprint).toHaveLength(64);
	});

	it("round-trips notification policy without widening authorization", async () => {
		const created = await createRoutine(definition, 1_753_185_600);
		const deviceIds = [
			"11111111-1111-4111-8111-111111111111",
			"22222222-2222-4222-8222-222222222222",
		];
		const updated = await updateRoutine(
			created.id,
			{
				...definition,
				grants: created.grants,
				notificationPolicy: {
					success: "notify",
					actionRequired: "default",
					failure: "mute",
					targets: { kind: "devices", deviceIds },
				},
			},
			1_753_185_601,
		);

		expect(updated.notificationPolicy).toEqual({
			success: "notify",
			actionRequired: "default",
			failure: "mute",
			targets: { kind: "devices", deviceIds },
		});
		expect(updated.authorizationFingerprint).toBe(
			created.authorizationFingerprint,
		);
		expect((await getRoutine(created.id))?.notificationPolicy).toEqual(
			updated.notificationPolicy,
		);
		expect(
			(await listRoutines()).find((routine) => routine.id === created.id)
				?.notificationPolicy,
		).toEqual(updated.notificationPolicy);
	});

	it("recovers a finished run from its claim-time notification policy snapshot", async () => {
		const created = await createRoutine(definition, 1_753_185_600);
		const snapshotPolicy = {
			success: "notify" as const,
			actionRequired: "mute" as const,
			failure: "notify" as const,
			targets: {
				kind: "devices" as const,
				deviceIds: ["11111111-1111-4111-8111-111111111111"],
			},
		};
		const snapshotted = await updateRoutine(
			created.id,
			{
				...definition,
				grants: created.grants,
				notificationPolicy: snapshotPolicy,
			},
			1_753_185_601,
		);
		const run = await claimManualRoutineRun({
			routineId: snapshotted.id,
			now: 1_753_200_000,
			leaseOwner: "boot",
			leaseSeconds: 120,
		});
		await updateRoutine(
			created.id,
			{
				...definition,
				grants: snapshotted.grants,
				notificationPolicy: {
					success: "mute",
					actionRequired: "notify",
					failure: "mute",
					targets: { kind: "all" },
				},
			},
			1_753_185_602,
		);
		await finishRoutineRun({
			runId: run.id,
			status: "succeeded",
			now: 1_753_200_010,
		});

		const [recovered] = await listRoutineRunsNeedingNotification({
			finishedSince: 1_753_200_000,
		});
		expect(recovered?.id).toBe(run.id);
		if (!recovered) throw new Error("Expected a recoverable Routine run");
		expect(routineRunNotificationPolicy(recovered)).toEqual(snapshotPolicy);
	});

	it("claims one due occurrence and advances the schedule atomically", async () => {
		const created = await createRoutine(definition, 1_753_185_600);
		const due = created.nextRunAt;
		expect(due).not.toBeNull();
		const claimed = await claimDueRoutineRuns({
			now: due as number,
			leaseOwner: "boot",
			leaseSeconds: 120,
		});
		expect(claimed).toHaveLength(1);
		expect(claimed[0]?.routine_revision).toBe(1);
		const advanced = await getRoutine(created.id);
		expect(advanced?.nextRunAt).toBeGreaterThan(due as number);
		const duplicate = await claimDueRoutineRuns({
			now: due as number,
			leaseOwner: "other",
			leaseSeconds: 120,
		});
		expect(duplicate).toEqual([]);
	});

	it("loads an exact run only through its owning Routine", async () => {
		const first = await createRoutine(definition, 1_753_185_600);
		const second = await createRoutine(
			{ ...definition, name: "Second review" },
			1_753_185_601,
		);
		const run = await claimManualRoutineRun({
			routineId: first.id,
			now: 1_753_200_000,
			leaseOwner: "boot",
			leaseSeconds: 120,
		});

		expect((await getRoutineRun(first.id, run.id))?.id).toBe(run.id);
		expect(await getRoutineRun(second.id, run.id)).toBeNull();
	});

	it("records missed catch-up windows instead of replaying every occurrence", async () => {
		const created = await createRoutine(
			{ ...definition, catchUpWindowMinutes: 5 },
			1_753_185_600,
		);
		const due = created.nextRunAt as number;
		const claimed = await claimDueRoutineRuns({
			now: due + 10 * 60,
			leaseOwner: "boot",
			leaseSeconds: 120,
		});
		expect(claimed).toEqual([]);
		expect((await listRoutineRuns(created.id))[0]?.status).toBe("missed");
	});

	it("skips an overlapping occurrence and preserves one active run", async () => {
		const created = await createRoutine(definition, 1_753_185_600);
		const firstDue = created.nextRunAt as number;
		const first = await claimDueRoutineRuns({
			now: firstDue,
			leaseOwner: "boot",
			leaseSeconds: 200_000,
		});
		expect(first).toHaveLength(1);
		const secondDue = (await getRoutine(created.id))?.nextRunAt as number;
		const second = await claimDueRoutineRuns({
			now: secondDue,
			leaseOwner: "boot",
			leaseSeconds: 120,
		});
		expect(second).toEqual([]);
		expect((await listRoutineRuns(created.id))[0]?.status).toBe(
			"skipped_overlap",
		);
	});

	it("marks an expired lease interrupted for restart recovery", async () => {
		const created = await createRoutine(definition, 1_753_185_600);
		const due = created.nextRunAt as number;
		await claimDueRoutineRuns({
			now: due,
			leaseOwner: "old-boot",
			leaseSeconds: 30,
		});
		expect(await interruptStaleRoutineRuns(due + 31)).toBe(1);
		const interrupted = (await listRoutineRuns(created.id))[0];
		expect(interrupted?.status).toBe("interrupted");
		expect(interrupted?.finished_at).toBe(due + 31);
		expect(
			(
				await listRoutineRunsNeedingNotification({
					finishedSince: due,
				})
			).map((candidate) => candidate.id),
		).toContain(interrupted?.id);
	});

	it("revokes the old authorization snapshot when a definition changes", async () => {
		const created = await createRoutine(definition, 1_753_185_600);
		const updated = await updateRoutine(
			created.id,
			{
				...definition,
				prompt: "Use the revised review prompt.",
				// The manager returns persisted grant IDs when editing an existing
				// Routine. A new immutable profile must replace those IDs safely.
				grants: created.grants,
			},
			1_753_185_601,
		);
		expect(updated.revision).toBe(2);
		expect(updated.authorizationFingerprint).not.toBe(
			created.authorizationFingerprint,
		);
		expect(updated.grants[0]?.id).not.toBe(created.grants[0]?.id);
	});

	it("can pause and re-enable a completed Routine", async () => {
		const created = await createRoutine(definition, 1_753_185_600);
		const disabled = await setRoutineEnabled(created.id, false, 1_753_185_601);
		expect(disabled.nextRunAt).toBeNull();
		const enabled = await setRoutineEnabled(created.id, true, 1_753_185_602);
		expect(enabled.nextRunAt).not.toBeNull();
		const due = enabled.nextRunAt as number;
		const [run] = await claimDueRoutineRuns({
			now: due,
			leaseOwner: "boot",
			leaseSeconds: 120,
		});
		await finishRoutineRun({
			runId: run?.id ?? "",
			status: "succeeded",
			now: due + 10,
		});
		expect((await listRoutineRuns(created.id))[0]?.status).toBe("succeeded");
	});

	it("derives attention from the latest persisted Routine run", async () => {
		const created = await createRoutine(definition, 1_753_185_600);
		const due = created.nextRunAt as number;
		const [run] = await claimDueRoutineRuns({
			now: due,
			leaseOwner: "boot",
			leaseSeconds: 120,
		});
		expect((await getRoutine(created.id))?.attention).toMatchObject({
			bucket: "queued",
			reason: "routine_queued",
		});

		await finishRoutineRun({
			runId: run?.id ?? "",
			status: "action_required",
			now: due + 1,
			actionRequired: "Approval needed",
		});
		expect((await getRoutine(created.id))?.attention).toMatchObject({
			bucket: "needs_attention",
			reason: "routine_action_required",
		});
	});

	it("recovers only unrecorded terminal runs in bounded oldest-first order", async () => {
		const created = await createRoutine(definition, 1_753_185_600);
		const statuses = [
			"succeeded",
			"action_required",
			"failed",
			"delivery_error",
			"provider_unavailable",
			"interrupted",
		] as const;
		const runs = [];
		for (const [index, status] of statuses.entries()) {
			const now = 1_753_200_000 + index * 10;
			const run = await claimManualRoutineRun({
				routineId: created.id,
				now,
				leaseOwner: "boot",
				leaseSeconds: 120,
			});
			await finishRoutineRun({ runId: run.id, status, now: now + 5 });
			runs.push(run);
		}

		expect(
			(
				await listRoutineRunsNeedingNotification({
					finishedSince: 1_753_200_000,
					limit: 2,
				})
			).map((run) => run.id),
		).toEqual([runs[0]?.id, runs[1]?.id]);

		expect(
			await markRoutineRunNotificationRecorded({
				runId: runs[0]?.id ?? "",
				eventId: "routine-event-1",
				recordedAt: 1_753_300_000,
			}),
		).toBe(true);
		expect(
			await markRoutineRunNotificationRecorded({
				runId: runs[0]?.id ?? "",
				eventId: "routine-event-duplicate",
				recordedAt: 1_753_300_001,
			}),
		).toBe(false);

		const pending = await listRoutineRunsNeedingNotification({
			finishedSince: 1_753_200_000,
			limit: 100,
		});
		expect(pending.map((run) => run.id)).toEqual([
			runs[1]?.id,
			runs[2]?.id,
			runs[3]?.id,
			runs[4]?.id,
			runs[5]?.id,
		]);

		const db = await getDb();
		expect(
			db
				.query<{ event_id: string; recorded_at: number }, [string]>(
					`SELECT event_id, recorded_at
					 FROM routine_run_notification_records WHERE run_id = ?`,
				)
				.get(runs[0]?.id ?? ""),
		).toEqual({
			event_id: "routine-event-1",
			recorded_at: 1_753_300_000,
		});
		expect(
			await markRoutineRunNotificationRecorded({
				runId: runs[5]?.id ?? "",
				recordedAt: 1_753_300_000,
			}),
		).toBe(true);
	});

	it("adds the recovery ledger without losing existing Routine runs", async () => {
		const created = await createRoutine(definition, 1_753_185_600);
		const run = await claimManualRoutineRun({
			routineId: created.id,
			now: 1_753_200_000,
			leaseOwner: "boot",
			leaseSeconds: 120,
		});
		await finishRoutineRun({
			runId: run.id,
			status: "succeeded",
			now: 1_753_200_005,
		});
		const db = await getDb();
		db.run(`DROP TABLE routine_run_notification_records`);
		db.run(
			`DELETE FROM settings
			 WHERE key = '_migrated_routine_run_notification_records_v1'`,
		);

		initializeSchema(db);

		expect(
			(
				await listRoutineRunsNeedingNotification({
					finishedSince: 1_753_200_000,
				})
			).map((candidate) => candidate.id),
		).toEqual([run.id]);

		// Reapplying around a restored migration flag is harmless too.
		db.run(
			`DELETE FROM settings
			 WHERE key = '_migrated_routine_run_notification_records_v1'`,
		);
		initializeSchema(db);
		expect(
			db
				.query<{ count: number }, []>(
					`SELECT COUNT(*) AS count FROM routine_run_notification_records`,
				)
				.get(),
		).toEqual({ count: 0 });
	});
});
