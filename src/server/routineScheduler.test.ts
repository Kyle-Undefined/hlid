import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
	finishRoutineRun: vi.fn(),
	getRoutine: vi.fn(),
	pauseRoutine: vi.fn(),
	renewRoutineRunLease: vi.fn(),
	routineRunNotificationPolicy: vi.fn((selected: RoutineRunRow) =>
		JSON.parse(selected.notification_policy_json),
	),
}));

vi.mock("../db", () => db);

const runRoutineSession = vi.hoisted(() => vi.fn());
vi.mock("./sessionRunner", () => ({ runRoutineSession }));

const bumpDataRevision = vi.hoisted(() => vi.fn());
vi.mock("./dataRevision", () => ({ bumpDataRevision }));

import type { RoutineRunRow } from "../db";
import type { ProviderInfo } from "../lib/providerTypes";
import type { RoutineSummary } from "../lib/routines";
import type { HlidDelegationManager } from "./hlidDelegation";
import {
	type RoutineRunCompletionEvent,
	RoutineScheduler,
} from "./routineScheduler";
import type { SessionPool } from "./sessionPool";
import type { RoutineSessionResult } from "./sessionRunner";

const routine: RoutineSummary = {
	id: "routine-1",
	name: "Daily review",
	prompt: "Review the project",
	enabled: true,
	archived: false,
	revision: 1,
	schedule: {
		kind: "interval",
		everyMinutes: 60,
		anchorAt: "2026-08-13T00:00:00Z",
	},
	timezone: "UTC",
	nextRunAt: null,
	providerId: "codex",
	model: "gpt-5.6-sol",
	effort: "high",
	agentCwd: "/work/project",
	agentName: "Routine",
	skillContexts: [],
	providerCommands: [],
	vaultReferences: [],
	relicIds: [],
	permissionMode: "preapproved",
	grants: [],
	deliveries: [],
	notificationPolicy: {
		success: "default",
		actionRequired: "default",
		failure: "default",
		targets: { kind: "all" },
	},
	catchUpWindowMinutes: 60,
	noOverlap: true,
	pausedReason: null,
	authorizationFingerprint: "fingerprint",
	createdAt: 10,
	updatedAt: 20,
};

const run: RoutineRunRow = {
	id: "routine-run-1",
	routine_id: routine.id,
	routine_revision: routine.revision,
	profile_id: "profile-1",
	authorization_fingerprint: routine.authorizationFingerprint,
	trigger: "scheduled",
	scheduled_for: 100,
	claimed_at: 105,
	lease_owner: "boot",
	lease_expires_at: 225,
	started_at: null,
	finished_at: null,
	status: "claimed",
	session_id: null,
	provider_used: null,
	error: null,
	action_required: null,
	delivery_json: null,
	notification_policy_json: JSON.stringify(routine.notificationPolicy),
	created_at: 101,
};

type ExecutableRoutineScheduler = {
	execute(run: RoutineRunRow): Promise<void>;
};

async function execute(
	scheduler: RoutineScheduler,
	routineRun = run,
): Promise<void> {
	await (scheduler as unknown as ExecutableRoutineScheduler).execute(
		routineRun,
	);
}

function scheduler(onRunComplete?: (event: RoutineRunCompletionEvent) => void) {
	return new RoutineScheduler(
		{} as SessionPool,
		{} as HlidDelegationManager,
		async () => [] satisfies ProviderInfo[],
		undefined,
		onRunComplete,
	);
}

describe("RoutineScheduler durable completion callback", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.spyOn(Date, "now").mockReturnValue(200_000);
		db.getRoutine.mockResolvedValue(routine);
		db.finishRoutineRun.mockResolvedValue(undefined);
		db.pauseRoutine.mockResolvedValue(undefined);
		db.renewRoutineRunLease.mockResolvedValue(true);
	});

	afterEach(() => vi.restoreAllMocks());

	it.each<{
		label: string;
		result: RoutineSessionResult;
		reason: RoutineRunCompletionEvent["reason"];
		message: string;
		paused: boolean;
	}>([
		{
			label: "success",
			result: {
				status: "succeeded",
				sessionId: "root-session",
				startedAt: 150,
			},
			reason: "routine_succeeded",
			message: "Daily review finished successfully.",
			paused: false,
		},
		{
			label: "action required",
			result: {
				status: "action_required",
				sessionId: "root-session",
				startedAt: 150,
				actionRequired: "Approval is required",
			},
			reason: "routine_action_required",
			message: "Daily review needs action: Approval is required",
			paused: true,
		},
		{
			label: "failure",
			result: {
				status: "failed",
				sessionId: "root-session",
				startedAt: 150,
				error: "Provider session failed",
			},
			reason: "routine_failed",
			message: "Daily review failed: Provider session failed",
			paused: false,
		},
		{
			label: "delivery error",
			result: {
				status: "delivery_error",
				sessionId: "root-session",
				startedAt: 150,
				delivery: [
					{ kind: "relic", ok: false, error: "Vault delivery failed" },
				],
			},
			reason: "routine_delivery_error",
			message:
				"Daily review finished, but delivery failed: Vault delivery failed",
			paused: false,
		},
		{
			label: "provider unavailable without a Raven session",
			result: {
				status: "provider_unavailable",
				sessionId: null,
				error: "Provider codex is unavailable",
			},
			reason: "routine_provider_unavailable",
			message: "Daily review could not start: Provider codex is unavailable",
			paused: true,
		},
	])("emits $label exactly once after terminal persistence", async ({
		result,
		reason,
		message,
		paused,
	}) => {
		const order: string[] = [];
		runRoutineSession.mockResolvedValue(result);
		db.finishRoutineRun.mockImplementation(async () => {
			order.push("persisted");
		});
		db.pauseRoutine.mockImplementation(async () => {
			order.push("paused");
		});
		const onRunComplete = vi.fn((event: RoutineRunCompletionEvent) => {
			order.push("callback");
			expect(event).toMatchObject({
				routine,
				routineId: routine.id,
				runId: run.id,
				rootSessionId: result.sessionId,
				status: result.status,
				reason,
				message,
				createdAt: run.created_at,
				scheduledAt: run.scheduled_for,
				claimedAt: run.claimed_at,
				startedAt: result.startedAt ?? null,
				finishedAt: 200,
				url: "/?routine=routine-1&routine_run=routine-run-1",
			});
		});

		await execute(scheduler(onRunComplete));

		expect(order).toEqual(
			paused ? ["persisted", "paused", "callback"] : ["persisted", "callback"],
		);
		expect(db.finishRoutineRun).toHaveBeenCalledOnce();
		expect(onRunComplete).toHaveBeenCalledOnce();
		if (paused) expect(db.pauseRoutine).toHaveBeenCalledOnce();
		else expect(db.pauseRoutine).not.toHaveBeenCalled();
	});

	it("turns an unexpected runner rejection into one durable failure event", async () => {
		runRoutineSession.mockRejectedValue(new Error("Runner exploded"));
		const onRunComplete = vi.fn();

		await execute(scheduler(onRunComplete));

		expect(db.finishRoutineRun).toHaveBeenCalledWith({
			runId: run.id,
			status: "failed",
			now: 200,
			error: "Runner exploded",
			actionRequired: undefined,
			delivery: undefined,
		});
		expect(onRunComplete).toHaveBeenCalledOnce();
		expect(onRunComplete).toHaveBeenCalledWith(
			expect.objectContaining({
				status: "failed",
				reason: "routine_failed",
				rootSessionId: null,
			}),
		);
	});

	it("contains callback failures without changing the persisted outcome", async () => {
		runRoutineSession.mockResolvedValue({
			status: "succeeded",
			sessionId: "root-session",
			startedAt: 150,
		});
		const consoleError = vi
			.spyOn(console, "error")
			.mockImplementation(() => {});
		const onRunComplete = vi.fn(() => {
			throw new Error("Push bridge unavailable");
		});

		await expect(execute(scheduler(onRunComplete))).resolves.toBeUndefined();

		expect(db.finishRoutineRun).toHaveBeenCalledOnce();
		expect(onRunComplete).toHaveBeenCalledOnce();
		expect(consoleError).toHaveBeenCalledWith(
			`[routine ${run.id}] completion callback failed:`,
			"Push bridge unavailable",
		);
	});

	it("persists a provider-unavailable pause before waiting on notification recovery", async () => {
		runRoutineSession.mockResolvedValue({
			status: "provider_unavailable",
			sessionId: null,
			error: "Provider codex is unavailable",
		});
		let releaseCallback!: () => void;
		const callbackGate = new Promise<void>((resolve) => {
			releaseCallback = resolve;
		});
		const onRunComplete = vi.fn(() => callbackGate);

		const pending = execute(scheduler(onRunComplete));
		await vi.waitFor(() => expect(onRunComplete).toHaveBeenCalledOnce());
		expect(db.finishRoutineRun).toHaveBeenCalledOnce();
		expect(db.pauseRoutine).toHaveBeenCalledWith(
			routine.id,
			"Provider codex is unavailable",
		);
		expect(db.pauseRoutine.mock.invocationCallOrder[0]).toBeLessThan(
			onRunComplete.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
		);
		releaseCallback();
		await pending;
	});

	it("bounds terminal messages and encodes the exact Routine run target", async () => {
		const specialRun = {
			...run,
			id: "run&other=1",
			routine_id: "routine / one",
		};
		db.getRoutine.mockResolvedValue({
			...routine,
			id: specialRun.routine_id,
		});
		runRoutineSession.mockResolvedValue({
			status: "failed",
			sessionId: null,
			error: `Bad\u0000${"x".repeat(700)}`,
		});
		const onRunComplete = vi.fn();

		await execute(scheduler(onRunComplete), specialRun);

		const event = onRunComplete.mock.calls[0]?.[0];
		expect(event?.url).toBe(
			"/?routine=routine+%2F+one&routine_run=run%26other%3D1",
		);
		expect(event?.message).toHaveLength(500);
		expect(event?.message).not.toContain("\u0000");
	});
});
