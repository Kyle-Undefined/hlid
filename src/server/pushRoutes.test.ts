import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
	EffectivePushSessionPolicy,
	PushNotificationBatchMember,
	PushNotificationBatchRecord,
	PushNotificationEventRecord,
	PushNotificationHistoryEntry,
	PushSessionPolicy,
	PushSubscriptionDevice,
	StoredPushSubscription,
} from "../db";
import { createPushRouteHandler } from "./pushRoutes";

const endpoint = "https://fcm.googleapis.com/fcm/send/device-one";
const preferences = {
	requests: true,
	problems: false,
	work_finished: false,
	privacy: "generic" as const,
	completion_min_runtime_minutes: 0 as const,
	paused_until: null,
	paused_indefinitely: false,
	quiet_hours: null,
};
const stored: StoredPushSubscription = {
	id: "57f3e352-5d49-4cff-bd06-ea37dd06a930",
	authSessionHash: "auth-session-1",
	endpoint,
	keys: { p256dh: "public", auth: "auth" },
	expirationTime: null,
	name: "Phone",
	preferences,
	enabled: true,
	createdAt: 1,
	updatedAt: 2,
	lastSuccessAt: null,
	lastFailureAt: null,
	failureCount: 0,
};
const device: PushSubscriptionDevice = {
	id: stored.id,
	name: "Phone",
	current: true,
	enabled: true,
	preferences,
	pausedUntil: null,
	pausedIndefinitely: false,
	createdAt: 1,
	updatedAt: 2,
	lastSuccessAt: null,
	lastFailureAt: null,
	failureCount: 0,
};

const sessionPolicy: PushSessionPolicy = {
	sessionId: "session-1",
	mode: "notify_completion_once",
	scope: "delegation_tree",
	targetDeviceIds: [stored.id],
	updatedAt: 42,
};
const effectivePolicy: EffectivePushSessionPolicy = {
	requestedSessionId: "session-1",
	sourceSessionId: "session-1",
	mode: "notify_completion_once",
	scope: "delegation_tree",
	targetDeviceIds: [stored.id],
	inherited: false,
};
const event: PushNotificationEventRecord = {
	id: "d028669f-f0dc-431d-bd31-bcc115f94db8",
	sourceKind: "session",
	sourceId: "session-1",
	category: "completion",
	reason: "work_finished",
	label: "Compile release",
	url: "/raven/session/session-1",
	runtimeMs: 30_000,
	pendingCount: 0,
	occurredAt: 1_700_000,
	expiresAt: 2_700_000,
	groupKey: "completion",
	batchId: "batch-one",
	status: "batched",
	statusReason: null,
	nextAttemptAt: null,
	metadata: {},
	dedupeKey: "session-1:completion",
	createdAt: 1_700_000,
	updatedAt: 1_700_000,
};
const historyEvent: PushNotificationHistoryEntry = {
	...event,
	deliveries: [
		{
			id: "ef6a5a87-282e-4679-82a7-abfa1a27c177",
			eventId: event.id,
			deviceId: stored.id,
			deviceSnapshot: {
				id: stored.id,
				name: "Phone",
				privacy: "generic",
			},
			status: "sent",
			reason: null,
			nextAttemptAt: null,
			attemptCount: 1,
			providerStatus: 201,
			receiptAt: 1_710_000,
			displayedAt: 1_720_000,
			openedAt: null,
			dismissedAt: null,
			createdAt: 1_700_000,
			updatedAt: 1_720_000,
		},
	],
};
const batch: PushNotificationBatchRecord = {
	id: "batch-one",
	category: "completion",
	groupKey: "completion",
	status: "sent",
	createdAt: 1_700_000,
	updatedAt: 1_710_000,
	sentAt: 1_710_000,
	readAt: null,
};
const batchMember: PushNotificationBatchMember = {
	batchId: batch.id,
	eventId: event.id,
	sessionId: "session-1",
	position: 0,
	addedAt: 1_700_000,
	readAt: null,
};

const publicKey = vi.fn();
const now = vi.fn();
const authSessionHash = vi.fn();
const getSubscription = vi.fn();
const upsertSubscription = vi.fn();
const updatePreferences = vi.fn();
const deleteSubscription = vi.fn();
const listDevices = vi.fn();
const updateDevice = vi.fn();
const revokeDevice = vi.fn();
const setSessionOverride = vi.fn();
const getSessionPolicy = vi.fn();
const getEffectiveSessionPolicy = vi.fn();
const setSessionPolicy = vi.fn();
const cancelOneShotDeliveries = vi.fn();
const recordClientReceipt = vi.fn();
const listHistory = vi.fn();
const getBatch = vi.fn();
const listBatchMembers = vi.fn();
const getEvent = vi.fn();
const markBatchRead = vi.fn();
const markBatchMemberRead = vi.fn();
const onDeliveryStateChanged = vi.fn();
const testPush = vi.fn();
const validateSubscription = vi.fn();
const validateEndpoint = vi.fn();

function routeHandler() {
	return createPushRouteHandler({
		publicKey,
		now,
		authSessionHash,
		getSubscription,
		upsertSubscription,
		updatePreferences,
		deleteSubscription,
		listDevices,
		updateDevice,
		revokeDevice,
		setSessionOverride,
		getSessionPolicy,
		getEffectiveSessionPolicy,
		setSessionPolicy,
		cancelOneShotDeliveries,
		recordClientReceipt,
		listHistory,
		getBatch,
		listBatchMembers,
		getEvent,
		markBatchRead,
		markBatchMemberRead,
		onDeliveryStateChanged,
		testPush,
		validateSubscription,
		validateEndpoint,
	});
}

let handle = routeHandler();

function request(path: string, method = "GET", body?: unknown): Request {
	return new Request(`https://hlid.test${path}`, {
		method,
		headers:
			body === undefined ? undefined : { "content-type": "application/json" },
		body: body === undefined ? undefined : JSON.stringify(body),
	});
}

async function call(path: string, method = "GET", body?: unknown) {
	return handle(
		new URL(`https://hlid.test${path}`),
		request(path, method, body),
	);
}

beforeEach(() => {
	vi.clearAllMocks();
	publicKey.mockReturnValue("public-vapid-key");
	now.mockReturnValue(1_800_000);
	authSessionHash.mockResolvedValue("auth-session-1");
	getSubscription.mockResolvedValue(stored);
	upsertSubscription.mockResolvedValue(stored);
	updatePreferences.mockResolvedValue(stored);
	deleteSubscription.mockResolvedValue(true);
	listDevices.mockResolvedValue([device]);
	updateDevice.mockResolvedValue(device);
	revokeDevice.mockResolvedValue(true);
	setSessionOverride.mockResolvedValue("default");
	getSessionPolicy.mockResolvedValue(sessionPolicy);
	getEffectiveSessionPolicy.mockResolvedValue(effectivePolicy);
	setSessionPolicy.mockResolvedValue(sessionPolicy);
	recordClientReceipt.mockResolvedValue(historyEvent.deliveries[0]);
	listHistory.mockResolvedValue([historyEvent]);
	getBatch.mockResolvedValue(batch);
	listBatchMembers.mockResolvedValue([batchMember]);
	getEvent.mockResolvedValue(event);
	markBatchRead.mockResolvedValue(true);
	markBatchMemberRead.mockResolvedValue(true);
	onDeliveryStateChanged.mockResolvedValue(undefined);
	testPush.mockResolvedValue({ accepted: true, subscriptionRemoved: false });
	handle = routeHandler();
});

describe("authenticated Web Push routes", () => {
	it("returns only public setup material and never caches it", async () => {
		const response = await call("/api/push/config");
		expect(response?.status).toBe(200);
		expect(response?.headers.get("cache-control")).toBe("private, no-store");
		expect(await response?.json()).toEqual({
			available: true,
			publicKey: "public-vapid-key",
		});
	});

	it("reports an unsubscribed device without requiring an endpoint", async () => {
		const response = await call("/api/push/status", "POST", {});
		expect(await response?.json()).toEqual({
			available: true,
			subscribed: false,
			preferences: null,
			device_name: null,
		});
		expect(getSubscription).not.toHaveBeenCalled();
	});

	it("reports an expired current endpoint as disabled before another delivery", async () => {
		getSubscription.mockResolvedValueOnce({
			...stored,
			expirationTime: 1_799_999,
			enabled: true,
		});
		const response = await call("/api/push/status", "POST", { endpoint });
		expect(await response?.json()).toMatchObject({
			subscribed: false,
			device_name: "Phone",
		});
		expect(getSubscription).toHaveBeenCalledWith(
			endpoint,
			"auth-session-1",
			1_800_000,
		);
	});

	it("normalizes legacy preferences when registering and updates v2 preferences", async () => {
		const subscription = {
			endpoint,
			expirationTime: null,
			keys: { p256dh: "cHVibGlj", auth: "YXV0aA" },
		};
		const registered = await call("/api/push/subscriptions", "POST", {
			subscription,
			preferences: {
				needs_attention: false,
				work_finished: true,
				privacy: "detailed",
			},
			device_name: "My phone",
		});
		expect(registered?.status).toBe(200);
		expect(upsertSubscription).toHaveBeenCalledWith(
			subscription,
			"auth-session-1",
			{
				requests: false,
				problems: false,
				work_finished: true,
				privacy: "detailed",
				completion_min_runtime_minutes: 0,
				paused_until: null,
				paused_indefinitely: false,
				quiet_hours: null,
			},
			"My phone",
		);

		const priorCanonical = await call("/api/push/subscriptions", "POST", {
			subscription,
			preferences: {
				requests: true,
				problems: false,
				work_finished: false,
				privacy: "generic",
				completion_min_runtime_minutes: 1,
				paused_until: null,
			},
		});
		expect(priorCanonical?.status).toBe(200);
		expect(upsertSubscription).toHaveBeenLastCalledWith(
			subscription,
			"auth-session-1",
			{
				requests: true,
				problems: false,
				work_finished: false,
				privacy: "generic",
				completion_min_runtime_minutes: 1,
				paused_until: null,
				paused_indefinitely: false,
				quiet_hours: null,
			},
			undefined,
		);

		onDeliveryStateChanged.mockClear();
		const updated = await call("/api/push/subscriptions", "PATCH", {
			endpoint,
			preferences: {
				requests: false,
				completion_min_runtime_minutes: 5,
				paused_until: 123,
			},
		});
		expect(updated?.status).toBe(200);
		expect(updatePreferences).toHaveBeenCalledWith(endpoint, "auth-session-1", {
			requests: false,
			completion_min_runtime_minutes: 5,
			paused_until: 123,
		});
		expect(onDeliveryStateChanged).toHaveBeenCalledTimes(1);

		const manuallyPaused = await call("/api/push/subscriptions", "PATCH", {
			endpoint,
			preferences: {
				paused_until: null,
				paused_indefinitely: true,
			},
		});
		expect(manuallyPaused?.status).toBe(200);
		expect(updatePreferences).toHaveBeenLastCalledWith(
			endpoint,
			"auth-session-1",
			{
				paused_until: null,
				paused_indefinitely: true,
			},
		);
		expect(onDeliveryStateChanged).toHaveBeenCalledTimes(2);
	});

	it("wakes the outbox after deleting an owned subscription", async () => {
		const response = await call("/api/push/subscriptions", "DELETE", {
			endpoint,
		});

		expect(await response?.json()).toEqual({ ok: true, removed: true });
		expect(deleteSubscription).toHaveBeenCalledWith(endpoint, "auth-session-1");
		expect(onDeliveryStateChanged).toHaveBeenCalledTimes(1);
	});

	it("rotates an owned endpoint without losing its device choices", async () => {
		const nextEndpoint = "https://fcm.googleapis.com/fcm/send/device-two";
		const subscription = {
			endpoint: nextEndpoint,
			expirationTime: null,
			keys: { p256dh: "bmV3LXB1YmxpYw", auth: "bmV3LWF1dGg" },
		};
		const replacement = { ...stored, endpoint: nextEndpoint };
		getSubscription.mockResolvedValueOnce(stored);
		upsertSubscription.mockResolvedValueOnce(replacement);

		const response = await call("/api/push/subscriptions", "POST", {
			subscription,
			replaces_endpoint: endpoint,
		});

		expect(response?.status).toBe(200);
		expect(getSubscription).toHaveBeenCalledWith(
			endpoint,
			"auth-session-1",
			1_800_000,
		);
		expect(upsertSubscription).toHaveBeenCalledWith(
			subscription,
			"auth-session-1",
			preferences,
			"Phone",
			endpoint,
		);
		expect(deleteSubscription).toHaveBeenCalledWith(endpoint, "auth-session-1");
		expect(onDeliveryStateChanged).toHaveBeenCalledTimes(1);
		expect(upsertSubscription.mock.invocationCallOrder[0]).toBeLessThan(
			deleteSubscription.mock.invocationCallOrder[0] ?? 0,
		);

		vi.clearAllMocks();
		now.mockReturnValue(1_800_000);
		authSessionHash.mockResolvedValue("auth-session-1");
		getSubscription.mockResolvedValue(stored);
		upsertSubscription.mockRejectedValue(new Error("database unavailable"));
		const failed = await call("/api/push/subscriptions", "POST", {
			subscription,
			replaces_endpoint: endpoint,
		});
		expect(failed?.status).toBe(500);
		expect(deleteSubscription).not.toHaveBeenCalled();
		expect(onDeliveryStateChanged).not.toHaveBeenCalled();
	});

	it("lets the DB repair a missing replacement after auth expiry", async () => {
		getSubscription.mockResolvedValueOnce(null);
		const response = await call("/api/push/subscriptions", "POST", {
			subscription: {
				endpoint: "https://fcm.googleapis.com/fcm/send/device-two",
				expirationTime: null,
				keys: { p256dh: "bmV3LXB1YmxpYw", auth: "bmV3LWF1dGg" },
			},
			replaces_endpoint: endpoint,
		});
		expect(response?.status).toBe(200);
		expect(upsertSubscription).toHaveBeenCalledWith(
			expect.objectContaining({
				endpoint: "https://fcm.googleapis.com/fcm/send/device-two",
			}),
			"auth-session-1",
			undefined,
			undefined,
			endpoint,
		);
		expect(deleteSubscription).toHaveBeenCalledWith(endpoint, "auth-session-1");
	});

	it("treats a same-endpoint refresh as an in-place subscription update", async () => {
		const subscription = {
			endpoint,
			expirationTime: null,
			keys: { p256dh: "cmVmcmVzaGVk", auth: "cmVmcmVzaGVkLWF1dGg" },
		};
		const response = await call("/api/push/subscriptions", "POST", {
			subscription,
			replaces_endpoint: endpoint,
		});
		expect(response?.status).toBe(200);
		expect(getSubscription).not.toHaveBeenCalled();
		expect(upsertSubscription).toHaveBeenCalledWith(
			subscription,
			"auth-session-1",
			undefined,
			undefined,
		);
		expect(deleteSubscription).not.toHaveBeenCalled();
		expect(onDeliveryStateChanged).toHaveBeenCalledTimes(1);
	});

	it("lists non-secret devices, preserves current identity on rename, and revokes", async () => {
		const listed = await call("/api/push/devices", "POST", { endpoint });
		expect(await listed?.json()).toEqual({
			devices: [
				{
					id: device.id,
					name: "Phone",
					current: true,
					enabled: true,
					preferences: {
						...preferences,
						needs_attention: true,
						catch_up_after_pause: false,
						reminder_minutes: 0,
					},
					paused_until: null,
					paused_indefinitely: false,
					created_at: 1,
					updated_at: 2,
					last_success_at: null,
					last_failure_at: null,
					failure_count: 0,
				},
			],
		});
		expect(listDevices).toHaveBeenCalledWith(
			"auth-session-1",
			endpoint,
			1_800_000,
		);

		const renamed = await call("/api/push/devices", "PATCH", {
			id: device.id,
			name: "Desktop PWA",
			endpoint,
		});
		expect(renamed?.status).toBe(200);
		expect(updateDevice).toHaveBeenCalledWith(
			device.id,
			"auth-session-1",
			{ name: "Desktop PWA" },
			endpoint,
		);

		const revoked = await call("/api/push/devices", "DELETE", {
			id: device.id,
		});
		expect(await revoked?.json()).toEqual({ ok: true, removed: true });
		expect(revokeDevice).toHaveBeenCalledWith(device.id, "auth-session-1");
		expect(onDeliveryStateChanged).toHaveBeenCalledTimes(1);
	});

	it("edits device preferences and discards retired catch-up fields", async () => {
		const quietHours = {
			timezone: "America/New_York",
			start: "22:00",
			end: "07:00",
			weekdays: [1, 2, 3, 4, 5, 6, 7],
			allow_requests: true,
			allow_problems: false,
		};
		const changedDevice: PushSubscriptionDevice = {
			...device,
			pausedUntil: 9_999,
			preferences: {
				...preferences,
				paused_until: 9_999,
				paused_indefinitely: false,
				quiet_hours: quietHours,
			},
		};
		updateDevice.mockResolvedValueOnce(changedDevice);

		const response = await call("/api/push/devices", "PATCH", {
			id: device.id,
			preferences: {
				paused_until: 9_999,
				paused_indefinitely: false,
				quiet_hours: { ...quietHours, catch_up: true },
				catch_up_after_pause: true,
			},
		});

		expect(response?.status).toBe(200);
		expect(await response?.json()).toEqual({
			ok: true,
			device: {
				id: device.id,
				name: "Phone",
				current: true,
				enabled: true,
				preferences: {
					requests: true,
					problems: false,
					work_finished: false,
					privacy: "generic",
					completion_min_runtime_minutes: 0,
					paused_until: 9_999,
					paused_indefinitely: false,
					quiet_hours: { ...quietHours, catch_up: false },
					needs_attention: true,
					catch_up_after_pause: false,
					reminder_minutes: 0,
				},
				paused_until: 9_999,
				paused_indefinitely: false,
				created_at: 1,
				updated_at: 2,
				last_success_at: null,
				last_failure_at: null,
				failure_count: 0,
			},
		});
		expect(updateDevice).toHaveBeenCalledWith(
			device.id,
			"auth-session-1",
			{
				preferences: {
					paused_until: 9_999,
					paused_indefinitely: false,
					quiet_hours: quietHours,
				},
			},
			undefined,
		);
		expect(onDeliveryStateChanged).toHaveBeenCalledTimes(1);
	});

	it("truthfully distinguishes push-service acceptance from failure", async () => {
		const accepted = await call("/api/push/test", "POST", {
			endpoint,
			scenario: "question",
		});
		expect(await accepted?.json()).toEqual({
			accepted: true,
			accepted_at: 1_800,
			failure_at: null,
			failure_count: 0,
			subscription_removed: false,
		});
		expect(testPush).toHaveBeenCalledWith(stored, "question");

		const throttled = await call("/api/push/test", "POST", { endpoint });
		expect(throttled?.status).toBe(429);
		expect(throttled?.headers.get("retry-after")).toBe("10");
		expect(await throttled?.json()).toEqual({
			error: "Test notification cooldown is active",
			retry_after_seconds: 10,
		});
		expect(testPush).toHaveBeenCalledTimes(1);

		now.mockReturnValue(1_810_000);
		testPush.mockResolvedValueOnce({
			accepted: false,
			subscriptionRemoved: false,
		});
		const failed = await call("/api/push/test", "POST", { endpoint });
		expect(await failed?.json()).toMatchObject({
			accepted: false,
			accepted_at: null,
			failure_at: 1_810,
			failure_count: 1,
		});
		expect(testPush).toHaveBeenLastCalledWith(stored, "delivery");
	});

	it("scopes test-notification cooldowns to the browser auth session", async () => {
		await call("/api/push/test", "POST", { endpoint });
		authSessionHash.mockResolvedValue("auth-session-2");
		const otherBrowser = await call("/api/push/test", "POST", { endpoint });
		expect(otherBrowser?.status).toBe(200);
		expect(testPush).toHaveBeenCalledTimes(2);
	});

	it("requires a durable browser auth session for device operations", async () => {
		authSessionHash.mockResolvedValue(null);
		const response = await call("/api/push/devices", "POST", {});
		expect(response?.status).toBe(403);
		expect(listDevices).not.toHaveBeenCalled();
	});

	it("reads and writes the full session policy using snake-case wire fields", async () => {
		const read = await call("/api/push/session-overrides?session_id=session-1");
		expect(await read?.json()).toEqual({
			policy: {
				session_id: "session-1",
				mode: "notify_completion_once",
				scope: "delegation_tree",
				target_device_ids: [stored.id],
				updated_at: 42,
			},
			effective: {
				requested_session_id: "session-1",
				source_session_id: "session-1",
				mode: "notify_completion_once",
				scope: "delegation_tree",
				target_device_ids: [stored.id],
				inherited: false,
			},
		});

		const written = await call("/api/push/session-overrides", "PATCH", {
			session_id: "session-1",
			mode: "notify_completion_once",
			scope: "delegation_tree",
			target_device_ids: [stored.id],
		});
		expect(await written?.json()).toMatchObject({
			ok: true,
			policy: {
				session_id: "session-1",
				mode: "notify_completion_once",
				scope: "delegation_tree",
				target_device_ids: [stored.id],
			},
			effective: { mode: "notify_completion_once" },
		});
		expect(setSessionPolicy).toHaveBeenCalledWith("session-1", {
			mode: "notify_completion_once",
			scope: "delegation_tree",
			targetDeviceIds: [stored.id],
		});
		expect(setSessionOverride).not.toHaveBeenCalled();
	});

	it("clears a session policy while returning its recomputed effective state", async () => {
		getEffectiveSessionPolicy.mockResolvedValueOnce({
			requestedSessionId: "session-1",
			sourceSessionId: null,
			mode: "default",
			scope: "session",
			targetDeviceIds: null,
			inherited: false,
		});
		const response = await call("/api/push/session-overrides", "PATCH", {
			session_id: "session-1",
			mode: "default",
		});
		expect(await response?.json()).toEqual({
			ok: true,
			policy: null,
			effective: {
				requested_session_id: "session-1",
				source_session_id: null,
				mode: "default",
				scope: "session",
				target_device_ids: null,
				inherited: false,
			},
		});
		expect(setSessionOverride).toHaveBeenCalledWith("session-1", "default");
		expect(cancelOneShotDeliveries).toHaveBeenCalledWith(
			"session-1",
			1_800_000,
		);
		expect(onDeliveryStateChanged).toHaveBeenCalled();
		expect(setSessionPolicy).not.toHaveBeenCalled();
	});

	it("preserves omitted policy fields and passes an explicit all-device target", async () => {
		await call("/api/push/session-overrides", "PATCH", {
			session_id: "session-1",
			mode: "mute",
		});
		expect(setSessionPolicy).toHaveBeenLastCalledWith("session-1", {
			mode: "mute",
		});
		expect(cancelOneShotDeliveries).toHaveBeenLastCalledWith(
			"session-1",
			1_800_000,
		);

		await call("/api/push/session-overrides", "PATCH", {
			session_id: "session-1",
			mode: "notify",
			target_device_ids: null,
		});
		expect(setSessionPolicy).toHaveBeenLastCalledWith("session-1", {
			mode: "notify",
			targetDeviceIds: null,
		});
	});

	it("records authenticated service-worker receipts", async () => {
		const response = await call("/api/push/receipts", "POST", {
			delivery_id: historyEvent.deliveries[0]?.id,
			status: "opened",
		});
		expect(await response?.json()).toEqual({ ok: true, recorded: true });
		expect(recordClientReceipt).toHaveBeenCalledWith(
			historyEvent.deliveries[0]?.id,
			"opened",
			1_800_000,
		);

		authSessionHash.mockResolvedValueOnce(null);
		const unauthenticated = await call("/api/push/receipts", "POST", {
			delivery_id: historyEvent.deliveries[0]?.id,
			status: "displayed",
		});
		expect(unauthenticated?.status).toBe(403);
		expect(recordClientReceipt).toHaveBeenCalledTimes(1);
	});

	it("acknowledges a well-formed receipt even when its delivery is gone", async () => {
		recordClientReceipt.mockResolvedValueOnce(null);
		const response = await call("/api/push/receipts", "POST", {
			delivery_id: "956e3d80-36b4-40b5-a96e-6d443f02b71f",
			status: "dismissed",
		});
		expect(await response?.json()).toEqual({ ok: true, recorded: false });
	});

	it("returns bounded notification history with per-device delivery state", async () => {
		const response = await call("/api/push/history");
		expect(response?.status).toBe(200);
		expect(listHistory).toHaveBeenCalledWith(20);
		expect(await response?.json()).toEqual({
			events: [
				{
					id: event.id,
					source_kind: "session",
					source_id: "session-1",
					category: "completion",
					reason: "work_finished",
					label: "Compile release",
					url: "/raven/session/session-1",
					runtime_ms: 30_000,
					pending_count: 0,
					occurred_at: 1_700_000,
					expires_at: 2_700_000,
					group_key: "completion",
					batch_id: "batch-one",
					status: "batched",
					status_reason: null,
					next_attempt_at: null,
					deliveries: [
						{
							id: historyEvent.deliveries[0]?.id,
							device_id: stored.id,
							device: {
								id: stored.id,
								name: "Phone",
								privacy: "generic",
							},
							status: "sent",
							reason: null,
							next_attempt_at: null,
							attempt_count: 1,
							provider_status: 201,
							receipt_at: 1_710_000,
							displayed_at: 1_720_000,
							opened_at: null,
							dismissed_at: null,
							created_at: 1_700_000,
							updated_at: 1_720_000,
						},
					],
				},
			],
		});

		const invalid = await call("/api/push/history?limit=101");
		expect(invalid?.status).toBe(400);
		expect(listHistory).toHaveBeenCalledTimes(1);
	});

	it("reads ordered batch summaries and marks one member or the batch read", async () => {
		const secondEvent: PushNotificationEventRecord = {
			...event,
			id: "5d71aff0-d482-4ea4-afc2-c68cf2d54746",
			sourceId: "session-2",
			label: "Run checks",
		};
		const secondMember: PushNotificationBatchMember = {
			...batchMember,
			eventId: secondEvent.id,
			sessionId: "session-2",
			position: 1,
		};
		listBatchMembers.mockResolvedValueOnce([secondMember, batchMember]);
		getEvent.mockImplementation(async (id: string) =>
			id === event.id ? event : secondEvent,
		);

		const response = await call("/api/push/batches?batch_id=batch-one");
		expect(response?.status).toBe(200);
		const payload = await response?.json();
		expect(payload.batch).toEqual({
			id: "batch-one",
			category: "completion",
			group_key: "completion",
			status: "sent",
			created_at: 1_700_000,
			updated_at: 1_710_000,
			sent_at: 1_710_000,
			read_at: null,
		});
		expect(
			payload.members.map(
				(member: { session_id: string }) => member.session_id,
			),
		).toEqual(["session-1", "session-2"]);
		expect(payload.members[1].event).toMatchObject({
			id: secondEvent.id,
			source_id: "session-2",
			label: "Run checks",
		});

		const memberRead = await call("/api/push/batches", "POST", {
			batch_id: "batch-one",
			session_id: "session-1",
		});
		expect(await memberRead?.json()).toEqual({ ok: true, read_at: 1_800_000 });
		expect(markBatchMemberRead).toHaveBeenCalledWith(
			"batch-one",
			"session-1",
			1_800_000,
		);

		const batchRead = await call("/api/push/batches", "POST", {
			batch_id: "batch-one",
		});
		expect(await batchRead?.json()).toEqual({ ok: true, read_at: 1_800_000 });
		expect(markBatchRead).toHaveBeenCalledWith("batch-one", 1_800_000);
	});

	it("protects notification history and batches with browser authentication", async () => {
		authSessionHash.mockResolvedValue(null);
		expect((await call("/api/push/history"))?.status).toBe(403);
		expect((await call("/api/push/batches?batch_id=batch-one"))?.status).toBe(
			403,
		);
		expect(listHistory).not.toHaveBeenCalled();
		expect(getBatch).not.toHaveBeenCalled();
	});

	it("rejects malformed inputs before durable or outbound use", async () => {
		const response = await call("/api/push/subscriptions", "POST", {
			subscription: {
				endpoint: "http://127.0.0.1/internal",
				keys: { p256dh: "not base64!", auth: "auth" },
			},
		});
		expect(response?.status).toBe(400);
		expect(upsertSubscription).not.toHaveBeenCalled();

		const badDevice = await call("/api/push/devices", "PATCH", {
			id: device.id,
			name: " ",
		});
		expect(badDevice?.status).toBe(400);
		const controlDevice = await call("/api/push/devices", "PATCH", {
			id: device.id,
			name: "Phone\nspoofed",
		});
		expect(controlDevice?.status).toBe(400);
		const badPreview = await call("/api/push/test", "POST", {
			endpoint,
			scenario: "pretend-success",
		});
		expect(badPreview?.status).toBe(400);
		expect(testPush).not.toHaveBeenCalled();
	});

	it("does not claim unrelated authenticated routes", async () => {
		expect(await call("/api/other")).toBeNull();
	});
});
