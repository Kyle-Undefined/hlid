import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StoredPushSubscription } from "../db";
import { createPushRouteHandler } from "./pushRoutes";

const endpoint = "https://fcm.googleapis.com/fcm/send/device-one";
const preferences = {
	needs_attention: true,
	work_finished: false,
	privacy: "generic" as const,
};
const stored: StoredPushSubscription = {
	id: "device-1",
	authSessionHash: "auth-session-1",
	endpoint,
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

const publicKey = vi.fn();
const authSessionHash = vi.fn();
const getSubscription = vi.fn();
const upsertSubscription = vi.fn();
const updatePreferences = vi.fn();
const deleteSubscription = vi.fn();
const getSessionOverride = vi.fn();
const setSessionOverride = vi.fn();
const validateSubscription = vi.fn();
const validateEndpoint = vi.fn();

const handle = createPushRouteHandler({
	publicKey,
	authSessionHash,
	getSubscription,
	upsertSubscription,
	updatePreferences,
	deleteSubscription,
	getSessionOverride,
	setSessionOverride,
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
	authSessionHash.mockResolvedValue("auth-session-1");
	getSubscription.mockResolvedValue(stored);
	upsertSubscription.mockResolvedValue(stored);
	updatePreferences.mockResolvedValue(stored);
	deleteSubscription.mockResolvedValue(true);
	getSessionOverride.mockResolvedValue("default");
	setSessionOverride.mockResolvedValue("notify");
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

	it("reports unavailable key storage as capability state", async () => {
		publicKey.mockImplementationOnce(() => {
			throw new Error("read only");
		});
		const response = await call("/api/push/config");
		expect(response?.status).toBe(200);
		expect(await response?.json()).toEqual({
			available: false,
			publicKey: null,
		});
	});

	it("reports an unsubscribed device without requiring an endpoint", async () => {
		const response = await call("/api/push/status", "POST", {});
		expect(await response?.json()).toEqual({
			available: true,
			subscribed: false,
			preferences: null,
		});
		expect(getSubscription).not.toHaveBeenCalled();
	});

	it("registers, updates, reports, and removes one exact browser endpoint", async () => {
		const subscription = {
			endpoint,
			expirationTime: null,
			keys: { p256dh: "cHVibGlj", auth: "YXV0aA" },
		};
		const registered = await call("/api/push/subscriptions", "POST", {
			subscription,
			preferences,
		});
		expect(registered?.status).toBe(200);
		expect(validateSubscription).toHaveBeenCalledWith(subscription);
		expect(upsertSubscription).toHaveBeenCalledWith(
			subscription,
			"auth-session-1",
			preferences,
		);

		const status = await call("/api/push/status", "POST", { endpoint });
		expect(await status?.json()).toEqual({
			available: true,
			subscribed: true,
			preferences,
		});
		expect(getSubscription).toHaveBeenCalledWith(endpoint, "auth-session-1");

		const updated = await call("/api/push/subscriptions", "PATCH", {
			endpoint,
			preferences: { work_finished: true, privacy: "detailed" },
		});
		expect(updated?.status).toBe(200);
		expect(updatePreferences).toHaveBeenCalledWith(endpoint, "auth-session-1", {
			work_finished: true,
			privacy: "detailed",
		});

		const removed = await call("/api/push/subscriptions", "DELETE", {
			endpoint,
		});
		expect(await removed?.json()).toEqual({ ok: true, removed: true });
		expect(deleteSubscription).toHaveBeenCalledWith(endpoint, "auth-session-1");
	});

	it("requires a durable browser auth session for device operations", async () => {
		authSessionHash.mockResolvedValue(null);
		const response = await call("/api/push/subscriptions", "POST", {
			subscription: {
				endpoint,
				expirationTime: null,
				keys: { p256dh: "cHVibGlj", auth: "YXV0aA" },
			},
		});

		expect(response?.status).toBe(403);
		expect(upsertSubscription).not.toHaveBeenCalled();
	});

	it("reads and writes installation-wide per-session overrides", async () => {
		const read = await call("/api/push/session-overrides?session_id=session-1");
		expect(await read?.json()).toEqual({ mode: "default" });
		expect(getSessionOverride).toHaveBeenCalledWith("session-1");

		const written = await call("/api/push/session-overrides", "PATCH", {
			session_id: "session-1",
			mode: "notify",
		});
		expect(await written?.json()).toEqual({ ok: true, mode: "notify" });
		expect(setSessionOverride).toHaveBeenCalledWith("session-1", "notify");
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

		const missing = await call("/api/push/session-overrides", "PATCH", {
			session_id: "session-1",
			mode: "sometimes",
		});
		expect(missing?.status).toBe(400);
		expect(setSessionOverride).not.toHaveBeenCalled();
	});

	it("does not claim unrelated authenticated routes", async () => {
		expect(await call("/api/other")).toBeNull();
	});
});
