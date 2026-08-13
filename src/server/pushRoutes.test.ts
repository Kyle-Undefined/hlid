import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PushSubscriptionDevice, StoredPushSubscription } from "../db";
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
	pausedUntil: null,
	pausedIndefinitely: false,
	createdAt: 1,
	updatedAt: 2,
	lastSuccessAt: null,
	lastFailureAt: null,
	failureCount: 0,
};

const publicKey = vi.fn();
const now = vi.fn();
const authSessionHash = vi.fn();
const getSubscription = vi.fn();
const upsertSubscription = vi.fn();
const updatePreferences = vi.fn();
const deleteSubscription = vi.fn();
const listDevices = vi.fn();
const renameDevice = vi.fn();
const revokeDevice = vi.fn();
const getSessionOverride = vi.fn();
const setSessionOverride = vi.fn();
const testPush = vi.fn();
const validateSubscription = vi.fn();
const validateEndpoint = vi.fn();

const handle = createPushRouteHandler({
	publicKey,
	now,
	authSessionHash,
	getSubscription,
	upsertSubscription,
	updatePreferences,
	deleteSubscription,
	listDevices,
	renameDevice,
	revokeDevice,
	getSessionOverride,
	setSessionOverride,
	testPush,
	validateSubscription,
	validateEndpoint,
});

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
	renameDevice.mockResolvedValue(device);
	revokeDevice.mockResolvedValue(true);
	getSessionOverride.mockResolvedValue("default");
	setSessionOverride.mockResolvedValue("notify_once");
	testPush.mockResolvedValue({ accepted: true, subscriptionRemoved: false });
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
			},
			undefined,
		);

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
		expect(renameDevice).toHaveBeenCalledWith(
			device.id,
			"Desktop PWA",
			"auth-session-1",
			endpoint,
		);

		const revoked = await call("/api/push/devices", "DELETE", {
			id: device.id,
		});
		expect(await revoked?.json()).toEqual({ ok: true, removed: true });
		expect(revokeDevice).toHaveBeenCalledWith(device.id, "auth-session-1");
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

		testPush.mockResolvedValueOnce({
			accepted: false,
			subscriptionRemoved: false,
		});
		const failed = await call("/api/push/test", "POST", { endpoint });
		expect(await failed?.json()).toMatchObject({
			accepted: false,
			accepted_at: null,
			failure_at: 1_800,
			failure_count: 1,
		});
		expect(testPush).toHaveBeenLastCalledWith(stored, "delivery");
	});

	it("requires a durable browser auth session for device operations", async () => {
		authSessionHash.mockResolvedValue(null);
		const response = await call("/api/push/devices", "POST", {});
		expect(response?.status).toBe(403);
		expect(listDevices).not.toHaveBeenCalled();
	});

	it("reads and writes the one-shot session override", async () => {
		const read = await call("/api/push/session-overrides?session_id=session-1");
		expect(await read?.json()).toEqual({ mode: "default" });

		const written = await call("/api/push/session-overrides", "PATCH", {
			session_id: "session-1",
			mode: "notify_once",
		});
		expect(await written?.json()).toEqual({ ok: true, mode: "notify_once" });
		expect(setSessionOverride).toHaveBeenCalledWith("session-1", "notify_once");
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
