import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HlidDelegationManager } from "./hlidDelegation";
import { createHlidDelegationRouteHandler } from "./hlidDelegationRoutes";
import type { HlidDelegationSnapshot } from "./hlidDelegationSchemas";

const delegationId = "7c0eea4d-f74e-45c8-8674-a535fbb4412b";

function snapshot(
	overrides: Partial<HlidDelegationSnapshot> = {},
): HlidDelegationSnapshot {
	return {
		id: delegationId,
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
		workspace: "/workspace",
		workspace_mode: "shared",
		execution_workspace: "/workspace",
		worktree_branch: null,
		worktree_base_commit: null,
		worktree_state: "none",
		permission_mode: "plan",
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
		error: null,
		progress_text: null,
		open_url: "/raven?session=child-1",
		complete: false,
		resumable: false,
		...overrides,
	};
}

describe("Hlid delegation routes", () => {
	const delegate = vi.fn();
	const list = vi.fn();
	const inspect = vi.fn();
	const wait = vi.fn();
	const steer = vi.fn();
	const cancel = vi.fn();
	const cleanupWorktree = vi.fn();
	const resume = vi.fn();
	const handler = createHlidDelegationRouteHandler({
		delegate,
		list,
		inspect,
		wait,
		steer,
		cancel,
		cleanupWorktree,
		resume,
	} as unknown as HlidDelegationManager);

	beforeEach(() => {
		vi.clearAllMocks();
		delegate.mockResolvedValue(snapshot());
		list.mockResolvedValue([snapshot()]);
		inspect.mockResolvedValue(snapshot({ status: "running" }));
		steer.mockResolvedValue(snapshot({ status: "running" }));
		cancel.mockResolvedValue(snapshot({ status: "cancelled", complete: true }));
		resume.mockResolvedValue(
			snapshot({
				status: "pending",
				attempt_count: 2,
				continuation_mode: "explicit_new_turn",
			}),
		);
		wait.mockResolvedValue(
			snapshot({
				status: "completed",
				complete: true,
				result_text: "Done",
			}),
		);
	});

	it("lists, steers, cancels, and explicitly continues parent-owned children", async () => {
		const listed = await handler(
			new URL(
				"http://hlid.test/hlid-agents?parent_session_id=parent-1&limit=10",
			),
			new Request("http://hlid.test/hlid-agents"),
		);
		expect(listed?.status).toBe(200);
		expect(list).toHaveBeenCalledWith("parent-1", 10);

		const steered = await handler(
			new URL(`http://hlid.test/hlid-agents/${delegationId}/steer`),
			new Request(`http://hlid.test/hlid-agents/${delegationId}/steer`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					parent_session_id: "parent-1",
					instruction: "Check the edge case",
				}),
			}),
		);
		expect(steered?.status).toBe(200);
		expect(steer).toHaveBeenCalledWith(
			"parent-1",
			delegationId,
			"Check the edge case",
		);

		const cancelled = await handler(
			new URL(`http://hlid.test/hlid-agents/${delegationId}/cancel`),
			new Request(`http://hlid.test/hlid-agents/${delegationId}/cancel`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ parent_session_id: "parent-1" }),
			}),
		);
		expect(cancelled?.status).toBe(200);
		expect(cancel).toHaveBeenCalledWith("parent-1", delegationId);

		const resumed = await handler(
			new URL(`http://hlid.test/hlid-agents/${delegationId}/resume`),
			new Request(`http://hlid.test/hlid-agents/${delegationId}/resume`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					parent_session_id: "parent-1",
					instruction: "Continue explicitly",
				}),
			}),
		);
		expect(resumed?.status).toBe(202);
		expect(resume).toHaveBeenCalledWith(
			"parent-1",
			delegationId,
			expect.objectContaining({ instruction: "Continue explicitly" }),
		);
	});

	it("creates a child asynchronously from a validated parent-owned request", async () => {
		const response = await handler(
			new URL("http://hlid.test/hlid-agents/delegate"),
			new Request("http://hlid.test/hlid-agents/delegate", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					parent_session_id: " parent-1 ",
					task: "Review the provider boundary",
					provider: "codex",
					permission_mode: "plan",
				}),
			}),
		);

		expect(response?.status).toBe(202);
		expect(delegate).toHaveBeenCalledWith("parent-1", {
			task: "Review the provider boundary",
			provider: "codex",
			permission_mode: "plan",
		});
		expect(await response?.json()).toMatchObject({
			id: delegationId,
			child_session_id: "child-1",
		});
	});

	it("strips legacy timeout and usage caps", async () => {
		const delegated = await handler(
			new URL("http://hlid.test/hlid-agents/delegate"),
			new Request("http://hlid.test/hlid-agents/delegate", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					parent_session_id: "parent-1",
					task: "Review the provider boundary",
					provider: "codex",
					timeout_seconds: 120,
					token_budget: 12_000,
					cost_budget: 1,
				}),
			}),
		);
		expect(delegated?.status).toBe(202);
		expect(delegate).toHaveBeenCalledWith("parent-1", {
			task: "Review the provider boundary",
			provider: "codex",
		});

		const resumed = await handler(
			new URL(`http://hlid.test/hlid-agents/${delegationId}/resume`),
			new Request(`http://hlid.test/hlid-agents/${delegationId}/resume`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					parent_session_id: "parent-1",
					instruction: "Continue explicitly",
					timeout_seconds: 180,
					token_budget: 24_000,
					cost_budget: 2,
				}),
			}),
		);
		expect(resumed?.status).toBe(202);
		expect(resume).toHaveBeenCalledWith("parent-1", delegationId, {
			id: delegationId,
			instruction: "Continue explicitly",
		});
	});

	it("inspects and waits only with explicit parent ownership", async () => {
		const inspected = await handler(
			new URL(
				`http://hlid.test/hlid-agents/${delegationId}?parent_session_id=parent-1`,
			),
			new Request(`http://hlid.test/hlid-agents/${delegationId}`),
		);
		expect(inspected?.status).toBe(200);
		expect(inspect).toHaveBeenCalledWith("parent-1", delegationId);

		const waited = await handler(
			new URL(`http://hlid.test/hlid-agents/${delegationId}/wait`),
			new Request(`http://hlid.test/hlid-agents/${delegationId}/wait`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					parent_session_id: "parent-1",
					wait_seconds: 5,
				}),
			}),
		);
		expect(waited?.status).toBe(200);
		expect(wait).toHaveBeenCalledWith("parent-1", delegationId, 5);
		expect(await waited?.json()).toMatchObject({
			status: "completed",
			result_text: "Done",
		});
	});

	it("rejects missing parent ownership and invalid delegation IDs", async () => {
		const missingParent = await handler(
			new URL(`http://hlid.test/hlid-agents/${delegationId}`),
			new Request(`http://hlid.test/hlid-agents/${delegationId}`),
		);
		expect(missingParent?.status).toBe(400);

		const invalidId = await handler(
			new URL("http://hlid.test/hlid-agents/not-a-uuid"),
			new Request(
				"http://hlid.test/hlid-agents/not-a-uuid?parent_session_id=parent-1",
			),
		);
		expect(invalidId?.status).toBe(400);
		expect(inspect).not.toHaveBeenCalled();
	});

	it("treats malformed JSON and non-object bodies as bad requests", async () => {
		for (const body of ["{", "null"]) {
			const response = await handler(
				new URL("http://hlid.test/hlid-agents/delegate"),
				new Request("http://hlid.test/hlid-agents/delegate", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body,
				}),
			);
			expect(response?.status).toBe(400);
		}
		expect(delegate).not.toHaveBeenCalled();
	});

	it("maps parent-scoped misses to not found", async () => {
		inspect.mockRejectedValueOnce(
			new Error("Delegated child not found for this parent session."),
		);
		const response = await handler(
			new URL(
				`http://hlid.test/hlid-agents/${delegationId}?parent_session_id=other-parent`,
			),
			new Request(`http://hlid.test/hlid-agents/${delegationId}`),
		);

		expect(response?.status).toBe(404);
	});
});
