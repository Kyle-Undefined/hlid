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
import type { ProviderInfo } from "../lib/providerTypes";
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
	notification_policy_json: JSON.stringify(routine.notificationPolicy),
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
	let inputOrigin: string | undefined;
	let queryAgentCwd: string | undefined;
	let close: ReturnType<typeof vi.fn>;
	let check: ReturnType<typeof vi.fn>;
	let providerRuntimeCwd: ReturnType<typeof vi.fn>;
	let providerCatalog: ReturnType<
		typeof vi.fn<(cwd: string) => Promise<ProviderInfo[]>>
	>;
	let waitForRoutineRun: ReturnType<typeof vi.fn>;
	let cancelRoutineRun: ReturnType<typeof vi.fn>;
	let pool: SessionPool;
	let delegations: HlidDelegationManager;

	beforeEach(() => {
		vi.clearAllMocks();
		inputOrigin = undefined;
		queryAgentCwd = undefined;
		close = vi.fn();
		check = vi.fn().mockResolvedValue({ available: true });
		providerRuntimeCwd = vi.fn((cwd: string) => cwd);
		providerCatalog = vi.fn(
			async (_cwd: string) =>
				[
					{
						id: "codex",
						label: "Codex",
						available: true,
						models: [
							{
								value: routine.model,
								label: routine.model,
								efforts: [{ value: routine.effort, label: "High" }],
							},
						],
						permissionModes: [
							{ value: "default", label: "Default" },
							{ value: "bypassPermissions", label: "Bypass" },
						],
					},
				] satisfies ProviderInfo[],
		);
		waitForRoutineRun = vi.fn().mockResolvedValue([child("completed")]);
		cancelRoutineRun = vi.fn().mockResolvedValue(undefined);
		const manager = {
			setProvider: vi.fn().mockResolvedValue(undefined),
			getProviderId: vi.fn().mockReturnValue("codex"),
			runQuery: vi.fn(
				async (_msg: unknown, _emit: unknown, options?: unknown) => {
					const runOptions = options as {
						routineContext?: RoutinePermissionContext;
						inputOrigin?: string;
						agentCwd?: string;
					};
					routineContext = runOptions?.routineContext;
					inputOrigin = runOptions?.inputOrigin;
					queryAgentCwd = runOptions?.agentCwd;
				},
			),
			getStatus: vi.fn().mockReturnValue({ state: "idle" }),
		};
		pool = {
			providerRuntimeCwd,
			getProvider: vi.fn().mockReturnValue({
				providerId: "codex",
				check,
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
			providerCatalog,
			routine,
			run,
		});

		expect(result).toMatchObject({
			status: "succeeded",
			startedAt: expect.any(Number),
		});
		expect(db.markRoutineRunRunning).toHaveBeenCalledWith({
			runId: run.id,
			sessionId: "routine-session",
			providerUsed: routine.providerId,
			now: result.startedAt,
		});
		expect(providerRuntimeCwd).toHaveBeenCalledWith(routine.agentCwd);
		expect(check).toHaveBeenCalledWith({ cwd: routine.agentCwd });
		expect(providerCatalog).toHaveBeenCalledWith(routine.agentCwd);
		expect(waitForRoutineRun).toHaveBeenCalledWith(run.id);
		expect(inputOrigin).toBe("scheduled-task");
		expect(routineContext).toMatchObject({
			routineId: routine.id,
			runId: run.id,
			profileId: run.profile_id,
			authorizationFingerprint: run.authorization_fingerprint,
		});
	});

	it("checks a context-mode WSL Routine against its Windows vault runtime", async () => {
		const agentCwd =
			"\\\\wsl.localhost\\Ubuntu-24.04\\home\\kyle\\context-agent";
		const vaultCwd = "C:\\Users\\kyle\\Fornbok";
		providerRuntimeCwd.mockReturnValue(vaultCwd);

		const result = await runRoutineSession({
			pool,
			delegations,
			providerCatalog,
			routine: { ...routine, agentCwd },
			run,
		});

		expect(result.status).toBe("succeeded");
		expect(providerRuntimeCwd).toHaveBeenCalledWith(agentCwd);
		expect(check).toHaveBeenCalledWith({ cwd: vaultCwd });
		expect(providerCatalog).toHaveBeenCalledWith(vaultCwd);
		expect(pool.create).toHaveBeenCalledWith(agentCwd, routine.name, true);
		expect(queryAgentCwd).toBe(agentCwd);
	});

	it("rejects a Routine effort absent from the exact ACP model row", async () => {
		providerCatalog.mockResolvedValue([
			{
				id: "codex",
				label: "OpenCode",
				available: true,
				effortScope: "model",
				models: [{ value: routine.model, label: routine.model }],
				effortLevels: [{ value: routine.effort, label: "High" }],
				permissionModes: [{ value: "default", label: "Default" }],
			},
		]);

		const result = await runRoutineSession({
			pool,
			delegations,
			providerCatalog,
			routine,
			run,
		});

		expect(result).toMatchObject({
			status: "provider_unavailable",
			sessionId: null,
			error: expect.stringContaining(
				`Effort ${routine.effort} is not available for the selected OpenCode model`,
			),
		});
		expect(pool.create).not.toHaveBeenCalled();
	});

	it("rejects an explicit Routine model when the exact ACP catalog is empty", async () => {
		providerCatalog.mockResolvedValue([
			{
				id: "codex",
				label: "OpenCode",
				available: true,
				effortScope: "model",
				models: [],
				permissionModes: [{ value: "default", label: "Default" }],
			},
		]);

		const result = await runRoutineSession({
			pool,
			delegations,
			providerCatalog,
			routine: { ...routine, effort: "" },
			run,
		});

		expect(result).toMatchObject({
			status: "provider_unavailable",
			sessionId: null,
			error: expect.stringContaining(
				`Model ${routine.model} is not in OpenCode's current model catalog`,
			),
		});
		expect(pool.create).not.toHaveBeenCalled();
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
			providerCatalog,
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
