import { describe, expect, it, vi } from "vitest";
import type { SessionStatusEntry } from "./protocol";
import {
	PushNotificationCoordinator,
	PushNotificationTransitionTracker,
} from "./pushNotificationCoordinator";

function session(
	bucket: NonNullable<SessionStatusEntry["attention"]>["bucket"],
	reason: NonNullable<SessionStatusEntry["attention"]>["reason"],
	since = 100,
): SessionStatusEntry {
	return {
		session_id: "pool-1",
		db_session_id: "db-1",
		hasDbSession: true,
		agent_cwd: "/workspace",
		agent_name: "Workspace",
		lastLabel: "Ship notifications",
		state: bucket === "working" ? "running" : "idle",
		model: "test",
		hasPendingPermissions: bucket === "needs_attention",
		attention: {
			bucket,
			reason,
			since,
			last_activity_at: since,
			queue_count: 0,
			pending_count: bucket === "needs_attention" ? 1 : 0,
		},
	};
}

function delegatedRollup(
	failedCount: number,
): NonNullable<SessionStatusEntry["delegated_attention"]> {
	return {
		direct_count: 1,
		descendant_count: 1,
		waiting_count: 0,
		completed_count: 0,
		failed_count: failedCount,
		needs_attention_count: 0,
		working_count: failedCount === 0 ? 1 : 0,
		queued_count: 0,
		recent_count: failedCount === 0 ? 0 : 1,
		leading_bucket: failedCount === 0 ? "working" : "recent",
		since: 1_000,
		last_activity_at: failedCount === 0 ? 1_000 : 1_100,
	};
}

describe("PushNotificationTransitionTracker", () => {
	it("seeds its first snapshot without startup spam", () => {
		const tracker = new PushNotificationTransitionTracker();
		expect(tracker.observe([session("needs_attention", "permission")])).toEqual(
			[],
		);
	});

	it("emits attention on entry and a replacement on meaningful reason change", () => {
		const tracker = new PushNotificationTransitionTracker();
		tracker.observe([session("working", "provider_turn")], 1_000);
		const events = tracker.observe(
			[session("needs_attention", "permission", 1_100)],
			1_100,
		);
		expect(events).toMatchObject([
			{
				kind: "needs_attention",
				sessionId: "db-1",
				url: "/raven?session=db-1&attention=permission",
				label: "Ship notifications",
			},
		]);
		expect(
			tracker.observe([session("needs_attention", "question", 1_200)], 1_200),
		).toMatchObject([{ kind: "needs_attention", reason: "question" }]);
		expect(
			tracker.observe([session("needs_attention", "question", 1_300)], 1_300),
		).toEqual([]);
	});

	it("re-alerts when another request joins the same attention state", () => {
		const tracker = new PushNotificationTransitionTracker();
		tracker.observe([session("working", "provider_turn")], 1_000);
		const firstRequest = session("needs_attention", "permission", 1_100);
		expect(tracker.observe([firstRequest], 1_100)).toMatchObject([
			{ category: "request", pendingCount: 1 },
		]);

		const secondRequest = structuredClone(firstRequest);
		if (!secondRequest.attention) throw new Error("attention is required");
		secondRequest.attention.pending_count = 2;
		secondRequest.attention.last_activity_at = 1_200;
		expect(tracker.observe([secondRequest], 1_200)).toMatchObject([
			{ category: "request", pendingCount: 2 },
		]);
		expect(tracker.observe([secondRequest], 1_300)).toEqual([]);
	});

	it("tracks equal-count request replacements by exact pending identity", () => {
		const tracker = new PushNotificationTransitionTracker();
		tracker.observe([session("working", "provider_turn")], 1_000);
		const first = session("needs_attention", "permission", 1_100);
		if (!first.attention) throw new Error("attention is required");
		first.attention.pending_ids = ["permission-1"];
		expect(tracker.observe([first], 1_100)).toMatchObject([
			{
				attentionId: "permission-1",
				url: "/raven?session=db-1&attention=permission&attention_id=permission-1",
			},
		]);

		const replacement = structuredClone(first);
		if (!replacement.attention) throw new Error("attention is required");
		replacement.attention.pending_ids = ["permission-2"];
		replacement.attention.last_activity_at = 1_200;
		expect(tracker.observe([replacement], 1_200)).toMatchObject([
			{
				pendingCount: 1,
				attentionId: "permission-2",
				url: "/raven?session=db-1&attention=permission&attention_id=permission-2",
			},
		]);
		expect(tracker.observe([replacement], 1_300)).toEqual([]);
	});

	it("re-alerts the remaining request when the selected exact request resolves", () => {
		const tracker = new PushNotificationTransitionTracker();
		tracker.observe([session("working", "provider_turn")], 1_000);
		const pair = session("needs_attention", "question", 1_100);
		if (!pair.attention) throw new Error("attention is required");
		pair.attention.pending_count = 2;
		pair.attention.pending_ids = ["question-1", "question-2"];
		expect(tracker.observe([pair], 1_100)).toMatchObject([
			{ attentionId: "question-2" },
		]);

		const remaining = structuredClone(pair);
		if (!remaining.attention) throw new Error("attention is required");
		remaining.attention.pending_count = 1;
		remaining.attention.pending_ids = ["question-1"];
		remaining.attention.last_activity_at = 1_200;
		expect(tracker.observe([remaining], 1_200)).toMatchObject([
			{
				attentionId: "question-1",
				url: "/raven?session=db-1&attention=question&attention_id=question-1",
			},
		]);
	});

	it("does not degrade an explicitly unusable request identity to a type-only hint", () => {
		const tracker = new PushNotificationTransitionTracker();
		tracker.observe([session("working", "provider_turn")], 1_000);
		const current = session("needs_attention", "plan_review", 1_100);
		if (!current.attention) throw new Error("attention is required");
		current.attention.pending_ids = [];
		const [event] = tracker.observe([current], 1_100);
		expect(event).toMatchObject({ url: "/raven?session=db-1" });
		expect(event).not.toHaveProperty("attentionId");
	});

	it("classifies operational attention separately from requests", () => {
		const tracker = new PushNotificationTransitionTracker();
		tracker.observe([session("working", "provider_turn")], 1_000);
		expect(
			tracker.observe([session("needs_attention", "error", 1_100)], 1_100),
		).toMatchObject([{ category: "problem" }]);
	});

	it("emits completion only for a top-level completed working transition", () => {
		const tracker = new PushNotificationTransitionTracker();
		tracker.observe([session("working", "provider_turn")], 1_000);
		expect(
			tracker.observe([session("recent", "ready", 1_100)], 1_100),
		).toMatchObject([{ kind: "work_finished", category: "completion" }]);

		const paused = new PushNotificationTransitionTracker();
		paused.observe([session("working", "goal_active")], 2_000);
		expect(
			paused.observe([session("recent", "goal_paused", 2_100)], 2_100),
		).toEqual([]);

		const delegated = new PushNotificationTransitionTracker();
		const childWorking = session("working", "provider_turn");
		childWorking.delegation_parent_session_id = "db-parent";
		delegated.observe([childWorking], 3_000);
		const childDone = session("recent", "ready", 3_100);
		childDone.delegation_parent_session_id = "db-parent";
		expect(delegated.observe([childDone], 3_100)).toEqual([]);
	});

	it("leaves all Routine-owned outcomes to the scheduler notification path", () => {
		for (const terminal of [
			["recent", "ready"],
			["needs_attention", "permission"],
			["needs_attention", "error"],
		] as const) {
			const tracker = new PushNotificationTransitionTracker();
			const started = session("working", "routine_running", 1_000);
			started.routine_owned = true;
			tracker.observe([started], 1_000);

			const providerActivity = session("working", "provider_activity", 1_050);
			providerActivity.routine_owned = true;
			expect(tracker.observe([providerActivity], 1_050)).toEqual([]);

			const settled = session(terminal[0], terminal[1], 1_100);
			settled.routine_owned = true;
			expect(tracker.observe([settled], 1_100)).toEqual([]);
		}
	});

	it("measures runtime from the continuous working epoch across reason churn", () => {
		const tracker = new PushNotificationTransitionTracker();
		tracker.observe([session("working", "provider_turn", 1_000)], 1_000);
		expect(
			tracker.observe(
				[session("working", "provider_activity", 120_000)],
				120_000,
			),
		).toEqual([]);
		expect(
			tracker.observe([session("recent", "ready", 301_000)], 301_000),
		).toMatchObject([{ kind: "work_finished", runtimeMs: 300_000 }]);
	});

	it("fails closed when delegated completion metadata is incomplete", () => {
		const remembered = new PushNotificationTransitionTracker();
		const childWorking = session("working", "provider_turn");
		childWorking.delegation_parent_session_id = "db-parent";
		remembered.observe([childWorking], 1_000);
		const childDoneWithoutMetadata = session("recent", "ready", 1_100);
		expect(remembered.observe([childDoneWithoutMetadata], 1_100)).toEqual([]);

		const currentDepth = new PushNotificationTransitionTracker();
		currentDepth.observe([session("working", "provider_turn")], 2_000);
		const childDoneWithDepth = session("recent", "ready", 2_100);
		childDoneWithDepth.delegation_depth = 1;
		expect(currentDepth.observe([childDoneWithDepth], 2_100)).toEqual([]);

		const sticky = new PushNotificationTransitionTracker();
		const stickyChild = session("working", "provider_turn", 3_000);
		stickyChild.delegation_parent_session_id = "db-parent";
		sticky.observe([stickyChild], 3_000);
		sticky.observe([session("working", "provider_turn", 3_100)], 3_100);
		expect(sticky.observe([session("recent", "ready", 3_200)], 3_200)).toEqual(
			[],
		);
	});

	it("does not create a deep link for an undurable session", () => {
		const tracker = new PushNotificationTransitionTracker();
		const running = session("working", "provider_turn");
		const attention = session("needs_attention", "permission");
		running.hasDbSession = false;
		running.db_session_id = null;
		attention.hasDbSession = false;
		attention.db_session_id = null;
		tracker.observe([running], 1_000);
		expect(tracker.observe([attention], 1_100)).toEqual([]);
	});

	it("does not carry a pool entry transition across durable chats", () => {
		const tracker = new PushNotificationTransitionTracker();
		tracker.observe([session("working", "provider_turn")], 1_000);
		const nextChat = session("recent", "ready", 1_100);
		nextChat.db_session_id = "db-2";
		expect(tracker.observe([nextChat], 1_100)).toEqual([]);
	});

	it("emits only the top-level completion when a nested delegation settles", () => {
		const tracker = new PushNotificationTransitionTracker();
		const rootWorking = session("working", "delegated_child_working");
		rootWorking.session_id = "pool-root";
		rootWorking.db_session_id = "db-root";
		const childWorking = session("working", "provider_turn");
		childWorking.session_id = "pool-child";
		childWorking.db_session_id = "db-child";
		childWorking.delegation_parent_session_id = "db-root";
		const grandchildWorking = session("working", "provider_turn");
		grandchildWorking.session_id = "pool-grandchild";
		grandchildWorking.db_session_id = "db-grandchild";
		grandchildWorking.delegation_parent_session_id = "db-child";
		tracker.observe([rootWorking, childWorking, grandchildWorking], 1_000);

		const rootDone = {
			...rootWorking,
			attention: {
				bucket: "recent" as const,
				reason: "ready" as const,
				since: 1_300,
				last_activity_at: 1_300,
				queue_count: 0,
				pending_count: 0,
			},
		};
		const childDone = {
			...childWorking,
			attention: {
				bucket: "recent" as const,
				reason: "ready" as const,
				since: 1_100,
				last_activity_at: 1_100,
				queue_count: 0,
				pending_count: 0,
			},
		};
		const grandchildDone = {
			...grandchildWorking,
			attention: {
				bucket: "recent" as const,
				reason: "background_completed" as const,
				since: 1_100,
				last_activity_at: 1_100,
				queue_count: 0,
				pending_count: 0,
			},
		};
		expect(
			tracker.observe([rootWorking, childWorking, grandchildDone], 1_100),
		).toEqual([]);
		expect(
			tracker.observe([rootWorking, childDone, grandchildDone], 1_200),
		).toEqual([]);
		const rootCompletion = tracker.observe(
			[rootDone, childDone, grandchildDone],
			1_300,
		);
		expect(rootCompletion).toHaveLength(1);
		expect(rootCompletion).toMatchObject([
			{ kind: "work_finished", sessionId: "db-root" },
		]);

		const simultaneous = new PushNotificationTransitionTracker();
		simultaneous.observe([rootWorking, childWorking, grandchildWorking], 2_000);
		const simultaneousCompletion = simultaneous.observe(
			[rootDone, childDone, grandchildDone],
			2_100,
		);
		expect(simultaneousCompletion).toHaveLength(1);
		expect(simultaneousCompletion).toMatchObject([
			{ kind: "work_finished", sessionId: "db-root" },
		]);
	});

	it("links delegated attention to the exact child and suppresses ancestor rollups", () => {
		const tracker = new PushNotificationTransitionTracker();
		const rootWorking = session("working", "provider_turn");
		rootWorking.session_id = "pool-root";
		rootWorking.db_session_id = "db-root";
		const childWorking = session("working", "provider_turn");
		childWorking.session_id = "pool-child";
		childWorking.db_session_id = "db-child";
		childWorking.delegation_parent_session_id = "db-root";
		const grandchildWorking = session("working", "provider_turn");
		grandchildWorking.session_id = "pool-grandchild";
		grandchildWorking.db_session_id = "db-grandchild";
		grandchildWorking.delegation_parent_session_id = "db-child";
		tracker.observe([rootWorking, childWorking, grandchildWorking], 1_000);

		const rollupAttention = (
			value: SessionStatusEntry,
		): SessionStatusEntry => ({
			...value,
			attention: {
				bucket: "needs_attention",
				reason: "delegated_child_attention",
				since: 1_100,
				last_activity_at: 1_100,
				queue_count: 0,
				pending_count: 0,
			},
		});
		const grandchildAttention: SessionStatusEntry = {
			...grandchildWorking,
			attention: {
				bucket: "needs_attention",
				reason: "question",
				since: 1_100,
				last_activity_at: 1_100,
				queue_count: 0,
				pending_count: 1,
			},
		};
		expect(
			tracker.observe(
				[
					rollupAttention(rootWorking),
					rollupAttention(childWorking),
					grandchildAttention,
				],
				1_100,
			),
		).toMatchObject([
			{
				kind: "needs_attention",
				sessionId: "db-grandchild",
				url: "/raven?session=db-grandchild&attention=question",
				reason: "question",
			},
		]);
	});

	it("suppresses a staggered ancestor rollup after exact child attention", () => {
		const tracker = new PushNotificationTransitionTracker();
		const rootWorking = session("working", "provider_turn");
		rootWorking.session_id = "pool-root";
		rootWorking.db_session_id = "db-root";
		const childWorking = session("working", "provider_turn");
		childWorking.session_id = "pool-child";
		childWorking.db_session_id = "db-child";
		childWorking.delegation_parent_session_id = "db-root";
		tracker.observe([rootWorking, childWorking], 1_000);

		const childAttention: SessionStatusEntry = {
			...childWorking,
			attention: {
				bucket: "needs_attention",
				reason: "permission",
				since: 1_100,
				last_activity_at: 1_100,
				queue_count: 0,
				pending_count: 1,
			},
		};
		expect(tracker.observe([rootWorking, childAttention], 1_100)).toMatchObject(
			[
				{
					kind: "needs_attention",
					sessionId: "db-child",
					url: "/raven?session=db-child&attention=permission",
				},
			],
		);

		const rootRollup: SessionStatusEntry = {
			...rootWorking,
			attention: {
				bucket: "needs_attention",
				reason: "delegated_child_attention",
				since: 1_100,
				last_activity_at: 1_200,
				queue_count: 0,
				pending_count: 0,
			},
		};
		expect(tracker.observe([rootRollup, childAttention], 1_200)).toEqual([]);
	});

	it("retains independent parent and child attention from the same snapshot", () => {
		const tracker = new PushNotificationTransitionTracker();
		const rootWorking = session("working", "provider_turn");
		rootWorking.session_id = "pool-root";
		rootWorking.db_session_id = "db-root";
		const childWorking = session("working", "provider_turn");
		childWorking.session_id = "pool-child";
		childWorking.db_session_id = "db-child";
		childWorking.delegation_parent_session_id = "db-root";
		tracker.observe([rootWorking, childWorking], 1_000);

		const rootPermission: SessionStatusEntry = {
			...rootWorking,
			attention: {
				bucket: "needs_attention",
				reason: "permission",
				since: 1_100,
				last_activity_at: 1_100,
				queue_count: 0,
				pending_count: 1,
			},
		};
		const childQuestion: SessionStatusEntry = {
			...childWorking,
			attention: {
				bucket: "needs_attention",
				reason: "question",
				since: 1_100,
				last_activity_at: 1_100,
				queue_count: 0,
				pending_count: 1,
			},
		};
		const events = tracker.observe([rootPermission, childQuestion], 1_100);
		expect(events).toHaveLength(2);
		expect(events).toMatchObject([
			{
				kind: "needs_attention",
				sessionId: "db-root",
				reason: "permission",
			},
			{
				kind: "needs_attention",
				sessionId: "db-child",
				reason: "question",
			},
		]);
	});

	it("keeps terminal durable child failure parent-owned", () => {
		const tracker = new PushNotificationTransitionTracker();
		const root = session("recent", "ready", 1_000);
		root.delegated_attention = delegatedRollup(0);
		tracker.observe([root], 1_000);

		const rootFailed = {
			...root,
			delegated_attention: delegatedRollup(1),
		};
		expect(tracker.observe([rootFailed], 1_100)).toEqual([]);

		const mainDecision = session("needs_attention", "question", 1_200);
		mainDecision.delegated_attention = delegatedRollup(1);
		expect(tracker.observe([mainDecision], 1_200)).toMatchObject([
			{
				kind: "needs_attention",
				sessionId: "db-1",
				reason: "question",
			},
		]);
	});

	it("keeps child failures parent-owned while retaining top-level failures", () => {
		const childOwnedReasons = [
			"error",
			"background_failed",
			"goal_blocked",
			"goal_budget",
			"routine_action_required",
			"routine_delivery_error",
			"routine_failed",
			"routine_unavailable",
			"delegation_interrupted",
		] as const;
		for (const [index, reason] of childOwnedReasons.entries()) {
			const delegated = new PushNotificationTransitionTracker();
			const startedAt = 1_000 + index * 100;
			const childWorking = session("working", "provider_turn", startedAt);
			childWorking.delegation_parent_session_id = "db-parent";
			delegated.observe([childWorking], startedAt);

			// Some terminal provider snapshots lose delegation metadata. Remembered
			// durable provenance must still fail closed and leave the outcome to the
			// top-level session.
			expect(
				delegated.observe(
					[session("needs_attention", reason, startedAt + 50)],
					startedAt + 50,
				),
			).toEqual([]);
		}

		const main = new PushNotificationTransitionTracker();
		main.observe([session("working", "provider_turn")], 2_000);
		expect(
			main.observe([session("needs_attention", "error", 2_100)], 2_100),
		).toMatchObject([
			{
				kind: "needs_attention",
				sessionId: "db-1",
				reason: "error",
			},
		]);

		const mainBackground = new PushNotificationTransitionTracker();
		mainBackground.observe([session("working", "provider_activity")], 3_000);
		expect(
			mainBackground.observe(
				[session("needs_attention", "background_failed", 3_100)],
				3_100,
			),
		).toMatchObject([
			{
				kind: "needs_attention",
				sessionId: "db-1",
				reason: "background_failed",
			},
		]);
	});

	it("retains exact deep links for direct child requests", () => {
		for (const reason of ["permission", "question", "plan_review"] as const) {
			const tracker = new PushNotificationTransitionTracker();
			const childWorking = session("working", "provider_turn", 1_000);
			childWorking.delegation_parent_session_id = "db-parent";
			tracker.observe([childWorking], 1_000);

			expect(
				tracker.observe([session("needs_attention", reason, 1_100)], 1_100),
			).toMatchObject([
				{
					kind: "needs_attention",
					sessionId: "db-1",
					reason,
					url: `/raven?session=db-1&attention=${reason}`,
				},
			]);
		}
	});
});

describe("PushNotificationCoordinator", () => {
	it("reconciles restored startup attention only after restoration completes", async () => {
		let now = 10_000;
		const callbacks: Array<() => void> = [];
		const persist = vi.fn();
		const deliver = vi.fn();
		const coordinator = new PushNotificationCoordinator({
			deliver,
			persist,
			now: () => now,
			visibleUntil: () => null,
			schedule: (next) => {
				callbacks.push(next);
				return callbacks.length as unknown as ReturnType<typeof setTimeout>;
			},
			cancel: () => {},
		});
		const recent = session("recent", "ready", 9_000);
		const restored = session("needs_attention", "permission", 9_500);
		if (!restored.attention) throw new Error("attention is required");
		restored.attention.pending_ids = ["permission-restored"];

		coordinator.observeStartup([recent]);
		coordinator.observe([restored]);
		expect(persist).not.toHaveBeenCalled();
		expect(deliver).not.toHaveBeenCalled();
		expect(
			coordinator.isEventStillRelevant({
				kind: "needs_attention",
				sessionId: "db-1",
				sessionAliases: ["pool-1", "db-1"],
				reason: "permission",
				pendingCount: 1,
				attentionSince: 9_500,
				attentionId: "permission-restored",
				occurredAt: 9_500,
			}),
		).toBe(true);

		coordinator.completeStartup([restored]);
		expect(persist).toHaveBeenCalledOnce();
		expect(persist).toHaveBeenCalledWith(
			expect.objectContaining({
				attentionId: "permission-restored",
				attentionSince: 9_500,
			}),
		);
		coordinator.observe([restored]);
		expect(persist).toHaveBeenCalledOnce();

		now = 10_751;
		callbacks.at(-1)?.();
		await Promise.resolve();
		expect(deliver).toHaveBeenCalledOnce();
	});

	it("treats missing or resolved startup attention as stale after completion", () => {
		const persisted = {
			kind: "needs_attention" as const,
			sessionId: "db-1",
			sessionAliases: ["pool-1", "db-1"],
			reason: "question",
			pendingCount: 1,
			attentionSince: 9_500,
			attentionId: "question-restored",
			occurredAt: 9_500,
		};
		const missing = new PushNotificationCoordinator({ deliver: vi.fn() });
		missing.observeStartup([]);
		expect(missing.isEventStillRelevant(persisted)).toBe(true);
		missing.completeStartup([]);
		expect(missing.isEventStillRelevant(persisted)).toBe(false);

		const resolved = new PushNotificationCoordinator({ deliver: vi.fn() });
		const pending = session("needs_attention", "question", 9_500);
		if (!pending.attention) throw new Error("attention is required");
		pending.attention.pending_ids = ["question-restored"];
		resolved.observeStartup([pending]);
		resolved.completeStartup([session("recent", "ready", 10_000)]);
		expect(resolved.isEventStillRelevant(persisted)).toBe(false);
	});

	it("ignores startup attention older than the durable event lifetime", () => {
		const persist = vi.fn();
		const now = 2 * 24 * 60 * 60_000;
		const coordinator = new PushNotificationCoordinator({
			deliver: vi.fn(),
			persist,
			now: () => now,
		});
		const stale = session("needs_attention", "permission", 1);
		if (!stale.attention) throw new Error("attention is required");
		stale.attention.pending_ids = ["permission-stale"];
		coordinator.observeStartup([stale]);
		coordinator.completeStartup([stale]);
		expect(persist).not.toHaveBeenCalled();
	});

	it("replaces a settling permission with the current pending question", async () => {
		let now = 1_000;
		const callbacks: Array<() => void> = [];
		const deliver = vi.fn();
		const coordinator = new PushNotificationCoordinator({
			deliver,
			now: () => now,
			visibleUntil: () => null,
			schedule: (next) => {
				callbacks.push(next);
				return callbacks.length as unknown as ReturnType<typeof setTimeout>;
			},
			cancel: () => {},
		});
		coordinator.observe([session("working", "provider_turn", 1_000)]);
		now = 1_100;
		coordinator.observe([session("needs_attention", "permission", 1_100)]);
		now = 1_200;
		coordinator.observe([session("needs_attention", "question", 1_200)]);
		now = 1_951;
		for (const callback of callbacks) callback();
		await Promise.resolve();
		expect(deliver).toHaveBeenCalledOnce();
		expect(deliver).toHaveBeenCalledWith(
			expect.objectContaining({ reason: "question" }),
		);
	});

	it("delivers a new direct attention reason after an earlier alert", async () => {
		let now = 1_000;
		const callbacks: Array<() => void> = [];
		const deliver = vi.fn();
		const coordinator = new PushNotificationCoordinator({
			deliver,
			now: () => now,
			visibleUntil: () => null,
			schedule: (next) => {
				callbacks.push(next);
				return callbacks.length as unknown as ReturnType<typeof setTimeout>;
			},
			cancel: () => {},
		});
		coordinator.observe([session("working", "provider_turn", 1_000)]);
		now = 1_100;
		coordinator.observe([session("needs_attention", "permission", 1_100)]);
		now = 1_851;
		callbacks.shift()?.();
		await Promise.resolve();
		now = 2_000;
		coordinator.observe([session("needs_attention", "question", 2_000)]);
		now = 2_751;
		callbacks.shift()?.();
		await Promise.resolve();
		expect(deliver).toHaveBeenCalledTimes(2);
		expect(deliver.mock.calls.map(([event]) => event.reason)).toEqual([
			"permission",
			"question",
		]);
	});

	it("defers while Raven is visible, then delivers if still relevant", async () => {
		let now = 1_000;
		let callback: (() => void) | undefined;
		const deliver = vi.fn();
		const coordinator = new PushNotificationCoordinator({
			deliver,
			now: () => now,
			visibleUntil: () => 1_500,
			schedule: (next) => {
				callback = next;
				return 1 as unknown as ReturnType<typeof setTimeout>;
			},
			cancel: () => {},
		});
		coordinator.observe([session("working", "provider_turn")]);
		coordinator.observe([session("needs_attention", "permission", 1_100)]);
		expect(deliver).not.toHaveBeenCalled();

		now = 1_760;
		callback?.();
		await Promise.resolve();
		expect(deliver).toHaveBeenCalledTimes(1);
	});

	it("cancels a deferred attention alert once resolved", () => {
		const deliver = vi.fn();
		const cancel = vi.fn();
		const coordinator = new PushNotificationCoordinator({
			deliver,
			now: () => 1_000,
			visibleUntil: () => 1_500,
			schedule: () => 1 as unknown as ReturnType<typeof setTimeout>,
			cancel,
		});
		coordinator.observe([session("working", "provider_turn")]);
		coordinator.observe([session("needs_attention", "permission", 1_100)]);
		coordinator.observe([session("recent", "ready", 1_200)]);
		expect(cancel).toHaveBeenCalledTimes(1);
		expect(deliver).not.toHaveBeenCalled();
	});

	it("lets a brief transition settle before starting delivery", async () => {
		let now = 1_000;
		let callback: (() => void) | undefined;
		const deliver = vi.fn();
		const coordinator = new PushNotificationCoordinator({
			deliver,
			now: () => now,
			visibleUntil: () => null,
			schedule: (next) => {
				callback = next;
				return 1 as unknown as ReturnType<typeof setTimeout>;
			},
			cancel: () => {},
		});
		coordinator.observe([session("working", "provider_turn")]);
		coordinator.observe([session("needs_attention", "permission", 1_100)]);
		expect(deliver).not.toHaveBeenCalled();

		now = 1_751;
		callback?.();
		await Promise.resolve();
		expect(deliver).toHaveBeenCalledOnce();
	});

	it("delivers a settled completion after its live row retires", async () => {
		let now = 1_000;
		let callback: (() => void) | undefined;
		const deliver = vi.fn();
		const coordinator = new PushNotificationCoordinator({
			deliver,
			now: () => now,
			visibleUntil: () => null,
			schedule: (next) => {
				callback = next;
				return 1 as unknown as ReturnType<typeof setTimeout>;
			},
			cancel: () => {},
		});
		coordinator.observe([session("working", "provider_turn")]);
		now = 1_100;
		coordinator.observe([session("recent", "ready", 1_100)]);
		coordinator.observe([]);

		now = 1_851;
		callback?.();
		now = 21_851;
		callback?.();
		await Promise.resolve();
		expect(deliver).toHaveBeenCalledOnce();
	});

	it("ignores a delegated completion and delivers its top-level session later", async () => {
		let now = 1_000;
		let callback: (() => void) | undefined;
		const deliver = vi.fn();
		const coordinator = new PushNotificationCoordinator({
			deliver,
			now: () => now,
			visibleUntil: () => null,
			schedule: (next) => {
				callback = next;
				return 1 as unknown as ReturnType<typeof setTimeout>;
			},
			cancel: () => {},
		});
		const parentWorking = session("working", "provider_turn");
		parentWorking.session_id = "pool-parent";
		parentWorking.db_session_id = "db-parent";
		const childWorking = session("working", "provider_turn");
		childWorking.session_id = "pool-child";
		childWorking.db_session_id = "db-child";
		childWorking.delegation_parent_session_id = "db-parent";
		coordinator.observe([parentWorking, childWorking]);

		now = 1_100;
		const childDone = {
			...childWorking,
			attention: {
				bucket: "recent" as const,
				reason: "ready" as const,
				since: now,
				last_activity_at: now,
				queue_count: 0,
				pending_count: 0,
			},
		};
		coordinator.observe([parentWorking, childDone]);
		now = 1_851;
		callback?.();
		await Promise.resolve();
		expect(deliver).not.toHaveBeenCalled();

		now = 10_100;
		coordinator.observe([
			{
				...parentWorking,
				attention: {
					bucket: "recent",
					reason: "ready",
					since: now,
					last_activity_at: now,
					queue_count: 0,
					pending_count: 0,
				},
			},
			childDone,
		]);
		now = 10_851;
		callback?.();
		now = 30_851;
		callback?.();
		await Promise.resolve();
		expect(deliver).toHaveBeenCalledTimes(1);
		expect(deliver).toHaveBeenCalledWith([
			expect.objectContaining({
				kind: "work_finished",
				sessionId: "db-parent",
			}),
		]);
	});

	it("chunks a busy completion window into portable batches of at most ten", async () => {
		let now = 1_000;
		const scheduled: Array<() => void> = [];
		const deliver = vi.fn();
		const coordinator = new PushNotificationCoordinator({
			deliver,
			now: () => now,
			visibleUntil: () => null,
			schedule: (next) => {
				scheduled.push(next);
				return scheduled.length as unknown as ReturnType<typeof setTimeout>;
			},
			cancel: () => {},
		});
		const working = Array.from({ length: 11 }, (_, index) => {
			const value = session("working", "provider_turn", 1_000);
			value.session_id = `pool-${index}`;
			value.db_session_id = `db-${index}`;
			return value;
		});
		coordinator.observe(working);
		now = 1_100;
		coordinator.observe(
			working.map((value) => ({
				...value,
				attention: {
					bucket: "recent" as const,
					reason: "ready" as const,
					since: now,
					last_activity_at: now,
					queue_count: 0,
					pending_count: 0,
				},
			})),
		);
		expect(scheduled).toHaveLength(11);
		now = 1_851;
		for (const callback of scheduled.splice(0, 11)) callback();
		expect(scheduled).toHaveLength(1);
		now = 21_851;
		scheduled.shift()?.();
		await Promise.resolve();
		expect(deliver).toHaveBeenCalledTimes(2);
		expect(deliver.mock.calls[0]?.[0]).toHaveLength(10);
		expect(deliver.mock.calls[1]?.[0]).toHaveLength(1);
	});

	it("rechecks presence and expiry when the completion batch flushes", async () => {
		let now = 1_000;
		let visible = false;
		const scheduled: Array<() => void> = [];
		const deliver = vi.fn();
		const coordinator = new PushNotificationCoordinator({
			deliver,
			now: () => now,
			visibleUntil: () => (visible ? now + 1_000 : null),
			schedule: (next) => {
				scheduled.push(next);
				return scheduled.length as unknown as ReturnType<typeof setTimeout>;
			},
			cancel: () => {},
		});
		coordinator.observe([session("working", "provider_turn", 1_000)]);
		now = 1_100;
		coordinator.observe([session("recent", "ready", 1_100)]);
		now = 1_851;
		scheduled.shift()?.();
		visible = true;
		now = 21_851;
		scheduled.shift()?.();
		await Promise.resolve();
		expect(deliver).not.toHaveBeenCalled();

		visible = false;
		coordinator.observe([session("working", "provider_turn", 30_000)]);
		now = 30_100;
		coordinator.observe([session("recent", "ready", 30_100)]);
		now = 30_851;
		scheduled.shift()?.();
		// The normal TTL is much longer; advance beyond it to exercise the flush
		// guard without changing production timers.
		now = 6 * 60_000;
		scheduled.shift()?.();
		await Promise.resolve();
		expect(deliver).not.toHaveBeenCalled();
	});
});
