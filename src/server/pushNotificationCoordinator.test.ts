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

	it("emits one attention event on entry, not reason churn", () => {
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
				url: "/raven?session=db-1",
				label: "Ship notifications",
			},
		]);
		expect(
			tracker.observe([session("needs_attention", "question", 1_200)], 1_200),
		).toEqual([]);
	});

	it("emits completion only for a top-level completed working transition", () => {
		const tracker = new PushNotificationTransitionTracker();
		tracker.observe([session("working", "provider_turn")], 1_000);
		expect(
			tracker.observe([session("recent", "ready", 1_100)], 1_100),
		).toMatchObject([{ kind: "work_finished" }]);

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
				url: "/raven?session=db-grandchild",
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
					url: "/raven?session=db-child",
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

	it("keeps delegated attention exact while retaining main failures", () => {
		const delegated = new PushNotificationTransitionTracker();
		const childWorking = session("working", "provider_turn");
		childWorking.delegation_parent_session_id = "db-parent";
		delegated.observe([childWorking], 1_000);
		const childError = session("needs_attention", "error", 1_100);
		childError.delegation_parent_session_id = "db-parent";
		expect(delegated.observe([childError], 1_100)).toMatchObject([
			{
				kind: "needs_attention",
				sessionId: "db-1",
				url: "/raven?session=db-1",
				reason: "error",
			},
		]);

		const background = new PushNotificationTransitionTracker();
		const backgroundChild = session("working", "provider_activity", 1_200);
		backgroundChild.delegation_depth = 1;
		background.observe([backgroundChild], 1_200);
		const backgroundFailure = session(
			"needs_attention",
			"background_failed",
			1_300,
		);
		backgroundFailure.delegation_depth = 1;
		expect(background.observe([backgroundFailure], 1_300)).toMatchObject([
			{
				kind: "needs_attention",
				sessionId: "db-1",
				reason: "background_failed",
			},
		]);

		const blocked = new PushNotificationTransitionTracker();
		const blockedChild = session("working", "goal_active", 1_400);
		blockedChild.delegation_parent_session_id = "db-parent";
		blocked.observe([blockedChild], 1_400);
		const childGoalBlocked = session("needs_attention", "goal_blocked", 1_500);
		childGoalBlocked.delegation_parent_session_id = "db-parent";
		expect(blocked.observe([childGoalBlocked], 1_500)).toMatchObject([
			{
				kind: "needs_attention",
				sessionId: "db-1",
				reason: "goal_blocked",
			},
		]);

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
});

describe("PushNotificationCoordinator", () => {
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
		await Promise.resolve();
		expect(deliver).toHaveBeenCalledTimes(1);
		expect(deliver).toHaveBeenCalledWith(
			expect.objectContaining({
				kind: "work_finished",
				sessionId: "db-parent",
			}),
		);
	});
});
