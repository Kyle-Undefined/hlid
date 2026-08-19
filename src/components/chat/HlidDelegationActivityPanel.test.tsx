// @vitest-environment jsdom
import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as privacyStore from "#/hooks/privacyStore";
import {
	getDataRevisionSnapshot,
	replaceDataRevisions,
	resetDataRevisionsForTesting,
} from "#/hooks/wsDataRevisionStore";
import {
	replaceSessionsStatus,
	resetSessionStatusForTesting,
} from "#/hooks/wsSessionStatusStore";
import type { HlidDelegationListItem } from "#/lib/serverFns/hlidDelegations";
import type { SessionStatusEntry } from "#/server/protocol";

const { mockGetHlidDelegationsFn } = vi.hoisted(() => ({
	mockGetHlidDelegationsFn: vi.fn(),
}));

vi.mock("#/lib/serverFns/hlidDelegations", () => ({
	getHlidDelegationsFn: mockGetHlidDelegationsFn,
}));

import { HlidDelegationActivityPanel } from "./HlidDelegationActivityPanel";

afterEach(cleanup);

beforeEach(() => {
	privacyStore.__resetForTesting();
	resetDataRevisionsForTesting();
	resetSessionStatusForTesting();
	mockGetHlidDelegationsFn.mockReset();
});

function child(
	overrides: Partial<HlidDelegationListItem> = {},
): HlidDelegationListItem {
	return {
		id: "7c0eea4d-f74e-45c8-8674-a535fbb4412b",
		parent_session_id: "parent-session",
		parent_turn_id: "parent-turn",
		parent_label: "Parent",
		parent_delegation_id: null,
		routine_run_id: null,
		child_session_id: "child-session",
		depth: 1,
		task: "Review the orchestration lifecycle",
		provider_id: "codex",
		model: "gpt-5.6",
		effort: "high",
		service_tier: null,
		workspace: "/workspace",
		workspace_mode: "shared",
		execution_workspace: "/workspace",
		worktree_branch: null,
		worktree_base_commit: null,
		worktree_state: "none",
		permission_mode: "default",
		timeout_seconds: 300,
		token_budget: null,
		tokens_used: 2_000,
		cost_budget: null,
		cost_used: 0.01,
		attempt_count: 1,
		continuation_mode: "initial",
		handoff: {
			visible_transcript_chars: 0,
			selected_skills: 0,
			selected_relics: 0,
			vault_references: 0,
			workspace_references: 0,
		},
		status: "running",
		started_at: Math.floor(Date.now() / 1_000) - 10,
		updated_at: Math.floor(Date.now() / 1_000),
		ended_at: null,
		result_text: null,
		error: null,
		progress_text: "Using Read",
		open_url: "/raven?session=child-session",
		complete: false,
		resumable: false,
		result_available: false,
		error_available: false,
		...overrides,
	};
}

function childSession(
	overrides: Partial<SessionStatusEntry> = {},
): SessionStatusEntry {
	return {
		session_id: "pool-child",
		agent_cwd: "/workspace",
		agent_name: "codex delegate",
		state: "running",
		provider_id: "codex",
		model: "gpt-5.6",
		hasPendingPermissions: false,
		hasDbSession: true,
		db_session_id: "child-session",
		...overrides,
	};
}

describe("HlidDelegationActivityPanel", () => {
	it("renders one durable child row per delegation id at mobile-safe width", async () => {
		const running = child();
		mockGetHlidDelegationsFn.mockResolvedValue([running, running]);
		render(<HlidDelegationActivityPanel sessionId="parent-session" />);

		const toggle = await screen.findByRole("button", {
			name: "Show Hlid delegated children",
		});
		expect(screen.queryByRole("listitem")).toBeNull();
		fireEvent.click(toggle);
		await waitFor(() =>
			expect(
				screen.getByText("Review the orchestration lifecycle"),
			).not.toBeNull(),
		);
		expect(screen.getAllByRole("listitem")).toHaveLength(1);
		const row = screen.getByRole("listitem");
		expect(row.className).toContain("grid-cols-[auto_minmax(0,1fr)_auto]");
		expect(row.className).toContain("min-w-0");
		const link = screen.getByRole("link", {
			name: "Open Review the orchestration lifecycle child",
		});
		expect(link.getAttribute("href")).toBe("/raven?session=child-session");
		expect(link.className).toContain("min-w-9");
		expect(within(row).getByText("codex · gpt-5.6").className).not.toContain(
			"hidden",
		);
		const effort = within(row).getByText("high effort");
		expect(effort.textContent).toBe("high effort");
		expect(effort.className).toContain("shrink-0");
		expect(effort.className).not.toContain("hidden");
		expect(mockGetHlidDelegationsFn).toHaveBeenCalledWith({
			data: { sessionId: "parent-session", limit: 50 },
		});
	});

	it("shows descendant-wide token, cost, and wall-clock elapsed totals", async () => {
		mockGetHlidDelegationsFn.mockResolvedValue([
			child({
				status: "completed",
				complete: true,
				started_at: 100,
				updated_at: 200,
				ended_at: 200,
				progress_text: null,
			}),
		]);
		replaceSessionsStatus([
			childSession({
				session_id: "pool-parent",
				db_session_id: "parent-session",
				state: "idle",
				delegated_attention: {
					direct_count: 1,
					descendant_count: 3,
					waiting_count: 0,
					completed_count: 3,
					failed_count: 0,
					needs_attention_count: 0,
					working_count: 0,
					queued_count: 0,
					recent_count: 0,
					leading_bucket: "recent",
					since: 1,
					last_activity_at: 2,
					total_tokens: 125_400,
					total_cost: 0.456,
					elapsed_duration_seconds: 7_505,
				},
			}),
		]);
		render(<HlidDelegationActivityPanel sessionId="parent-session" />);

		const totals = await screen.findByTitle(/all delegated descendants/);
		expect(totals.textContent).toBe("125.4k tokens · $0.456 · 2h 5m elapsed");
		expect(totals.getAttribute("title")).toContain("all delegated descendants");
	});

	it("uses the wall-clock span for the direct-child fallback", async () => {
		mockGetHlidDelegationsFn.mockResolvedValue([
			child({
				id: "delegation-a",
				child_session_id: "child-a",
				status: "completed",
				complete: true,
				started_at: 100,
				updated_at: 200,
				ended_at: 200,
				tokens_used: 1_000,
				cost_used: 0.01,
				progress_text: null,
			}),
			child({
				id: "delegation-b",
				child_session_id: "child-b",
				status: "completed",
				complete: true,
				started_at: 150,
				updated_at: 260,
				ended_at: 260,
				tokens_used: 3_000,
				cost_used: 0.02,
				progress_text: null,
			}),
		]);
		render(<HlidDelegationActivityPanel sessionId="fallback-parent" />);

		const totals = await screen.findByTitle(/direct children shown/);
		expect(totals.textContent).toBe("4k tokens · $0.030 · 2m 40s elapsed");
	});

	it("replaces a stale running snapshot after the durable sessions revision", async () => {
		mockGetHlidDelegationsFn
			.mockResolvedValueOnce([child()])
			.mockResolvedValueOnce([
				child({
					status: "cancelled",
					complete: true,
					ended_at: Math.floor(Date.now() / 1_000),
					progress_text: null,
				}),
			]);
		render(<HlidDelegationActivityPanel sessionId="revision-parent" />);

		await waitFor(() =>
			expect(screen.getByText(/1 child · 1 running/)).not.toBeNull(),
		);
		act(() => {
			replaceDataRevisions({
				...getDataRevisionSnapshot(),
				sessions: getDataRevisionSnapshot().sessions + 1,
			});
		});

		await waitFor(() =>
			expect(screen.getByText(/1 child · 1 settled/)).not.toBeNull(),
		);
		fireEvent.click(
			screen.getByRole("button", { name: "Show Hlid delegated children" }),
		);
		expect(screen.getByText("CANCELLED")).not.toBeNull();
		expect(screen.queryByText("RUNNING")).toBeNull();
		expect(mockGetHlidDelegationsFn).toHaveBeenCalledTimes(2);
	});

	it("shows an active child with stopping progress as stopping", async () => {
		mockGetHlidDelegationsFn.mockResolvedValue([
			child({ progress_text: "Stopping after current tool call" }),
		]);
		render(<HlidDelegationActivityPanel sessionId="stopping-parent" />);

		fireEvent.click(
			await screen.findByRole("button", {
				name: "Show Hlid delegated children",
			}),
		);
		await waitFor(() => expect(screen.getByText("STOPPING")).not.toBeNull());
		expect(screen.queryByText("RUNNING")).toBeNull();
		const status = screen.getByLabelText("stopping delegation status");
		expect(status.className).toContain("text-status-warning/80");
		expect(status.querySelector(".animate-spin")).toBeNull();
	});

	it("attributes exact session attention to the owning child row", async () => {
		mockGetHlidDelegationsFn.mockResolvedValue([
			child({ provider_id: "claude", model: "sonnet" }),
		]);
		replaceSessionsStatus([
			childSession({
				provider_id: "claude",
				model: "sonnet",
				hasPendingPermissions: true,
				attention: {
					bucket: "needs_attention",
					reason: "question",
					since: 1,
					last_activity_at: 2,
					queue_count: 0,
					pending_count: 1,
				},
			}),
		]);
		render(<HlidDelegationActivityPanel sessionId="attention-parent" />);

		const toggle = await screen.findByRole("button", {
			name: "Show Hlid delegated children",
		});
		expect(
			screen.getByText(/1 child · 1 needs you · 1 running/),
		).not.toBeNull();
		expect(screen.queryByRole("listitem")).toBeNull();
		fireEvent.click(toggle);
		await waitFor(() => expect(screen.getByRole("listitem")).not.toBeNull());
		const row = screen.getByRole("listitem");
		expect(within(row).getAllByText(/Question/).length).toBeGreaterThan(0);
		expect(row.dataset.delegationId).toBe(
			"7c0eea4d-f74e-45c8-8674-a535fbb4412b",
		);
		expect(
			within(row).getByRole("link", {
				name: "Open Review the orchestration lifecycle child",
			}),
		).not.toBeNull();
	});

	it("keeps settled history compact until the user opens it", async () => {
		mockGetHlidDelegationsFn.mockResolvedValue([
			child({
				status: "completed",
				complete: true,
				ended_at: Math.floor(Date.now() / 1_000),
				progress_text: null,
			}),
		]);
		render(<HlidDelegationActivityPanel sessionId="settled-parent" />);

		const toggle = await screen.findByRole("button", {
			name: "Show Hlid delegated children",
		});
		expect(screen.queryByRole("listitem")).toBeNull();
		expect(screen.getByText(/1 child · 1 settled/)).not.toBeNull();

		fireEvent.click(toggle);
		expect(screen.getByRole("listitem")).not.toBeNull();
		expect(screen.getByText("COMPLETED")).not.toBeNull();
	});

	it("keeps historical budget-exhausted caps visible", async () => {
		mockGetHlidDelegationsFn.mockResolvedValue([
			child({
				status: "budget_exhausted",
				complete: true,
				token_budget: 12_000,
				cost_budget: 0.05,
				ended_at: Math.floor(Date.now() / 1_000),
				progress_text: null,
			}),
		]);
		render(<HlidDelegationActivityPanel sessionId="legacy-budget-parent" />);

		fireEvent.click(
			await screen.findByRole("button", {
				name: "Show Hlid delegated children",
			}),
		);
		expect(screen.getByText("BUDGET EXHAUSTED")).not.toBeNull();
		expect(screen.getByText("2k / 12k tokens")).not.toBeNull();
		expect(screen.getByText("$0.010 / $0.050")).not.toBeNull();
	});
});
