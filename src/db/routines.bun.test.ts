import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, it } from "bun:test";
import {
	claimDueRoutineRuns,
	createRoutine,
	finishRoutineRun,
	getRoutine,
	interruptStaleRoutineRuns,
	listRoutineRuns,
	setRoutineEnabled,
	updateRoutine,
} from "./routines";
import { setDbForTest } from "./schema";

function freshDb(): void {
	setDbForTest(new Database(":memory:"));
}

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
});
