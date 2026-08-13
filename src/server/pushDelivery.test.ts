import { describe, expect, it, vi } from "vitest";
import type { StoredPushSubscription } from "../db";
import type {
	PushPreferences,
	WebPushNotificationPayload,
} from "../lib/pushNotificationSchemas";
import { deliverPushEvents, deliverTestPushNotification } from "./pushDelivery";
import type { WebPushSendResult } from "./webPush";

const deliverPushEvent = (
	event: Parameters<typeof deliverPushEvents>[0][number],
	overrides?: Parameters<typeof deliverPushEvents>[1],
) => deliverPushEvents([event], overrides);

const NOW = Date.UTC(2026, 7, 13, 12, 0, 0);

function preferences(patch: Partial<PushPreferences> = {}): PushPreferences {
	return {
		requests: true,
		problems: true,
		work_finished: false,
		privacy: "generic",
		completion_min_runtime_minutes: 0,
		paused_until: null,
		paused_indefinitely: false,
		...patch,
	};
}

function device(
	id: string,
	selected: PushPreferences = preferences(),
): StoredPushSubscription {
	return {
		id,
		authSessionHash: "auth-session-1",
		endpoint: `https://fcm.googleapis.com/fcm/send/${id}`,
		keys: { p256dh: "public", auth: "auth" },
		expirationTime: null,
		name: id,
		preferences: selected,
		enabled: true,
		createdAt: 1,
		updatedAt: 1,
		lastSuccessAt: null,
		lastFailureAt: null,
		failureCount: 0,
	};
}

const genericDevice = device("generic");
const detailedDevice = device(
	"detailed",
	preferences({ work_finished: true, privacy: "detailed" }),
);

function dependencies(
	options: {
		devices?: StoredPushSubscription[];
		mode?: "default" | "notify" | "notify_once" | "mute";
		modes?: Record<string, "default" | "notify" | "notify_once" | "mute">;
		results?: Record<string, "delivered" | "gone" | "failed">;
	} = {},
) {
	const send = vi.fn(
		async (
			subscription: StoredPushSubscription,
			_payload: WebPushNotificationPayload,
			_options: unknown,
		): Promise<WebPushSendResult> => {
			const outcome = options.results?.[subscription.id] ?? "delivered";
			return outcome === "gone"
				? ({ outcome, statusCode: 410 } as const)
				: outcome === "failed"
					? ({ outcome, statusCode: 503 } as const)
					: ({ outcome, statusCode: 201 } as const);
		},
	);
	return {
		now: () => NOW,
		disableExpired: vi.fn(async () => 0),
		listSubscriptions: vi.fn(
			async () => options.devices ?? [genericDevice, detailedDevice],
		),
		getOverride: vi.fn(
			async (sessionId: string) =>
				options.modes?.[sessionId] ?? options.mode ?? "default",
		),
		clearNotifyOnce: vi.fn(async () => true),
		loadVapidKeys: vi.fn(() => ({
			publicKey: "vapid-public",
			privateKey: "vapid-private",
		})),
		send,
		recordSuccess: vi.fn(async () => {}),
		recordFailure: vi.fn(async () => {}),
		sleep: vi.fn(async () => {}),
	};
}

describe("Web Push event delivery", () => {
	it("splits request/problem categories and preserves generic privacy", async () => {
		const requestOnly = device(
			"request-only",
			preferences({ requests: true, problems: false }),
		);
		const deps = dependencies({ devices: [requestOnly, detailedDevice] });
		const summary = await deliverPushEvent(
			{
				kind: "needs_attention",
				sessionId: "session-1",
				label: "Private workspace",
				reason: "permission",
				url: "/raven?session=session-1&attention=permission",
			},
			deps,
		);
		expect(summary).toEqual({
			subscriptions: 2,
			attempted: 2,
			delivered: 2,
			failed: 0,
			disabled: 0,
			suppressed: 0,
		});
		const genericPayload = deps.send.mock.calls.find(
			([subscription]) => subscription.id === "request-only",
		)?.[1] as WebPushNotificationPayload;
		const detailedPayload = deps.send.mock.calls.find(
			([subscription]) => subscription.id === "detailed",
		)?.[1] as WebPushNotificationPayload;
		expect(genericPayload).toMatchObject({
			title: "Hlid needs your attention",
			body: "Open Hlid to continue.",
			url: "/raven?session=session-1",
		});
		expect(JSON.stringify(genericPayload)).not.toContain("Private workspace");
		expect(detailedPayload).toMatchObject({
			title: "Approval required",
			body: "Private workspace",
		});

		const problem = dependencies({ devices: [requestOnly] });
		expect(
			await deliverPushEvent(
				{
					kind: "needs_attention",
					sessionId: "session-2",
					reason: "error",
				},
				problem,
			),
		).toMatchObject({ attempted: 0, suppressed: 1 });
	});

	it("uses reliable runtime for detailed text and per-device thresholds", async () => {
		const threshold = device(
			"threshold",
			preferences({
				work_finished: true,
				privacy: "detailed",
				completion_min_runtime_minutes: 5,
			}),
		);
		const short = dependencies({ devices: [threshold] });
		expect(
			await deliverPushEvent(
				{
					kind: "work_finished",
					sessionId: "short",
					label: "Quick check",
					runtimeMs: 299_999,
				},
				short,
			),
		).toMatchObject({ attempted: 0 });

		const long = dependencies({ devices: [threshold] });
		await deliverPushEvent(
			{
				kind: "work_finished",
				sessionId: "long",
				label: "Release check",
				runtimeMs: 8 * 60_000,
			},
			long,
		);
		expect(long.send.mock.calls[0]?.[1]).toMatchObject({
			title: "Work finished",
			body: "Release check · 8m",
			durationMs: 480_000,
		});
	});

	it("batches only the events eligible for each individual device", async () => {
		const all = device(
			"all",
			preferences({ work_finished: true, completion_min_runtime_minutes: 0 }),
		);
		const longOnly = device(
			"long-only",
			preferences({ work_finished: true, completion_min_runtime_minutes: 5 }),
		);
		const deps = dependencies({ devices: [all, longOnly] });
		const summary = await deliverPushEvents(
			[
				{
					kind: "work_finished",
					sessionId: "short",
					label: "Short",
					runtimeMs: 60_000,
				},
				{
					kind: "work_finished",
					sessionId: "long",
					label: "Long",
					runtimeMs: 600_000,
				},
			],
			deps,
		);
		expect(summary).toMatchObject({ attempted: 2, delivered: 2 });
		const allPayload = deps.send.mock.calls.find(
			([subscription]) => subscription.id === "all",
		)?.[1] as WebPushNotificationPayload;
		const longPayload = deps.send.mock.calls.find(
			([subscription]) => subscription.id === "long-only",
		)?.[1] as WebPushNotificationPayload;
		expect(allPayload).toMatchObject({
			sessionId: "short",
			sessionIds: ["short", "long"],
			url: "/raven",
		});
		expect(allPayload).toHaveProperty("batchId");
		expect(longPayload).toMatchObject({ sessionId: "long" });
		expect(longPayload).not.toHaveProperty("sessionIds");
	});

	it("makes Notify bypass preferences, Mute suppress, and pause win", async () => {
		const optedOut = device(
			"opted-out",
			preferences({ requests: false, problems: false, work_finished: false }),
		);
		const notify = dependencies({ devices: [optedOut], mode: "notify" });
		expect(
			await deliverPushEvent(
				{ kind: "work_finished", sessionId: "session-1" },
				notify,
			),
		).toMatchObject({ attempted: 1, delivered: 1 });

		const mute = dependencies({ devices: [detailedDevice], mode: "mute" });
		expect(
			await deliverPushEvent(
				{ kind: "needs_attention", sessionId: "session-1" },
				mute,
			),
		).toMatchObject({ attempted: 0, suppressed: 1 });

		const paused = device(
			"paused",
			preferences({ paused_until: Math.floor(NOW / 1_000) + 60 }),
		);
		const pause = dependencies({ devices: [paused], mode: "notify" });
		expect(
			await deliverPushEvent(
				{ kind: "needs_attention", sessionId: "session-1" },
				pause,
			),
		).toMatchObject({ attempted: 0 });

		const manuallyPaused = device(
			"manually-paused",
			preferences({ paused_indefinitely: true }),
		);
		const manualPause = dependencies({
			devices: [manuallyPaused],
			mode: "notify",
		});
		expect(
			await deliverPushEvent(
				{ kind: "needs_attention", sessionId: "session-1" },
				manualPause,
			),
		).toMatchObject({ attempted: 0 });
	});

	it("clears Notify once only after at least one provider accepts it", async () => {
		const accepted = dependencies({
			devices: [genericDevice],
			mode: "notify_once",
		});
		await deliverPushEvent(
			{
				kind: "needs_attention",
				sessionId: "session-1",
				reason: "error",
			},
			accepted,
		);
		expect(accepted.clearNotifyOnce).toHaveBeenCalledWith("session-1");

		const failed = dependencies({
			devices: [genericDevice],
			mode: "notify_once",
			results: { generic: "failed" },
		});
		await deliverPushEvent(
			{ kind: "work_finished", sessionId: "session-1" },
			failed,
		);
		expect(failed.clearNotifyOnce).not.toHaveBeenCalled();
	});

	it("serializes overlapping Notify once delivery for the same session", async () => {
		let mode: "notify_once" | "default" = "notify_once";
		let acceptFirst: (() => void) | undefined;
		const firstAccepted = new Promise<void>((resolve) => {
			acceptFirst = resolve;
		});
		const optedOut = device(
			"once",
			preferences({ requests: false, problems: false, work_finished: false }),
		);
		const deps = dependencies({ devices: [optedOut] });
		deps.getOverride.mockImplementation(async () => mode);
		deps.clearNotifyOnce.mockImplementation(async () => {
			mode = "default";
			return true;
		});
		deps.send.mockImplementationOnce(async () => {
			await firstAccepted;
			return { outcome: "delivered", statusCode: 201 };
		});
		const event = {
			kind: "needs_attention" as const,
			sessionId: "session-once",
			reason: "error",
		};
		const first = deliverPushEvent(event, deps);
		await vi.waitFor(() => expect(deps.send).toHaveBeenCalledOnce());
		const second = deliverPushEvent(event, deps);
		expect(deps.getOverride).toHaveBeenCalledOnce();
		acceptFirst?.();
		expect(await first).toMatchObject({ delivered: 1 });
		expect(await second).toMatchObject({ attempted: 0, suppressed: 1 });
		expect(deps.send).toHaveBeenCalledOnce();
		expect(deps.clearNotifyOnce).toHaveBeenCalledOnce();
	});

	it("marks gone subscriptions permanent and records transient failures", async () => {
		const deps = dependencies({
			results: { generic: "gone", detailed: "failed" },
		});
		expect(
			await deliverPushEvent(
				{ kind: "needs_attention", sessionId: "session-1" },
				deps,
			),
		).toMatchObject({ disabled: 1, failed: 1 });
		expect(deps.recordFailure).toHaveBeenCalledWith(
			genericDevice.endpoint,
			true,
		);
		expect(deps.recordFailure).toHaveBeenCalledWith(
			detailedDevice.endpoint,
			false,
		);
		expect(deps.send).toHaveBeenCalledTimes(4);
	});

	it("retries a transient failure without duplicating bookkeeping", async () => {
		const deps = dependencies({ devices: [genericDevice] });
		deps.send
			.mockResolvedValueOnce({ outcome: "failed", statusCode: 503 })
			.mockResolvedValueOnce({ outcome: "delivered", statusCode: 201 });
		expect(
			await deliverPushEvent(
				{ kind: "needs_attention", sessionId: "session-1" },
				deps,
			),
		).toMatchObject({ delivered: 1, failed: 0 });
		expect(deps.sleep).toHaveBeenCalledWith(1_000);
		expect(deps.recordSuccess).toHaveBeenCalledOnce();
		expect(deps.recordFailure).not.toHaveBeenCalled();
	});

	it("sends a distinct test payload despite categories and pause", async () => {
		const paused = device(
			"paused",
			preferences({
				requests: false,
				problems: false,
				work_finished: false,
				paused_until: Math.floor(NOW / 1_000) + 60,
				paused_indefinitely: true,
			}),
		);
		const deps = dependencies({ devices: [paused] });
		expect(await deliverTestPushNotification(paused, deps)).toEqual({
			accepted: true,
			subscriptionRemoved: false,
		});
		expect(deps.send.mock.calls[0]?.[1]).toEqual({
			version: 1,
			kind: "test",
			title: "Hlid test notification",
			body: "Notifications are working on this device.",
			url: "/forge?category=experience&section=notifications",
			createdAt: NOW,
			expiresAt: NOW + 300_000,
		});
	});

	it.each([
		["permission", "Approval required", "Notification preview"],
		["question", "Question waiting", "Notification preview"],
		["plan_review", "Plan review waiting", "Notification preview"],
		["problem", "Session error", "Notification preview"],
		["work_finished", "Work finished", "Notification preview · 2m"],
		[
			"work_finished_batch",
			"3 sessions finished",
			"Preview one, Preview two, Preview three",
		],
	] as const)("renders the %s preview with the device's detailed wording", async (scenario, title, body) => {
		const detailed = device(
			`preview-${scenario}`,
			preferences({ privacy: "detailed" }),
		);
		const deps = dependencies({ devices: [detailed] });

		expect(await deliverTestPushNotification(detailed, deps, scenario)).toEqual(
			{ accepted: true, subscriptionRemoved: false },
		);
		expect(deps.send.mock.calls[0]?.[1]).toMatchObject({
			kind: "test",
			title,
			body,
			url: "/forge?category=experience&section=notifications",
		});
	});

	it("falls back to a strict exact Raven attention link", async () => {
		const deps = dependencies({ devices: [genericDevice] });
		await deliverPushEvent(
			{
				kind: "needs_attention",
				sessionId: "session & one",
				url: "/raven?session=session+%26+one&attention=permission&agent=bad",
			},
			deps,
		);
		const payload = deps.send.mock.calls[0]?.[1] as WebPushNotificationPayload;
		expect(payload.url).toBe("/raven?session=session+%26+one");
	});
});
