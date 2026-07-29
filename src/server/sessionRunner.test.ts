import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
	getAttachment: vi.fn(),
	markRoutineRunRunning: vi.fn(),
	recordRoutineGrantUse: vi.fn(),
	pauseRoutine: vi.fn(),
}));

vi.mock("../db", () => db);

const deliverRoutineResult = vi.hoisted(() => vi.fn());
vi.mock("./routineDelivery", () => ({ deliverRoutineResult }));

import type { RoutineRunRow } from "../db";
import type { RoutinePermissionContext } from "../lib/routinePermissions";
import type { RoutineSummary } from "../lib/routines";
import type { HlidDelegationManager } from "./hlidDelegation";
import type { HlidDelegationSnapshot } from "./hlidDelegationSchemas";
import type { SessionPool } from "./sessionPool";
import { runRoutineSession } from "./sessionRunner";

const routine: RoutineSummary = {
	id: "routine-1",
	name: "Routine",
	prompt: "Delegate the work",
	enabled: true,
	archived: false,
	revision: 1,
	schedule: {
		kind: "interval",
		everyMinutes: 60,
		anchorAt: "2026-07-28T00:00:00Z",
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
	grants: [
		{
			id: "grant-1",
			capability: "hlid.call",
			tool: "mcp__hlid__delegate_hlid_agent",
			maxUsesPerRun: 1,
		},
	],
	deliveries: [],
	catchUpWindowMinutes: 60,
	noOverlap: true,
	pausedReason: null,
	authorizationFingerprint: "fingerprint",
	createdAt: 1,
	updatedAt: 1,
};

const run: RoutineRunRow = {
	id: "routine-run-1",
	routine_id: "routine-1",
	routine_revision: 1,
	profile_id: "profile-1",
	authorization_fingerprint: "fingerprint",
	trigger: "scheduled",
	scheduled_for: 1,
	claimed_at: 1,
	lease_owner: "boot",
	lease_expires_at: 120,
	started_at: null,
	finished_at: null,
	status: "claimed",
	session_id: null,
	provider_used: null,
	error: null,
	action_required: null,
	delivery_json: null,
	created_at: 1,
};

function child(
	status: HlidDelegationSnapshot["status"],
): HlidDelegationSnapshot {
	return {
		id: "delegation-1",
		parent_session_id: "routine-session",
		parent_turn_id: "routine-turn",
		parent_label: "Routine",
		parent_delegation_id: null,
		routine_run_id: run.id,
		child_session_id: "child-session",
		depth: 1,
		task: "Do work",
		provider_id: "codex",
		model: "gpt-5.6-sol",
		effort: "high",
		service_tier: null,
		workspace: "/work/project",
		permission_mode: "default",
		timeout_seconds: 600,
		token_budget: null,
		tokens_used: 0,
		cost_budget: null,
		cost_used: 0,
		attempt_count: 1,
		continuation_mode: "initial",
		handoff: {
			visible_transcript_chars: 0,
			selected_skills: 0,
			selected_relics: 0,
			vault_references: 0,
			workspace_references: 0,
		},
		status,
		started_at: 1,
		updated_at: 1,
		ended_at: status === "completed" ? 2 : null,
		result_text: status === "completed" ? "done" : null,
		error: null,
		progress_text: null,
		open_url: "/raven?session=child-session",
		complete: status !== "pending" && status !== "running",
		resumable: false,
	};
}

describe("Routine detached delegation ownership", () => {
	let routineContext: RoutinePermissionContext | undefined;
	let close: ReturnType<typeof vi.fn>;
	let waitForRoutineRun: ReturnType<typeof vi.fn>;
	let cancelRoutineRun: ReturnType<typeof vi.fn>;
	let pool: SessionPool;
	let delegations: HlidDelegationManager;

	beforeEach(() => {
		vi.clearAllMocks();
		close = vi.fn();
		waitForRoutineRun = vi.fn().mockResolvedValue([child("completed")]);
		cancelRoutineRun = vi.fn().mockResolvedValue(undefined);
		const manager = {
			setProvider: vi.fn().mockResolvedValue(undefined),
			getProviderId: vi.fn().mockReturnValue("codex"),
			runQuery: vi.fn(
				async (_msg: unknown, _emit: unknown, options?: unknown) => {
					routineContext = (
						options as { routineContext?: RoutinePermissionContext }
					)?.routineContext;
				},
			),
			getStatus: vi.fn().mockReturnValue({ state: "idle" }),
		};
		pool = {
			getProvider: vi.fn().mockReturnValue({
				providerId: "codex",
				check: vi.fn().mockResolvedValue({ available: true }),
			}),
			create: vi.fn().mockReturnValue({
				sessionId: "routine-session",
				manager,
				runState: { broadcast: vi.fn() },
			}),
			close,
		} as unknown as SessionPool;
		delegations = {
			waitForRoutineRun,
			cancelRoutineRun,
		} as unknown as HlidDelegationManager;
		db.markRoutineRunRunning.mockResolvedValue(undefined);
		db.recordRoutineGrantUse.mockResolvedValue(undefined);
		db.pauseRoutine.mockResolvedValue(undefined);
		deliverRoutineResult.mockResolvedValue([]);
	});

	it("closes the parent provider session before waiting for owned children", async () => {
		waitForRoutineRun.mockImplementation(async () => {
			expect(close).toHaveBeenCalledWith("routine-session");
			return [child("completed")];
		});

		const result = await runRoutineSession({
			pool,
			delegations,
			routine,
			run,
		});

		expect(result.status).toBe("succeeded");
		expect(waitForRoutineRun).toHaveBeenCalledWith(run.id);
		expect(routineContext).toMatchObject({
			routineId: routine.id,
			runId: run.id,
			profileId: run.profile_id,
			authorizationFingerprint: run.authorization_fingerprint,
		});
	});

	it("handles a late child approval boundary as Routine action required", async () => {
		waitForRoutineRun.mockImplementation(async () => {
			expect(close).toHaveBeenCalledWith("routine-session");
			if (!routineContext) throw new Error("Routine context was not captured");
			const reason = "No Routine grant matches fs.write via Write";
			routineContext.actionRequired = { tool: "Write", reason };
			await routineContext.onActionRequired?.(reason);
			return [child("cancelled")];
		});

		const result = await runRoutineSession({
			pool,
			delegations,
			routine,
			run,
		});

		expect(result).toMatchObject({
			status: "action_required",
			actionRequired: "No Routine grant matches fs.write via Write",
		});
		expect(db.pauseRoutine).toHaveBeenCalledWith(
			routine.id,
			expect.stringContaining("No Routine grant"),
		);
		expect(cancelRoutineRun).toHaveBeenCalledWith(run.id);
		expect(deliverRoutineResult).not.toHaveBeenCalled();
	});
});
