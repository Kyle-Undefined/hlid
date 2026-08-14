import { Buffer } from "node:buffer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	pushPreferencesInputSchema,
	pushPreferencesPatchSchema,
} from "./pushNotificationSchemas";

const serverFns = vi.hoisted(() => ({
	deletePushDeviceFn: vi.fn(),
	getPushConfigFn: vi.fn(),
	getPushNotificationBatchFn: vi.fn(),
	getPushNotificationHistoryFn: vi.fn(),
	getPushStatusFn: vi.fn(),
	getSessionNotificationOverrideFn: vi.fn(),
	listPushDevicesFn: vi.fn(),
	markPushNotificationBatchReadFn: vi.fn(),
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
	getPushNotificationBatch,
	getPushNotificationDevices,
	getPushNotificationHistory,
	getPushNotificationState,
	getPushNotificationSupport,
	getSessionNotificationOverride,
	markPushNotificationBatchRead,
	pausePushNotifications,
	reconcilePushNotificationBadge,
	renamePushNotificationDevice,
	reportPushClientPresentation,
	revokePushNotificationDevice,
	sendTestPushNotification,
	setSessionNotificationOverride,
	syncPushSubscription,
	updatePushNotificationDevice,
	updatePushNotificationPreferences,
} from "./pushNotifications";

const PUBLIC_KEY_BYTES = Uint8Array.from(
	{ length: 65 },
	(_, index) => index + 1,
);
const PUBLIC_KEY = Buffer.from(PUBLIC_KEY_BYTES).toString("base64url");
const PREFERENCES_KEY = "hlid:push:preferences:v1";
const ENABLED_KEY = "hlid:push:enabled:v1";
const REPAIR_KEY = "hlid:push:repair:v1";

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

function wirePreferences(
	overrides: Record<string, unknown> = {},
): Record<string, unknown> {
	return {
		requests: true,
		problems: true,
		work_finished: false,
		privacy: "generic",
		completion_min_runtime_minutes: 0,
		paused_until: null,
		paused_indefinitely: false,
		quiet_hours: null,
		// The immediately previous wire shape included this field. New clients ignore it.
		reminder_minutes: 0,
		...overrides,
	};
}

function subscriptionResponse(
	overrides: Record<string, unknown> = {},
): Record<string, unknown> {
	return { ok: true, preferences: wirePreferences(overrides) };
}

const DEVICE_ID = "11111111-1111-4111-8111-111111111111";

function wireDevice(overrides: Record<string, unknown> = {}) {
	return {
		id: DEVICE_ID,
		name: "Phone",
		current: true,
		enabled: true,
		preferences: wirePreferences(),
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
			...wirePreferences(),
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
	it("strips removed reminder and catch-up fields from stale API preferences", () => {
		const preferences = pushPreferencesInputSchema.parse(
			wirePreferences({
				quiet_hours: {
					timezone: "America/New_York",
					start: "22:00",
					end: "07:00",
					weekdays: [1, 2, 3, 4, 5],
					allow_requests: true,
					allow_problems: false,
					catch_up: true,
				},
				catch_up_after_pause: true,
				reminder_minutes: 30,
			}),
		);

		expect(preferences).not.toHaveProperty("reminder_minutes");
		expect(preferences).not.toHaveProperty("catch_up_after_pause");
		expect(preferences.quiet_hours).not.toHaveProperty("catch_up");
		expect(pushPreferencesPatchSchema.parse({ reminder_minutes: 15 })).toEqual(
			{},
		);
		expect(
			pushPreferencesPatchSchema.parse({ catch_up_after_pause: true }),
		).toEqual({});
	});

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
					quiet_hours: null,
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

	it("migrates prior local choices and strips removed local fields", async () => {
		const browser = installBrowser({ permission: "default" });
		browser.local.setItem(
			PREFERENCES_KEY,
			JSON.stringify({
				needsAttention: false,
				workFinished: true,
				detail: "detailed",
				reminderMinutes: 30,
				catchUpAfterPause: true,
				quietHours: {
					timezone: "America/New_York",
					start: "22:00",
					end: "07:00",
					weekdays: [1, 2, 3, 4, 5],
					allowRequests: true,
					allowProblems: false,
					catchUp: true,
				},
			}),
		);

		const state = await syncPushSubscription();
		expect(state).toMatchObject({
			preferences: {
				requests: false,
				problems: false,
				workFinished: true,
				detail: "detailed",
				completionMinimumMinutes: 0,
				quietHours: {
					timezone: "America/New_York",
					start: "22:00",
					end: "07:00",
					weekdays: [1, 2, 3, 4, 5],
					allowRequests: true,
					allowProblems: false,
				},
			},
		});
		expect(state.preferences).not.toHaveProperty("reminderMinutes");
		expect(state.preferences).not.toHaveProperty("catchUpAfterPause");
		expect(state.preferences.quietHours).not.toHaveProperty("catchUp");
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

	it("atomically repairs a server-disabled endpoint across two explicit taps", async () => {
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
			device_name: "Hlid device",
			preferences: wirePreferences(),
		});

		await expect(getPushNotificationState()).resolves.toMatchObject({
			enabled: false,
			reenableRequired: true,
		});
		await expect(enablePushNotifications()).rejects.toMatchObject({
			code: "repair-ready",
			message: "Old browser subscription removed. Tap Repair again to finish.",
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
		expect(serverFns.subscribeToPushFn).toHaveBeenCalledWith({
			data: expect.objectContaining({
				replaces_endpoint: "https://push.test/subscription-1",
				subscription: expect.objectContaining({
					endpoint: "https://push.test/subscription-2",
				}),
			}),
		});
		expect(serverFns.unsubscribeFromPushFn).not.toHaveBeenCalled();
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
			replaces_endpoint: "https://push.test/subscription-1",
		});
	});

	it("keeps repair metadata until replacement registration succeeds", async () => {
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
		serverFns.subscribeToPushFn
			.mockRejectedValueOnce(new Error("temporary database error"))
			.mockResolvedValue(
				subscriptionResponse({
					work_finished: true,
					paused_until: 2_000_000_000,
				}),
			);

		await getPushNotificationState();
		await expect(enablePushNotifications()).rejects.toMatchObject({
			code: "repair-ready",
		});
		expect(browser.local.getItem(REPAIR_KEY)).not.toBeNull();
		browser.getSubscription.mockResolvedValue(null);
		vi.resetModules();
		const fresh = await import("./pushNotifications");
		await fresh.getPushNotificationState();
		await expect(fresh.enablePushNotifications()).rejects.toThrow(
			"temporary database error",
		);
		expect(browser.local.getItem(REPAIR_KEY)).not.toBeNull();
		await expect(fresh.enablePushNotifications()).resolves.toMatchObject({
			enabled: true,
			pausedUntil: 2_000_000_000_000,
		});
		expect(browser.local.getItem(REPAIR_KEY)).toBeNull();

		expect(serverFns.subscribeToPushFn).toHaveBeenCalledTimes(2);
		for (const [call] of serverFns.subscribeToPushFn.mock.calls) {
			expect(call.data).toEqual(
				expect.objectContaining({
					device_name: "Travel phone",
					replaces_endpoint: "https://push.test/subscription-1",
					preferences: expect.objectContaining({
						work_finished: true,
						paused_until: 2_000_000_000,
					}),
				}),
			);
		}
		expect(serverFns.unsubscribeFromPushFn).not.toHaveBeenCalled();
	});

	it("retries a locally retained replacement against the original endpoint after reload", async () => {
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
			preferences: subscriptionResponse({ work_finished: true }).preferences,
		});
		serverFns.subscribeToPushFn
			.mockRejectedValueOnce(new Error("temporary database error"))
			.mockResolvedValue(subscriptionResponse({ work_finished: true }));

		await getPushNotificationState();
		await expect(enablePushNotifications()).rejects.toMatchObject({
			code: "repair-ready",
		});
		await expect(enablePushNotifications()).rejects.toThrow(
			"temporary database error",
		);
		expect(
			JSON.parse(browser.local.getItem(REPAIR_KEY) ?? "null"),
		).toMatchObject({ oldEndpoint: "https://push.test/subscription-1" });

		// The browser retained replacement B even though its registration POST did
		// not reach the server. A reload must retry B against original endpoint A.
		browser.getSubscription.mockResolvedValue(replacement.subscription);
		vi.resetModules();
		const fresh = await import("./pushNotifications");
		await expect(fresh.getPushNotificationState()).resolves.toMatchObject({
			enabled: false,
			reenableRequired: true,
		});
		await expect(fresh.enablePushNotifications()).resolves.toMatchObject({
			enabled: true,
			preferences: { workFinished: true },
		});

		expect(existing.unsubscribe).toHaveBeenCalledOnce();
		expect(replacement.unsubscribe).not.toHaveBeenCalled();
		expect(browser.subscribe).toHaveBeenCalledOnce();
		expect(serverFns.subscribeToPushFn).toHaveBeenCalledTimes(2);
		for (const [call] of serverFns.subscribeToPushFn.mock.calls) {
			expect(call.data).toEqual(
				expect.objectContaining({
					replaces_endpoint: "https://push.test/subscription-1",
					subscription: expect.objectContaining({
						endpoint: "https://push.test/subscription-2",
					}),
				}),
			);
		}
		expect(browser.local.getItem(REPAIR_KEY)).toBeNull();
	});

	it("foreground sync completes a pending replacement in place", async () => {
		const existing = fakeSubscription();
		const replacement = fakeSubscription(
			PUBLIC_KEY_BYTES.buffer,
			"https://push.test/subscription-2",
		);
		const browser = installBrowser({
			permission: "granted",
			existingSubscription: existing.subscription,
		});
		serverFns.getPushStatusFn.mockResolvedValue({
			available: true,
			subscribed: false,
			device_name: "Travel phone",
			preferences: subscriptionResponse({ work_finished: true }).preferences,
		});
		serverFns.subscribeToPushFn.mockResolvedValue(
			subscriptionResponse({ work_finished: true }),
		);

		await getPushNotificationState();
		await expect(enablePushNotifications()).rejects.toMatchObject({
			code: "repair-ready",
		});
		browser.getSubscription.mockResolvedValue(replacement.subscription);
		vi.resetModules();
		const fresh = await import("./pushNotifications");

		await expect(fresh.syncPushSubscription()).resolves.toMatchObject({
			enabled: true,
			preferences: { workFinished: true },
		});
		expect(browser.subscribe).not.toHaveBeenCalled();
		expect(serverFns.subscribeToPushFn).toHaveBeenCalledWith({
			data: expect.objectContaining({
				replaces_endpoint: "https://push.test/subscription-1",
				subscription: expect.objectContaining({
					endpoint: "https://push.test/subscription-2",
				}),
			}),
		});
		expect(serverFns.unsubscribeFromPushFn).not.toHaveBeenCalled();
		expect(browser.local.getItem(REPAIR_KEY)).toBeNull();
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
			preferences: wirePreferences({
				requests: false,
				problems: true,
				work_finished: true,
				privacy: "detailed",
				completion_min_runtime_minutes: 5,
				paused_until: 2_000_000_000,
				quiet_hours: {
					timezone: "America/New_York",
					start: "22:00",
					end: "07:00",
					weekdays: [1, 2, 3, 4, 5],
					allow_requests: true,
					allow_problems: false,
					catch_up: true,
				},
				catch_up_after_pause: true,
				reminder_minutes: 15,
			}),
		});
		serverFns.updatePushPreferencesFn.mockResolvedValue(
			subscriptionResponse({
				requests: true,
				problems: false,
				work_finished: true,
				privacy: "generic",
				completion_min_runtime_minutes: 10,
				paused_until: 2_000_000_000,
				quiet_hours: null,
				catch_up_after_pause: false,
				reminder_minutes: 30,
			}),
		);

		const initial = await getPushNotificationState();
		const updated = await updatePushNotificationPreferences({
			requests: true,
			problems: false,
			workFinished: true,
			detail: "generic",
			completionMinimumMinutes: 10,
			quietHours: null,
		});

		expect(initial.preferences).toEqual({
			requests: false,
			problems: true,
			workFinished: true,
			detail: "detailed",
			completionMinimumMinutes: 5,
			quietHours: {
				timezone: "America/New_York",
				start: "22:00",
				end: "07:00",
				weekdays: [1, 2, 3, 4, 5],
				allowRequests: true,
				allowProblems: false,
			},
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
					quiet_hours: null,
				},
			},
		});
		expect(updated.preferences).toEqual({
			requests: true,
			problems: false,
			workFinished: true,
			detail: "generic",
			completionMinimumMinutes: 10,
			quietHours: null,
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
				preferences: {
					requests: true,
					problems: true,
					workFinished: false,
					detail: "generic",
					completionMinimumMinutes: 0,
					quietHours: null,
				},
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

	it("maps notification history and exact batch read state", async () => {
		const event = {
			id: "33333333-3333-4333-8333-333333333333",
			source_kind: "session",
			source_id: "session-1",
			category: "completion",
			reason: "work_finished",
			label: "Compile release",
			url: "/raven?session=session-1",
			runtime_ms: 30_000,
			pending_count: 0,
			occurred_at: 1_700_000,
			expires_at: 2_700_000,
			group_key: "completion",
			batch_id: "batch-one",
			status: "batched",
			status_reason: null,
			next_attempt_at: null,
		} as const;
		serverFns.getPushNotificationHistoryFn.mockResolvedValue({
			events: [
				{
					...event,
					deliveries: [
						{
							id: "44444444-4444-4444-8444-444444444444",
							device_id: DEVICE_ID,
							device: { id: DEVICE_ID, name: "Phone", privacy: "generic" },
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
		serverFns.getPushNotificationBatchFn.mockResolvedValue({
			batch: {
				id: "batch-one",
				category: "completion",
				group_key: "completion",
				status: "sent",
				created_at: 1_700_000,
				updated_at: 1_710_000,
				sent_at: 1_710_000,
				read_at: null,
			},
			members: [
				{
					event_id: "55555555-5555-4555-8555-555555555555",
					session_id: "session-2",
					position: 1,
					added_at: 1_700_001,
					read_at: null,
					event: {
						...event,
						id: "55555555-5555-4555-8555-555555555555",
						source_id: "session-2",
						label: "Run checks",
					},
				},
				{
					event_id: event.id,
					session_id: "session-1",
					position: 0,
					added_at: 1_700_000,
					read_at: null,
					event,
				},
			],
		});
		serverFns.markPushNotificationBatchReadFn.mockResolvedValue({
			ok: true,
			read_at: 1_800_000,
		});

		await expect(getPushNotificationHistory()).resolves.toMatchObject([
			{
				sourceKind: "session",
				category: "completion",
				label: "Compile release",
				deliveries: [
					{
						device: { name: "Phone" },
						status: "sent",
						displayedAt: 1_720_000,
					},
				],
			},
		]);
		await expect(getPushNotificationBatch("batch-one")).resolves.toMatchObject({
			batch: { id: "batch-one", status: "sent", readAt: null },
			members: [
				{ sessionId: "session-1", position: 0 },
				{ sessionId: "session-2", position: 1 },
			],
		});
		await expect(
			markPushNotificationBatchRead("batch-one", "session-1"),
		).resolves.toBe(1_800_000);
		expect(serverFns.getPushNotificationHistoryFn).toHaveBeenCalledWith({
			data: 20,
		});
		expect(serverFns.getPushNotificationBatchFn).toHaveBeenCalledWith({
			data: "batch-one",
		});
		expect(serverFns.markPushNotificationBatchReadFn).toHaveBeenCalledWith({
			data: { batch_id: "batch-one", session_id: "session-1" },
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

	it("updates a remote device profile through its opaque ID", async () => {
		installBrowser({ existingSubscription: null });
		serverFns.updatePushDeviceFn.mockResolvedValue({
			ok: true,
			device: wireDevice({
				current: false,
				preferences: wirePreferences({
					requests: false,
					work_finished: true,
					privacy: "detailed",
					completion_min_runtime_minutes: 5,
					quiet_hours: {
						timezone: "America/New_York",
						start: "23:00",
						end: "06:00",
						weekdays: [1, 2, 3, 4, 5],
						allow_requests: true,
						allow_problems: false,
						catch_up: true,
					},
					catch_up_after_pause: true,
					reminder_minutes: 30,
				}),
			}),
		});

		await expect(
			updatePushNotificationDevice(DEVICE_ID, {
				preferences: {
					requests: false,
					problems: true,
					workFinished: true,
					detail: "detailed",
					completionMinimumMinutes: 5,
					quietHours: {
						timezone: "America/New_York",
						start: "23:00",
						end: "06:00",
						weekdays: [1, 2, 3, 4, 5],
						allowRequests: true,
						allowProblems: false,
					},
				},
			}),
		).resolves.toMatchObject({
			id: DEVICE_ID,
			current: false,
			preferences: {
				requests: false,
				workFinished: true,
				detail: "detailed",
				quietHours: {
					timezone: "America/New_York",
					allowProblems: false,
				},
			},
		});
		expect(serverFns.updatePushDeviceFn).toHaveBeenCalledWith({
			data: {
				id: DEVICE_ID,
				preferences: {
					requests: false,
					problems: true,
					work_finished: true,
					privacy: "detailed",
					completion_min_runtime_minutes: 5,
					quiet_hours: {
						timezone: "America/New_York",
						start: "23:00",
						end: "06:00",
						weekdays: [1, 2, 3, 4, 5],
						allow_requests: true,
						allow_problems: false,
					},
				},
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

	it("reads and updates the effective per-session policy through server functions", async () => {
		serverFns.getSessionNotificationOverrideFn.mockResolvedValue({
			policy: null,
			effective: {
				requested_session_id: "session-1",
				source_session_id: "parent-session",
				mode: "mute",
				scope: "delegation_tree",
				target_device_ids: ["11111111-1111-4111-8111-111111111111"],
				inherited: true,
			},
		});
		serverFns.setSessionNotificationOverrideFn.mockResolvedValue({
			ok: true,
			policy: {
				session_id: "session-1",
				mode: "notify_completion_once",
				scope: "delegation_tree",
				target_device_ids: [
					"11111111-1111-4111-8111-111111111111",
					"22222222-2222-4222-8222-222222222222",
				],
				updated_at: 1_800,
			},
			effective: {
				requested_session_id: "session-1",
				source_session_id: "session-1",
				mode: "notify_completion_once",
				scope: "delegation_tree",
				target_device_ids: [
					"11111111-1111-4111-8111-111111111111",
					"22222222-2222-4222-8222-222222222222",
				],
				inherited: false,
			},
		});

		await expect(getSessionNotificationOverride("session-1")).resolves.toEqual({
			policy: null,
			effective: {
				requestedSessionId: "session-1",
				sourceSessionId: "parent-session",
				mode: "mute",
				scope: "delegation_tree",
				targetDeviceIds: ["11111111-1111-4111-8111-111111111111"],
				inherited: true,
			},
		});
		await expect(
			setSessionNotificationOverride("session-1", {
				mode: "notify_completion_once",
				scope: "delegation_tree",
				targetDeviceIds: [
					"11111111-1111-4111-8111-111111111111",
					"22222222-2222-4222-8222-222222222222",
				],
			}),
		).resolves.toEqual({
			policy: {
				sessionId: "session-1",
				mode: "notify_completion_once",
				scope: "delegation_tree",
				targetDeviceIds: [
					"11111111-1111-4111-8111-111111111111",
					"22222222-2222-4222-8222-222222222222",
				],
				updatedAt: 1_800_000,
			},
			effective: {
				requestedSessionId: "session-1",
				sourceSessionId: "session-1",
				mode: "notify_completion_once",
				scope: "delegation_tree",
				targetDeviceIds: [
					"11111111-1111-4111-8111-111111111111",
					"22222222-2222-4222-8222-222222222222",
				],
				inherited: false,
			},
		});
		expect(serverFns.getSessionNotificationOverrideFn).toHaveBeenCalledWith({
			data: "session-1",
		});
		expect(serverFns.setSessionNotificationOverrideFn).toHaveBeenCalledWith({
			data: {
				session_id: "session-1",
				mode: "notify_completion_once",
				scope: "delegation_tree",
				target_device_ids: [
					"11111111-1111-4111-8111-111111111111",
					"22222222-2222-4222-8222-222222222222",
				],
			},
		});
	});
});
