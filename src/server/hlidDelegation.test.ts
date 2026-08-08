import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
	createSession: vi.fn(),
	setSessionAgentCwd: vi.fn(),
	setSessionProviderId: vi.fn(),
	setSessionPermissionMode: vi.fn(),
	rollbackHlidDelegationSetup: vi.fn(),
	createHlidDelegation: vi.fn(),
	getHlidDelegationByChildSession: vi.fn(),
	getHlidDelegationForParent: vi.fn(),
	listHlidDelegationsForParent: vi.fn(),
	listHlidDelegationsForRoutineRun: vi.fn(),
	listHlidDelegationsByParentDelegation: vi.fn(),
	countActiveHlidDelegations: vi.fn(),
	markHlidDelegationRunning: vi.fn(),
	updateHlidDelegationProgress: vi.fn(),
	updateHlidDelegationTokens: vi.fn(),
	updateHlidDelegationCost: vi.fn(),
	recordHlidDelegationPartialResult: vi.fn(),
	resumeHlidDelegation: vi.fn(),
	rollbackHlidDelegationResume: vi.fn(),
	finishHlidDelegation: vi.fn(),
	abandonInterruptedHlidDelegation: vi.fn(),
	getSessionMessages: vi.fn(),
	getSessionNextMessageSeq: vi.fn(),
	getSessionAgentCwd: vi.fn(),
}));

vi.mock("../db", () => db);

import type { ProviderInfo } from "../lib/providerTypes";
import type { RoutinePermissionContext } from "../lib/routinePermissions";
import {
	childPermissionModeAllowed,
	HlidDelegationManager,
} from "./hlidDelegation";
import {
	delegateHlidAgentSchema,
	type HlidDelegationSnapshot,
	resumeHlidAgentSchema,
} from "./hlidDelegationSchemas";
import type { ServerMessage } from "./protocol";
import type { SessionPool } from "./sessionPool";

function snapshot(
	overrides: Partial<HlidDelegationSnapshot> = {},
): HlidDelegationSnapshot {
	return {
		id: "delegation-1",
		parent_session_id: "parent-1",
		parent_turn_id: "turn-1",
		parent_label: "Parent task",
		parent_delegation_id: null,
		routine_run_id: null,
		child_session_id: "child-1",
		depth: 1,
		task: "Review the provider boundary",
		provider_id: "codex",
		model: "gpt-5.6-sol",
		effort: "high",
		service_tier: null,
		workspace: "/work/project",
		permission_mode: "acceptEdits",
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
		status: "pending",
		started_at: 1,
		updated_at: 1,
		ended_at: null,
		result_text: null,
		progress_text: null,
		error: null,
		open_url: "/raven?session=child-1",
		complete: false,
		resumable: false,
		...overrides,
	};
}

function installActiveCancellationControls(
	manager: HlidDelegationManager,
	delegationId: string,
): {
	abort: ReturnType<typeof vi.fn>;
	requestCancel: ReturnType<typeof vi.fn>;
} {
	const abort = vi.fn();
	const requestCancel = vi.fn();
	const active = (
		manager as unknown as {
			active: Map<
				string,
				{
					entry: { manager: { abort: () => void } };
					completion: Promise<void>;
					requestCancel: () => void;
				}
			>;
		}
	).active;
	active.set(delegationId, {
		entry: { manager: { abort } },
		completion: Promise.resolve(),
		requestCancel,
	});
	return { abort, requestCancel };
}

describe("Hlid delegation manager", () => {
	let persisted: HlidDelegationSnapshot | null;
	let parentStatus: {
		state: "running" | "idle";
		permission_mode: string;
		model: string;
		effort: string;
	};
	let parentProviderId: string;
	let parentTurnId: string | null;
	let parentEntryCwd: string;
	let parentManagerCwd: string | undefined;
	let parentRoutine: boolean;
	let parentRoutineContext: RoutinePermissionContext;
	let delegatedParent: HlidDelegationSnapshot | null;
	let parentHandoff: {
		skillContexts: string[];
		relics: Array<{
			id: string;
			path: string;
			filename: string;
			mime: string;
			kind: string;
			reference: "relic";
		}>;
		vaultReferences: string[];
		workspaceReferences: { relativePath: string; sha256: string }[];
		currentAssistantSequence: number | null;
	} | null;
	let pool: {
		findByDbSessionId: ReturnType<typeof vi.fn>;
		getProvider: ReturnType<typeof vi.fn>;
		resolveDelegationWorkspace: ReturnType<typeof vi.fn>;
		create: ReturnType<typeof vi.fn>;
		claimDbSessionId: ReturnType<typeof vi.fn>;
		close: ReturnType<typeof vi.fn>;
	};
	let childManager: {
		validatePermissionMode: ReturnType<typeof vi.fn>;
		setProvider: ReturnType<typeof vi.fn>;
		runQuery: ReturnType<typeof vi.fn>;
		getStatus: ReturnType<typeof vi.fn>;
		getCurrentSessionId: ReturnType<typeof vi.fn>;
		getCurrentTurnId: ReturnType<typeof vi.fn>;
		getProviderId: ReturnType<typeof vi.fn>;
		abort: ReturnType<typeof vi.fn>;
		isRunning: ReturnType<typeof vi.fn>;
		setPermissionMode: ReturnType<typeof vi.fn>;
		steerActiveTurn: ReturnType<typeof vi.fn>;
	};
	let broadcast: ReturnType<typeof vi.fn>;
	let childSubscriberCount: number;
	let statusChangedCalls: number;
	let catalog: ProviderInfo[];

	beforeEach(() => {
		vi.clearAllMocks();
		persisted = null;
		delegatedParent = null;
		parentHandoff = null;
		parentProviderId = "codex";
		parentTurnId = "turn-1";
		parentEntryCwd = "/work/project";
		parentManagerCwd = "/work/project";
		parentRoutine = false;
		parentRoutineContext = {
			routineId: "routine-1",
			runId: "routine-run-1",
			profileId: "routine-profile-1",
			revision: 1,
			authorizationFingerprint: "routine-fingerprint",
			mode: "preapproved",
			providerId: "codex",
			approvedCwd: "/work/project",
			grants: [],
			onGrantUsed: vi.fn(),
			onActionRequired: vi.fn(),
		};
		parentStatus = {
			state: "running",
			permission_mode: "acceptEdits",
			model: "gpt-5.6-sol",
			effort: "high",
		};
		broadcast = vi.fn();
		childSubscriberCount = 0;
		statusChangedCalls = 0;
		childManager = {
			validatePermissionMode: vi.fn().mockResolvedValue(undefined),
			setProvider: vi.fn().mockResolvedValue(undefined),
			runQuery: vi.fn().mockResolvedValue(undefined),
			getStatus: vi.fn().mockReturnValue({
				state: "idle",
				model: "gpt-5.6-sol",
				effort: "high",
			}),
			getCurrentSessionId: vi.fn().mockReturnValue("child-1"),
			getCurrentTurnId: vi.fn().mockReturnValue("child-active-turn"),
			getProviderId: vi.fn().mockReturnValue("codex"),
			abort: vi.fn(),
			isRunning: vi.fn().mockReturnValue(false),
			setPermissionMode: vi.fn().mockResolvedValue(undefined),
			steerActiveTurn: vi.fn().mockResolvedValue({
				targetTurnId: "child-active-turn",
				targetAssistantSeq: 4,
				steerSeq: 5,
				steerToolEventIndex: 2,
			}),
		};
		const parent = {
			get agentCwd() {
				return parentEntryCwd;
			},
			manager: {
				getCurrentSessionId: vi.fn().mockReturnValue("parent-1"),
				getCurrentTurnId: vi.fn(() => parentTurnId),
				getAgentCwd: vi.fn(() => parentManagerCwd),
				getCurrentTurnPermissionMode: vi.fn(() => parentStatus.permission_mode),
				isCurrentTurnRoutine: vi.fn(() => parentRoutine),
				getCurrentRoutinePermissionContext: vi.fn(() =>
					parentRoutine ? parentRoutineContext : null,
				),
				getStatus: vi.fn(() => parentStatus),
				getProviderId: vi.fn(() => parentProviderId),
				getSessionLabel: vi.fn().mockReturnValue("Parent task"),
				getCurrentDelegationHandoff: vi.fn(() => parentHandoff),
			},
		};
		const child = {
			sessionId: "child-1",
			agentCwd: "/work/project",
			manager: childManager,
			runState: {
				broadcast,
				getSubscriberCount: vi.fn(() => childSubscriberCount),
			},
		};
		const providers = {
			codex: {
				providerId: "codex",
				label: "Codex",
				check: vi.fn().mockResolvedValue({ available: true }),
			},
			claude: {
				providerId: "claude",
				label: "Claude",
				check: vi.fn().mockResolvedValue({ available: true }),
			},
			"cliproxy-claude": {
				providerId: "cliproxy-claude",
				label: "Claude via CLIProxy",
				check: vi.fn().mockResolvedValue({ available: true }),
			},
		};
		pool = {
			findByDbSessionId: vi.fn((id: string) =>
				id === "parent-1" ? parent : id === "child-1" ? child : undefined,
			),
			getProvider: vi.fn((id: keyof typeof providers) => providers[id]),
			resolveDelegationWorkspace: vi.fn((cwd: string) => cwd),
			create: vi.fn().mockReturnValue(child),
			claimDbSessionId: vi.fn().mockReturnValue(child),
			close: vi.fn(),
		};
		catalog = [
			{
				id: "codex",
				label: "Codex",
				available: true,
				models: [
					{
						value: "gpt-5.6-sol",
						label: "GPT",
						efforts: [{ value: "high", label: "High" }],
						serviceTiers: [
							{ value: "standard", label: "Standard", isDefault: true },
							{ value: "fast", label: "Fast" },
						],
					},
				],
				permissionModes: [
					{ value: "default", label: "Default" },
					{ value: "acceptEdits", label: "Accept edits" },
					{ value: "plan", label: "Plan" },
				],
			},
			{
				id: "claude",
				label: "Claude",
				available: true,
				models: [
					{
						value: "claude-sonnet",
						label: "Claude Sonnet",
						efforts: [{ value: "medium", label: "Medium" }],
					},
				],
				permissionModes: [
					{ value: "default", label: "Default" },
					{ value: "acceptEdits", label: "Accept edits" },
					{ value: "bypassPermissions", label: "Bypass" },
					{ value: "plan", label: "Plan" },
				],
				sessionPermissionModes: [
					{ value: "default", label: "Default" },
					{ value: "acceptEdits", label: "Accept edits" },
					{ value: "bypassPermissions", label: "Bypass" },
					{ value: "plan", label: "Plan" },
					{ value: "dontAsk", label: "Pre-approved only" },
					{ value: "auto", label: "Auto" },
				],
			},
			{
				id: "cliproxy-claude",
				label: "Claude via CLIProxy",
				available: true,
				models: [{ value: "claude-sonnet", label: "Claude Sonnet" }],
				// A defensive fixture: even a bad catalog advertisement must not make
				// Claude Auto available through CLIProxy.
				sessionPermissionModes: [
					{ value: "default", label: "Default" },
					{ value: "auto", label: "Auto" },
				],
			},
		] as ProviderInfo[];

		db.createSession.mockResolvedValue(undefined);
		db.setSessionAgentCwd.mockResolvedValue(undefined);
		db.setSessionProviderId.mockResolvedValue(undefined);
		db.setSessionPermissionMode.mockResolvedValue(undefined);
		db.rollbackHlidDelegationSetup.mockImplementation(async () => {
			persisted = null;
		});
		db.getHlidDelegationByChildSession.mockImplementation(async () => {
			return delegatedParent;
		});
		db.createHlidDelegation.mockImplementation(async (input) => {
			persisted = snapshot({
				id: input.id,
				parent_session_id: input.parentSessionId,
				parent_turn_id: input.parentTurnId,
				parent_label: input.parentLabel,
				parent_delegation_id: input.parentDelegationId,
				routine_run_id: input.routineRunId,
				child_session_id: input.childSessionId,
				depth: input.depth,
				task: input.task,
				provider_id: input.providerId,
				model: input.model,
				effort: input.effort,
				service_tier: input.serviceTier,
				workspace: input.workspace,
				permission_mode: input.permissionMode,
				timeout_seconds: input.timeoutSeconds,
				token_budget: null,
				cost_budget: null,
				handoff: input.handoff,
			});
			return persisted;
		});
		db.getHlidDelegationForParent.mockImplementation(
			async (id, parentSessionId) => {
				const current = persisted;
				if (!current) return null;
				return current.id === id &&
					current.parent_session_id === parentSessionId
					? current
					: null;
			},
		);
		db.markHlidDelegationRunning.mockImplementation(async () => {
			if (persisted?.status !== "pending") return null;
			persisted = { ...persisted, status: "running" };
			return persisted;
		});
		db.countActiveHlidDelegations.mockResolvedValue(0);
		db.updateHlidDelegationProgress.mockImplementation(async (_id, text) => {
			if (persisted && ["pending", "running"].includes(persisted.status)) {
				persisted = { ...persisted, progress_text: text };
			}
			return persisted;
		});
		db.finishHlidDelegation.mockImplementation(async (_id, input) => {
			if (persisted && ["pending", "running"].includes(persisted.status)) {
				persisted = {
					...persisted,
					status: input.status,
					result_text: input.resultText ?? null,
					progress_text: null,
					error: input.error ?? null,
					complete: true,
				};
			}
			return persisted;
		});
		db.abandonInterruptedHlidDelegation.mockImplementation(
			async (_id, error) => {
				if (persisted?.status === "interrupted" && persisted.resumable) {
					persisted = {
						...persisted,
						status: "cancelled",
						resumable: false,
						error,
						progress_text: null,
						complete: true,
					};
				}
				return persisted;
			},
		);
		db.updateHlidDelegationTokens.mockImplementation(async (_id, tokens) => {
			if (persisted) {
				persisted = {
					...persisted,
					tokens_used: Math.max(persisted.tokens_used, tokens),
				};
			}
			return persisted;
		});
		db.updateHlidDelegationCost.mockImplementation(async (_id, cost) => {
			if (persisted) {
				persisted = {
					...persisted,
					cost_used: Math.max(persisted.cost_used, cost),
				};
			}
			return persisted;
		});
		db.recordHlidDelegationPartialResult.mockImplementation(
			async (_id, resultText) => {
				if (persisted && persisted.result_text === null) {
					persisted = { ...persisted, result_text: resultText };
				}
				return persisted;
			},
		);
		db.resumeHlidDelegation.mockImplementation(async (_id, input) => {
			if (persisted?.status !== "interrupted") return null;
			persisted = {
				...persisted,
				status: "pending",
				complete: false,
				resumable: false,
				attempt_count: persisted.attempt_count + 1,
				continuation_mode: input.continuationMode,
				timeout_seconds: input.timeoutSeconds,
				token_budget: null,
				cost_budget: null,
				permission_mode: input.permissionMode,
				handoff: input.handoff,
			};
			return persisted;
		});
		db.rollbackHlidDelegationResume.mockImplementation(
			async (_id, previous) => {
				persisted = previous;
				return persisted;
			},
		);
		db.listHlidDelegationsForParent.mockImplementation(async () =>
			persisted ? [persisted] : [],
		);
		db.listHlidDelegationsForRoutineRun.mockImplementation(async () =>
			persisted?.routine_run_id === parentRoutineContext.runId
				? [persisted]
				: [],
		);
		db.listHlidDelegationsByParentDelegation.mockResolvedValue([]);
		db.getSessionNextMessageSeq.mockResolvedValue(0);
		db.getSessionAgentCwd.mockResolvedValue("/work/project");
		db.getSessionMessages.mockResolvedValue([
			{ seq: 1, role: "assistant", text: "Completed child result" },
			{ seq: 2, role: "user", text: "A later interactive turn" },
			{ seq: 3, role: "assistant", text: "Later interactive result" },
		]);
	});

	it("creates a normal child, inherits same-provider settings, and retains a bounded result", async () => {
		const manager = new HlidDelegationManager(
			pool as unknown as SessionPool,
			async () => catalog,
			() => {
				statusChangedCalls++;
			},
		);

		const created = await manager.delegate("parent-1", {
			task: "Review the provider boundary",
			provider: "codex",
		});
		const completed = await manager.wait("parent-1", created.id, 1);

		expect(created).toMatchObject({
			parent_session_id: "parent-1",
			parent_turn_id: "turn-1",
			child_session_id: "child-1",
			status: "pending",
		});
		expect(db.createSession).toHaveBeenCalledWith(
			"child-1",
			"REVIEW THE PROVIDER BOUNDARY",
			"gpt-5.6-sol",
			{
				effort: "high",
				permissionMode: "acceptEdits",
				agentCwd: "/work/project",
				providerId: "codex",
			},
		);
		expect(childManager.setProvider).toHaveBeenCalledWith("codex", {
			model: "gpt-5.6-sol",
			effort: "high",
			serviceTier: undefined,
			permissionMode: "acceptEdits",
		});
		expect(childManager.runQuery).toHaveBeenCalledWith(
			"Review the provider boundary",
			expect.any(Function),
			expect.objectContaining({
				inputOrigin: "coordinator",
				sessionId: "child-1",
				skillContexts: [],
				attachments: [],
				agentCwd: "/work/project",
				turnId: expect.stringMatching(/^delegation-/),
				vaultReferences: [],
				workspaceReferences: [],
				backgroundSession: true,
			}),
		);
		expect(completed).toMatchObject({
			status: "completed",
			result_text: "Completed child result",
			complete: true,
		});
		expect(pool.close).toHaveBeenCalledOnce();
		expect(pool.close).toHaveBeenCalledWith("child-1");
		expect(db.finishHlidDelegation.mock.invocationCallOrder[0]).toBeLessThan(
			pool.close.mock.invocationCallOrder[0] ?? 0,
		);
		// Retiring the live provider entry does not delete the durable child.
		await expect(
			manager.inspect("parent-1", created.id),
		).resolves.toMatchObject({
			child_session_id: "child-1",
			status: "completed",
			result_text: "Completed child result",
		});
		expect(db.createHlidDelegation.mock.invocationCallOrder[0]).toBeLessThan(
			db.createSession.mock.invocationCallOrder[0] ?? 0,
		);
		expect(statusChangedCalls).toBeGreaterThan(0);
	});

	it("fails a provider turn that completes without an assistant result", async () => {
		db.getSessionMessages.mockResolvedValue([]);
		const manager = new HlidDelegationManager(
			pool as unknown as SessionPool,
			async () => catalog,
			() => {
				statusChangedCalls++;
			},
		);

		const created = await manager.delegate("parent-1", {
			task: "Complete without a result",
			provider: "codex",
		});
		const failed = await manager.wait("parent-1", created.id, 1);

		expect(failed).toMatchObject({
			status: "failed",
			result_text: null,
			error: "The delegated provider completed without an assistant result.",
			complete: true,
		});
		expect(db.finishHlidDelegation).toHaveBeenCalledWith(created.id, {
			status: "failed",
			error: "The delegated provider completed without an assistant result.",
		});
	});

	it("retires only the terminal nested child and leaves active descendants alone", async () => {
		delegatedParent = snapshot({
			id: "parent-delegation",
			parent_session_id: "root-session",
			child_session_id: "parent-1",
			depth: 1,
			status: "running",
			complete: false,
		});
		const manager = new HlidDelegationManager(
			pool as unknown as SessionPool,
			async () => catalog,
			() => {
				statusChangedCalls++;
			},
		);
		const descendantAbort = vi.fn();
		const neverSettles = new Promise<void>(() => {});
		const active = (
			manager as unknown as {
				active: Map<
					string,
					{
						entry: {
							sessionId: string;
							manager: { abort: () => void };
						};
						completion: Promise<void>;
						requestCancel: () => void;
						routineRunId: string | null;
					}
				>;
			}
		).active;
		active.set("active-descendant", {
			entry: {
				sessionId: "child-2",
				manager: { abort: descendantAbort },
			},
			completion: neverSettles,
			requestCancel: vi.fn(),
			routineRunId: null,
		});

		const created = await manager.delegate("parent-1", {
			task: "Complete one nested branch",
			provider: "codex",
		});
		const completed = await manager.wait("parent-1", created.id, 1);

		expect(completed).toMatchObject({
			parent_delegation_id: "parent-delegation",
			depth: 2,
			status: "completed",
		});
		expect(pool.close).toHaveBeenCalledOnce();
		expect(pool.close).toHaveBeenCalledWith("child-1");
		expect(pool.close).not.toHaveBeenCalledWith("child-2");
		expect(descendantAbort).not.toHaveBeenCalled();
		expect(active.has("active-descendant")).toBe(true);
	});

	it("does not retire a child before its provider turn reaches a terminal state", async () => {
		let releaseProvider: (() => void) | undefined;
		childManager.runQuery.mockReturnValue(
			new Promise<void>((resolve) => {
				releaseProvider = resolve;
			}),
		);
		const manager = new HlidDelegationManager(
			pool as unknown as SessionPool,
			async () => catalog,
			() => {
				statusChangedCalls++;
			},
		);

		const created = await manager.delegate("parent-1", {
			task: "Keep the active child alive",
			provider: "codex",
		});
		await vi.waitFor(() => expect(persisted?.status).toBe("running"));
		expect(pool.close).not.toHaveBeenCalled();

		releaseProvider?.();
		await manager.wait("parent-1", created.id, 1);
		expect(pool.close).toHaveBeenCalledOnce();
		expect(pool.close).toHaveBeenCalledWith("child-1");
	});

	it("does not close a terminal child's entry after it has begun another live turn", async () => {
		childManager.isRunning.mockReturnValue(true);
		const manager = new HlidDelegationManager(
			pool as unknown as SessionPool,
			async () => catalog,
			() => {
				statusChangedCalls++;
			},
		);

		const created = await manager.delegate("parent-1", {
			task: "Preserve a concurrently reused child entry",
			provider: "codex",
		});
		const completed = await manager.wait("parent-1", created.id, 1);

		expect(completed.status).toBe("completed");
		expect(pool.close).not.toHaveBeenCalled();
		expect(childManager.abort).not.toHaveBeenCalled();
	});

	it("retires an idle provider process without invalidating a connected child view", async () => {
		childSubscriberCount = 1;
		const manager = new HlidDelegationManager(
			pool as unknown as SessionPool,
			async () => catalog,
			() => {
				statusChangedCalls++;
			},
		);

		const created = await manager.delegate("parent-1", {
			task: "Keep the connected durable child view",
			provider: "codex",
		});
		const completed = await manager.wait("parent-1", created.id, 1);

		expect(completed.status).toBe("completed");
		expect(childManager.abort).toHaveBeenCalledOnce();
		expect(pool.close).not.toHaveBeenCalled();
		await expect(
			manager.inspect("parent-1", created.id),
		).resolves.toMatchObject({
			child_session_id: "child-1",
			status: "completed",
		});
	});

	it("persists meaningful bounded progress for the original parent card", async () => {
		childManager.runQuery.mockImplementation(async (_task, emit) => {
			emit({
				type: "status",
				state: "running",
				model: "gpt-5.6-sol",
			});
			emit({
				type: "tool_event",
				id: "tool-1",
				name: "Read",
				input: { path: "/private/path" },
			});
		});
		const manager = new HlidDelegationManager(
			pool as unknown as SessionPool,
			async () => catalog,
			() => {
				statusChangedCalls++;
			},
		);

		const created = await manager.delegate("parent-1", {
			task: "Report bounded progress",
			provider: "codex",
		});
		const completed = await manager.wait("parent-1", created.id, 1);

		expect(
			db.updateHlidDelegationProgress.mock.calls.map(([, text]) => text),
		).toEqual(["Provider turn running", "Using Read"]);
		expect(
			db.updateHlidDelegationProgress.mock.calls.flat().join(" "),
		).not.toContain("/private/path");
		expect(completed).toMatchObject({
			status: "completed",
			progress_text: null,
		});
	});

	it("validates and carries an exact service tier from the live model catalog", async () => {
		const manager = new HlidDelegationManager(
			pool as unknown as SessionPool,
			async () => catalog,
			() => {
				statusChangedCalls++;
			},
		);

		const created = await manager.delegate("parent-1", {
			task: "Use the selected service tier",
			provider: "codex",
			model: "gpt-5.6-sol",
			service_tier: "fast",
		});
		await manager.wait("parent-1", created.id, 1);

		expect(created.service_tier).toBe("fast");
		expect(childManager.setProvider).toHaveBeenCalledWith(
			"codex",
			expect.objectContaining({ serviceTier: "fast" }),
		);
		await expect(
			manager.delegate("parent-1", {
				task: "Reject catalog drift",
				provider: "codex",
				model: "gpt-5.6-sol",
				service_tier: "retired",
			}),
		).rejects.toThrow(
			"Service tier retired is not available for the selected Codex model",
		);
	});

	it("runs only in the exact configured workspace selected for the child", async () => {
		const manager = new HlidDelegationManager(
			pool as unknown as SessionPool,
			async () => catalog,
			() => {
				statusChangedCalls++;
			},
		);

		const created = await manager.delegate("parent-1", {
			task: "Work in another registered workspace",
			provider: "codex",
			cwd: "/work/other-project",
		});
		await manager.wait("parent-1", created.id, 1);
		expect(created.workspace).toBe("/work/other-project");
		expect(pool.create).toHaveBeenCalledWith(
			"/work/other-project",
			"Codex delegate",
			true,
		);

		pool.resolveDelegationWorkspace.mockReturnValueOnce(null);
		await expect(
			manager.delegate("parent-1", {
				task: "Reject an unregistered workspace",
				provider: "codex",
				cwd: "/tmp/unregistered",
			}),
		).rejects.toThrow(
			"not the configured vault or an exact registered workspace",
		);
	});

	it("records provider-reported cost without enforcing a ceiling", async () => {
		childManager.runQuery.mockImplementation(async (_task, emit) => {
			emit({
				type: "usage_update",
				input_tokens: 10,
				output_tokens: 5,
				cache_read_tokens: 0,
				cache_creation_tokens: 0,
				query_input_tokens: 10,
				query_output_tokens: 5,
				query_cache_read_tokens: 0,
				query_cache_creation_tokens: 0,
				query_estimated_cost: 0.05,
				tokens_in_context: 10,
			});
		});
		const manager = new HlidDelegationManager(
			pool as unknown as SessionPool,
			async () => catalog,
			() => {
				statusChangedCalls++;
			},
		);

		const created = await manager.delegate("parent-1", {
			task: "Track delegated cost",
			provider: "codex",
			model: "gpt-5.6-sol",
		});
		const completed = await manager.wait("parent-1", created.id, 1);

		expect(completed).toMatchObject({
			status: "completed",
			cost_budget: null,
			cost_used: 0.05,
		});
		expect(childManager.abort).not.toHaveBeenCalled();
	});

	it("does not require pricing when delegated usage is only observed", async () => {
		catalog[0] = {
			...catalog[0],
			models: [{ value: "unpriced-model", label: "Unpriced" }],
		};
		const manager = new HlidDelegationManager(
			pool as unknown as SessionPool,
			async () => catalog,
			() => {
				statusChangedCalls++;
			},
		);

		const created = await manager.delegate("parent-1", {
			task: "Run without a priced usage cap",
			provider: "codex",
			model: "unpriced-model",
		});
		const completed = await manager.wait("parent-1", created.id, 1);

		expect(completed).toMatchObject({
			status: "completed",
			model: "unpriced-model",
			cost_budget: null,
		});
	});

	it("enforces delegation-specific parent and global active limits", async () => {
		const manager = new HlidDelegationManager(
			pool as unknown as SessionPool,
			async () => catalog,
			() => {
				statusChangedCalls++;
			},
		);
		db.countActiveHlidDelegations.mockImplementation(async (parentId) =>
			parentId ? 4 : 4,
		);
		await expect(
			manager.delegate("parent-1", {
				task: "One child too many",
				provider: "codex",
			}),
		).rejects.toThrow("at most 4 active delegated children");

		db.countActiveHlidDelegations.mockImplementation(async (parentId) =>
			parentId ? 0 : 12,
		);
		await expect(
			manager.delegate("parent-1", {
				task: "One global child too many",
				provider: "codex",
			}),
		).rejects.toThrow("at most 12 delegated children");
		expect(pool.create).not.toHaveBeenCalled();

		persisted = snapshot({
			status: "interrupted",
			complete: true,
			resumable: true,
		});
		db.countActiveHlidDelegations.mockImplementation(async (parentId) =>
			parentId ? 4 : 4,
		);
		await expect(
			manager.resume("parent-1", persisted.id, {
				id: persisted.id,
				instruction: "Continue after restart",
			}),
		).rejects.toThrow("at most 4 active delegated children");
		expect(db.resumeHlidDelegation).not.toHaveBeenCalled();
	});

	it("preserves one shared Routine grant envelope in detached children", async () => {
		parentRoutine = true;
		const manager = new HlidDelegationManager(
			pool as unknown as SessionPool,
			async () => catalog,
			() => {
				statusChangedCalls++;
			},
		);

		const created = await manager.delegate("parent-1", {
			task: "Stay inside the Routine grant",
			provider: "codex",
		});
		await manager.waitForRoutineRun(parentRoutineContext.runId);
		expect(db.createHlidDelegation).toHaveBeenCalledWith(
			expect.objectContaining({
				routineRunId: parentRoutineContext.runId,
			}),
		);
		expect(childManager.runQuery.mock.calls[0]?.[2]?.routineContext).toBe(
			parentRoutineContext,
		);
		expect(childManager.runQuery.mock.calls[0]?.[2]?.inputOrigin).toBe(
			"coordinator",
		);
		expect(pool.close).toHaveBeenCalledWith("child-1");
		expect(created.routine_run_id).toBe(parentRoutineContext.runId);
		await expect(
			manager.resume("parent-1", "delegation-1", {
				id: "delegation-1",
				instruction: "Do not broaden a Routine grant",
			}),
		).rejects.toThrow("Routines cannot continue Hlid delegations");
	});

	it.each([
		{
			name: "Codex to Codex",
			parentProvider: "codex",
			parentModel: "gpt-5.6-sol",
			parentEffort: "high",
			childProvider: "codex",
			expectedModel: "gpt-5.6-sol",
			expectedEffort: "high",
		},
		{
			name: "Claude to Claude",
			parentProvider: "claude",
			parentModel: "claude-sonnet",
			parentEffort: "medium",
			childProvider: "claude",
			expectedModel: "claude-sonnet",
			expectedEffort: "medium",
		},
		{
			name: "Claude to Codex",
			parentProvider: "claude",
			parentModel: "claude-sonnet",
			parentEffort: "medium",
			childProvider: "codex",
			expectedModel: undefined,
			expectedEffort: undefined,
		},
		{
			name: "Codex to Claude",
			parentProvider: "codex",
			parentModel: "gpt-5.6-sol",
			parentEffort: "high",
			childProvider: "claude",
			expectedModel: undefined,
			expectedEffort: undefined,
		},
	])("inherits model and effort only for the same provider: $name", async ({
		parentProvider,
		parentModel,
		parentEffort,
		childProvider,
		expectedModel,
		expectedEffort,
	}) => {
		parentProviderId = parentProvider;
		parentStatus.model = parentModel;
		parentStatus.effort = parentEffort;
		const manager = new HlidDelegationManager(
			pool as unknown as SessionPool,
			async () => catalog,
			() => {
				statusChangedCalls++;
			},
		);

		const created = await manager.delegate("parent-1", {
			task: `Exercise ${parentProvider} to ${childProvider}`,
			provider: childProvider,
		});
		await manager.wait("parent-1", created.id, 1);

		expect(childManager.setProvider).toHaveBeenCalledWith(childProvider, {
			model: expectedModel,
			effort: expectedEffort,
			permissionMode: "acceptEdits",
		});
		expect(db.createHlidDelegation).toHaveBeenCalledWith(
			expect.objectContaining({
				providerId: childProvider,
				model: expectedModel ?? null,
				effort: expectedEffort ?? null,
			}),
		);
	});

	it("accepts a custom ACP provider only after live registration, catalog, and availability checks", async () => {
		const acpCheck = vi.fn().mockResolvedValue({ available: true });
		pool.getProvider.mockImplementation((id: string) =>
			id === "acp-local"
				? {
						providerId: "acp-local",
						label: "ACP Local",
						check: acpCheck,
					}
				: undefined,
		);
		catalog.push({
			id: "acp-local",
			label: "ACP Local",
			available: true,
			models: [
				{
					value: "acp-model",
					label: "ACP Model",
					efforts: [{ value: "balanced", label: "Balanced" }],
				},
			],
			permissionModes: [
				{ value: "default", label: "Default" },
				{ value: "acceptEdits", label: "Accept edits" },
				{ value: "plan", label: "Plan" },
			],
		});
		const manager = new HlidDelegationManager(
			pool as unknown as SessionPool,
			async () => catalog,
			() => {
				statusChangedCalls++;
			},
		);

		const created = await manager.delegate("parent-1", {
			task: "Exercise a negotiated ACP provider",
			provider: "acp-local",
			model: "acp-model",
			effort: "balanced",
		});
		await manager.wait("parent-1", created.id, 1);

		expect(acpCheck).toHaveBeenCalledOnce();
		expect(childManager.setProvider).toHaveBeenCalledWith("acp-local", {
			model: "acp-model",
			effort: "balanced",
			permissionMode: "acceptEdits",
		});
		expect(created).toMatchObject({
			provider_id: "acp-local",
			model: "acp-model",
			effort: "balanced",
		});
	});

	it("uses the restored parent manager workspace instead of stale pool metadata", async () => {
		parentEntryCwd = "/stale/client-workspace";
		parentManagerCwd = "/work/restored-project";
		const manager = new HlidDelegationManager(
			pool as unknown as SessionPool,
			async () => catalog,
			() => {
				statusChangedCalls++;
			},
		);

		const created = await manager.delegate("parent-1", {
			task: "Stay in the restored workspace",
			provider: "codex",
		});
		await manager.wait("parent-1", created.id, 1);

		expect(pool.create).toHaveBeenCalledWith(
			"/work/restored-project",
			"Codex delegate",
			true,
		);
		expect(db.createSession).toHaveBeenCalledWith(
			"child-1",
			"STAY IN THE RESTORED WORKSPACE",
			"gpt-5.6-sol",
			expect.objectContaining({ agentCwd: "/work/restored-project" }),
		);
	});

	it("falls back to the pool root for a parent without a manager workspace", async () => {
		parentEntryCwd = "/vault/root";
		parentManagerCwd = undefined;
		const manager = new HlidDelegationManager(
			pool as unknown as SessionPool,
			async () => catalog,
			() => {
				statusChangedCalls++;
			},
		);

		const created = await manager.delegate("parent-1", {
			task: "Delegate from the vault root",
			provider: "codex",
		});
		await manager.wait("parent-1", created.id, 1);

		expect(pool.create).toHaveBeenCalledWith(
			"/vault/root",
			"Codex delegate",
			true,
		);
		expect(db.createSession).toHaveBeenCalledWith(
			"child-1",
			"DELEGATE FROM THE VAULT ROOT",
			"gpt-5.6-sol",
			expect.objectContaining({ agentCwd: "/vault/root" }),
		);
	});

	it("atomically rolls back a persisted setup failure", async () => {
		db.createHlidDelegation.mockImplementationOnce(async (input) => {
			persisted = snapshot({
				id: input.id,
				parent_session_id: input.parentSessionId,
				parent_turn_id: input.parentTurnId,
				child_session_id: input.childSessionId,
				status: "pending",
			});
			throw new Error("delegation snapshot read failed");
		});
		const manager = new HlidDelegationManager(
			pool as unknown as SessionPool,
			async () => catalog,
			() => {
				statusChangedCalls++;
			},
		);

		await expect(
			manager.delegate("parent-1", {
				task: "Fail after persistence",
				provider: "codex",
			}),
		).rejects.toThrow("delegation snapshot read failed");

		expect(db.rollbackHlidDelegationSetup).toHaveBeenCalledWith(
			expect.any(String),
			"child-1",
		);
		expect(db.createSession).not.toHaveBeenCalled();
		expect(persisted).toBeNull();
	});

	it("surfaces both setup and rollback failures without hiding durable drift", async () => {
		db.createHlidDelegation.mockRejectedValueOnce(
			new Error("delegation snapshot read failed"),
		);
		db.rollbackHlidDelegationSetup.mockRejectedValueOnce(
			new Error("delegation rollback failed"),
		);
		const manager = new HlidDelegationManager(
			pool as unknown as SessionPool,
			async () => catalog,
			() => {
				statusChangedCalls++;
			},
		);

		let failure: unknown;
		try {
			await manager.delegate("parent-1", {
				task: "Fail rollback visibly",
				provider: "codex",
			});
		} catch (error) {
			failure = error;
		}

		expect(failure).toBeInstanceOf(AggregateError);
		expect((failure as AggregateError).errors).toEqual([
			expect.objectContaining({ message: "delegation snapshot read failed" }),
			expect.objectContaining({ message: "delegation rollback failed" }),
		]);
		expect((failure as AggregateError).message).toContain(
			"durable rollback did not complete",
		);
	});

	it("rolls back child setup when the parent turn ends before launch", async () => {
		let releaseProviderSetup: (() => void) | undefined;
		childManager.setProvider.mockReturnValueOnce(
			new Promise<void>((resolve) => {
				releaseProviderSetup = resolve;
			}),
		);
		const manager = new HlidDelegationManager(
			pool as unknown as SessionPool,
			async () => catalog,
			() => {
				statusChangedCalls++;
			},
		);

		const delegation = manager.delegate("parent-1", {
			task: "Do not outlive admission",
			provider: "codex",
		});
		await vi.waitFor(() => expect(childManager.setProvider).toHaveBeenCalled());
		parentStatus = { ...parentStatus, state: "idle" };
		releaseProviderSetup?.();

		await expect(delegation).rejects.toThrow(
			"The parent turn changed before delegation could start",
		);
		expect(db.rollbackHlidDelegationSetup).toHaveBeenCalledOnce();
		expect(persisted).toBeNull();
		expect(childManager.runQuery).not.toHaveBeenCalled();
	});

	it("publishes a status refresh when the pending-to-running claim loses", async () => {
		let resolveClaim: ((value: null) => void) | undefined;
		db.markHlidDelegationRunning.mockImplementationOnce(
			() =>
				new Promise<null>((resolve) => {
					resolveClaim = resolve;
				}),
		);
		const manager = new HlidDelegationManager(
			pool as unknown as SessionPool,
			async () => catalog,
			() => {
				statusChangedCalls++;
			},
		);

		await manager.delegate("parent-1", {
			task: "Lose the launch claim",
			provider: "codex",
		});
		await vi.waitFor(() =>
			expect(db.markHlidDelegationRunning).toHaveBeenCalledOnce(),
		);
		const launchNotificationCount = statusChangedCalls;
		if (persisted) {
			persisted = {
				...persisted,
				status: "cancelled",
				complete: true,
			};
		}
		resolveClaim?.(null);

		await vi.waitFor(() =>
			expect(statusChangedCalls).toBeGreaterThan(launchNotificationCount),
		);
		expect(childManager.runQuery).not.toHaveBeenCalled();
	});

	it("keeps list responses compact and reserves details for inspect", async () => {
		persisted = snapshot({
			status: "completed",
			complete: true,
			task: "T".repeat(2_000),
			result_text: "R".repeat(12_000),
			error: "E".repeat(2_000),
		});
		const manager = new HlidDelegationManager(
			pool as unknown as SessionPool,
			async () => catalog,
			() => {
				statusChangedCalls++;
			},
		);

		const [listed] = await manager.list("parent-1");
		expect(listed?.task.length).toBe(240);
		expect(listed).toMatchObject({
			result_available: true,
			error_available: true,
			result_text: null,
			error: null,
		});
		await expect(
			manager.inspect("parent-1", persisted.id),
		).resolves.toMatchObject({
			result_text: "R".repeat(12_000),
			error: "E".repeat(2_000),
		});
	});

	it("accepts bounded nesting and rejects depth four or broader permissions", async () => {
		const manager = new HlidDelegationManager(
			pool as unknown as SessionPool,
			async () => catalog,
			() => {
				statusChangedCalls++;
			},
		);
		parentStatus.state = "idle";
		await expect(
			manager.delegate("parent-1", {
				task: "Inactive",
				provider: "codex",
			}),
		).rejects.toThrow("while the parent turn is running");

		parentStatus.state = "running";
		delegatedParent = snapshot({
			id: "parent-delegation",
			child_session_id: "parent-1",
			depth: 1,
			status: "running",
		});
		await expect(
			manager.delegate("parent-1", {
				task: "Nested",
				provider: "codex",
			}),
		).resolves.toMatchObject({
			parent_delegation_id: "parent-delegation",
			depth: 2,
		});

		delegatedParent = snapshot({
			id: "depth-three",
			child_session_id: "parent-1",
			depth: 3,
			status: "running",
		});
		await expect(
			manager.delegate("parent-1", {
				task: "Too deep",
				provider: "codex",
			}),
		).rejects.toThrow("bounded to 3 levels");

		delegatedParent = snapshot({
			id: "completed-parent",
			child_session_id: "parent-1",
			depth: 1,
			status: "completed",
			complete: true,
		});
		await expect(
			manager.delegate("parent-1", {
				task: "Too late",
				provider: "codex",
			}),
		).rejects.toThrow("Only a running Hlid delegation");

		delegatedParent = null;
		parentStatus.permission_mode = "default";
		await expect(
			manager.delegate("parent-1", {
				task: "Broader",
				provider: "codex",
				permission_mode: "acceptEdits",
			}),
		).rejects.toThrow("cannot delegate with broader");
		expect(pool.create).toHaveBeenCalledTimes(1);
	});

	it("validates inherited same-provider settings against the live catalog", async () => {
		parentStatus.model = "retired-model";
		const manager = new HlidDelegationManager(
			pool as unknown as SessionPool,
			async () => catalog,
			() => {
				statusChangedCalls++;
			},
		);

		await expect(
			manager.delegate("parent-1", {
				task: "Use current model",
				provider: "codex",
			}),
		).rejects.toThrow("not in Codex's current model catalog");
		expect(pool.create).not.toHaveBeenCalled();
	});

	it("rejects a registered provider missing from the live catalog", async () => {
		const manager = new HlidDelegationManager(
			pool as unknown as SessionPool,
			async () => [],
			() => {
				statusChangedCalls++;
			},
		);

		await expect(
			manager.delegate("parent-1", {
				task: "Do not infer catalog availability",
				provider: "codex",
			}),
		).rejects.toThrow("missing from the current provider catalog");
		expect(pool.create).not.toHaveBeenCalled();
	});

	it("does not create a child after the parent turn rolls over", async () => {
		let releaseCheck: (() => void) | undefined;
		let signalCheckStarted: (() => void) | undefined;
		const checkStarted = new Promise<void>((resolve) => {
			signalCheckStarted = resolve;
		});
		const checkGate = new Promise<void>((resolve) => {
			releaseCheck = resolve;
		});
		pool.getProvider.mockReturnValueOnce({
			providerId: "codex",
			label: "Codex",
			check: vi.fn(async () => {
				signalCheckStarted?.();
				await checkGate;
				return { available: true };
			}),
		});
		const manager = new HlidDelegationManager(
			pool as unknown as SessionPool,
			async () => catalog,
			() => {
				statusChangedCalls++;
			},
		);

		const delegation = manager.delegate("parent-1", {
			task: "Stay on the originating turn",
			provider: "codex",
		});
		await checkStarted;
		parentTurnId = "turn-2";
		releaseCheck?.();

		await expect(delegation).rejects.toThrow(
			"The parent turn changed before delegation could start",
		);
		expect(pool.create).not.toHaveBeenCalled();
		expect(db.createHlidDelegation).not.toHaveBeenCalled();
	});

	it("allows Hlid's transient plan boundary even when settings catalogs omit it", async () => {
		parentStatus.permission_mode = "default";
		const manager = new HlidDelegationManager(
			pool as unknown as SessionPool,
			async () => catalog,
			() => {
				statusChangedCalls++;
			},
		);

		const created = await manager.delegate("parent-1", {
			task: "Inspect without mutations",
			provider: "codex",
			permission_mode: "plan",
		});
		await manager.wait("parent-1", created.id, 1);

		expect(childManager.setProvider).toHaveBeenCalledWith(
			"codex",
			expect.objectContaining({ permissionMode: "plan" }),
		);
	});

	it("hands off only explicitly selected validated context", async () => {
		parentHandoff = {
			skillContexts: ["/vault/skills/review/SKILL.md"],
			relics: [
				{
					id: "relic-1",
					path: "/artifacts/report.html",
					filename: "report.html",
					mime: "text/html",
					kind: "vault",
					reference: "relic",
				},
			],
			vaultReferences: ["Plans/Exact.md"],
			workspaceReferences: [{ relativePath: "src/exact.ts", sha256: "abc123" }],
			currentAssistantSequence: 1,
		};
		const manager = new HlidDelegationManager(
			pool as unknown as SessionPool,
			async () => catalog,
			() => {
				statusChangedCalls++;
			},
		);

		const created = await manager.delegate("parent-1", {
			task: "Review exact context",
			provider: "codex",
			handoff: {
				visible_transcript: true,
				selected_skills: true,
				selected_relics: true,
				exact_references: true,
			},
		});
		await manager.wait("parent-1", created.id, 1);

		expect(db.createHlidDelegation).toHaveBeenCalledWith(
			expect.objectContaining({
				handoff: {
					visible_transcript_chars: expect.any(Number),
					selected_skills: 1,
					selected_relics: 1,
					vault_references: 1,
					workspace_references: 1,
				},
			}),
		);
		const options = childManager.runQuery.mock.calls[0]?.[2] ?? {};
		expect(options.skillContexts).toEqual(["/vault/skills/review/SKILL.md"]);
		expect(options.attachments).toEqual([
			expect.objectContaining({ id: "relic-1" }),
		]);
		expect(options.vaultReferences).toEqual(["Plans/Exact.md"]);
		expect(options.workspaceReferences).toEqual([
			{ relativePath: "src/exact.ts", sha256: "abc123" },
		]);
		expect(options.delegationContext).toContain("A later interactive turn");
		expect(options.delegationContext).not.toContain("Completed child result");
	});

	it("records provider-reported tokens without enforcing a ceiling", async () => {
		childManager.runQuery.mockImplementation(async (_task, emit) => {
			emit({
				type: "usage_update",
				input_tokens: 70,
				output_tokens: 20,
				cache_read_tokens: 10,
				cache_creation_tokens: 0,
				query_input_tokens: 70,
				query_output_tokens: 20,
				query_cache_read_tokens: 10,
				query_cache_creation_tokens: 0,
				tokens_in_context: 80,
				context_window: 200_000,
			});
		});
		const manager = new HlidDelegationManager(
			pool as unknown as SessionPool,
			async () => catalog,
			() => {
				statusChangedCalls++;
			},
		);

		const created = await manager.delegate("parent-1", {
			task: "Track token use",
			provider: "codex",
		});
		const finished = await manager.wait("parent-1", created.id, 1);

		expect(childManager.abort).not.toHaveBeenCalled();
		expect(db.updateHlidDelegationTokens).toHaveBeenCalledWith(created.id, 100);
		expect(finished).toMatchObject({
			status: "completed",
			token_budget: null,
			tokens_used: 100,
			result_text: "Completed child result",
		});
	});

	it("refreshes parent roll-up usage before the child turn settles", async () => {
		let emitUsage: (() => void) | undefined;
		let releaseProvider: (() => void) | undefined;
		const providerHeld = new Promise<void>((resolve) => {
			releaseProvider = resolve;
		});
		childManager.runQuery.mockImplementation(
			(_task, emit) =>
				new Promise<void>((resolve) => {
					emitUsage = () => {
						emit({
							type: "usage_update",
							input_tokens: 70,
							output_tokens: 20,
							cache_read_tokens: 10,
							cache_creation_tokens: 0,
							query_input_tokens: 70,
							query_output_tokens: 20,
							query_cache_read_tokens: 10,
							query_cache_creation_tokens: 0,
							query_estimated_cost: 0.05,
							tokens_in_context: 80,
							context_window: 200_000,
						});
					};
					void providerHeld.then(resolve);
				}),
		);
		const manager = new HlidDelegationManager(
			pool as unknown as SessionPool,
			async () => catalog,
			() => {
				statusChangedCalls++;
			},
		);

		const created = await manager.delegate("parent-1", {
			task: "Publish live roll-up usage",
			provider: "codex",
		});
		await vi.waitFor(() => expect(emitUsage).toBeTypeOf("function"));
		await vi.waitFor(() =>
			expect(db.updateHlidDelegationProgress).toHaveBeenCalledWith(
				created.id,
				"Provider turn running",
			),
		);
		await Promise.resolve();
		await Promise.resolve();
		const beforeUsage = statusChangedCalls;

		emitUsage?.();
		await vi.waitFor(() =>
			expect(db.updateHlidDelegationTokens).toHaveBeenCalledWith(
				created.id,
				100,
			),
		);
		await vi.waitFor(() =>
			expect(db.updateHlidDelegationCost).toHaveBeenCalledWith(
				created.id,
				0.05,
			),
		);
		await vi.waitFor(() =>
			expect(statusChangedCalls).toBeGreaterThan(beforeUsage),
		);

		releaseProvider?.();
		await manager.wait("parent-1", created.id, 1);
	});

	it("retains partial assistant work when the provider turn rejects", async () => {
		childManager.runQuery.mockRejectedValue(
			new Error("provider transport failed"),
		);
		const manager = new HlidDelegationManager(
			pool as unknown as SessionPool,
			async () => catalog,
			() => {
				statusChangedCalls++;
			},
		);

		const created = await manager.delegate("parent-1", {
			task: "Retain partial analysis",
			provider: "codex",
		});
		const failed = await manager.wait("parent-1", created.id, 1);

		expect(failed).toMatchObject({
			status: "failed",
			result_text: "Completed child result",
			error: "provider transport failed",
		});
		expect(pool.close).toHaveBeenCalledOnce();
		expect(pool.close).toHaveBeenCalledWith("child-1");
	});

	it("persists the provider's emitted error instead of replacing it generically", async () => {
		childManager.getStatus.mockReturnValue({
			state: "error",
			model: "gpt-5.6-sol",
			effort: "high",
		});
		childManager.runQuery.mockImplementation(async (_task, emit) => {
			emit({
				type: "error",
				message: "Provider transport closed while reading the result.",
			});
		});
		const manager = new HlidDelegationManager(
			pool as unknown as SessionPool,
			async () => catalog,
			() => {
				statusChangedCalls++;
			},
		);

		const created = await manager.delegate("parent-1", {
			task: "Retain the exact provider failure",
			provider: "codex",
		});
		const failed = await manager.wait("parent-1", created.id, 1);

		expect(failed).toMatchObject({
			status: "failed",
			error: "Provider transport closed while reading the result.",
		});
	});

	it("prefers an emitted provider error when the turn then rejects generically", async () => {
		childManager.runQuery.mockImplementation(async (_task, emit) => {
			emit({
				type: "error",
				message: "Exact provider protocol failure.",
			});
			throw new Error("transport closed");
		});
		const manager = new HlidDelegationManager(
			pool as unknown as SessionPool,
			async () => catalog,
			() => {
				statusChangedCalls++;
			},
		);

		const created = await manager.delegate("parent-1", {
			task: "Retain the precise provider error",
			provider: "codex",
		});
		const failed = await manager.wait("parent-1", created.id, 1);

		expect(failed).toMatchObject({
			status: "failed",
			error: "Exact provider protocol failure.",
		});
	});

	it("uses native steering and cancels the active child idempotently", async () => {
		let resolveRun: (() => void) | undefined;
		childManager.runQuery.mockReturnValue(
			new Promise<void>((resolve) => {
				resolveRun = resolve;
			}),
		);
		childManager.abort.mockImplementation(() => resolveRun?.());
		const manager = new HlidDelegationManager(
			pool as unknown as SessionPool,
			async () => catalog,
			() => {
				statusChangedCalls++;
			},
		);
		const created = await manager.delegate("parent-1", {
			task: "Keep working",
			provider: "codex",
		});
		await vi.waitFor(() => expect(persisted?.status).toBe("running"));

		await manager.steer("parent-1", created.id, "Check the edge case too");
		expect(childManager.steerActiveTurn).toHaveBeenCalledWith(
			"Check the edge case too",
			expect.any(Function),
			"child-1",
			expect.stringMatching(/^delegation-steer-/),
			"coordinator",
		);
		expect(broadcast).toHaveBeenCalledWith(
			expect.objectContaining({
				type: "turn_steered",
				target_turn_id: "child-active-turn",
				target_assistant_seq: 4,
				steer_seq: 5,
				steer_tool_event_index: 2,
				session_id: "child-1",
			}),
		);

		const requested = await manager.cancel("parent-1", created.id);
		expect(requested).toMatchObject({
			status: "running",
			progress_text: "Cancellation requested by parent",
		});
		await vi.waitFor(() => expect(persisted?.status).toBe("cancelled"));
		const repeated = await manager.cancel("parent-1", created.id);
		expect(repeated.status).toBe("cancelled");
		expect(childManager.abort).toHaveBeenCalled();
		expect(persisted?.result_text).toBe("Completed child result");
		expect(pool.close).toHaveBeenCalledOnce();
		expect(pool.close).toHaveBeenCalledWith("child-1");
	});

	it("reports unavailable provider-native steering without queuing a fallback turn", async () => {
		const acpCheck = vi.fn().mockResolvedValue({ available: true });
		pool.getProvider.mockImplementation((id: string) =>
			id === "acp-local"
				? {
						providerId: "acp-local",
						label: "ACP Local",
						check: acpCheck,
					}
				: undefined,
		);
		catalog.push({
			id: "acp-local",
			label: "ACP Local",
			available: true,
			permissionModes: [
				{ value: "default", label: "Default" },
				{ value: "acceptEdits", label: "Accept edits" },
				{ value: "plan", label: "Plan" },
			],
		});
		let resolveRun: (() => void) | undefined;
		childManager.runQuery.mockReturnValue(
			new Promise<void>((resolve) => {
				resolveRun = resolve;
			}),
		);
		childManager.steerActiveTurn.mockRejectedValue(
			new Error("The active provider does not support steering."),
		);
		childManager.abort.mockImplementation(() => resolveRun?.());
		const manager = new HlidDelegationManager(
			pool as unknown as SessionPool,
			async () => catalog,
			() => {
				statusChangedCalls++;
			},
		);

		const created = await manager.delegate("parent-1", {
			task: "Keep the ACP child running",
			provider: "acp-local",
		});
		await vi.waitFor(() => expect(persisted?.status).toBe("running"));

		await expect(
			manager.steer(
				"parent-1",
				created.id,
				"Do not turn this into a queued follow-up",
			),
		).rejects.toThrow("does not support steering");
		expect(childManager.runQuery).toHaveBeenCalledOnce();
		expect(
			broadcast.mock.calls.some(
				([event]) =>
					event?.type === "user_message" || event?.type === "turn_steered",
			),
		).toBe(false);
		expect(persisted?.status).toBe("running");

		await manager.cancel("parent-1", created.id);
	});

	it("keeps cancellation durable when provider abort rejects the active query", async () => {
		let rejectRun: ((error: Error) => void) | undefined;
		childManager.runQuery.mockReturnValue(
			new Promise<void>((_resolve, reject) => {
				rejectRun = reject;
			}),
		);
		childManager.abort.mockImplementation(() =>
			rejectRun?.(new Error("provider aborted")),
		);
		const manager = new HlidDelegationManager(
			pool as unknown as SessionPool,
			async () => catalog,
			() => {
				statusChangedCalls++;
			},
		);
		const created = await manager.delegate("parent-1", {
			task: "Cancel cleanly",
			provider: "codex",
		});
		await vi.waitFor(() => expect(persisted?.status).toBe("running"));

		await expect(manager.cancel("parent-1", created.id)).resolves.toMatchObject(
			{
				status: "running",
				progress_text: "Cancellation requested by parent",
			},
		);
		await vi.waitFor(() => expect(persisted?.status).toBe("cancelled"));
		expect(persisted?.error).toContain("cancelled this delegated child");
	});

	it("cancels a resumable restart-interrupted child instead of leaving it stranded", async () => {
		persisted = snapshot({
			status: "interrupted",
			resumable: true,
			complete: true,
			error: "Hlid restarted before this delegated child finished.",
		});
		const manager = new HlidDelegationManager(
			pool as unknown as SessionPool,
			async () => catalog,
			() => {
				statusChangedCalls++;
			},
		);

		await expect(
			manager.cancel("parent-1", persisted.id),
		).resolves.toMatchObject({
			status: "cancelled",
			resumable: false,
			error: "The parent session cancelled this restart-interrupted child.",
		});
		expect(db.abandonInterruptedHlidDelegation).toHaveBeenCalledWith(
			"delegation-1",
			"The parent session cancelled this restart-interrupted child.",
		);
	});

	it("keeps an explicitly cancelled child owned until the provider settles", async () => {
		vi.useFakeTimers();
		try {
			let releaseProvider: (() => void) | undefined;
			childManager.runQuery.mockReturnValue(
				new Promise<void>((resolve) => {
					releaseProvider = resolve;
				}),
			);
			const manager = new HlidDelegationManager(
				pool as unknown as SessionPool,
				async () => catalog,
				() => {
					statusChangedCalls++;
				},
			);
			const created = await manager.delegate("parent-1", {
				task: "Keep ownership while cancellation settles",
				provider: "codex",
			});
			await vi.advanceTimersByTimeAsync(0);
			expect(persisted?.status).toBe("running");

			await expect(
				manager.cancel("parent-1", created.id),
			).resolves.toMatchObject({
				status: "running",
				progress_text: "Cancellation requested by parent",
			});
			const internals = manager as unknown as {
				active: Map<string, { completion: Promise<void> }>;
				cancellationRequested: Set<string>;
			};
			const completion = internals.active.get(created.id)?.completion;
			expect(completion).toBeDefined();

			await vi.advanceTimersByTimeAsync(5_000);
			expect(persisted?.status).toBe("running");
			expect(internals.active.has(created.id)).toBe(true);
			expect(internals.cancellationRequested.has(created.id)).toBe(true);
			const abortCallsBeforeRepeat = childManager.abort.mock.calls.length;
			await expect(
				manager.cancel("parent-1", created.id),
			).resolves.toMatchObject({ status: "running" });
			expect(childManager.abort).toHaveBeenCalledTimes(abortCallsBeforeRepeat);
			await expect(
				manager.steer("parent-1", created.id, "Do more work"),
			).rejects.toThrow("already stopping");

			releaseProvider?.();
			await completion;
			expect(persisted?.status).toBe("cancelled");
			expect(internals.active.has(created.id)).toBe(false);
		} finally {
			vi.useRealTimers();
		}
	});

	it("continues only a restart-interrupted child as an explicit new turn", async () => {
		persisted = snapshot({
			status: "interrupted",
			complete: true,
			resumable: true,
			error: "Hlid restarted before this delegated child finished.",
			token_budget: 100,
			tokens_used: 100,
			cost_budget: 0.01,
			cost_used: 0.01,
		});
		db.getSessionNextMessageSeq.mockResolvedValue(4);
		db.getSessionMessages.mockResolvedValue([
			{ seq: 1, role: "user", text: "Original task" },
			{ seq: 2, role: "assistant", text: "Partial work" },
			{ seq: 5, role: "assistant", text: "Continued result" },
		]);
		const manager = new HlidDelegationManager(
			pool as unknown as SessionPool,
			async () => catalog,
			() => {
				statusChangedCalls++;
			},
		);

		const resumed = await manager.resume("parent-1", persisted.id, {
			id: persisted.id,
			instruction: "Continue from the durable evidence and finish.",
		});
		await manager.wait("parent-1", resumed.id, 1);

		expect(resumed).toMatchObject({
			status: "pending",
			attempt_count: 2,
			continuation_mode: "explicit_new_turn",
			token_budget: null,
			cost_budget: null,
		});
		expect(childManager.setProvider).toHaveBeenCalledWith("codex", {
			model: "gpt-5.6-sol",
			effort: "high",
			serviceTier: undefined,
			permissionMode: "acceptEdits",
			persistSessionSelection: false,
		});
		const call = childManager.runQuery.mock.calls[0] ?? [];
		expect(call[0]).toBe("Continue from the durable evidence and finish.");
		const options = call[2] ?? {};
		expect(options.inputOrigin).toBe("coordinator");
		expect(options.skillContexts).toEqual([]);
		expect(options.attachments).toEqual([]);
		expect(options.vaultReferences).toEqual([]);
		expect(options.workspaceReferences).toEqual([]);
		expect(options.delegationContext).toContain("Original task");
	});

	it("rolls back continuation admission when the parent turn ends during its CAS", async () => {
		persisted = snapshot({
			status: "interrupted",
			complete: true,
			resumable: true,
			error: "Hlid restarted before this delegated child finished.",
		});
		const interrupted = persisted;
		let releaseResume: (() => void) | undefined;
		db.resumeHlidDelegation.mockImplementationOnce(
			() =>
				new Promise<HlidDelegationSnapshot | null>((resolve) => {
					releaseResume = () => {
						persisted = interrupted
							? {
									...interrupted,
									status: "pending",
									complete: false,
									resumable: false,
									attempt_count: interrupted.attempt_count + 1,
									error: null,
								}
							: null;
						resolve(persisted);
					};
				}),
		);
		const manager = new HlidDelegationManager(
			pool as unknown as SessionPool,
			async () => catalog,
			() => {
				statusChangedCalls++;
			},
		);

		const continuation = manager.resume("parent-1", interrupted.id, {
			id: interrupted.id,
			instruction: "Do not launch after the parent ends",
			permission_mode: "default",
		});
		await vi.waitFor(() =>
			expect(db.resumeHlidDelegation).toHaveBeenCalledOnce(),
		);
		parentStatus = { ...parentStatus, state: "idle" };
		releaseResume?.();

		await expect(continuation).rejects.toThrow(
			"The parent turn changed before continuation could start",
		);
		expect(db.rollbackHlidDelegationResume).toHaveBeenCalledWith(
			interrupted.id,
			interrupted,
		);
		expect(persisted).toEqual(interrupted);
		expect(childManager.setProvider).toHaveBeenLastCalledWith("codex", {
			model: "gpt-5.6-sol",
			effort: "high",
			serviceTier: undefined,
			permissionMode: "acceptEdits",
			persistSessionSelection: false,
		});
		expect(childManager.runQuery).not.toHaveBeenCalled();
	});

	it("validates continuation against the restored parent manager workspace", async () => {
		persisted = snapshot({
			status: "interrupted",
			complete: true,
			resumable: true,
			workspace: "/work/restored-project",
		});
		parentEntryCwd = "/stale/client-workspace";
		parentManagerCwd = "/work/restored-project";
		db.getSessionAgentCwd.mockResolvedValueOnce("/stale/client-workspace");
		const manager = new HlidDelegationManager(
			pool as unknown as SessionPool,
			async () => catalog,
			() => {
				statusChangedCalls++;
			},
		);

		await expect(
			manager.resume("parent-1", persisted.id, {
				id: persisted.id,
				instruction: "Reject the stale workspace",
			}),
		).rejects.toThrow(
			"The delegated child no longer resolves to its recorded configured workspace.",
		);
		expect(db.resumeHlidDelegation).not.toHaveBeenCalled();

		db.getSessionAgentCwd.mockResolvedValueOnce("/work/restored-project");
		await expect(
			manager.resume("parent-1", persisted.id, {
				id: persisted.id,
				instruction: "Continue in the restored workspace",
			}),
		).resolves.toMatchObject({
			status: "pending",
			attempt_count: 2,
		});
		expect(db.resumeHlidDelegation).toHaveBeenCalledOnce();
	});

	it("does not revive an archived or missing interrupted child", async () => {
		persisted = snapshot({
			status: "interrupted",
			complete: true,
			resumable: false,
		});
		const manager = new HlidDelegationManager(
			pool as unknown as SessionPool,
			async () => catalog,
			() => {
				statusChangedCalls++;
			},
		);

		await expect(
			manager.resume("parent-1", persisted.id, {
				id: persisted.id,
				instruction: "Do not revive archived work",
			}),
		).rejects.toThrow(
			"Only a restart-interrupted delegation with remaining attempts",
		);
		expect(childManager.setProvider).not.toHaveBeenCalled();
		expect(db.resumeHlidDelegation).not.toHaveBeenCalled();
	});

	it("serializes concurrent continuation attempts without closing the winner", async () => {
		persisted = snapshot({
			status: "interrupted",
			complete: true,
			resumable: true,
		});
		let releaseSetup: (() => void) | undefined;
		childManager.setProvider.mockImplementationOnce(
			() =>
				new Promise<void>((resolve) => {
					releaseSetup = resolve;
				}),
		);
		childManager.runQuery.mockReturnValue(new Promise<void>(() => {}));
		const manager = new HlidDelegationManager(
			pool as unknown as SessionPool,
			async () => catalog,
			() => {
				statusChangedCalls++;
			},
		);

		const first = manager.resume("parent-1", persisted.id, {
			id: persisted.id,
			instruction: "First continuation",
		});
		await vi.waitFor(() =>
			expect(childManager.setProvider).toHaveBeenCalledOnce(),
		);
		const second = manager.resume("parent-1", persisted.id, {
			id: persisted.id,
			instruction: "Duplicate continuation",
		});
		releaseSetup?.();

		const [firstResult, secondResult] = await Promise.allSettled([
			first,
			second,
		]);
		expect(firstResult.status).toBe("fulfilled");
		expect(secondResult).toMatchObject({ status: "rejected" });
		expect(db.resumeHlidDelegation).toHaveBeenCalledOnce();
		expect(pool.close).not.toHaveBeenCalled();
	});

	it("leaves an interrupted child eligible when pre-CAS setup fails", async () => {
		persisted = snapshot({
			status: "interrupted",
			complete: true,
			resumable: true,
		});
		childManager.setProvider.mockRejectedValueOnce(
			new Error("permission setup failed"),
		);
		const manager = new HlidDelegationManager(
			pool as unknown as SessionPool,
			async () => catalog,
			() => {
				statusChangedCalls++;
			},
		);

		await expect(
			manager.resume("parent-1", persisted.id, {
				id: persisted.id,
				instruction: "Do not strand this attempt",
			}),
		).rejects.toThrow("permission setup failed");
		expect(db.resumeHlidDelegation).not.toHaveBeenCalled();
		expect(persisted).toMatchObject({
			status: "interrupted",
			attempt_count: 1,
			resumable: true,
		});
	});

	it("does not consume an attempt when permission persistence fails", async () => {
		persisted = snapshot({
			status: "interrupted",
			complete: true,
			resumable: true,
		});
		childManager.setProvider.mockRejectedValueOnce(
			new Error("permission persistence failed"),
		);
		const manager = new HlidDelegationManager(
			pool as unknown as SessionPool,
			async () => catalog,
			() => {
				statusChangedCalls++;
			},
		);

		await expect(
			manager.resume("parent-1", persisted.id, {
				id: persisted.id,
				instruction: "Keep the interrupted row retryable",
			}),
		).rejects.toThrow("permission persistence failed");
		expect(db.resumeHlidDelegation).not.toHaveBeenCalled();
		expect(persisted).toMatchObject({
			status: "interrupted",
			attempt_count: 1,
			resumable: true,
		});
	});

	it("requires the persisted continuation provider to remain registered and available", async () => {
		persisted = snapshot({
			status: "interrupted",
			complete: true,
			resumable: true,
		});
		const manager = new HlidDelegationManager(
			pool as unknown as SessionPool,
			async () => catalog,
			() => {
				statusChangedCalls++;
			},
		);

		pool.getProvider.mockReturnValueOnce(undefined);
		await expect(
			manager.resume("parent-1", persisted.id, {
				id: persisted.id,
				instruction: "Missing provider",
			}),
		).rejects.toThrow("no longer registered");

		pool.getProvider.mockReturnValueOnce({
			providerId: "codex",
			label: "Codex",
			check: vi.fn().mockResolvedValue({
				available: false,
				reason: "runtime offline",
			}),
		});
		await expect(
			manager.resume("parent-1", persisted.id, {
				id: persisted.id,
				instruction: "Unavailable provider",
			}),
		).rejects.toThrow("runtime offline");
		expect(db.resumeHlidDelegation).not.toHaveBeenCalled();
	});

	it("revalidates recorded continuation settings against the live catalog", async () => {
		persisted = snapshot({
			status: "interrupted",
			complete: true,
			resumable: true,
			model: "retired-model",
		});
		const manager = new HlidDelegationManager(
			pool as unknown as SessionPool,
			async () => catalog,
			() => {
				statusChangedCalls++;
			},
		);

		await expect(
			manager.resume("parent-1", persisted.id, {
				id: persisted.id,
				instruction: "Use the recorded selection",
			}),
		).rejects.toThrow("not in Codex's current model catalog");
		expect(childManager.setProvider).not.toHaveBeenCalled();
		expect(db.resumeHlidDelegation).not.toHaveBeenCalled();
	});

	it("rejects continuation when a live child drifted from its recorded runtime", async () => {
		persisted = snapshot({
			status: "interrupted",
			complete: true,
			resumable: true,
		});
		const manager = new HlidDelegationManager(
			pool as unknown as SessionPool,
			async () => catalog,
			() => {
				statusChangedCalls++;
			},
		);

		childManager.getProviderId.mockReturnValueOnce("claude");
		await expect(
			manager.resume("parent-1", persisted.id, {
				id: persisted.id,
				instruction: "Do not change providers silently",
			}),
		).rejects.toThrow("no longer uses its recorded provider");

		childManager.getProviderId.mockReturnValue("codex");
		childManager.getStatus.mockReturnValueOnce({
			state: "idle",
			model: "gpt-5.6-sol",
			effort: "low",
		});
		await expect(
			manager.resume("parent-1", persisted.id, {
				id: persisted.id,
				instruction: "Do not change effort silently",
			}),
		).rejects.toThrow("no longer uses its recorded model and effort");

		expect(childManager.setProvider).not.toHaveBeenCalled();
		expect(db.resumeHlidDelegation).not.toHaveBeenCalled();
	});

	it("serializes subtree cancellation before concurrent nested admission", async () => {
		persisted = snapshot({
			status: "running",
			complete: false,
			resumable: false,
			child_session_id: "parent-1",
		});
		db.getHlidDelegationByChildSession.mockImplementation(
			async () => persisted,
		);
		let signalFinishStarted: (() => void) | undefined;
		let releaseFinish: (() => void) | undefined;
		const finishStarted = new Promise<void>((resolve) => {
			signalFinishStarted = resolve;
		});
		const finishGate = new Promise<void>((resolve) => {
			releaseFinish = resolve;
		});
		db.finishHlidDelegation.mockImplementationOnce(async (_id, input) => {
			signalFinishStarted?.();
			await finishGate;
			persisted = persisted
				? {
						...persisted,
						status: input.status,
						error: input.error ?? null,
						complete: true,
					}
				: null;
			return persisted;
		});
		const manager = new HlidDelegationManager(
			pool as unknown as SessionPool,
			async () => catalog,
			() => {
				statusChangedCalls++;
			},
		);

		const cancelling = manager.cancel("parent-1", persisted.id);
		await finishStarted;
		const nested = manager.delegate("parent-1", {
			task: "Must not escape cancellation",
			provider: "codex",
		});
		const nestedRejection = expect(nested).rejects.toThrow(
			"Only a running Hlid delegation",
		);
		await vi.waitFor(() =>
			expect(db.getHlidDelegationByChildSession).toHaveBeenCalled(),
		);
		releaseFinish?.();

		await expect(cancelling).resolves.toMatchObject({ status: "cancelled" });
		await nestedRejection;
		expect(pool.create).not.toHaveBeenCalled();
		expect(db.createHlidDelegation).not.toHaveBeenCalled();
	});

	it("does not abort a child when completion wins the cancellation CAS", async () => {
		let resolveRun: (() => void) | undefined;
		childManager.runQuery.mockReturnValue(
			new Promise<void>((resolve) => {
				resolveRun = resolve;
			}),
		);
		const manager = new HlidDelegationManager(
			pool as unknown as SessionPool,
			async () => catalog,
			() => {
				statusChangedCalls++;
			},
		);
		const created = await manager.delegate("parent-1", {
			task: "Finish at the cancellation boundary",
			provider: "codex",
		});
		await vi.waitFor(() => expect(persisted?.status).toBe("running"));
		db.updateHlidDelegationProgress.mockImplementationOnce(async () => {
			persisted = persisted
				? {
						...persisted,
						status: "completed",
						result_text: "Completed first",
						complete: true,
					}
				: null;
			return persisted;
		});

		await expect(manager.cancel("parent-1", created.id)).resolves.toMatchObject(
			{
				status: "completed",
			},
		);
		expect(childManager.abort).not.toHaveBeenCalled();
		resolveRun?.();
	});

	it("cancels active descendants even when the addressed ancestor is terminal", async () => {
		const root = snapshot({
			status: "completed",
			complete: true,
			result_text: "Root finished",
		});
		let descendant = snapshot({
			id: "delegation-2",
			parent_delegation_id: root.id,
			parent_session_id: root.child_session_id,
			parent_turn_id: "turn-2",
			child_session_id: "child-2",
			depth: 2,
			status: "running",
			complete: false,
		});
		persisted = root;
		db.listHlidDelegationsByParentDelegation.mockImplementation(async (id) =>
			id === root.id ? [descendant] : [],
		);
		db.updateHlidDelegationProgress.mockImplementation(async (id, text) => {
			if (id !== descendant.id) return root;
			descendant = { ...descendant, progress_text: text };
			return descendant;
		});
		db.finishHlidDelegation.mockImplementation(async (id, input) => {
			if (id !== descendant.id) return root;
			descendant = {
				...descendant,
				status: input.status,
				error: input.error ?? null,
				complete: true,
			};
			return descendant;
		});
		const manager = new HlidDelegationManager(
			pool as unknown as SessionPool,
			async () => catalog,
			() => {
				statusChangedCalls++;
			},
		);

		await expect(manager.cancel("parent-1", root.id)).resolves.toMatchObject({
			status: "completed",
		});

		expect(db.finishHlidDelegation).toHaveBeenCalledWith(descendant.id, {
			status: "cancelled",
			error: "An ancestor Hlid delegation was cancelled.",
		});
		expect(descendant.status).toBe("cancelled");
	});

	it("cancels every Routine child even when corrupt lineage forms a closed cycle", async () => {
		const first = snapshot({
			id: "delegation-cycle-1",
			parent_delegation_id: "delegation-cycle-2",
			routine_run_id: "routine-run-cycle",
			status: "running",
			complete: false,
		});
		const second = snapshot({
			id: "delegation-cycle-2",
			parent_delegation_id: first.id,
			parent_session_id: first.child_session_id,
			child_session_id: "child-cycle-2",
			routine_run_id: "routine-run-cycle",
			status: "running",
			complete: false,
		});
		const rows = new Map(
			[first, second].map((delegation) => [delegation.id, delegation]),
		);
		db.listHlidDelegationsForRoutineRun.mockResolvedValue([first, second]);
		db.listHlidDelegationsByParentDelegation.mockImplementation(async (id) =>
			id === first.id ? [second] : id === second.id ? [first] : [],
		);
		db.updateHlidDelegationProgress.mockImplementation(async (id, text) => {
			const delegation = rows.get(id);
			if (!delegation) return null;
			const updated = { ...delegation, progress_text: text };
			rows.set(id, updated);
			return updated;
		});
		db.finishHlidDelegation.mockImplementation(async (id, input) => {
			const delegation = rows.get(id);
			if (!delegation) return null;
			const finished = {
				...delegation,
				status: input.status,
				error: input.error ?? null,
				complete: true,
			};
			rows.set(id, finished);
			return finished;
		});
		const manager = new HlidDelegationManager(
			pool as unknown as SessionPool,
			async () => catalog,
			() => {
				statusChangedCalls++;
			},
		);

		await manager.cancelRoutineRun("routine-run-cycle");

		expect([...rows.values()].map((delegation) => delegation.status)).toEqual([
			"cancelled",
			"cancelled",
		]);
		expect(db.finishHlidDelegation).toHaveBeenCalledTimes(2);
		expect(db.listHlidDelegationsByParentDelegation).toHaveBeenCalledTimes(2);
	});

	it("hard-aborts an active child when cancellation persistence fails", async () => {
		let resolveRun: (() => void) | undefined;
		childManager.runQuery.mockReturnValue(
			new Promise<void>((resolve) => {
				resolveRun = resolve;
			}),
		);
		childManager.abort.mockImplementation(() => resolveRun?.());
		const manager = new HlidDelegationManager(
			pool as unknown as SessionPool,
			async () => catalog,
			() => {
				statusChangedCalls++;
			},
		);
		const created = await manager.delegate("parent-1", {
			task: "Cancel despite a database write failure",
			provider: "codex",
		});
		await vi.waitFor(() => expect(persisted?.status).toBe("running"));
		db.updateHlidDelegationProgress.mockRejectedValueOnce(
			new Error("delegation database unavailable"),
		);

		await expect(manager.cancel("parent-1", created.id)).rejects.toThrow(
			"delegation database unavailable",
		);
		expect(childManager.abort).toHaveBeenCalled();
		await vi.waitFor(() => expect(persisted?.status).toBe("cancelled"));
		expect(db.finishHlidDelegation).toHaveBeenCalledOnce();
	});

	it("traverses and aborts every active descendant when root cancellation persistence fails", async () => {
		const root = snapshot({
			status: "running",
			complete: false,
			resumable: false,
		});
		const firstChild = snapshot({
			id: "delegation-2",
			parent_delegation_id: root.id,
			parent_session_id: root.child_session_id,
			parent_turn_id: "turn-2",
			child_session_id: "child-2",
			depth: 2,
			status: "running",
			complete: false,
		});
		const firstGrandchild = snapshot({
			id: "delegation-3",
			parent_delegation_id: firstChild.id,
			parent_session_id: firstChild.child_session_id,
			parent_turn_id: "turn-3",
			child_session_id: "child-3",
			depth: 3,
			status: "running",
			complete: false,
		});
		const laterChild = snapshot({
			id: "delegation-4",
			parent_delegation_id: root.id,
			parent_session_id: root.child_session_id,
			parent_turn_id: "turn-2",
			child_session_id: "child-4",
			depth: 2,
			status: "running",
			complete: false,
		});
		persisted = root;
		const rows = new Map(
			[root, firstChild, firstGrandchild, laterChild].map((row) => [
				row.id,
				row,
			]),
		);
		db.listHlidDelegationsByParentDelegation.mockImplementation(async (id) => {
			if (id === root.id) return [firstChild, laterChild];
			if (id === firstChild.id) return [firstGrandchild];
			return [];
		});
		const rootFailure = new Error("root cancellation persistence failed");
		db.updateHlidDelegationProgress.mockImplementation(async (id, text) => {
			if (id === root.id) throw rootFailure;
			const row = rows.get(id);
			if (!row) return null;
			const updated = {
				...row,
				progress_text: text,
			};
			rows.set(id, updated);
			return updated;
		});
		const manager = new HlidDelegationManager(
			pool as unknown as SessionPool,
			async () => catalog,
			() => {
				statusChangedCalls++;
			},
		);
		const controls = [root, firstChild, firstGrandchild, laterChild].map(
			(row) => installActiveCancellationControls(manager, row.id),
		);

		await expect(manager.cancel("parent-1", root.id)).rejects.toBe(rootFailure);

		expect(
			db.updateHlidDelegationProgress.mock.calls.map(
				([delegationId]) => delegationId,
			),
		).toEqual([root.id, firstChild.id, firstGrandchild.id, laterChild.id]);
		expect(db.finishHlidDelegation).not.toHaveBeenCalled();
		expect(
			db.listHlidDelegationsByParentDelegation.mock.calls.map(
				([delegationId]) => delegationId,
			),
		).toEqual([root.id, firstChild.id, firstGrandchild.id, laterChild.id]);
		for (const control of controls) {
			expect(control.requestCancel).toHaveBeenCalledOnce();
			expect(control.abort).toHaveBeenCalledOnce();
		}
	});

	it("aggregates sibling cancellation failures after traversing and aborting both subtrees", async () => {
		const root = snapshot({
			status: "running",
			complete: false,
			resumable: false,
		});
		const firstChild = snapshot({
			id: "delegation-2",
			parent_delegation_id: root.id,
			parent_session_id: root.child_session_id,
			parent_turn_id: "turn-2",
			child_session_id: "child-2",
			depth: 2,
			status: "running",
			complete: false,
		});
		const firstGrandchild = snapshot({
			id: "delegation-3",
			parent_delegation_id: firstChild.id,
			parent_session_id: firstChild.child_session_id,
			parent_turn_id: "turn-3",
			child_session_id: "child-3",
			depth: 3,
			status: "running",
			complete: false,
		});
		const laterChild = snapshot({
			id: "delegation-4",
			parent_delegation_id: root.id,
			parent_session_id: root.child_session_id,
			parent_turn_id: "turn-2",
			child_session_id: "child-4",
			depth: 2,
			status: "running",
			complete: false,
		});
		const laterGrandchild = snapshot({
			id: "delegation-5",
			parent_delegation_id: laterChild.id,
			parent_session_id: laterChild.child_session_id,
			parent_turn_id: "turn-3",
			child_session_id: "child-5",
			depth: 3,
			status: "running",
			complete: false,
		});
		persisted = root;
		const rows = new Map(
			[root, firstChild, firstGrandchild, laterChild, laterGrandchild].map(
				(row) => [row.id, row],
			),
		);
		db.listHlidDelegationsByParentDelegation.mockImplementation(async (id) => {
			if (id === root.id) return [firstChild, laterChild];
			if (id === firstChild.id) return [firstGrandchild];
			if (id === laterChild.id) return [laterGrandchild];
			return [];
		});
		const firstFailure = new Error("first sibling persistence failed");
		const laterFailure = new Error("later sibling persistence failed");
		db.updateHlidDelegationProgress.mockImplementation(async (id, text) => {
			if (id === firstChild.id) throw firstFailure;
			if (id === laterChild.id) throw laterFailure;
			const row = rows.get(id);
			if (!row) return null;
			const updated = {
				...row,
				progress_text: text,
			};
			rows.set(id, updated);
			return updated;
		});
		const manager = new HlidDelegationManager(
			pool as unknown as SessionPool,
			async () => catalog,
			() => {
				statusChangedCalls++;
			},
		);
		const controls = [
			root,
			firstChild,
			firstGrandchild,
			laterChild,
			laterGrandchild,
		].map((row) => installActiveCancellationControls(manager, row.id));

		let cancellationError: unknown;
		try {
			await manager.cancel("parent-1", root.id);
		} catch (error) {
			cancellationError = error;
		}

		expect(cancellationError).toBeInstanceOf(AggregateError);
		expect((cancellationError as AggregateError).errors).toEqual([
			firstFailure,
			laterFailure,
		]);
		expect(
			db.updateHlidDelegationProgress.mock.calls.map(
				([delegationId]) => delegationId,
			),
		).toEqual([
			root.id,
			firstChild.id,
			firstGrandchild.id,
			laterChild.id,
			laterGrandchild.id,
		]);
		expect(db.finishHlidDelegation).not.toHaveBeenCalled();
		expect(
			db.listHlidDelegationsByParentDelegation.mock.calls.map(
				([delegationId]) => delegationId,
			),
		).toEqual([
			root.id,
			firstChild.id,
			firstGrandchild.id,
			laterChild.id,
			laterGrandchild.id,
		]);
		for (const control of controls) {
			expect(control.requestCancel).toHaveBeenCalledOnce();
			expect(control.abort).toHaveBeenCalledOnce();
		}
	});

	it("keeps silent model work running beyond the former timeout", async () => {
		vi.useFakeTimers();
		try {
			const check = vi.fn().mockResolvedValue({ available: true });
			pool.getProvider.mockReturnValue({
				providerId: "codex",
				label: "Codex",
				check,
			});
			let releaseProvider: (() => void) | undefined;
			childManager.runQuery.mockReturnValue(
				new Promise<void>((resolve) => {
					releaseProvider = resolve;
				}),
			);
			const manager = new HlidDelegationManager(
				pool as unknown as SessionPool,
				async () => catalog,
				() => {
					statusChangedCalls++;
				},
			);

			const created = await manager.delegate("parent-1", {
				task: "Allow silent model work",
				provider: "codex",
			});
			await vi.advanceTimersByTimeAsync(60 * 60_000);
			expect(childManager.abort).not.toHaveBeenCalled();
			expect(check).toHaveBeenCalledOnce();
			expect(persisted?.status).toBe("running");

			releaseProvider?.();
			const completed = await manager.wait("parent-1", created.id, 1);
			expect(completed.status).toBe("completed");
			expect(
				db.finishHlidDelegation.mock.calls.some(
					([, result]) => result.status === "timed_out",
				),
			).toBe(false);
		} finally {
			vi.useRealTimers();
		}
	});

	it.each([
		{
			wait: "approval",
			event: {
				type: "permission_request",
				id: "approval-1",
				toolName: "Bash",
				title: "Allow this command?",
			} satisfies ServerMessage,
		},
		{
			wait: "question",
			event: {
				type: "ask_user_question",
				id: "question-1",
				questions: [
					{
						question: "Which option?",
						options: ["One", "Two"],
						multiSelect: false,
					},
				],
			} satisfies ServerMessage,
		},
		{
			wait: "plan review",
			event: {
				type: "plan_mode_exit",
				id: "plan-1",
				input: {},
			} satisfies ServerMessage,
		},
		{
			wait: "provider sleep",
			event: {
				type: "agent_sleep",
				state: "sleeping",
				providerId: "codex",
				until: 10_000,
			} satisfies ServerMessage,
		},
		{
			wait: "long-running tool",
			event: {
				type: "tool_event",
				id: "tool-1",
				name: "LongRunningTool",
				input: {},
			} satisfies ServerMessage,
		},
	])("keeps a child running through $wait", async ({ event }) => {
		vi.useFakeTimers();
		try {
			let emitProvider: ((event: ServerMessage) => void) | undefined;
			let releaseProvider: (() => void) | undefined;
			childManager.runQuery.mockImplementation(
				(_task, emit) =>
					new Promise<void>((resolve) => {
						emitProvider = emit;
						releaseProvider = resolve;
					}),
			);
			const manager = new HlidDelegationManager(
				pool as unknown as SessionPool,
				async () => catalog,
				() => {
					statusChangedCalls++;
				},
			);

			const created = await manager.delegate("parent-1", {
				task: "Wait without a lifecycle cap",
				provider: "codex",
			});
			await vi.advanceTimersByTimeAsync(0);
			emitProvider?.(event);
			await vi.advanceTimersByTimeAsync(60 * 60_000);
			expect(childManager.abort).not.toHaveBeenCalled();
			expect(persisted?.status).toBe("running");

			releaseProvider?.();
			const completed = await manager.wait("parent-1", created.id, 1);
			expect(completed.status).toBe("completed");
			expect(
				db.finishHlidDelegation.mock.calls.some(
					([, result]) => result.status === "timed_out",
				),
			).toBe(false);
		} finally {
			vi.useRealTimers();
		}
	});

	it("applies inherited Claude Auto through one provider transaction before durable setup", async () => {
		parentProviderId = "claude";
		parentStatus = {
			state: "running",
			permission_mode: "auto",
			model: "claude-sonnet",
			effort: "medium",
		};
		const manager = new HlidDelegationManager(
			pool as unknown as SessionPool,
			async () => catalog,
			() => {
				statusChangedCalls++;
			},
		);

		await expect(
			manager.delegate("parent-1", {
				task: "Use Claude Auto in the child workspace",
				provider: "claude",
			}),
		).resolves.toMatchObject({
			provider_id: "claude",
			model: "claude-sonnet",
			permission_mode: "auto",
		});
		expect(childManager.setProvider).toHaveBeenCalledWith("claude", {
			model: "claude-sonnet",
			effort: "medium",
			serviceTier: undefined,
			permissionMode: "auto",
		});
		expect(childManager.setProvider).toHaveBeenCalledTimes(1);
		expect(childManager.setProvider.mock.invocationCallOrder[0]).toBeLessThan(
			db.createHlidDelegation.mock.invocationCallOrder[0] ?? 0,
		);
		expect(childManager.validatePermissionMode).not.toHaveBeenCalled();
	});

	it("applies explicitly selected cross-provider Claude Auto once", async () => {
		parentStatus.permission_mode = "bypassPermissions";
		const manager = new HlidDelegationManager(
			pool as unknown as SessionPool,
			async () => catalog,
			() => {
				statusChangedCalls++;
			},
		);

		await manager.delegate("parent-1", {
			task: "Use the selected Claude model",
			provider: "claude",
			model: "claude-sonnet",
			effort: "medium",
			permission_mode: "auto",
		});

		expect(childManager.setProvider).toHaveBeenCalledWith("claude", {
			model: "claude-sonnet",
			effort: "medium",
			serviceTier: undefined,
			permissionMode: "auto",
		});
		expect(childManager.setProvider).toHaveBeenCalledTimes(1);
		expect(childManager.validatePermissionMode).not.toHaveBeenCalled();
	});

	it("rolls back all child setup when exact Claude Auto readiness rejects", async () => {
		parentStatus.permission_mode = "bypassPermissions";
		childManager.setProvider.mockRejectedValueOnce(
			new Error("Claude Auto is not ready for this model"),
		);
		const manager = new HlidDelegationManager(
			pool as unknown as SessionPool,
			async () => catalog,
			() => {
				statusChangedCalls++;
			},
		);

		await expect(
			manager.delegate("parent-1", {
				task: "Do not leave a partial Auto child",
				provider: "claude",
				model: "claude-sonnet",
				permission_mode: "auto",
			}),
		).rejects.toThrow("Claude Auto is not ready for this model");
		expect(pool.close).toHaveBeenCalledWith("child-1");
		expect(db.rollbackHlidDelegationSetup).toHaveBeenCalledOnce();
		expect(db.createHlidDelegation).not.toHaveBeenCalled();
		expect(db.createSession).not.toHaveBeenCalled();
		expect(persisted).toBeNull();
	});

	it.each([
		{ provider: "codex", model: "gpt-5.6-sol" },
		{ provider: "cliproxy-claude", model: "claude-sonnet" },
	])("rejects Auto for non-native provider $provider", async ({
		provider,
		model,
	}) => {
		parentStatus.permission_mode = "bypassPermissions";
		const manager = new HlidDelegationManager(
			pool as unknown as SessionPool,
			async () => catalog,
			() => {
				statusChangedCalls++;
			},
		);

		await expect(
			manager.delegate("parent-1", {
				task: "Reject non-native Auto",
				provider,
				model,
				permission_mode: "auto",
			}),
		).rejects.toThrow("only for direct native Claude sessions");
		expect(childManager.validatePermissionMode).not.toHaveBeenCalled();
		expect(pool.create).not.toHaveBeenCalled();
	});

	it("requires a cross-provider child of an Auto parent to narrow explicitly", async () => {
		parentProviderId = "claude";
		parentStatus = {
			state: "running",
			permission_mode: "auto",
			model: "claude-sonnet",
			effort: "medium",
		};
		const manager = new HlidDelegationManager(
			pool as unknown as SessionPool,
			async () => catalog,
			() => {
				statusChangedCalls++;
			},
		);

		await expect(
			manager.delegate("parent-1", {
				task: "Inherited Auto cannot cross providers",
				provider: "codex",
			}),
		).rejects.toThrow("only for direct native Claude sessions");
		await expect(
			manager.delegate("parent-1", {
				task: "Explicitly narrow the Codex child",
				provider: "codex",
				permission_mode: "default",
			}),
		).resolves.toMatchObject({
			provider_id: "codex",
			permission_mode: "default",
		});
		expect(childManager.validatePermissionMode).not.toHaveBeenCalled();
	});

	it("allows nested Auto only within the recorded running lineage", async () => {
		parentProviderId = "claude";
		parentStatus = {
			state: "running",
			permission_mode: "auto",
			model: "claude-sonnet",
			effort: "medium",
		};
		delegatedParent = snapshot({
			id: "parent-delegation",
			child_session_id: "parent-1",
			status: "running",
			depth: 1,
			permission_mode: "auto",
		});
		const manager = new HlidDelegationManager(
			pool as unknown as SessionPool,
			async () => catalog,
			() => {
				statusChangedCalls++;
			},
		);

		await expect(
			manager.delegate("parent-1", {
				task: "Create a nested native Claude Auto child",
				provider: "claude",
			}),
		).resolves.toMatchObject({
			parent_delegation_id: "parent-delegation",
			depth: 2,
			permission_mode: "auto",
		});
		expect(childManager.setProvider).toHaveBeenCalledWith("claude", {
			model: "claude-sonnet",
			effort: "medium",
			serviceTier: undefined,
			permissionMode: "auto",
		});
		expect(childManager.setProvider).toHaveBeenCalledTimes(1);
	});

	it("lets a full-access Routine explicitly choose ready Claude Auto", async () => {
		parentRoutine = true;
		parentRoutineContext = {
			...parentRoutineContext,
			mode: "full_access",
		};
		parentStatus.permission_mode = "bypassPermissions";
		const manager = new HlidDelegationManager(
			pool as unknown as SessionPool,
			async () => catalog,
			() => {
				statusChangedCalls++;
			},
		);

		await expect(
			manager.delegate("parent-1", {
				task: "Use ready Auto inside the Routine envelope",
				provider: "claude",
				model: "claude-sonnet",
				permission_mode: "auto",
			}),
		).resolves.toMatchObject({
			routine_run_id: "routine-run-1",
			permission_mode: "auto",
		});
		expect(childManager.setProvider).toHaveBeenCalledWith("claude", {
			model: "claude-sonnet",
			effort: undefined,
			serviceTier: undefined,
			permissionMode: "auto",
		});
		expect(childManager.setProvider).toHaveBeenCalledTimes(1);
	});

	it("revalidates the recorded exact model before consuming an Auto continuation", async () => {
		parentStatus.permission_mode = "bypassPermissions";
		persisted = snapshot({
			status: "interrupted",
			complete: true,
			resumable: true,
			provider_id: "claude",
			model: "claude-sonnet",
			effort: "medium",
			permission_mode: "auto",
		});
		childManager.getProviderId.mockReturnValue("claude");
		childManager.getStatus.mockReturnValue({
			state: "idle",
			model: "claude-sonnet",
			effort: "medium",
		});
		const manager = new HlidDelegationManager(
			pool as unknown as SessionPool,
			async () => catalog,
			() => {
				statusChangedCalls++;
			},
		);

		await expect(
			manager.resume("parent-1", persisted.id, {
				id: persisted.id,
				instruction: "Continue with exact Auto readiness",
			}),
		).resolves.toMatchObject({
			attempt_count: 2,
			permission_mode: "auto",
		});
		expect(childManager.setProvider).toHaveBeenCalledWith("claude", {
			model: "claude-sonnet",
			effort: "medium",
			serviceTier: undefined,
			permissionMode: "auto",
			persistSessionSelection: false,
		});
		expect(childManager.setProvider).toHaveBeenCalledTimes(1);
		expect(childManager.setProvider.mock.invocationCallOrder[0]).toBeLessThan(
			db.resumeHlidDelegation.mock.invocationCallOrder[0] ?? 0,
		);
		expect(childManager.validatePermissionMode).not.toHaveBeenCalled();
	});

	it("keeps an interrupted Auto child retryable when readiness rejects", async () => {
		parentStatus.permission_mode = "bypassPermissions";
		persisted = snapshot({
			status: "interrupted",
			complete: true,
			resumable: true,
			provider_id: "claude",
			model: "claude-sonnet",
			effort: "medium",
			permission_mode: "auto",
		});
		childManager.getProviderId.mockReturnValue("claude");
		childManager.getStatus.mockReturnValue({
			state: "idle",
			model: "claude-sonnet",
			effort: "medium",
		});
		childManager.setProvider.mockRejectedValueOnce(
			new Error("Auto readiness changed"),
		);
		const manager = new HlidDelegationManager(
			pool as unknown as SessionPool,
			async () => catalog,
			() => {
				statusChangedCalls++;
			},
		);

		await expect(
			manager.resume("parent-1", persisted.id, {
				id: persisted.id,
				instruction: "Do not consume this attempt",
			}),
		).rejects.toThrow("Auto readiness changed");
		expect(db.resumeHlidDelegation).not.toHaveBeenCalled();
		expect(persisted).toMatchObject({
			status: "interrupted",
			attempt_count: 1,
			resumable: true,
		});
	});

	it("requires an inherited non-Claude Auto continuation to narrow explicitly", async () => {
		parentStatus.permission_mode = "auto";
		persisted = snapshot({
			status: "interrupted",
			complete: true,
			resumable: true,
			provider_id: "codex",
			permission_mode: "auto",
		});
		const manager = new HlidDelegationManager(
			pool as unknown as SessionPool,
			async () => catalog,
			() => {
				statusChangedCalls++;
			},
		);

		await expect(
			manager.resume("parent-1", persisted.id, {
				id: persisted.id,
				instruction: "Inherited Auto must not cross providers",
			}),
		).rejects.toThrow("only for direct native Claude sessions");
		await expect(
			manager.resume("parent-1", persisted.id, {
				id: persisted.id,
				instruction: "Explicitly narrow this continuation",
				permission_mode: "default",
			}),
		).resolves.toMatchObject({
			attempt_count: 2,
			permission_mode: "default",
		});
		expect(childManager.validatePermissionMode).not.toHaveBeenCalled();
	});
});

describe("delegation permission narrowing", () => {
	const modes = [
		"plan",
		"dontAsk",
		"default",
		"acceptEdits",
		"auto",
		"bypassPermissions",
	] as const;
	const allowedChildren: Record<(typeof modes)[number], ReadonlySet<string>> = {
		plan: new Set(["plan"]),
		dontAsk: new Set(["dontAsk", "plan"]),
		default: new Set(["default", "dontAsk", "plan"]),
		acceptEdits: new Set(["acceptEdits", "default", "dontAsk", "plan"]),
		auto: new Set(["auto", "default", "dontAsk", "plan"]),
		bypassPermissions: new Set(modes),
	};
	const pairs = modes.flatMap((parent) =>
		modes.map(
			(child) => [parent, child, allowedChildren[parent].has(child)] as const,
		),
	);

	it.each(pairs)("%s parent to %s child is %s", (parent, child, allowed) => {
		expect(childPermissionModeAllowed(parent, child)).toBe(allowed);
	});

	it("fails closed for unknown modes", () => {
		expect(childPermissionModeAllowed("unknown", "plan")).toBe(false);
		expect(childPermissionModeAllowed("bypassPermissions", "unknown")).toBe(
			false,
		);
	});
});

describe("delegation permission schemas", () => {
	const modes = [
		"default",
		"acceptEdits",
		"bypassPermissions",
		"plan",
		"dontAsk",
		"auto",
	] as const;

	it.each(modes)("accepts %s for create and resume", (permission_mode) => {
		expect(
			delegateHlidAgentSchema.safeParse({
				task: "Delegate",
				provider: "claude",
				permission_mode,
			}).success,
		).toBe(true);
		expect(
			resumeHlidAgentSchema.safeParse({
				id: "7c0eea4d-f74e-45c8-8674-a535fbb4412b",
				instruction: "Continue",
				permission_mode,
			}).success,
		).toBe(true);
	});

	it("rejects permission modes outside the six-mode session union", () => {
		expect(
			delegateHlidAgentSchema.safeParse({
				task: "Delegate",
				provider: "claude",
				permission_mode: "full_access",
			}).success,
		).toBe(false);
		expect(
			resumeHlidAgentSchema.safeParse({
				id: "7c0eea4d-f74e-45c8-8674-a535fbb4412b",
				instruction: "Continue",
				permission_mode: "read_only",
			}).success,
		).toBe(false);
	});
});
