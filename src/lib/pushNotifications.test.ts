import { Buffer } from "node:buffer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const serverFns = vi.hoisted(() => ({
	deletePushDeviceFn: vi.fn(),
	getPushConfigFn: vi.fn(),
	getPushStatusFn: vi.fn(),
	getSessionNotificationOverrideFn: vi.fn(),
	listPushDevicesFn: vi.fn(),
	sendTestPushNotificationFn: vi.fn(),
	setSessionNotificationOverrideFn: vi.fn(),
	subscribeToPushFn: vi.fn(),
	unsubscribeFromPushFn: vi.fn(),
	updatePushDeviceFn: vi.fn(),
	updatePushPreferencesFn: vi.fn(),
}));

vi.mock("./serverFns/pushNotifications", () => serverFns);

import {
	closePushNotificationsForSession,
	disablePushNotifications,
	enablePushNotifications,
	getPushNotificationDevices,
	getPushNotificationState,
	getPushNotificationSupport,
	getSessionNotificationOverride,
	pausePushNotifications,
	reconcilePushNotificationBadge,
	renamePushNotificationDevice,
	reportPushClientPresentation,
	revokePushNotificationDevice,
	sendTestPushNotification,
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

function fakeSubscription(
	applicationServerKey = PUBLIC_KEY_BYTES.buffer,
	endpoint = "https://push.test/subscription-1",
) {
	const unsubscribe = vi.fn().mockResolvedValue(true);
	const subscription = {
		endpoint,
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
			requests: true,
			problems: true,
			work_finished: false,
			privacy: "generic",
			completion_min_runtime_minutes: 0,
			paused_until: null,
			paused_indefinitely: false,
			...overrides,
		},
	};
}

const DEVICE_ID = "11111111-1111-4111-8111-111111111111";

function wireDevice(overrides: Record<string, unknown> = {}) {
	return {
		id: DEVICE_ID,
		name: "Phone",
		current: true,
		enabled: true,
		paused_until: null,
		paused_indefinitely: false,
		created_at: 1_700_000_000,
		updated_at: 1_700_000_100,
		last_success_at: 1_700_000_050,
		last_failure_at: null,
		failure_count: 0,
		...overrides,
	};
}

beforeEach(() => {
	for (const mock of Object.values(serverFns)) mock.mockReset();
	serverFns.getPushConfigFn.mockResolvedValue(configResponse());
	serverFns.getPushStatusFn.mockResolvedValue({
		available: true,
		subscribed: true,
		device_name: "Hlid device",
		preferences: {
			requests: true,
			problems: true,
			work_finished: false,
			privacy: "generic",
			completion_min_runtime_minutes: 0,
			paused_until: null,
			paused_indefinitely: false,
		},
	});
	serverFns.subscribeToPushFn.mockResolvedValue(subscriptionResponse());
	serverFns.unsubscribeFromPushFn.mockResolvedValue({
		ok: true,
		removed: true,
	});
	serverFns.listPushDevicesFn.mockResolvedValue({ devices: [] });
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe("push notification client", () => {
	it("reports the installed standalone presentation to the worker", () => {
		const { registration } = installBrowser();
		vi.stubGlobal("window", {
			matchMedia: vi.fn(() => ({ matches: true })),
		});

		reportPushClientPresentation(registration);

		expect(registration.active?.postMessage).toHaveBeenCalledWith({
			type: "hlid:client-presentation",
			standalone: true,
		});
	});

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
					requests: true,
					problems: true,
					work_finished: false,
					privacy: "generic",
					completion_min_runtime_minutes: 0,
					paused_until: null,
					paused_indefinitely: false,
				},
				device_name: "Hlid device",
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

	it("syncs without overwriting a renamed device or active pause", async () => {
		const existing = fakeSubscription();
		const browser = installBrowser({
			permission: "granted",
			existingSubscription: existing.subscription,
		});
		browser.local.setItem(ENABLED_KEY, "true");
		serverFns.getPushConfigFn.mockResolvedValue(configResponse());
		serverFns.subscribeToPushFn.mockResolvedValue(
			subscriptionResponse({
				work_finished: true,
				paused_until: 2_000_000_000,
			}),
		);

		const state = await syncPushSubscription();

		expect(browser.notification.requestPermission).not.toHaveBeenCalled();
		expect(browser.subscribe).not.toHaveBeenCalled();
		expect(serverFns.subscribeToPushFn).toHaveBeenCalledOnce();
		expect(serverFns.subscribeToPushFn).toHaveBeenCalledWith({
			data: {
				subscription: expect.objectContaining({
					endpoint: "https://push.test/subscription-1",
				}),
			},
		});
		expect(state.preferences.workFinished).toBe(true);
		expect(state.pausedUntil).toBe(2_000_000_000_000);
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

	it("migrates the prior local attention choice into both new categories", async () => {
		const browser = installBrowser({ permission: "default" });
		browser.local.setItem(
			PREFERENCES_KEY,
			JSON.stringify({
				needsAttention: false,
				workFinished: true,
				detail: "detailed",
			}),
		);

		await expect(syncPushSubscription()).resolves.toMatchObject({
			preferences: {
				requests: false,
				problems: false,
				workFinished: true,
				detail: "detailed",
				completionMinimumMinutes: 0,
			},
		});
	});

	it("leaves a server-disabled endpoint for an explicit re-enable tap", async () => {
		const existing = fakeSubscription();
		const browser = installBrowser({
			permission: "granted",
			existingSubscription: existing.subscription,
		});
		browser.local.setItem(ENABLED_KEY, "true");
		serverFns.getPushStatusFn.mockResolvedValue({
			available: true,
			subscribed: false,
			device_name: null,
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

	it("repairs a server-disabled endpoint across two explicit taps", async () => {
		const existing = fakeSubscription();
		const replacement = fakeSubscription(
			PUBLIC_KEY_BYTES.buffer,
			"https://push.test/subscription-2",
		);
		const browser = installBrowser({
			permission: "granted",
			existingSubscription: existing.subscription,
		});
		browser.subscribe.mockResolvedValue(replacement.subscription);
		serverFns.getPushStatusFn.mockResolvedValue({
			available: true,
			subscribed: false,
			device_name: null,
			preferences: null,
		});

		await expect(getPushNotificationState()).resolves.toMatchObject({
			enabled: false,
			reenableRequired: true,
		});
		await expect(enablePushNotifications()).rejects.toMatchObject({
			code: "repair-ready",
			message: "Old subscription removed. Tap Repair again to finish.",
		});
		expect(browser.subscribe).not.toHaveBeenCalled();
		browser.getSubscription.mockResolvedValue(null);
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

	it("preserves a retained device name and pause when repairing its row", async () => {
		const existing = fakeSubscription();
		const replacement = fakeSubscription(
			PUBLIC_KEY_BYTES.buffer,
			"https://push.test/subscription-2",
		);
		const browser = installBrowser({
			permission: "granted",
			existingSubscription: existing.subscription,
		});
		browser.subscribe.mockResolvedValue(replacement.subscription);
		serverFns.getPushStatusFn.mockResolvedValue({
			available: true,
			subscribed: false,
			device_name: "Kitchen iPad",
			preferences: subscriptionResponse({
				paused_until: 2_000_000_000,
			}).preferences,
		});

		await getPushNotificationState();
		await expect(enablePushNotifications()).rejects.toMatchObject({
			code: "repair-ready",
		});
		browser.getSubscription.mockResolvedValue(null);
		await enablePushNotifications();

		const data = serverFns.subscribeToPushFn.mock.calls[0]?.[0]?.data;
		expect(data).toMatchObject({
			device_name: "Kitchen iPad",
			preferences: { paused_until: 2_000_000_000 },
		});
	});

	it("keeps repair metadata across reload and retries old endpoint cleanup", async () => {
		const existing = fakeSubscription();
		const replacement = fakeSubscription(
			PUBLIC_KEY_BYTES.buffer,
			"https://push.test/subscription-2",
		);
		const browser = installBrowser({
			permission: "granted",
			existingSubscription: existing.subscription,
		});
		browser.subscribe.mockResolvedValue(replacement.subscription);
		serverFns.getPushStatusFn.mockResolvedValue({
			available: true,
			subscribed: false,
			device_name: "Travel phone",
			preferences: subscriptionResponse({
				work_finished: true,
				paused_until: 2_000_000_000,
			}).preferences,
		});
		serverFns.unsubscribeFromPushFn
			.mockRejectedValueOnce(new Error("temporary database error"))
			.mockResolvedValue({ ok: true, removed: true });
		serverFns.subscribeToPushFn.mockResolvedValue(
			subscriptionResponse({
				work_finished: true,
				paused_until: 2_000_000_000,
			}),
		);

		await getPushNotificationState();
		await expect(enablePushNotifications()).rejects.toMatchObject({
			code: "repair-ready",
		});
		browser.getSubscription.mockResolvedValue(null);
		vi.resetModules();
		const fresh = await import("./pushNotifications");
		await fresh.getPushNotificationState();
		await expect(fresh.enablePushNotifications()).resolves.toMatchObject({
			enabled: true,
			pausedUntil: 2_000_000_000_000,
		});

		expect(serverFns.subscribeToPushFn).toHaveBeenCalledWith({
			data: expect.objectContaining({
				device_name: "Travel phone",
				preferences: expect.objectContaining({
					work_finished: true,
					paused_until: 2_000_000_000,
				}),
			}),
		});
		expect(serverFns.unsubscribeFromPushFn).toHaveBeenCalledTimes(2);
		expect(serverFns.unsubscribeFromPushFn).toHaveBeenLastCalledWith({
			data: { endpoint: "https://push.test/subscription-1" },
		});
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
				requests: false,
				problems: true,
				workFinished: true,
				detail: "detailed",
				completionMinimumMinutes: 5,
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
				requests: false,
				problems: true,
				workFinished: true,
				detail: "detailed",
				completionMinimumMinutes: 5,
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
			available: true,
			subscribed: true,
			device_name: "Phone",
			preferences: {
				requests: false,
				problems: true,
				work_finished: true,
				privacy: "detailed",
				completion_min_runtime_minutes: 5,
				paused_until: 2_000_000_000,
				paused_indefinitely: false,
			},
		});
		serverFns.updatePushPreferencesFn.mockResolvedValue(
			subscriptionResponse({
				requests: true,
				problems: false,
				work_finished: true,
				privacy: "generic",
				completion_min_runtime_minutes: 10,
				paused_until: 2_000_000_000,
			}),
		);

		const initial = await getPushNotificationState();
		const updated = await updatePushNotificationPreferences({
			requests: true,
			problems: false,
			workFinished: true,
			detail: "generic",
			completionMinimumMinutes: 10,
		});

		expect(initial.preferences).toEqual({
			requests: false,
			problems: true,
			workFinished: true,
			detail: "detailed",
			completionMinimumMinutes: 5,
		});
		expect(initial.pausedUntil).toBe(2_000_000_000_000);
		expect(serverFns.updatePushPreferencesFn).toHaveBeenCalledWith({
			data: {
				endpoint: "https://push.test/subscription-1",
				preferences: {
					requests: true,
					problems: false,
					work_finished: true,
					privacy: "generic",
					completion_min_runtime_minutes: 10,
				},
			},
		});
		expect(updated.preferences).toEqual({
			requests: true,
			problems: false,
			workFinished: true,
			detail: "generic",
			completionMinimumMinutes: 10,
		});
		expect(updated.pausedUntil).toBe(2_000_000_000_000);
	});

	it("rejects an incoherent subscription status response", async () => {
		const existing = fakeSubscription();
		installBrowser({
			permission: "granted",
			existingSubscription: existing.subscription,
		});
		serverFns.getPushStatusFn.mockResolvedValue({
			available: true,
			subscribed: true,
			preferences: null,
			device_name: null,
		});

		await expect(getPushNotificationState()).rejects.toMatchObject({
			code: "request-failed",
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

	it("lists opaque device health with browser-friendly millisecond timestamps", async () => {
		const existing = fakeSubscription();
		installBrowser({
			permission: "granted",
			existingSubscription: existing.subscription,
		});
		serverFns.listPushDevicesFn.mockResolvedValue({
			devices: [wireDevice({ paused_until: 1_700_000_200 })],
		});

		await expect(getPushNotificationDevices()).resolves.toEqual([
			{
				id: DEVICE_ID,
				name: "Phone",
				current: true,
				enabled: true,
				pausedUntil: 1_700_000_200_000,
				pausedIndefinitely: false,
				createdAt: 1_700_000_000_000,
				lastSeenAt: 1_700_000_100_000,
				lastAcceptedAt: 1_700_000_050_000,
				lastFailureAt: null,
				lastFailureMessage: null,
				failureCount: 0,
			},
		]);
		expect(serverFns.listPushDevicesFn).toHaveBeenCalledWith({
			data: { endpoint: "https://push.test/subscription-1" },
		});
	});

	it("rejects ambiguous current-device lists", async () => {
		installBrowser();
		serverFns.listPushDevicesFn.mockResolvedValue({
			devices: [wireDevice(), wireDevice()],
		});

		await expect(getPushNotificationDevices()).rejects.toMatchObject({
			code: "request-failed",
		});
	});

	it("renames an opaque notification device", async () => {
		const existing = fakeSubscription();
		installBrowser({ existingSubscription: existing.subscription });
		serverFns.updatePushDeviceFn.mockResolvedValue({
			ok: true,
			device: wireDevice({ name: "Desk" }),
		});

		await expect(
			renamePushNotificationDevice(DEVICE_ID, "  Desk  "),
		).resolves.toMatchObject({ id: DEVICE_ID, name: "Desk" });
		expect(serverFns.updatePushDeviceFn).toHaveBeenCalledWith({
			data: {
				id: DEVICE_ID,
				name: "Desk",
				endpoint: "https://push.test/subscription-1",
			},
		});
	});

	it("revokes the current opaque device and its browser subscription", async () => {
		const existing = fakeSubscription();
		const browser = installBrowser({
			permission: "granted",
			existingSubscription: existing.subscription,
		});
		browser.local.setItem(ENABLED_KEY, "true");
		serverFns.listPushDevicesFn.mockResolvedValue({ devices: [wireDevice()] });
		serverFns.deletePushDeviceFn.mockResolvedValue({ ok: true, removed: true });

		await expect(revokePushNotificationDevice(DEVICE_ID)).resolves.toBe(true);
		expect(serverFns.deletePushDeviceFn).toHaveBeenCalledWith({
			data: { id: DEVICE_ID },
		});
		expect(existing.unsubscribe).toHaveBeenCalledOnce();
		expect(browser.local.getItem(ENABLED_KEY)).toBe("false");
	});

	it("revokes a remote device without touching the current subscription", async () => {
		const existing = fakeSubscription();
		installBrowser({
			permission: "granted",
			existingSubscription: existing.subscription,
		});
		serverFns.listPushDevicesFn.mockResolvedValue({
			devices: [wireDevice({ current: false })],
		});
		serverFns.deletePushDeviceFn.mockResolvedValue({ ok: true, removed: true });

		await expect(revokePushNotificationDevice(DEVICE_ID)).resolves.toBe(true);
		expect(existing.unsubscribe).not.toHaveBeenCalled();
	});

	it("reports push-service acceptance without claiming delivery", async () => {
		const existing = fakeSubscription();
		installBrowser({
			permission: "granted",
			existingSubscription: existing.subscription,
		});
		serverFns.sendTestPushNotificationFn.mockResolvedValue({
			accepted: true,
			accepted_at: 1_700_000_000,
			failure_at: null,
			failure_count: 0,
			subscription_removed: false,
		});

		await expect(sendTestPushNotification("plan_review")).resolves.toEqual({
			accepted: true,
			acceptedAt: 1_700_000_000_000,
			failureAt: null,
			failureCount: 0,
			subscriptionRemoved: false,
		});
		expect(serverFns.sendTestPushNotificationFn).toHaveBeenCalledWith({
			data: {
				endpoint: existing.subscription.endpoint,
				scenario: "plan_review",
			},
		});
	});

	it("rejects an incoherent push-service test result", async () => {
		const existing = fakeSubscription();
		installBrowser({ existingSubscription: existing.subscription });
		serverFns.sendTestPushNotificationFn.mockResolvedValue({
			accepted: true,
			accepted_at: null,
			failure_at: null,
			failure_count: 0,
			subscription_removed: false,
		});

		await expect(sendTestPushNotification()).rejects.toMatchObject({
			code: "request-failed",
		});
	});

	it("pauses the current device without changing category choices", async () => {
		const existing = fakeSubscription();
		installBrowser({
			permission: "granted",
			existingSubscription: existing.subscription,
		});
		serverFns.updatePushPreferencesFn.mockResolvedValue(
			subscriptionResponse({ paused_until: 1_700_000_200 }),
		);

		const state = await pausePushNotifications(1_700_000_200_000);

		expect(serverFns.updatePushPreferencesFn).toHaveBeenCalledWith({
			data: {
				endpoint: "https://push.test/subscription-1",
				preferences: {
					paused_until: 1_700_000_200,
					paused_indefinitely: false,
				},
			},
		});
		expect(state).toMatchObject({
			enabled: true,
			pausedUntil: 1_700_000_200_000,
			preferences: {
				requests: true,
				problems: true,
				workFinished: false,
			},
		});
	});

	it("pauses the current device until manual resume", async () => {
		const existing = fakeSubscription();
		installBrowser({
			permission: "granted",
			existingSubscription: existing.subscription,
		});
		serverFns.updatePushPreferencesFn.mockResolvedValue(
			subscriptionResponse({ paused_indefinitely: true }),
		);

		const state = await pausePushNotifications("indefinite");

		expect(serverFns.updatePushPreferencesFn).toHaveBeenCalledWith({
			data: {
				endpoint: "https://push.test/subscription-1",
				preferences: {
					paused_until: null,
					paused_indefinitely: true,
				},
			},
		});
		expect(state).toMatchObject({
			enabled: true,
			pausedUntil: null,
			pausedIndefinitely: true,
		});
	});

	it("asks the worker to reconcile its locally authoritative app badge", async () => {
		const browser = installBrowser();

		await expect(reconcilePushNotificationBadge()).resolves.toBeUndefined();

		expect(browser.registration.active?.postMessage).toHaveBeenCalledWith({
			type: "hlid:reconcile-notification-badge",
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
