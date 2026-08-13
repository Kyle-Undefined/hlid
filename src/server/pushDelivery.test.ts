import { describe, expect, it, vi } from "vitest";
import type { StoredPushSubscription } from "../db";
import type { WebPushNotificationPayload } from "../lib/pushNotificationSchemas";
import { deliverPushEvent } from "./pushDelivery";
import type { WebPushSendResult } from "./webPush";

const NOW = Date.UTC(2026, 7, 13, 12, 0, 0);

function device(
	id: string,
	preferences: StoredPushSubscription["preferences"],
): StoredPushSubscription {
	return {
		id,
		authSessionHash: "auth-session-1",
		endpoint: `https://fcm.googleapis.com/fcm/send/${id}`,
		keys: { p256dh: "public", auth: "auth" },
		expirationTime: null,
		preferences,
		enabled: true,
		createdAt: 1,
		updatedAt: 1,
		lastSuccessAt: null,
		lastFailureAt: null,
		failureCount: 0,
	};
}

const genericDevice = device("generic", {
	needs_attention: true,
	work_finished: false,
	privacy: "generic",
});
const detailedDevice = device("detailed", {
	needs_attention: true,
	work_finished: true,
	privacy: "detailed",
});

function dependencies(
	options: {
		devices?: StoredPushSubscription[];
		mode?: "default" | "notify" | "mute";
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
		getOverride: vi.fn(async () => options.mode ?? "default"),
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
	it("applies device categories and generic/detailed privacy independently", async () => {
		const deps = dependencies();
		const summary = await deliverPushEvent(
			{
				kind: "needs_attention",
				sessionId: "session-1",
				label: "Private workspace",
				reason: "Approval required for rm -rf secret",
				url: "/raven?session=session-1",
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
			([subscription]) => subscription.id === "generic",
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
			body: "Private workspace: Needs your attention",
		});
	});

	it("turns internal reasons into useful detailed wording", async () => {
		const attention = dependencies({ devices: [detailedDevice] });
		await deliverPushEvent(
			{
				kind: "needs_attention",
				sessionId: "session-1",
				label: "Release check",
				reason: "permission",
			},
			attention,
		);
		expect(attention.send.mock.calls[0]?.[1]).toMatchObject({
			body: "Release check: Approval required",
		});

		const finished = dependencies({ devices: [detailedDevice] });
		await deliverPushEvent(
			{
				kind: "work_finished",
				sessionId: "session-1",
				label: "Release check",
				reason: "background_completed",
			},
			finished,
		);
		expect(finished.send.mock.calls[0]?.[1]).toMatchObject({
			body: "Work finished in Release check.",
		});
	});

	it("makes Default follow device toggles, Notify bypass them, and Mute suppress", async () => {
		const optedOut = device("opted-out", {
			needs_attention: false,
			work_finished: false,
			privacy: "generic",
		});
		const defaults = dependencies({ devices: [optedOut] });
		expect(
			await deliverPushEvent(
				{ kind: "work_finished", sessionId: "session-1" },
				defaults,
			),
		).toMatchObject({ attempted: 0, suppressed: 1 });
		expect(defaults.loadVapidKeys).not.toHaveBeenCalled();

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
		expect(deps.recordSuccess).not.toHaveBeenCalled();
		expect(deps.send).toHaveBeenCalledTimes(4);
		expect(deps.sleep).toHaveBeenCalledTimes(2);
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

	it("does not retry a permanent request failure", async () => {
		const deps = dependencies({ devices: [genericDevice] });
		deps.send.mockResolvedValueOnce({ outcome: "failed", statusCode: 400 });

		expect(
			await deliverPushEvent(
				{ kind: "needs_attention", sessionId: "session-1" },
				deps,
			),
		).toMatchObject({ delivered: 0, failed: 1 });
		expect(deps.send).toHaveBeenCalledOnce();
		expect(deps.sleep).not.toHaveBeenCalled();
	});

	it("does not recast a delivered push when bookkeeping is unavailable", async () => {
		const deps = dependencies({ devices: [genericDevice] });
		deps.recordSuccess.mockRejectedValueOnce(new Error("database unavailable"));
		expect(
			await deliverPushEvent(
				{ kind: "needs_attention", sessionId: "session-1" },
				deps,
			),
		).toMatchObject({ delivered: 1, failed: 0 });
		expect(deps.recordFailure).not.toHaveBeenCalled();
	});

	it("prunes expired devices before loading eligible subscriptions", async () => {
		const deps = dependencies({ devices: [] });
		await deliverPushEvent(
			{ kind: "needs_attention", sessionId: "session-1" },
			deps,
		);
		expect(deps.disableExpired).toHaveBeenCalledWith(NOW);
		expect(deps.listSubscriptions).toHaveBeenCalledWith(NOW);
	});

	it("falls back to an exact relative Raven link", async () => {
		const deps = dependencies({ devices: [genericDevice] });
		await deliverPushEvent(
			{
				kind: "needs_attention",
				sessionId: "session & one",
				url: "https://evil.example/",
			},
			deps,
		);
		const payload = deps.send.mock.calls[0]?.[1] as WebPushNotificationPayload;
		expect(payload.url).toBe("/raven?session=session+%26+one");
	});
});
