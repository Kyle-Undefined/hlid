import { Buffer } from "node:buffer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const serverFns = vi.hoisted(() => ({
	getPushConfigFn: vi.fn(),
	getPushStatusFn: vi.fn(),
	getSessionNotificationOverrideFn: vi.fn(),
	setSessionNotificationOverrideFn: vi.fn(),
	subscribeToPushFn: vi.fn(),
	unsubscribeFromPushFn: vi.fn(),
	updatePushPreferencesFn: vi.fn(),
}));

vi.mock("./serverFns/pushNotifications", () => serverFns);

import {
	closePushNotificationsForSession,
	disablePushNotifications,
	enablePushNotifications,
	getPushNotificationState,
	getPushNotificationSupport,
	getSessionNotificationOverride,
	setSessionNotificationOverride,
	syncPushSubscription,
	updatePushNotificationPreferences,
} from "./pushNotifications";

const PUBLIC_KEY_BYTES = Uint8Array.from(
	{ length: 65 },
	(_, index) => index + 1,
);
const PUBLIC_KEY = Buffer.from(PUBLIC_KEY_BYTES).toString("base64url");
const PREFERENCES_KEY = "hlid:push:preferences:v1";
const ENABLED_KEY = "hlid:push:enabled:v1";

function storage(): Storage {
	const values = new Map<string, string>();
	return {
		get length() {
			return values.size;
		},
		clear: () => values.clear(),
		getItem: (key) => values.get(key) ?? null,
		key: (index) => [...values.keys()][index] ?? null,
		removeItem: (key) => values.delete(key),
		setItem: (key, value) => values.set(key, value),
	};
}

function keyBuffer(seed: number): ArrayBuffer {
	return Uint8Array.from({ length: 16 }, (_, index) => seed + index).buffer;
}

function fakeSubscription(applicationServerKey = PUBLIC_KEY_BYTES.buffer) {
	const unsubscribe = vi.fn().mockResolvedValue(true);
	const subscription = {
		endpoint: "https://push.test/subscription-1",
		expirationTime: null,
		options: { applicationServerKey, userVisibleOnly: true },
		getKey: vi.fn((name: PushEncryptionKeyName) =>
			name === "p256dh" ? keyBuffer(1) : keyBuffer(32),
		),
		toJSON: vi.fn(),
		unsubscribe,
	} as unknown as PushSubscription;
	return { subscription, unsubscribe };
}

function installBrowser(
	options: {
		permission?: NotificationPermission;
		userActive?: boolean;
		existingSubscription?: PushSubscription | null;
	} = {},
) {
	const local = storage();
	const notification = {
		permission: options.permission ?? "default",
		requestPermission: vi.fn(async () => {
			notification.permission = "granted";
			return "granted" as NotificationPermission;
		}),
	};
	const subscribe = vi.fn(
		async (
			_options: PushSubscriptionOptionsInit,
		): Promise<PushSubscription> => {
			notification.permission = "granted";
			return fakeSubscription().subscription;
		},
	);
	const getSubscription = vi
		.fn()
		.mockResolvedValue(options.existingSubscription ?? null);
	const registration = {
		active: { postMessage: vi.fn() },
		pushManager: { getSubscription, subscribe },
	} as unknown as ServiceWorkerRegistration;
	const getRegistration = vi.fn().mockResolvedValue(registration);
	const register = vi.fn().mockResolvedValue(registration);
	vi.stubGlobal("isSecureContext", true);
	vi.stubGlobal("Notification", notification);
	vi.stubGlobal("PushManager", function PushManager() {});
	vi.stubGlobal("localStorage", local);
	vi.stubGlobal("navigator", {
		userActivation: { isActive: options.userActive ?? true },
		serviceWorker: { getRegistration, register },
	});
	return {
		local,
		notification,
		subscribe,
		getSubscription,
		getRegistration,
		register,
		registration,
	};
}

function configResponse() {
	return { available: true, publicKey: PUBLIC_KEY } as const;
}

function subscriptionResponse(
	overrides: Record<string, unknown> = {},
): Record<string, unknown> {
	return {
		ok: true,
		preferences: {
			needs_attention: true,
			work_finished: false,
			privacy: "generic",
			...overrides,
		},
	};
}

beforeEach(() => {
	for (const mock of Object.values(serverFns)) mock.mockReset();
	serverFns.getPushConfigFn.mockResolvedValue(configResponse());
	serverFns.getPushStatusFn.mockResolvedValue({
		subscribed: true,
		preferences: {
			needs_attention: true,
			work_finished: false,
			privacy: "generic",
		},
	});
	serverFns.subscribeToPushFn.mockResolvedValue(subscriptionResponse());
	serverFns.unsubscribeFromPushFn.mockResolvedValue({
		ok: true,
		removed: true,
	});
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe("push notification client", () => {
	it("detects missing browser capabilities without touching permission", () => {
		vi.stubGlobal("isSecureContext", true);
		vi.stubGlobal("navigator", {});

		expect(getPushNotificationSupport()).toEqual({
			supported: false,
			reason: "notifications-unavailable",
		});
	});

	it("preloads setup and invokes PushManager.subscribe directly from enable", async () => {
		const browser = installBrowser();
		const order: string[] = [];
		serverFns.getPushConfigFn.mockImplementation(async () => {
			order.push("config");
			return configResponse();
		});
		browser.subscribe.mockImplementation(async () => {
			order.push("browser-subscribe");
			browser.notification.permission = "granted";
			return fakeSubscription().subscription;
		});
		serverFns.subscribeToPushFn.mockImplementation(async () => {
			order.push("server-subscribe");
			return subscriptionResponse();
		});

		await getPushNotificationState();
		const enabling = enablePushNotifications();

		// No permission API or network prerequisite runs in front of the actual
		// subscription call once the user taps Enable.
		expect(browser.subscribe).toHaveBeenCalledOnce();
		expect(order).toEqual(["config", "browser-subscribe"]);
		const state = await enabling;

		expect(browser.notification.requestPermission).not.toHaveBeenCalled();
		expect(browser.subscribe).toHaveBeenCalledWith({
			userVisibleOnly: true,
			applicationServerKey: expect.any(ArrayBuffer),
		});
		expect(
			new Uint8Array(
				browser.subscribe.mock.calls[0]?.[0]
					?.applicationServerKey as ArrayBuffer,
			),
		).toEqual(PUBLIC_KEY_BYTES);
		expect(serverFns.subscribeToPushFn).toHaveBeenCalledWith({
			data: {
				subscription: {
					endpoint: "https://push.test/subscription-1",
					expirationTime: null,
					keys: { p256dh: expect.any(String), auth: expect.any(String) },
				},
				preferences: {
					needs_attention: true,
					work_finished: false,
					privacy: "generic",
				},
			},
		});
		expect(state).toMatchObject({
			supported: true,
			permission: "granted",
			enabled: true,
		});
		expect(browser.local.getItem(ENABLED_KEY)).toBe("true");
	});

	it("refuses to request permission outside an explicit click or tap", async () => {
		const browser = installBrowser({ userActive: false });

		await expect(enablePushNotifications()).rejects.toMatchObject({
			code: "explicit-user-action-required",
		});
		expect(browser.notification.requestPermission).not.toHaveBeenCalled();
		expect(serverFns.getPushConfigFn).not.toHaveBeenCalled();
		expect(serverFns.subscribeToPushFn).not.toHaveBeenCalled();
	});

	it("syncs an opted-in existing subscription without requesting permission", async () => {
		const existing = fakeSubscription();
		const browser = installBrowser({
			permission: "granted",
			existingSubscription: existing.subscription,
		});
		browser.local.setItem(ENABLED_KEY, "true");
		serverFns.getPushConfigFn.mockResolvedValue(configResponse());
		serverFns.subscribeToPushFn.mockResolvedValue(
			subscriptionResponse({ work_finished: true }),
		);

		const state = await syncPushSubscription();

		expect(browser.notification.requestPermission).not.toHaveBeenCalled();
		expect(browser.subscribe).not.toHaveBeenCalled();
		expect(serverFns.subscribeToPushFn).toHaveBeenCalledOnce();
		expect(state.preferences.workFinished).toBe(true);
	});

	it("never creates a missing subscription during silent sync", async () => {
		const browser = installBrowser({ permission: "granted" });
		browser.local.setItem(ENABLED_KEY, "true");

		const state = await syncPushSubscription();

		expect(state).toMatchObject({
			enabled: false,
			reenableRequired: true,
		});
		expect(browser.subscribe).not.toHaveBeenCalled();
		expect(serverFns.subscribeToPushFn).not.toHaveBeenCalled();
	});

	it("leaves a server-disabled endpoint for an explicit re-enable tap", async () => {
		const existing = fakeSubscription();
		const browser = installBrowser({
			permission: "granted",
			existingSubscription: existing.subscription,
		});
		browser.local.setItem(ENABLED_KEY, "true");
		serverFns.getPushStatusFn.mockResolvedValue({
			subscribed: false,
			preferences: null,
		});

		const state = await syncPushSubscription();

		expect(state).toMatchObject({
			enabled: false,
			reenableRequired: true,
		});
		expect(existing.unsubscribe).not.toHaveBeenCalled();
		expect(browser.subscribe).not.toHaveBeenCalled();
		expect(serverFns.subscribeToPushFn).not.toHaveBeenCalled();
	});

	it("requires re-enable when the VAPID key has rotated", async () => {
		const rotatedKey = Uint8Array.from(
			PUBLIC_KEY_BYTES,
			(byte) => byte + 1,
		).buffer;
		const existing = fakeSubscription(rotatedKey);
		const browser = installBrowser({
			permission: "granted",
			existingSubscription: existing.subscription,
		});
		browser.local.setItem(ENABLED_KEY, "true");

		const state = await getPushNotificationState();

		expect(state).toMatchObject({
			enabled: false,
			reenableRequired: true,
		});
		expect(serverFns.getPushStatusFn).toHaveBeenCalledOnce();
		expect(browser.subscribe).not.toHaveBeenCalled();
	});

	it("replaces a server-disabled endpoint from the next explicit tap", async () => {
		const existing = fakeSubscription();
		const replacement = fakeSubscription();
		const browser = installBrowser({
			permission: "granted",
			existingSubscription: existing.subscription,
		});
		browser.subscribe.mockResolvedValue(replacement.subscription);
		serverFns.getPushStatusFn.mockResolvedValue({
			subscribed: false,
			preferences: null,
		});

		await expect(getPushNotificationState()).resolves.toMatchObject({
			enabled: false,
			reenableRequired: true,
		});
		await expect(enablePushNotifications()).resolves.toMatchObject({
			enabled: true,
		});

		expect(serverFns.getPushStatusFn).toHaveBeenCalledWith({
			data: { endpoint: "https://push.test/subscription-1" },
		});
		expect(existing.unsubscribe).toHaveBeenCalledOnce();
		expect(browser.subscribe).toHaveBeenCalledOnce();
		expect(serverFns.subscribeToPushFn).toHaveBeenCalledOnce();
	});

	it("unsubscribes locally while retaining the user's category choices", async () => {
		const existing = fakeSubscription();
		const browser = installBrowser({
			permission: "granted",
			existingSubscription: existing.subscription,
		});
		browser.local.setItem(ENABLED_KEY, "true");
		browser.local.setItem(
			PREFERENCES_KEY,
			JSON.stringify({
				needsAttention: false,
				workFinished: true,
				detail: "detailed",
			}),
		);
		serverFns.unsubscribeFromPushFn.mockResolvedValue({
			ok: true,
			removed: true,
		});

		const state = await disablePushNotifications();
		await Promise.resolve();

		expect(existing.unsubscribe).toHaveBeenCalledOnce();
		expect(serverFns.unsubscribeFromPushFn).toHaveBeenCalledWith({
			data: { endpoint: "https://push.test/subscription-1" },
		});
		expect(browser.local.getItem(ENABLED_KEY)).toBe("false");
		expect(state).toMatchObject({
			enabled: false,
			preferences: {
				needsAttention: false,
				workFinished: true,
				detail: "detailed",
			},
		});
	});

	it("still revokes the server endpoint when browser unsubscribe fails", async () => {
		const existing = fakeSubscription();
		existing.unsubscribe.mockRejectedValue(new Error("browser failure"));
		const browser = installBrowser({
			permission: "granted",
			existingSubscription: existing.subscription,
		});
		browser.local.setItem(ENABLED_KEY, "true");
		serverFns.unsubscribeFromPushFn.mockResolvedValue({
			ok: true,
			removed: true,
		});

		await expect(disablePushNotifications()).resolves.toMatchObject({
			enabled: false,
		});
		expect(serverFns.unsubscribeFromPushFn).toHaveBeenCalledOnce();
	});

	it("keeps the device enabled when neither revocation path succeeds", async () => {
		const existing = fakeSubscription();
		existing.unsubscribe.mockRejectedValue(new Error("browser failure"));
		const browser = installBrowser({
			permission: "granted",
			existingSubscription: existing.subscription,
		});
		browser.local.setItem(ENABLED_KEY, "true");
		serverFns.unsubscribeFromPushFn.mockRejectedValue(
			new Error("server failure"),
		);

		await expect(disablePushNotifications()).rejects.toMatchObject({
			code: "request-failed",
		});
		expect(browser.local.getItem(ENABLED_KEY)).toBe("true");
	});

	it("maps server preferences into client state and PATCH updates", async () => {
		const existing = fakeSubscription();
		const browser = installBrowser({
			permission: "granted",
			existingSubscription: existing.subscription,
		});
		browser.local.setItem(ENABLED_KEY, "true");
		serverFns.getPushConfigFn.mockResolvedValue(configResponse());
		serverFns.getPushStatusFn.mockResolvedValue({
			subscribed: true,
			preferences: {
				needs_attention: false,
				work_finished: true,
				privacy: "detailed",
			},
		});
		serverFns.updatePushPreferencesFn.mockResolvedValue(
			subscriptionResponse({
				needs_attention: true,
				work_finished: true,
				privacy: "generic",
			}),
		);

		const initial = await getPushNotificationState();
		const updated = await updatePushNotificationPreferences({
			needsAttention: true,
			workFinished: true,
			detail: "generic",
		});

		expect(initial.preferences).toEqual({
			needsAttention: false,
			workFinished: true,
			detail: "detailed",
		});
		expect(serverFns.updatePushPreferencesFn).toHaveBeenCalledWith({
			data: {
				endpoint: "https://push.test/subscription-1",
				preferences: {
					needs_attention: true,
					work_finished: true,
					privacy: "generic",
				},
			},
		});
		expect(updated.preferences).toEqual({
			needsAttention: true,
			workFinished: true,
			detail: "generic",
		});
	});

	it("asks the active worker to close an exact session notification", async () => {
		const browser = installBrowser();

		await expect(
			closePushNotificationsForSession("session-1"),
		).resolves.toBeUndefined();

		expect(browser.registration.active?.postMessage).toHaveBeenCalledWith({
			type: "hlid:close-session-notifications",
			sessionId: "session-1",
		});
	});

	it("silently rejects an invalid notification-close session ID", async () => {
		const browser = installBrowser();

		await expect(
			closePushNotificationsForSession("bad\nsession"),
		).resolves.toBeUndefined();

		expect(browser.registration.active?.postMessage).not.toHaveBeenCalled();
	});

	it("reads and updates the global per-session override through server functions", async () => {
		serverFns.getSessionNotificationOverrideFn.mockResolvedValue({
			mode: "mute",
		});
		serverFns.setSessionNotificationOverrideFn.mockResolvedValue({
			ok: true,
			mode: "notify",
		});

		await expect(getSessionNotificationOverride("session-1")).resolves.toBe(
			"mute",
		);
		await expect(
			setSessionNotificationOverride("session-1", "notify"),
		).resolves.toBe("notify");
		expect(serverFns.getSessionNotificationOverrideFn).toHaveBeenCalledWith({
			data: "session-1",
		});
		expect(serverFns.setSessionNotificationOverrideFn).toHaveBeenCalledWith({
			data: { session_id: "session-1", mode: "notify" },
		});
	});
});
