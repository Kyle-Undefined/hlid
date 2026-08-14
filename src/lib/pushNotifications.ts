import type {
	PushNotificationDeliveryState,
	PushNotificationDeliveryStatus,
	PushNotificationEventStatus,
	PushNotificationEventSummary,
	PushNotificationSourceKind,
	PushNotificationTestScenario,
	SessionNotificationMode,
	SessionNotificationScope,
	PushQuietHours as WirePushQuietHours,
} from "./pushNotificationSchemas";
import {
	deletePushDeviceFn,
	getPushConfigFn,
	getPushNotificationBatchFn,
	getPushNotificationHistoryFn,
	getPushStatusFn,
	getSessionNotificationOverrideFn,
	listPushDevicesFn,
	markPushNotificationBatchReadFn,
	sendTestPushNotificationFn,
	setSessionNotificationOverrideFn,
	subscribeToPushFn,
	unsubscribeFromPushFn,
	updatePushDeviceFn,
	updatePushPreferencesFn,
	type PushNotificationBatchResponse as WirePushNotificationBatch,
	type PushNotificationBatchMemberResponse as WirePushNotificationBatchMember,
	type PushNotificationEventSummaryResponse as WirePushNotificationEventSummary,
	type PushNotificationHistoryEventResponse as WirePushNotificationHistoryEvent,
} from "./serverFns/pushNotifications";

export type {
	PushNotificationEventSummary,
	PushNotificationTestScenario,
} from "./pushNotificationSchemas";

export type PushCompletionMinimumMinutes = 0 | 1 | 5 | 10;

export type PushIsoWeekday = 1 | 2 | 3 | 4 | 5 | 6 | 7;

export type PushNotificationQuietHours = {
	timezone: string;
	start: string;
	end: string;
	weekdays: PushIsoWeekday[];
	allowRequests: boolean;
	allowProblems: boolean;
};

export type PushNotificationPreferences = {
	requests: boolean;
	problems: boolean;
	workFinished: boolean;
	detail: "generic" | "detailed";
	completionMinimumMinutes: PushCompletionMinimumMinutes;
	quietHours: PushNotificationQuietHours | null;
};

export type PushNotificationDevice = {
	id: string;
	name: string;
	current: boolean;
	enabled: boolean;
	createdAt: number;
	lastSeenAt: number;
	pausedUntil: number | null;
	pausedIndefinitely: boolean;
	preferences: PushNotificationPreferences;
	lastAcceptedAt: number | null;
	lastFailureAt: number | null;
	lastFailureMessage: string | null;
	failureCount: number;
};

export type PushNotificationDevicePatch = {
	name?: string;
	preferences?: Partial<PushNotificationPreferences>;
};

export type PushNotificationCategory = "request" | "problem" | "completion";

export type PushNotificationHistoryDelivery = {
	id: string;
	deviceId: string;
	device: { id: string; name: string; privacy: "generic" | "detailed" };
} & PushNotificationDeliveryState;

export type PushNotificationHistoryEvent = PushNotificationEventSummary & {
	deliveries: PushNotificationHistoryDelivery[];
};

export type PushNotificationBatch = {
	id: string;
	category: PushNotificationCategory;
	groupKey: string | null;
	status: "open" | "ready" | "sent" | "read" | "expired";
	createdAt: number;
	updatedAt: number;
	sentAt: number | null;
	readAt: number | null;
};

export type PushNotificationBatchMember = {
	eventId: string;
	sessionId: string;
	position: number;
	addedAt: number;
	readAt: number | null;
	event: PushNotificationEventSummary | null;
};

export type PushNotificationBatchState = {
	batch: PushNotificationBatch;
	members: PushNotificationBatchMember[];
};

export type PushNotificationTestResult = {
	accepted: boolean;
	acceptedAt: number | null;
	failureAt: number | null;
	failureCount: number;
	subscriptionRemoved: boolean;
};

export type SessionNotificationOverride = SessionNotificationMode;

export type SessionNotificationPolicy = {
	sessionId: string;
	mode: Exclude<SessionNotificationMode, "default">;
	scope: SessionNotificationScope;
	/** null means every subscribed device; an array is an exact target set. */
	targetDeviceIds: string[] | null;
	updatedAt: number;
};

export type EffectiveSessionNotificationPolicy = {
	requestedSessionId: string;
	sourceSessionId: string | null;
	mode: SessionNotificationMode;
	scope: SessionNotificationScope;
	targetDeviceIds: string[] | null;
	inherited: boolean;
};

export type SessionNotificationPolicyState = {
	policy: SessionNotificationPolicy | null;
	effective: EffectiveSessionNotificationPolicy;
};

export type SessionNotificationPolicyUpdate = {
	mode: SessionNotificationMode;
	scope: SessionNotificationScope;
	targetDeviceIds: string[] | null;
};

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
	pausedUntil: number | null;
	pausedIndefinitely: boolean;
};

export type PushNotificationErrorCode =
	| "explicit-user-action-required"
	| "permission-denied"
	| "repair-ready"
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
	requests: boolean;
	problems: boolean;
	work_finished: boolean;
	privacy: "generic" | "detailed";
	completion_min_runtime_minutes: PushCompletionMinimumMinutes;
	paused_until: number | null;
	paused_indefinitely: boolean;
	quiet_hours: WirePushQuietHours | null;
};

type WirePushDevice = {
	id: string;
	name: string;
	current: boolean;
	enabled: boolean;
	paused_until: number | null;
	paused_indefinitely: boolean;
	preferences: WirePreferences;
	created_at: number;
	updated_at: number;
	last_success_at: number | null;
	last_failure_at: number | null;
	failure_count: number;
};

type WireSessionNotificationPolicy = {
	session_id: string;
	mode: Exclude<SessionNotificationMode, "default">;
	scope: SessionNotificationScope;
	target_device_ids: string[] | null;
	updated_at: number;
};

type WireEffectiveSessionNotificationPolicy = {
	requested_session_id: string;
	source_session_id: string | null;
	mode: SessionNotificationMode;
	scope: SessionNotificationScope;
	target_device_ids: string[] | null;
	inherited: boolean;
};

type PushConfig =
	| { available: true; publicKey: string }
	| { available: false; publicKey?: never };

type SubscriptionStatus = {
	subscribed: boolean;
	preferences: WirePreferences | null;
	deviceName: string | null;
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

type PendingSubscriptionRepair = {
	owner: ServiceWorkerContainer;
	oldEndpoint: string;
	preferences: WirePreferences | null;
	deviceName: string | null;
};

const PREFERENCES_STORAGE_KEY = "hlid:push:preferences:v1";
const ENABLED_STORAGE_KEY = "hlid:push:enabled:v1";
const REPAIR_STORAGE_KEY = "hlid:push:repair:v1";
const MAX_SAFE_EPOCH_SECONDS = 8_640_000_000_000;
const UUID_PATTERN =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DEFAULT_PREFERENCES: PushNotificationPreferences = {
	requests: true,
	problems: true,
	workFinished: false,
	detail: "generic",
	completionMinimumMinutes: 0,
	quietHours: null,
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
let pendingSubscriptionRepair: PendingSubscriptionRepair | null = null;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isIanaTimeZone(value: unknown): value is string {
	if (typeof value !== "string" || value.length === 0 || value.length > 64)
		return false;
	try {
		new Intl.DateTimeFormat("en-US", { timeZone: value }).format(0);
		return true;
	} catch {
		return false;
	}
}

function isQuietHoursCore(value: unknown): value is Record<string, unknown> & {
	timezone: string;
	start: string;
	end: string;
	weekdays: number[];
} {
	return (
		isRecord(value) &&
		isIanaTimeZone(value.timezone) &&
		typeof value.start === "string" &&
		/^([01]\d|2[0-3]):[0-5]\d$/.test(value.start) &&
		typeof value.end === "string" &&
		/^([01]\d|2[0-3]):[0-5]\d$/.test(value.end) &&
		Array.isArray(value.weekdays) &&
		value.weekdays.length >= 1 &&
		value.weekdays.length <= 7 &&
		value.weekdays.every(
			(day) => Number.isInteger(day) && day >= 1 && day <= 7,
		) &&
		new Set(value.weekdays).size === value.weekdays.length
	);
}

function isWireQuietHours(value: unknown): value is WirePushQuietHours {
	return (
		isQuietHoursCore(value) &&
		typeof value.allow_requests === "boolean" &&
		typeof value.allow_problems === "boolean"
	);
}

function isWirePreferences(value: unknown): value is WirePreferences {
	return (
		isRecord(value) &&
		typeof value.requests === "boolean" &&
		typeof value.problems === "boolean" &&
		typeof value.work_finished === "boolean" &&
		(value.privacy === "generic" || value.privacy === "detailed") &&
		(value.completion_min_runtime_minutes === 0 ||
			value.completion_min_runtime_minutes === 1 ||
			value.completion_min_runtime_minutes === 5 ||
			value.completion_min_runtime_minutes === 10) &&
		(value.paused_until === null ||
			(typeof value.paused_until === "number" &&
				Number.isSafeInteger(value.paused_until) &&
				value.paused_until >= 0 &&
				value.paused_until <= MAX_SAFE_EPOCH_SECONDS)) &&
		typeof value.paused_indefinitely === "boolean" &&
		(value.quiet_hours === null || isWireQuietHours(value.quiet_hours))
	);
}

function isWireDeviceName(value: unknown): value is string {
	if (
		!(
			typeof value === "string" &&
			value.length > 0 &&
			value.length <= 80 &&
			value.trim() === value
		)
	)
		return false;
	for (let index = 0; index < value.length; index++) {
		const code = value.charCodeAt(index);
		if (code <= 31 || code === 127) return false;
	}
	return true;
}

function isNotificationQuietHours(
	value: unknown,
): value is PushNotificationQuietHours {
	return (
		isQuietHoursCore(value) &&
		typeof value.allowRequests === "boolean" &&
		typeof value.allowProblems === "boolean"
	);
}

function normalizePreferences(
	value: unknown,
): PushNotificationPreferences | null {
	if (!isRecord(value)) return null;
	const legacyNeedsAttention =
		typeof value.needsAttention === "boolean" ? value.needsAttention : null;
	if (
		(typeof value.requests !== "boolean" && legacyNeedsAttention === null) ||
		(typeof value.problems !== "boolean" && legacyNeedsAttention === null) ||
		typeof value.workFinished !== "boolean" ||
		(value.detail !== "generic" && value.detail !== "detailed") ||
		(value.completionMinimumMinutes !== undefined &&
			value.completionMinimumMinutes !== 0 &&
			value.completionMinimumMinutes !== 1 &&
			value.completionMinimumMinutes !== 5 &&
			value.completionMinimumMinutes !== 10) ||
		(value.quietHours !== undefined &&
			value.quietHours !== null &&
			!isNotificationQuietHours(value.quietHours))
	)
		return null;
	return {
		requests:
			typeof value.requests === "boolean"
				? value.requests
				: (legacyNeedsAttention ?? true),
		problems:
			typeof value.problems === "boolean"
				? value.problems
				: (legacyNeedsAttention ?? true),
		workFinished: value.workFinished,
		detail: value.detail,
		completionMinimumMinutes:
			(value.completionMinimumMinutes as PushCompletionMinimumMinutes) ?? 0,
		quietHours:
			value.quietHours === undefined || value.quietHours === null
				? null
				: {
						timezone: value.quietHours.timezone,
						start: value.quietHours.start,
						end: value.quietHours.end,
						weekdays: [...value.quietHours.weekdays],
						allowRequests: value.quietHours.allowRequests,
						allowProblems: value.quietHours.allowProblems,
					},
	};
}

function normalizePreferencesPatch(
	value: unknown,
): Partial<PushNotificationPreferences> | null {
	if (!isRecord(value)) return null;
	const allowed = new Set([
		"requests",
		"problems",
		"workFinished",
		"detail",
		"completionMinimumMinutes",
		"quietHours",
		// Accept the removed camelCase field from stale callers, then discard it.
		"catchUpAfterPause",
	]);
	const keys = Object.keys(value);
	if (keys.length === 0 || keys.some((key) => !allowed.has(key))) return null;
	const normalized = normalizePreferences({ ...DEFAULT_PREFERENCES, ...value });
	if (!normalized) return null;
	return {
		...("requests" in value ? { requests: normalized.requests } : {}),
		...("problems" in value ? { problems: normalized.problems } : {}),
		...("workFinished" in value
			? { workFinished: normalized.workFinished }
			: {}),
		...("detail" in value ? { detail: normalized.detail } : {}),
		...("completionMinimumMinutes" in value
			? { completionMinimumMinutes: normalized.completionMinimumMinutes }
			: {}),
		...("quietHours" in value ? { quietHours: normalized.quietHours } : {}),
	};
}

function fromWirePreferences(
	preferences: WirePreferences,
): PushNotificationPreferences {
	return {
		requests: preferences.requests,
		problems: preferences.problems,
		workFinished: preferences.work_finished,
		detail: preferences.privacy,
		completionMinimumMinutes: preferences.completion_min_runtime_minutes,
		quietHours:
			preferences.quiet_hours === null
				? null
				: {
						timezone: preferences.quiet_hours.timezone,
						start: preferences.quiet_hours.start,
						end: preferences.quiet_hours.end,
						weekdays: preferences.quiet_hours.weekdays as PushIsoWeekday[],
						allowRequests: preferences.quiet_hours.allow_requests,
						allowProblems: preferences.quiet_hours.allow_problems,
					},
	};
}

function toWireQuietHours(
	quietHours: PushNotificationQuietHours | null,
): WirePushQuietHours | null {
	return quietHours === null
		? null
		: {
				timezone: quietHours.timezone,
				start: quietHours.start,
				end: quietHours.end,
				weekdays: [...quietHours.weekdays],
				allow_requests: quietHours.allowRequests,
				allow_problems: quietHours.allowProblems,
			};
}

function toWirePreferences(
	preferences: PushNotificationPreferences,
	pausedUntil: number | null,
	pausedIndefinitely: boolean,
): WirePreferences {
	return {
		requests: preferences.requests,
		problems: preferences.problems,
		work_finished: preferences.workFinished,
		privacy: preferences.detail,
		completion_min_runtime_minutes: preferences.completionMinimumMinutes,
		paused_until: pausedUntil,
		paused_indefinitely: pausedIndefinitely,
		quiet_hours: toWireQuietHours(preferences.quietHours),
	};
}

function toWirePreferencesPatch(
	preferences: Partial<PushNotificationPreferences>,
) {
	return {
		...(preferences.requests === undefined
			? {}
			: { requests: preferences.requests }),
		...(preferences.problems === undefined
			? {}
			: { problems: preferences.problems }),
		...(preferences.workFinished === undefined
			? {}
			: { work_finished: preferences.workFinished }),
		...(preferences.detail === undefined
			? {}
			: { privacy: preferences.detail }),
		...(preferences.completionMinimumMinutes === undefined
			? {}
			: {
					completion_min_runtime_minutes: preferences.completionMinimumMinutes,
				}),
		...(preferences.quietHours === undefined
			? {}
			: { quiet_hours: toWireQuietHours(preferences.quietHours) }),
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

function isStoredPushEndpoint(value: unknown): value is string {
	if (typeof value !== "string" || value.length === 0 || value.length > 4096)
		return false;
	try {
		const endpoint = new URL(value);
		return (
			endpoint.protocol === "https:" &&
			!endpoint.username &&
			!endpoint.password &&
			!endpoint.hash
		);
	} catch {
		return false;
	}
}

function loadStoredSubscriptionRepair(): Omit<
	PendingSubscriptionRepair,
	"owner"
> | null {
	if (typeof localStorage === "undefined") return null;
	try {
		const raw = localStorage.getItem(REPAIR_STORAGE_KEY);
		if (!raw) return null;
		const value: unknown = JSON.parse(raw);
		if (
			!isRecord(value) ||
			!isStoredPushEndpoint(value.oldEndpoint) ||
			(value.preferences !== null && !isWirePreferences(value.preferences)) ||
			(value.deviceName !== null && !isWireDeviceName(value.deviceName)) ||
			(value.preferences === null) !== (value.deviceName === null)
		)
			return null;
		return {
			oldEndpoint: value.oldEndpoint,
			preferences: value.preferences as WirePreferences | null,
			deviceName: value.deviceName as string | null,
		};
	} catch {
		return null;
	}
}

function storeSubscriptionRepair(
	repair: Omit<PendingSubscriptionRepair, "owner">,
): PendingSubscriptionRepair {
	const stored = { owner: navigator.serviceWorker, ...repair };
	pendingSubscriptionRepair = stored;
	try {
		localStorage.setItem(REPAIR_STORAGE_KEY, JSON.stringify(repair));
	} catch {
		// The in-memory handoff still protects the ordinary two-tap path.
	}
	return stored;
}

function clearSubscriptionRepair(): void {
	pendingSubscriptionRepair = null;
	try {
		localStorage.removeItem(REPAIR_STORAGE_KEY);
	} catch {
		// The successfully registered endpoint is already authoritative.
	}
}

async function cleanUpReplacedSubscription(
	repair: PendingSubscriptionRepair | null,
): Promise<void> {
	if (!repair) return;
	// A successful replacement POST atomically retires the old server row. Only
	// clear the durable handoff after that response has been validated.
	clearSubscriptionRepair();
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

/** Report whether this exact window is an installed standalone app client.
 * The worker uses the source client id to prefer the PWA over same-origin tabs
 * when a notification is tapped. */
export function reportPushClientPresentation(
	registration?: ServiceWorkerRegistration,
): void {
	if (typeof navigator === "undefined" || !("serviceWorker" in navigator))
		return;
	const standalone =
		(typeof window !== "undefined" &&
			window.matchMedia?.("(display-mode: standalone)").matches === true) ||
		(navigator as Navigator & { standalone?: boolean }).standalone === true;
	const worker =
		navigator.serviceWorker.controller ??
		registration?.active ??
		registration?.waiting ??
		registration?.installing;
	worker?.postMessage({
		type: "hlid:client-presentation",
		standalone,
	});
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
		pausedUntil: null,
		pausedIndefinitely: false,
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
	if (
		!isRecord(payload) ||
		payload.available !== true ||
		typeof payload.subscribed !== "boolean" ||
		(payload.preferences !== null && !isWirePreferences(payload.preferences)) ||
		(payload.device_name !== null && !isWireDeviceName(payload.device_name)) ||
		(payload.preferences === null) !== (payload.device_name === null) ||
		(payload.subscribed && payload.preferences === null)
	)
		throw new PushNotificationError(
			"request-failed",
			"Hlid returned an invalid notification status.",
		);
	return {
		subscribed: payload.subscribed,
		preferences: payload.preferences as WirePreferences | null,
		deviceName: payload.device_name as string | null,
	};
}

function browserState(
	permission: NotificationPermission,
	enabled: boolean,
	preferences: PushNotificationPreferences,
	reenableRequired = false,
	pausedUntil: number | null = null,
	pausedIndefinitely = false,
): PushNotificationState {
	return {
		supported: true,
		permission,
		enabled,
		...(reenableRequired ? { reenableRequired: true } : {}),
		preferences,
		pausedUntil,
		pausedIndefinitely,
	};
}

function secondsToMilliseconds(value: number | null): number | null {
	return value === null ? null : value * 1_000;
}

function millisecondsToSeconds(value: number | null): number | null {
	if (value === null) return null;
	if (!Number.isSafeInteger(value) || value < 0)
		throw new PushNotificationError(
			"request-failed",
			"The notification pause time is invalid.",
		);
	return Math.floor(value / 1_000);
}

function cachedPrerequisites(): PushEnablePrerequisites | null {
	const cached = cachedEnablePrerequisites;
	return cached?.owner === navigator.serviceWorker ? cached : null;
}

function cachedSubscriptionRepair(): PendingSubscriptionRepair | null {
	const pending = pendingSubscriptionRepair;
	if (pending?.owner === navigator.serviceWorker) return pending;
	const stored = loadStoredSubscriptionRepair();
	return stored ? storeSubscriptionRepair(stored) : null;
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
	const repair = cachedSubscriptionRepair();
	const authoritativePreferences =
		status?.preferences ?? repair?.preferences ?? null;
	const preferences = authoritativePreferences
		? fromWirePreferences(authoritativePreferences)
		: localPreferences;
	if (authoritativePreferences) storePreferences(preferences);
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
	return browserState(
		permission,
		enabled,
		preferences,
		reenableRequired,
		secondsToMilliseconds(authoritativePreferences?.paused_until ?? null),
		authoritativePreferences?.paused_indefinitely ?? false,
	);
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
	options: {
		preferences?: PushNotificationPreferences;
		pausedUntil?: number | null;
		pausedIndefinitely?: boolean;
		deviceName?: string;
		replacesEndpoint?: string;
	} = {},
): Promise<WirePreferences> {
	const payload: unknown = await pushRequest(() =>
		subscribeToPushFn({
			data: {
				subscription: serializeSubscription(subscription),
				...(options.preferences
					? {
							preferences: toWirePreferences(
								options.preferences,
								options.pausedUntil ?? null,
								options.pausedIndefinitely ?? false,
							),
						}
					: {}),
				...(options.deviceName ? { device_name: options.deviceName } : {}),
				...(options.replacesEndpoint &&
				isStoredPushEndpoint(options.replacesEndpoint) &&
				options.replacesEndpoint !== subscription.endpoint
					? { replaces_endpoint: options.replacesEndpoint }
					: {}),
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
	return payload.preferences;
}

function defaultPushDeviceName(): string {
	// Do not infer device capabilities from the user agent. The server retains
	// this name on later syncs, and the user can rename it from Forge.
	return "Hlid device";
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
	const repair = cachedSubscriptionRepair();
	const replaceExisting =
		subscription !== null &&
		(!applicationServerKeyMatches(subscription, applicationServerKey) ||
			(status?.subscribed !== true && repair === null));
	if (replaceExisting && subscription) {
		const replacedEndpoint = subscription.endpoint;
		const unsubscribed = await subscription.unsubscribe();
		if (unsubscribed === false)
			throw new PushNotificationError(
				"request-failed",
				"The old notification subscription could not be replaced.",
			);
		subscription = null;
		// A locally created replacement can survive a failed registration POST and
		// become visible again after reload. In that case the durable repair still
		// names the original server-owned endpoint. Never replace that handoff with
		// the server-unknown local endpoint or every retry will target the wrong row.
		if (!repair) {
			storeSubscriptionRepair({
				oldEndpoint: replacedEndpoint,
				preferences: status?.preferences ?? null,
				deviceName: status?.deviceName ?? null,
			});
		}
		storePrerequisites({
			config,
			registration,
			subscription: null,
			status: null,
		});
		setLocallyEnabled(true);
		throw new PushNotificationError(
			"repair-ready",
			"Old browser subscription removed. Tap Repair again to finish.",
		);
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
	const savedWire = await registerSubscription(subscription, {
		preferences: normalized,
		pausedUntil:
			repair?.preferences?.paused_until ??
			status?.preferences?.paused_until ??
			null,
		pausedIndefinitely:
			repair?.preferences?.paused_indefinitely ??
			status?.preferences?.paused_indefinitely ??
			false,
		...(repair
			? { deviceName: repair.deviceName ?? defaultPushDeviceName() }
			: status === null || status.preferences === null
				? { deviceName: defaultPushDeviceName() }
				: {}),
		...(repair ? { replacesEndpoint: repair.oldEndpoint } : {}),
	});
	const saved = fromWirePreferences(savedWire);
	await cleanUpReplacedSubscription(repair);
	storePreferences(saved);
	setLocallyEnabled(true);
	storePrerequisites({
		config,
		registration,
		subscription,
		status: {
			subscribed: true,
			preferences: savedWire,
			deviceName: repair?.deviceName ?? status?.deviceName ?? null,
		},
	});
	return browserState(
		permission,
		true,
		saved,
		false,
		secondsToMilliseconds(savedWire.paused_until),
		savedWire.paused_indefinitely,
	);
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
	const repair = cachedSubscriptionRepair();
	if (
		(status?.subscribed !== true && !repair) ||
		!applicationServerKeyMatches(subscription, applicationServerKey)
	)
		return browserState(permission, false, preferences, true);

	// Re-upload current key material for same-endpoint browser rotations, while
	// preserving the server's authoritative device preferences. Creating a new
	// PushSubscription is intentionally reserved for the next explicit tap.
	// Omit preferences and a device name during foreground reconciliation. The
	// server preserves its authoritative choices, including a pause and any user
	// rename, while refreshing rotated key material for this endpoint.
	const savedWire = await registerSubscription(subscription, {
		...(repair ? { replacesEndpoint: repair.oldEndpoint } : {}),
	});
	const saved = fromWirePreferences(savedWire);
	storePreferences(saved);
	setLocallyEnabled(true);
	await cleanUpReplacedSubscription(repair);
	storePrerequisites({
		config,
		registration,
		subscription,
		status: {
			subscribed: true,
			preferences: savedWire,
			deviceName: status?.deviceName ?? repair?.deviceName ?? null,
		},
	});
	return browserState(
		permission,
		true,
		saved,
		false,
		secondsToMilliseconds(savedWire.paused_until),
		savedWire.paused_indefinitely,
	);
}

/** Stop delivery and invalidate this browser's endpoint. Category/detail
 * choices remain local so re-enabling restores the user's previous choices. */
export async function disablePushNotifications(): Promise<PushNotificationState> {
	const support = getPushNotificationSupport();
	if (!support.supported)
		return unsupportedState(support.reason ?? "not-browser");
	const preferences = loadPreferences();
	const repair = cachedSubscriptionRepair();
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
					? { subscribed: false, preferences: null, deviceName: null }
					: cached.status,
			});
		}
	}
	if (repair)
		await removeServerSubscription(repair.oldEndpoint).catch(() => {});
	clearSubscriptionRepair();
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
				preferences: toWirePreferencesPatch(normalized),
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
	return browserState(
		permission,
		true,
		saved,
		false,
		secondsToMilliseconds(payload.preferences.paused_until),
		payload.preferences.paused_indefinitely,
	);
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

function isNullableTimestamp(value: unknown): value is number | null {
	return (
		value === null ||
		(Number.isSafeInteger(value) &&
			typeof value === "number" &&
			value >= 0 &&
			value <= MAX_SAFE_EPOCH_SECONDS)
	);
}

function isNullableString(value: unknown): value is string | null {
	return value === null || typeof value === "string";
}

function isNonnegativeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isPushNotificationCategory(
	value: unknown,
): value is PushNotificationCategory {
	return value === "request" || value === "problem" || value === "completion";
}

function isPushNotificationSourceKind(
	value: unknown,
): value is PushNotificationSourceKind {
	return value === "session" || value === "routine" || value === "system";
}

function isPushNotificationEventStatus(
	value: unknown,
): value is PushNotificationEventStatus {
	return (
		value === "pending" ||
		value === "deferred" ||
		value === "batched" ||
		value === "processed" ||
		value === "expired" ||
		value === "cancelled"
	);
}

function isPushNotificationDeliveryStatus(
	value: unknown,
): value is PushNotificationDeliveryStatus {
	return (
		value === "pending" ||
		value === "suppressed" ||
		value === "queued" ||
		value === "sent" ||
		value === "failed" ||
		value === "gone" ||
		value === "expired"
	);
}

function isWireNotificationEventSummary(
	value: unknown,
): value is WirePushNotificationEventSummary {
	return (
		isRecord(value) &&
		typeof value.id === "string" &&
		UUID_PATTERN.test(value.id) &&
		isPushNotificationSourceKind(value.source_kind) &&
		isValidSessionId(value.source_id) &&
		isPushNotificationCategory(value.category) &&
		isNullableString(value.reason) &&
		isNullableString(value.label) &&
		isNullableString(value.url) &&
		(value.runtime_ms === null || isNonnegativeInteger(value.runtime_ms)) &&
		isNonnegativeInteger(value.pending_count) &&
		isNullableTimestamp(value.occurred_at) &&
		value.occurred_at !== null &&
		isNullableTimestamp(value.expires_at) &&
		value.expires_at !== null &&
		isNullableString(value.group_key) &&
		isNullableString(value.batch_id) &&
		isPushNotificationEventStatus(value.status) &&
		isNullableString(value.status_reason) &&
		isNullableTimestamp(value.next_attempt_at)
	);
}

function isWireNotificationHistoryDelivery(value: unknown): boolean {
	return (
		isRecord(value) &&
		typeof value.id === "string" &&
		UUID_PATTERN.test(value.id) &&
		typeof value.device_id === "string" &&
		value.device_id.length > 0 &&
		isRecord(value.device) &&
		typeof value.device.id === "string" &&
		typeof value.device.name === "string" &&
		(value.device.privacy === "generic" ||
			value.device.privacy === "detailed") &&
		isPushNotificationDeliveryStatus(value.status) &&
		isNullableString(value.reason) &&
		isNullableTimestamp(value.next_attempt_at) &&
		isNonnegativeInteger(value.attempt_count) &&
		(value.provider_status === null ||
			isNonnegativeInteger(value.provider_status)) &&
		isNullableTimestamp(value.receipt_at) &&
		isNullableTimestamp(value.displayed_at) &&
		isNullableTimestamp(value.opened_at) &&
		isNullableTimestamp(value.dismissed_at) &&
		isNullableTimestamp(value.created_at) &&
		value.created_at !== null &&
		isNullableTimestamp(value.updated_at) &&
		value.updated_at !== null
	);
}

function isWireNotificationHistoryEvent(
	value: unknown,
): value is WirePushNotificationHistoryEvent {
	if (!isRecord(value)) return false;
	const deliveries = value.deliveries;
	return (
		isWireNotificationEventSummary(value) &&
		Array.isArray(deliveries) &&
		deliveries.every(isWireNotificationHistoryDelivery)
	);
}

function isWireNotificationBatch(
	value: unknown,
): value is WirePushNotificationBatch {
	return (
		isRecord(value) &&
		typeof value.id === "string" &&
		/^[A-Za-z0-9_-]{8,64}$/.test(value.id) &&
		isPushNotificationCategory(value.category) &&
		isNullableString(value.group_key) &&
		(value.status === "open" ||
			value.status === "ready" ||
			value.status === "sent" ||
			value.status === "read" ||
			value.status === "expired") &&
		isNullableTimestamp(value.created_at) &&
		value.created_at !== null &&
		isNullableTimestamp(value.updated_at) &&
		value.updated_at !== null &&
		isNullableTimestamp(value.sent_at) &&
		isNullableTimestamp(value.read_at)
	);
}

function isWireNotificationBatchMember(
	value: unknown,
): value is WirePushNotificationBatchMember {
	return (
		isRecord(value) &&
		typeof value.event_id === "string" &&
		UUID_PATTERN.test(value.event_id) &&
		isValidSessionId(value.session_id) &&
		isNonnegativeInteger(value.position) &&
		isNullableTimestamp(value.added_at) &&
		value.added_at !== null &&
		isNullableTimestamp(value.read_at) &&
		(value.event === null || isWireNotificationEventSummary(value.event))
	);
}

function fromWireNotificationEventSummary(
	event: WirePushNotificationEventSummary,
): PushNotificationEventSummary {
	return {
		id: event.id,
		sourceKind: event.source_kind,
		sourceId: event.source_id,
		category: event.category,
		reason: event.reason,
		label: event.label,
		url: event.url,
		runtimeMs: event.runtime_ms,
		pendingCount: event.pending_count,
		occurredAt: event.occurred_at,
		expiresAt: event.expires_at,
		groupKey: event.group_key,
		batchId: event.batch_id,
		status: event.status,
		statusReason: event.status_reason,
		nextAttemptAt: event.next_attempt_at,
	};
}

function fromWireNotificationHistoryEvent(
	event: WirePushNotificationHistoryEvent,
): PushNotificationHistoryEvent {
	return {
		...fromWireNotificationEventSummary(event),
		deliveries: event.deliveries.map((delivery) => ({
			id: delivery.id,
			deviceId: delivery.device_id,
			device: {
				id: delivery.device.id,
				name: delivery.device.name,
				privacy: delivery.device.privacy,
			},
			status: delivery.status,
			reason: delivery.reason,
			nextAttemptAt: delivery.next_attempt_at,
			attemptCount: delivery.attempt_count,
			providerStatus: delivery.provider_status,
			receiptAt: delivery.receipt_at,
			displayedAt: delivery.displayed_at,
			openedAt: delivery.opened_at,
			dismissedAt: delivery.dismissed_at,
			createdAt: delivery.created_at,
			updatedAt: delivery.updated_at,
		})),
	};
}

function isWirePushDevice(value: unknown): value is WirePushDevice {
	return (
		isRecord(value) &&
		typeof value.id === "string" &&
		UUID_PATTERN.test(value.id) &&
		isWireDeviceName(value.name) &&
		typeof value.current === "boolean" &&
		typeof value.enabled === "boolean" &&
		isWirePreferences(value.preferences) &&
		isNullableTimestamp(value.paused_until) &&
		typeof value.paused_indefinitely === "boolean" &&
		isNullableTimestamp(value.created_at) &&
		value.created_at !== null &&
		isNullableTimestamp(value.updated_at) &&
		value.updated_at !== null &&
		isNullableTimestamp(value.last_success_at) &&
		isNullableTimestamp(value.last_failure_at) &&
		Number.isSafeInteger(value.failure_count) &&
		typeof value.failure_count === "number" &&
		value.failure_count >= 0
	);
}

function fromWirePushDevice(device: WirePushDevice): PushNotificationDevice {
	return {
		id: device.id,
		name: device.name,
		current: device.current,
		enabled: device.enabled,
		createdAt: device.created_at * 1_000,
		lastSeenAt: device.updated_at * 1_000,
		pausedUntil: secondsToMilliseconds(device.paused_until),
		pausedIndefinitely: device.paused_indefinitely,
		preferences: fromWirePreferences(device.preferences),
		lastAcceptedAt: secondsToMilliseconds(device.last_success_at),
		lastFailureAt: secondsToMilliseconds(device.last_failure_at),
		lastFailureMessage: null,
		failureCount: device.failure_count,
	};
}

async function currentPushSubscription(): Promise<PushSubscription | null> {
	if (typeof navigator === "undefined" || !("serviceWorker" in navigator))
		return null;
	const registration = await existingRegistration();
	return (await registration?.pushManager.getSubscription()) ?? null;
}

async function requireCurrentPushSubscription(): Promise<PushSubscription> {
	const subscription = await currentPushSubscription();
	if (!subscription)
		throw new PushNotificationError(
			"subscription-invalid",
			"This device does not have an active notification subscription.",
		);
	return subscription;
}

async function loadPushNotificationDevices(): Promise<
	PushNotificationDevice[]
> {
	const subscription = await currentPushSubscription().catch(() => null);
	const payload: unknown = await pushRequest(() =>
		listPushDevicesFn({
			data: subscription ? { endpoint: subscription.endpoint } : {},
		}),
	);
	if (
		!isRecord(payload) ||
		!Array.isArray(payload.devices) ||
		!payload.devices.every(isWirePushDevice) ||
		new Set(payload.devices.map((device) => device.id)).size !==
			payload.devices.length ||
		payload.devices.filter((device) => device.current).length > 1
	)
		throw new PushNotificationError(
			"request-failed",
			"Hlid returned invalid notification devices.",
		);
	return payload.devices.map(fromWirePushDevice);
}

/** List this installation's subscriptions without exposing push endpoints or
 * encryption material to the browser. */
export async function getPushNotificationDevices(): Promise<
	PushNotificationDevice[]
> {
	return loadPushNotificationDevices();
}

export async function renamePushNotificationDevice(
	id: string,
	name: string,
): Promise<PushNotificationDevice> {
	return updatePushNotificationDevice(id, { name });
}

export async function updatePushNotificationDevice(
	id: string,
	patch: PushNotificationDevicePatch,
): Promise<PushNotificationDevice> {
	const name = patch.name?.trim();
	const preferences =
		patch.preferences === undefined
			? undefined
			: normalizePreferencesPatch(patch.preferences);
	if (preferences === null)
		throw new PushNotificationError(
			"request-failed",
			"The notification device update is invalid.",
		);
	if (
		!UUID_PATTERN.test(id) ||
		(name !== undefined && !isWireDeviceName(name)) ||
		(name === undefined && preferences === undefined)
	)
		throw new PushNotificationError(
			"request-failed",
			"The notification device update is invalid.",
		);
	const subscription = await currentPushSubscription().catch(() => null);
	const payload: unknown = await pushRequest(() =>
		updatePushDeviceFn({
			data: {
				id,
				...(name === undefined ? {} : { name }),
				...(preferences === undefined
					? {}
					: { preferences: toWirePreferencesPatch(preferences) }),
				...(subscription ? { endpoint: subscription.endpoint } : {}),
			},
		}),
	);
	if (
		!isRecord(payload) ||
		payload.ok !== true ||
		!isWirePushDevice(payload.device) ||
		payload.device.id !== id
	)
		throw new PushNotificationError(
			"request-failed",
			"Hlid returned an invalid notification device.",
		);
	return fromWirePushDevice(payload.device);
}

export async function revokePushNotificationDevice(
	id: string,
): Promise<boolean> {
	if (!UUID_PATTERN.test(id))
		throw new PushNotificationError(
			"request-failed",
			"The notification device is invalid.",
		);
	const devices = await loadPushNotificationDevices();
	const current = devices.find((device) => device.id === id)?.current === true;
	const payload: unknown = await pushRequest(() =>
		deletePushDeviceFn({ data: { id } }),
	);
	if (
		!isRecord(payload) ||
		payload.ok !== true ||
		typeof payload.removed !== "boolean"
	)
		throw new PushNotificationError(
			"request-failed",
			"Hlid returned an invalid device revocation result.",
		);
	if (current && payload.removed) {
		const repair = cachedSubscriptionRepair();
		const subscription = await currentPushSubscription().catch(() => null);
		await subscription?.unsubscribe().catch(() => false);
		setLocallyEnabled(false);
		const cached = cachedPrerequisites();
		if (cached) {
			const { owner: _owner, ...prerequisites } = cached;
			storePrerequisites({
				...prerequisites,
				subscription: null,
				status: {
					subscribed: false,
					preferences: null,
					deviceName: null,
				},
			});
		}
		if (repair) {
			await removeServerSubscription(repair.oldEndpoint)
				.then(clearSubscriptionRepair)
				.catch(() => {});
		}
	}
	return payload.removed;
}

export async function sendTestPushNotification(
	scenario: PushNotificationTestScenario = "delivery",
): Promise<PushNotificationTestResult> {
	const subscription = await requireCurrentPushSubscription();
	const payload: unknown = await pushRequest(() =>
		sendTestPushNotificationFn({
			data: { endpoint: subscription.endpoint, scenario },
		}),
	);
	if (
		!isRecord(payload) ||
		typeof payload.accepted !== "boolean" ||
		!isNullableTimestamp(payload.accepted_at) ||
		!isNullableTimestamp(payload.failure_at) ||
		!Number.isSafeInteger(payload.failure_count) ||
		typeof payload.failure_count !== "number" ||
		payload.failure_count < 0 ||
		typeof payload.subscription_removed !== "boolean" ||
		(payload.accepted
			? payload.accepted_at === null ||
				payload.failure_at !== null ||
				payload.failure_count !== 0 ||
				payload.subscription_removed
			: payload.accepted_at !== null || payload.failure_at === null)
	)
		throw new PushNotificationError(
			"request-failed",
			"Hlid returned an invalid test notification result.",
		);
	if (payload.subscription_removed) setLocallyEnabled(false);
	return {
		accepted: payload.accepted,
		acceptedAt: secondsToMilliseconds(payload.accepted_at),
		failureAt: secondsToMilliseconds(payload.failure_at),
		failureCount: payload.failure_count,
		subscriptionRemoved: payload.subscription_removed,
	};
}

/** Pause or resume only the current subscription. Public timestamps are epoch
 * milliseconds; the internal API stores epoch seconds. */
export async function pausePushNotifications(
	until: number | "indefinite" | null,
): Promise<PushNotificationState> {
	const subscription = await requireCurrentPushSubscription();
	const pausedIndefinitely = until === "indefinite";
	const pausedUntilSeconds = millisecondsToSeconds(
		typeof until === "number" ? until : null,
	);
	const payload: unknown = await pushRequest(() =>
		updatePushPreferencesFn({
			data: {
				endpoint: subscription.endpoint,
				preferences: {
					paused_until: pausedUntilSeconds,
					paused_indefinitely: pausedIndefinitely,
				},
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
			"Hlid returned an invalid notification pause.",
		);
	const preferences = fromWirePreferences(payload.preferences);
	storePreferences(preferences);
	return browserState(
		Notification.permission,
		true,
		preferences,
		false,
		secondsToMilliseconds(payload.preferences.paused_until),
		payload.preferences.paused_indefinitely,
	);
}

export async function getPushNotificationHistory(
	limit = 20,
): Promise<PushNotificationHistoryEvent[]> {
	if (!Number.isInteger(limit) || limit < 1 || limit > 100)
		throw new PushNotificationError(
			"request-failed",
			"The notification history limit is invalid.",
		);
	const payload: unknown = await pushRequest(() =>
		getPushNotificationHistoryFn({ data: limit }),
	);
	if (
		!isRecord(payload) ||
		!Array.isArray(payload.events) ||
		!payload.events.every(isWireNotificationHistoryEvent)
	)
		throw new PushNotificationError(
			"request-failed",
			"Hlid returned invalid notification history.",
		);
	return payload.events.map(fromWireNotificationHistoryEvent);
}

export async function getPushNotificationBatch(
	batchId: string,
): Promise<PushNotificationBatchState> {
	if (!/^[A-Za-z0-9_-]{8,64}$/.test(batchId))
		throw new PushNotificationError(
			"request-failed",
			"The notification batch identifier is invalid.",
		);
	const payload: unknown = await pushRequest(() =>
		getPushNotificationBatchFn({ data: batchId }),
	);
	if (
		!isRecord(payload) ||
		!isWireNotificationBatch(payload.batch) ||
		payload.batch.id !== batchId ||
		!Array.isArray(payload.members) ||
		!payload.members.every(isWireNotificationBatchMember) ||
		new Set(payload.members.map((member) => member.event_id)).size !==
			payload.members.length ||
		new Set(payload.members.map((member) => member.session_id)).size !==
			payload.members.length
	)
		throw new PushNotificationError(
			"request-failed",
			"Hlid returned an invalid notification batch.",
		);
	return {
		batch: {
			id: payload.batch.id,
			category: payload.batch.category,
			groupKey: payload.batch.group_key,
			status: payload.batch.status,
			createdAt: payload.batch.created_at,
			updatedAt: payload.batch.updated_at,
			sentAt: payload.batch.sent_at,
			readAt: payload.batch.read_at,
		},
		members: payload.members
			.map((member) => ({
				eventId: member.event_id,
				sessionId: member.session_id,
				position: member.position,
				addedAt: member.added_at,
				readAt: member.read_at,
				event: member.event
					? fromWireNotificationEventSummary(member.event)
					: null,
			}))
			.sort(
				(left, right) =>
					left.position - right.position ||
					left.eventId.localeCompare(right.eventId),
			),
	};
}

export async function markPushNotificationBatchRead(
	batchId: string,
	sessionId?: string,
): Promise<number> {
	if (!/^[A-Za-z0-9_-]{8,64}$/.test(batchId))
		throw new PushNotificationError(
			"request-failed",
			"The notification batch identifier is invalid.",
		);
	if (sessionId !== undefined) assertSessionId(sessionId);
	const payload: unknown = await pushRequest(() =>
		markPushNotificationBatchReadFn({
			data: {
				batch_id: batchId,
				...(sessionId === undefined ? {} : { session_id: sessionId }),
			},
		}),
	);
	if (
		!isRecord(payload) ||
		payload.ok !== true ||
		!isNonnegativeInteger(payload.read_at)
	)
		throw new PushNotificationError(
			"request-failed",
			"Hlid returned an invalid notification read state.",
		);
	return payload.read_at;
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

/** Recalculate the progressive app badge from the notifications the browser is
 * still displaying. This is deliberately local: the worker owns the only
 * honest unread count, and unsupported badge APIs are ignored there. */
export async function reconcilePushNotificationBadge(): Promise<void> {
	try {
		if (typeof navigator === "undefined" || !("serviceWorker" in navigator))
			return;
		const registration = await existingRegistration();
		const worker =
			registration?.active ?? registration?.waiting ?? registration?.installing;
		worker?.postMessage({ type: "hlid:reconcile-notification-badge" });
	} catch {
		// Badging is optional and must never disrupt app foregrounding.
	}
}

function isSessionNotificationMode(
	value: unknown,
): value is SessionNotificationMode {
	return (
		value === "default" ||
		value === "notify" ||
		value === "notify_once" ||
		value === "notify_completion_once" ||
		value === "mute"
	);
}

function isSessionNotificationScope(
	value: unknown,
): value is SessionNotificationScope {
	return value === "session" || value === "delegation_tree";
}

function isValidSessionId(value: unknown): value is string {
	if (typeof value !== "string") return false;
	try {
		assertSessionId(value);
		return true;
	} catch {
		return false;
	}
}

function isWireTargetDeviceIds(value: unknown): value is string[] | null {
	return (
		value === null ||
		(Array.isArray(value) &&
			value.length <= 32 &&
			value.every(
				(id): id is string => typeof id === "string" && UUID_PATTERN.test(id),
			) &&
			new Set(value).size === value.length)
	);
}

function isWireSessionNotificationPolicy(
	value: unknown,
): value is WireSessionNotificationPolicy {
	return (
		isRecord(value) &&
		isValidSessionId(value.session_id) &&
		isSessionNotificationMode(value.mode) &&
		value.mode !== "default" &&
		isSessionNotificationScope(value.scope) &&
		isWireTargetDeviceIds(value.target_device_ids) &&
		isNullableTimestamp(value.updated_at) &&
		value.updated_at !== null
	);
}

function isWireEffectiveSessionNotificationPolicy(
	value: unknown,
): value is WireEffectiveSessionNotificationPolicy {
	return (
		isRecord(value) &&
		isValidSessionId(value.requested_session_id) &&
		(value.source_session_id === null ||
			isValidSessionId(value.source_session_id)) &&
		isSessionNotificationMode(value.mode) &&
		isSessionNotificationScope(value.scope) &&
		isWireTargetDeviceIds(value.target_device_ids) &&
		typeof value.inherited === "boolean"
	);
}

function fromWireSessionNotificationPolicy(
	policy: WireSessionNotificationPolicy,
): SessionNotificationPolicy {
	return {
		sessionId: policy.session_id,
		mode: policy.mode,
		scope: policy.scope,
		targetDeviceIds:
			policy.target_device_ids === null ? null : [...policy.target_device_ids],
		updatedAt: policy.updated_at * 1_000,
	};
}

function fromWireEffectiveSessionNotificationPolicy(
	policy: WireEffectiveSessionNotificationPolicy,
): EffectiveSessionNotificationPolicy {
	return {
		requestedSessionId: policy.requested_session_id,
		sourceSessionId: policy.source_session_id,
		mode: policy.mode,
		scope: policy.scope,
		targetDeviceIds:
			policy.target_device_ids === null ? null : [...policy.target_device_ids],
		inherited: policy.inherited,
	};
}

function parseSessionNotificationPolicyState(
	payload: unknown,
	sessionId: string,
): SessionNotificationPolicyState {
	if (
		!isRecord(payload) ||
		(payload.policy !== null &&
			!isWireSessionNotificationPolicy(payload.policy)) ||
		!isWireEffectiveSessionNotificationPolicy(payload.effective) ||
		(payload.policy !== null && payload.policy.session_id !== sessionId) ||
		payload.effective.requested_session_id !== sessionId
	)
		throw new PushNotificationError(
			"request-failed",
			"Hlid returned an invalid session notification policy.",
		);
	return {
		policy:
			payload.policy === null
				? null
				: fromWireSessionNotificationPolicy(payload.policy),
		effective: fromWireEffectiveSessionNotificationPolicy(payload.effective),
	};
}

export async function getSessionNotificationOverride(
	sessionId: string,
): Promise<SessionNotificationPolicyState> {
	assertSessionId(sessionId);
	const payload: unknown = await pushRequest(() =>
		getSessionNotificationOverrideFn({ data: sessionId }),
	);
	return parseSessionNotificationPolicyState(payload, sessionId);
}

export async function setSessionNotificationOverride(
	sessionId: string,
	update: SessionNotificationPolicyUpdate,
): Promise<SessionNotificationPolicyState> {
	assertSessionId(sessionId);
	if (
		!isSessionNotificationMode(update.mode) ||
		!isSessionNotificationScope(update.scope) ||
		!isWireTargetDeviceIds(update.targetDeviceIds) ||
		(update.targetDeviceIds !== null && update.targetDeviceIds.length === 0)
	)
		throw new PushNotificationError(
			"request-failed",
			"The session notification policy is invalid.",
		);
	const payload: unknown = await pushRequest(() =>
		setSessionNotificationOverrideFn({
			data: {
				session_id: sessionId,
				mode: update.mode,
				scope: update.scope,
				target_device_ids: update.targetDeviceIds,
			},
		}),
	);
	if (!isRecord(payload) || payload.ok !== true)
		throw new PushNotificationError(
			"request-failed",
			"Hlid returned an invalid session notification policy.",
		);
	return parseSessionNotificationPolicyState(payload, sessionId);
}
