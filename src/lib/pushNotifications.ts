import {
	getPushConfigFn,
	getPushStatusFn,
	getSessionNotificationOverrideFn,
	setSessionNotificationOverrideFn,
	subscribeToPushFn,
	unsubscribeFromPushFn,
	updatePushPreferencesFn,
} from "./serverFns/pushNotifications";

export type PushNotificationPreferences = {
	needsAttention: boolean;
	workFinished: boolean;
	detail: "generic" | "detailed";
};

export type SessionNotificationOverride = "default" | "notify" | "mute";

export type PushNotificationUnsupportedReason =
	| "not-browser"
	| "insecure-context"
	| "notifications-unavailable"
	| "service-worker-unavailable"
	| "push-unavailable"
	| "server-unavailable";

export type PushNotificationSupport = {
	supported: boolean;
	reason?: PushNotificationUnsupportedReason;
};

export type PushNotificationState = PushNotificationSupport & {
	permission: NotificationPermission | "unsupported";
	enabled: boolean;
	/** The prior opt-in can no longer deliver and needs another explicit tap. */
	reenableRequired?: boolean;
	preferences: PushNotificationPreferences;
};

export type PushNotificationErrorCode =
	| "explicit-user-action-required"
	| "permission-denied"
	| "server-unavailable"
	| "subscription-invalid"
	| "unsupported"
	| "request-failed";

export class PushNotificationError extends Error {
	readonly code: PushNotificationErrorCode;

	constructor(code: PushNotificationErrorCode, message: string) {
		super(message);
		this.name = "PushNotificationError";
		this.code = code;
	}
}

type WirePreferences = {
	needs_attention: boolean;
	work_finished: boolean;
	privacy: "generic" | "detailed";
};

type PushConfig =
	| { available: true; publicKey: string }
	| { available: false; publicKey?: never };

type SubscriptionStatus = {
	subscribed: boolean;
	preferences: WirePreferences | null;
};

type StoredPushSubscription = {
	endpoint: string;
	expirationTime: number | null;
	keys: { p256dh: string; auth: string };
};

type PushEnablePrerequisites = {
	owner: ServiceWorkerContainer;
	config: PushConfig;
	registration: ServiceWorkerRegistration;
	subscription: PushSubscription | null;
	status: SubscriptionStatus | null;
};

const PREFERENCES_STORAGE_KEY = "hlid:push:preferences:v1";
const ENABLED_STORAGE_KEY = "hlid:push:enabled:v1";
const DEFAULT_PREFERENCES: PushNotificationPreferences = {
	needsAttention: true,
	workFinished: false,
	detail: "generic",
};

// WebKit requires PushManager.subscribe() to be called immediately from the
// user's gesture handler. Forge loads notification state before rendering the
// Enable button, so retain the non-sensitive prerequisites gathered there and
// avoid putting a server request in front of subscribe(). The owner check keeps
// tests, document replacements, and unusual embedded contexts from reusing a
// registration that belongs to a different ServiceWorkerContainer.
let cachedEnablePrerequisites: PushEnablePrerequisites | null = null;
let pendingEnablePrerequisites: Promise<PushEnablePrerequisites> | null = null;
let pendingEnablePrerequisitesOwner: ServiceWorkerContainer | null = null;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isWirePreferences(value: unknown): value is WirePreferences {
	return (
		isRecord(value) &&
		typeof value.needs_attention === "boolean" &&
		typeof value.work_finished === "boolean" &&
		(value.privacy === "generic" || value.privacy === "detailed")
	);
}

function normalizePreferences(
	value: unknown,
): PushNotificationPreferences | null {
	if (!isRecord(value)) return null;
	if (
		typeof value.needsAttention !== "boolean" ||
		typeof value.workFinished !== "boolean" ||
		(value.detail !== "generic" && value.detail !== "detailed")
	)
		return null;
	return {
		needsAttention: value.needsAttention,
		workFinished: value.workFinished,
		detail: value.detail,
	};
}

function fromWirePreferences(
	preferences: WirePreferences,
): PushNotificationPreferences {
	return {
		needsAttention: preferences.needs_attention,
		workFinished: preferences.work_finished,
		detail: preferences.privacy,
	};
}

function toWirePreferences(
	preferences: PushNotificationPreferences,
): WirePreferences {
	return {
		needs_attention: preferences.needsAttention,
		work_finished: preferences.workFinished,
		privacy: preferences.detail,
	};
}

function loadPreferences(): PushNotificationPreferences {
	if (typeof localStorage === "undefined") return { ...DEFAULT_PREFERENCES };
	try {
		const stored = localStorage.getItem(PREFERENCES_STORAGE_KEY);
		return (
			normalizePreferences(stored ? JSON.parse(stored) : null) ?? {
				...DEFAULT_PREFERENCES,
			}
		);
	} catch {
		return { ...DEFAULT_PREFERENCES };
	}
}

function storePreferences(preferences: PushNotificationPreferences): void {
	if (typeof localStorage === "undefined") return;
	try {
		localStorage.setItem(PREFERENCES_STORAGE_KEY, JSON.stringify(preferences));
	} catch {
		// Preferences still apply for this call when storage is unavailable.
	}
}

function isLocallyEnabled(): boolean {
	if (typeof localStorage === "undefined") return false;
	try {
		return localStorage.getItem(ENABLED_STORAGE_KEY) === "true";
	} catch {
		return false;
	}
}

function setLocallyEnabled(enabled: boolean): void {
	if (typeof localStorage === "undefined") return;
	try {
		localStorage.setItem(ENABLED_STORAGE_KEY, String(enabled));
	} catch {
		// The browser subscription remains the source of delivery truth.
	}
}

/** Browser-only capability detection. Server availability is included by the
 * async state APIs, which query Hlid's current push configuration. */
export function getPushNotificationSupport(): PushNotificationSupport {
	if (typeof navigator === "undefined" || typeof globalThis === "undefined")
		return { supported: false, reason: "not-browser" };
	if (globalThis.isSecureContext !== true)
		return { supported: false, reason: "insecure-context" };
	if (!("Notification" in globalThis))
		return { supported: false, reason: "notifications-unavailable" };
	if (!("serviceWorker" in navigator))
		return { supported: false, reason: "service-worker-unavailable" };
	if (!("PushManager" in globalThis))
		return { supported: false, reason: "push-unavailable" };
	return { supported: true };
}

function unsupportedState(
	reason: PushNotificationUnsupportedReason,
): PushNotificationState {
	return {
		supported: false,
		reason,
		permission: "unsupported",
		enabled: false,
		preferences: loadPreferences(),
	};
}

async function pushRequest<T>(operation: () => Promise<T>): Promise<T> {
	try {
		return await operation();
	} catch (error) {
		if (error instanceof PushNotificationError) throw error;
		throw new PushNotificationError(
			"request-failed",
			error instanceof Error
				? error.message
				: "The notification request failed.",
		);
	}
}

async function getPushConfig(): Promise<PushConfig> {
	const payload: unknown = await pushRequest(() => getPushConfigFn());
	if (!isRecord(payload) || typeof payload.available !== "boolean")
		throw new PushNotificationError(
			"request-failed",
			"Hlid returned an invalid notification configuration.",
		);
	if (!payload.available) return { available: false };
	if (typeof payload.publicKey !== "string")
		throw new PushNotificationError(
			"request-failed",
			"Hlid returned an invalid notification public key.",
		);
	return { available: true, publicKey: payload.publicKey };
}

function decodeApplicationServerKey(value: string): ArrayBuffer {
	if (!/^[A-Za-z0-9_-]{80,120}$/.test(value))
		throw new PushNotificationError(
			"server-unavailable",
			"Hlid's notification public key is invalid.",
		);
	let decoded: string;
	try {
		const padded = `${value.replaceAll("-", "+").replaceAll("_", "/")}${"=".repeat((4 - (value.length % 4)) % 4)}`;
		decoded = atob(padded);
	} catch {
		throw new PushNotificationError(
			"server-unavailable",
			"Hlid's notification public key is invalid.",
		);
	}
	if (decoded.length !== 65)
		throw new PushNotificationError(
			"server-unavailable",
			"Hlid's notification public key is invalid.",
		);
	const bytes = new Uint8Array(decoded.length);
	for (let index = 0; index < decoded.length; index++)
		bytes[index] = decoded.charCodeAt(index);
	return bytes.buffer;
}

function sameBytes(left: ArrayBuffer, right: ArrayBuffer): boolean {
	const a = new Uint8Array(left);
	const b = new Uint8Array(right);
	if (a.byteLength !== b.byteLength) return false;
	for (let index = 0; index < a.byteLength; index++) {
		if (a[index] !== b[index]) return false;
	}
	return true;
}

function encodeKey(value: ArrayBuffer | null): string | null {
	if (!value) return null;
	const bytes = new Uint8Array(value);
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary)
		.replaceAll("+", "-")
		.replaceAll("/", "_")
		.replace(/=+$/, "");
}

function serializeSubscription(
	subscription: PushSubscription,
): StoredPushSubscription {
	const p256dh = encodeKey(subscription.getKey("p256dh"));
	const auth = encodeKey(subscription.getKey("auth"));
	if (
		!subscription.endpoint ||
		subscription.endpoint.length > 4096 ||
		!p256dh ||
		!auth
	)
		throw new PushNotificationError(
			"subscription-invalid",
			"The browser returned an invalid push subscription.",
		);
	return {
		endpoint: subscription.endpoint,
		expirationTime: subscription.expirationTime,
		keys: { p256dh, auth },
	};
}

async function existingRegistration(): Promise<ServiceWorkerRegistration | null> {
	return (await navigator.serviceWorker.getRegistration()) ?? null;
}

async function registrationForEnable(): Promise<ServiceWorkerRegistration> {
	return (
		(await existingRegistration()) ??
		(await navigator.serviceWorker.register("/sw.js"))
	);
}

async function subscriptionStatus(
	endpoint: string,
): Promise<SubscriptionStatus> {
	const payload: unknown = await pushRequest(() =>
		getPushStatusFn({ data: { endpoint } }),
	);
	if (!isRecord(payload) || typeof payload.subscribed !== "boolean")
		throw new PushNotificationError(
			"request-failed",
			"Hlid returned an invalid notification status.",
		);
	const preferences = isWirePreferences(payload.preferences)
		? payload.preferences
		: null;
	return { subscribed: payload.subscribed, preferences };
}

function browserState(
	permission: NotificationPermission,
	enabled: boolean,
	preferences: PushNotificationPreferences,
	reenableRequired = false,
): PushNotificationState {
	return {
		supported: true,
		permission,
		enabled,
		...(reenableRequired ? { reenableRequired: true } : {}),
		preferences,
	};
}

function cachedPrerequisites(): PushEnablePrerequisites | null {
	const cached = cachedEnablePrerequisites;
	return cached?.owner === navigator.serviceWorker ? cached : null;
}

function storePrerequisites(
	value: Omit<PushEnablePrerequisites, "owner">,
): PushEnablePrerequisites {
	const stored = { owner: navigator.serviceWorker, ...value };
	cachedEnablePrerequisites = stored;
	return stored;
}

async function loadEnablePrerequisites(
	refresh = false,
): Promise<PushEnablePrerequisites> {
	const owner = navigator.serviceWorker;
	if (pendingEnablePrerequisites && pendingEnablePrerequisitesOwner === owner)
		return pendingEnablePrerequisites;
	if (!refresh) {
		const cached = cachedPrerequisites();
		if (cached) return cached;
	}

	const loading = (async () => {
		const [config, registration] = await Promise.all([
			getPushConfig(),
			registrationForEnable(),
		]);
		const subscription = await registration.pushManager.getSubscription();
		const status = subscription
			? await subscriptionStatus(subscription.endpoint)
			: null;
		return storePrerequisites({ config, registration, subscription, status });
	})();
	pendingEnablePrerequisites = loading;
	pendingEnablePrerequisitesOwner = owner;
	try {
		return await loading;
	} finally {
		if (pendingEnablePrerequisites === loading) {
			pendingEnablePrerequisites = null;
			pendingEnablePrerequisitesOwner = null;
		}
	}
}

function applicationServerKeyMatches(
	subscription: PushSubscription,
	applicationServerKey: ArrayBuffer,
): boolean {
	const currentKey = subscription.options.applicationServerKey;
	return currentKey !== null && sameBytes(currentKey, applicationServerKey);
}

export async function getPushNotificationState(): Promise<PushNotificationState> {
	const support = getPushNotificationSupport();
	if (!support.supported)
		return unsupportedState(support.reason ?? "not-browser");

	const prerequisites = await loadEnablePrerequisites(true);
	const { config, subscription, status } = prerequisites;
	if (!config.available) return unsupportedState("server-unavailable");
	const permission = Notification.permission;
	const localPreferences = loadPreferences();
	const preferences = status?.preferences
		? fromWirePreferences(status.preferences)
		: localPreferences;
	if (status?.preferences) storePreferences(preferences);
	const applicationServerKey = decodeApplicationServerKey(config.publicKey);
	const keyMatches =
		subscription !== null &&
		applicationServerKeyMatches(subscription, applicationServerKey);
	const enabled =
		permission === "granted" && status?.subscribed === true && keyMatches;
	if (enabled) setLocallyEnabled(true);
	const reenableRequired =
		permission === "granted" &&
		((subscription !== null && (status?.subscribed !== true || !keyMatches)) ||
			(subscription === null && isLocallyEnabled()));
	return browserState(permission, enabled, preferences, reenableRequired);
}

function assertSupported(): void {
	const support = getPushNotificationSupport();
	if (!support.supported)
		throw new PushNotificationError(
			"unsupported",
			`Push notifications are unavailable (${support.reason ?? "unsupported"}).`,
		);
}

function assertExplicitUserAction(): void {
	const activation = navigator.userActivation;
	if (activation && !activation.isActive)
		throw new PushNotificationError(
			"explicit-user-action-required",
			"Enable notifications from a direct click or tap.",
		);
}

async function removeServerSubscription(endpoint: string): Promise<void> {
	await pushRequest(() => unsubscribeFromPushFn({ data: { endpoint } }));
}

async function registerSubscription(
	subscription: PushSubscription,
	preferences: PushNotificationPreferences,
): Promise<PushNotificationPreferences> {
	const payload: unknown = await pushRequest(() =>
		subscribeToPushFn({
			data: {
				subscription: serializeSubscription(subscription),
				preferences: toWirePreferences(preferences),
			},
		}),
	);
	if (
		!isRecord(payload) ||
		payload.ok !== true ||
		!isWirePreferences(payload.preferences)
	)
		throw new PushNotificationError(
			"request-failed",
			"Hlid returned an invalid subscription response.",
		);
	return fromWirePreferences(payload.preferences);
}

/**
 * Enable delivery for this browser. Call this directly from a click or tap.
 * This is the only client API that may request notification permission.
 */
export async function enablePushNotifications(
	preferences: PushNotificationPreferences = loadPreferences(),
): Promise<PushNotificationState> {
	assertSupported();
	assertExplicitUserAction();
	const normalized = normalizePreferences(preferences);
	if (!normalized)
		throw new PushNotificationError(
			"request-failed",
			"Notification preferences are invalid.",
		);

	if (Notification.permission === "denied")
		throw new PushNotificationError(
			"permission-denied",
			"Notification permission is blocked by this browser.",
		);

	const prerequisites = cachedPrerequisites();
	if (!prerequisites) {
		// Preparing is safe without permission, but the user must tap again so the
		// eventual PushManager.subscribe() still has a live WebKit activation.
		void loadEnablePrerequisites(true).catch(() => {});
		throw new PushNotificationError(
			"request-failed",
			"Notification setup is still preparing. Try Enable again.",
		);
	}
	const { config, registration, status } = prerequisites;
	if (!config.available)
		throw new PushNotificationError(
			"server-unavailable",
			"Push notifications are not configured on this Hlid server.",
		);
	const applicationServerKey = decodeApplicationServerKey(config.publicKey);
	let subscription = prerequisites.subscription;
	const replaceExisting =
		subscription !== null &&
		(status?.subscribed !== true ||
			!applicationServerKeyMatches(subscription, applicationServerKey));
	let replacedEndpoint: string | null = null;
	if (replaceExisting && subscription) {
		replacedEndpoint = subscription.endpoint;
		const unsubscribed = await subscription.unsubscribe();
		if (unsubscribed === false)
			throw new PushNotificationError(
				"request-failed",
				"The old notification subscription could not be replaced.",
			);
		subscription = null;
	}
	// Do not put Notification.requestPermission(), a server function, or service
	// worker registration in front of this call. PushManager owns the permission
	// prompt and WebKit requires this method to run from the explicit tap.
	const subscriptionPromise = subscription
		? null
		: registration.pushManager.subscribe({
				userVisibleOnly: true,
				applicationServerKey,
			});
	subscription ??= await subscriptionPromise;
	if (!subscription)
		throw new PushNotificationError(
			"subscription-invalid",
			"The browser did not create a push subscription.",
		);
	const permission = Notification.permission;
	if (permission !== "granted")
		throw new PushNotificationError(
			"permission-denied",
			"Notification permission was not granted.",
		);
	const saved = await registerSubscription(subscription, normalized);
	if (replacedEndpoint && replacedEndpoint !== subscription.endpoint)
		void removeServerSubscription(replacedEndpoint).catch(() => {});
	storePreferences(saved);
	setLocallyEnabled(true);
	storePrerequisites({
		config,
		registration,
		subscription,
		status: { subscribed: true, preferences: toWirePreferences(saved) },
	});
	return browserState(permission, true, saved);
}

/** Reconcile an already opted-in browser after startup, foregrounding, or a
 * browser subscription rotation. Never requests notification permission. */
export async function syncPushSubscription(): Promise<PushNotificationState> {
	const support = getPushNotificationSupport();
	if (!support.supported)
		return unsupportedState(support.reason ?? "not-browser");
	const permission = Notification.permission;
	const preferences = loadPreferences();
	if (permission !== "granted")
		return browserState(permission, false, preferences);

	const prerequisites = await loadEnablePrerequisites(true);
	const { config, registration, subscription, status } = prerequisites;
	if (!config.available) return unsupportedState("server-unavailable");
	if (!subscription)
		return browserState(permission, false, preferences, isLocallyEnabled());
	const applicationServerKey = decodeApplicationServerKey(config.publicKey);
	if (
		status?.subscribed !== true ||
		!applicationServerKeyMatches(subscription, applicationServerKey)
	)
		return browserState(permission, false, preferences, true);

	// Re-upload current key material for same-endpoint browser rotations, while
	// preserving the server's authoritative device preferences. Creating a new
	// PushSubscription is intentionally reserved for the next explicit tap.
	const currentPreferences = status.preferences
		? fromWirePreferences(status.preferences)
		: preferences;
	const saved = await registerSubscription(subscription, currentPreferences);
	storePreferences(saved);
	setLocallyEnabled(true);
	storePrerequisites({
		config,
		registration,
		subscription,
		status: { subscribed: true, preferences: toWirePreferences(saved) },
	});
	return browserState(permission, true, saved);
}

/** Stop delivery and invalidate this browser's endpoint. Category/detail
 * choices remain local so re-enabling restores the user's previous choices. */
export async function disablePushNotifications(): Promise<PushNotificationState> {
	const support = getPushNotificationSupport();
	if (!support.supported)
		return unsupportedState(support.reason ?? "not-browser");
	const preferences = loadPreferences();
	const registration = await existingRegistration();
	const subscription = await registration?.pushManager.getSubscription();
	if (subscription) {
		const endpoint = subscription.endpoint;
		const [browserResult, serverResult] = await Promise.allSettled([
			subscription.unsubscribe(),
			removeServerSubscription(endpoint),
		]);
		const browserDisabled =
			browserResult.status === "fulfilled" && browserResult.value !== false;
		const serverDisabled = serverResult.status === "fulfilled";
		if (!browserDisabled && !serverDisabled) {
			throw new PushNotificationError(
				"request-failed",
				"Could not revoke this device's notification subscription.",
			);
		}
		const cached = cachedPrerequisites();
		if (cached) {
			storePrerequisites({
				config: cached.config,
				registration: cached.registration,
				subscription: browserDisabled ? null : subscription,
				status: serverDisabled
					? { subscribed: false, preferences: null }
					: cached.status,
			});
		}
	}
	setLocallyEnabled(false);
	return browserState(Notification.permission, false, preferences);
}

export async function updatePushNotificationPreferences(
	preferences: PushNotificationPreferences,
): Promise<PushNotificationState> {
	const normalized = normalizePreferences(preferences);
	if (!normalized)
		throw new PushNotificationError(
			"request-failed",
			"Notification preferences are invalid.",
		);
	const support = getPushNotificationSupport();
	if (!support.supported) {
		storePreferences(normalized);
		return {
			...unsupportedState(support.reason ?? "not-browser"),
			preferences: normalized,
		};
	}
	const permission = Notification.permission;
	const registration = await existingRegistration();
	const subscription = await registration?.pushManager.getSubscription();
	if (permission !== "granted" || !subscription) {
		storePreferences(normalized);
		return browserState(permission, false, normalized);
	}

	const payload: unknown = await pushRequest(() =>
		updatePushPreferencesFn({
			data: {
				endpoint: subscription.endpoint,
				preferences: toWirePreferences(normalized),
			},
		}),
	);
	if (
		!isRecord(payload) ||
		payload.ok !== true ||
		!isWirePreferences(payload.preferences)
	)
		throw new PushNotificationError(
			"request-failed",
			"Hlid returned invalid notification preferences.",
		);
	const saved = fromWirePreferences(payload.preferences);
	storePreferences(saved);
	return browserState(permission, true, saved);
}

function assertSessionId(sessionId: string): void {
	let hasControlCharacter = false;
	for (let index = 0; index < sessionId.length; index++) {
		const code = sessionId.charCodeAt(index);
		if (code <= 31 || code === 127) {
			hasControlCharacter = true;
			break;
		}
	}
	if (sessionId.length === 0 || sessionId.length > 256 || hasControlCharacter)
		throw new PushNotificationError(
			"request-failed",
			"The session identifier is invalid.",
		);
}

/**
 * Best-effort dismissal for the exact session the user is currently viewing.
 * The worker validates the identifier again and closes only matching Hlid
 * notifications, so callers do not need to coordinate displayed state.
 */
export async function closePushNotificationsForSession(
	sessionId: string,
): Promise<void> {
	try {
		assertSessionId(sessionId);
		const support = getPushNotificationSupport();
		if (!support.supported) return;
		const registration = await existingRegistration();
		const worker =
			registration?.active ?? registration?.waiting ?? registration?.installing;
		worker?.postMessage({
			type: "hlid:close-session-notifications",
			sessionId,
		});
	} catch {
		// Presence updates must never be disrupted by optional notification cleanup.
	}
}

export async function getSessionNotificationOverride(
	sessionId: string,
): Promise<SessionNotificationOverride> {
	assertSessionId(sessionId);
	const payload: unknown = await pushRequest(() =>
		getSessionNotificationOverrideFn({ data: sessionId }),
	);
	if (
		!isRecord(payload) ||
		(payload.mode !== "default" &&
			payload.mode !== "notify" &&
			payload.mode !== "mute")
	)
		throw new PushNotificationError(
			"request-failed",
			"Hlid returned an invalid session notification mode.",
		);
	return payload.mode;
}

export async function setSessionNotificationOverride(
	sessionId: string,
	mode: SessionNotificationOverride,
): Promise<SessionNotificationOverride> {
	assertSessionId(sessionId);
	if (mode !== "default" && mode !== "notify" && mode !== "mute")
		throw new PushNotificationError(
			"request-failed",
			"The session notification mode is invalid.",
		);
	const payload: unknown = await pushRequest(() =>
		setSessionNotificationOverrideFn({
			data: { session_id: sessionId, mode },
		}),
	);
	if (!isRecord(payload) || payload.ok !== true || payload.mode !== mode)
		throw new PushNotificationError(
			"request-failed",
			"Hlid returned an invalid session notification mode.",
		);
	return mode;
}
