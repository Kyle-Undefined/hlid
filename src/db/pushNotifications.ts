import { randomUUID } from "node:crypto";
import type {
	BrowserPushSubscription,
	PushNotificationCategory,
	PushNotificationDeliveryState,
	PushNotificationDeliveryStatus,
	PushNotificationEventStatus,
	PushNotificationEventSummary,
	PushNotificationSourceKind,
	PushPreferences,
	PushPreferencesPatch,
	PushQuietHours,
	SessionNotificationMode,
	SessionNotificationScope,
	WebPushNotificationPayload,
} from "../lib/pushNotificationSchemas";
import {
	DEFAULT_PUSH_PREFERENCES,
	pushNotificationBatchIdSchema,
	pushPreferencesInputSchema,
	pushPreferencesSchema,
	pushQuietHoursSchema,
	pushTargetDeviceIdsSchema,
	sessionNotificationModeSchema,
	sessionNotificationScopeSchema,
} from "../lib/pushNotificationSchemas";
import type { Db } from "./schema";
import { getDb } from "./schema";

export const MAX_PUSH_SUBSCRIPTION_DEVICES = 32;

type PushSubscriptionDbRow = {
	id: string;
	auth_session_hash: string | null;
	endpoint: string;
	p256dh: string;
	auth: string;
	expiration_time_ms: number | null;
	requests: number;
	problems: number;
	work_finished: number;
	privacy: PushPreferences["privacy"];
	completion_min_runtime_minutes: PushPreferences["completion_min_runtime_minutes"];
	paused_until: number | null;
	paused_indefinitely: number;
	quiet_hours_json: string | null;
	device_name: string;
	enabled: number;
	created_at: number;
	updated_at: number;
	last_success_at: number | null;
	last_failure_at: number | null;
	failure_count: number;
};

export type StoredPushSubscription = {
	id: string;
	authSessionHash: string | null;
	endpoint: string;
	keys: { p256dh: string; auth: string };
	expirationTime: number | null;
	name: string;
	preferences: PushPreferences;
	enabled: boolean;
	createdAt: number;
	updatedAt: number;
	lastSuccessAt: number | null;
	lastFailureAt: number | null;
	failureCount: number;
};

export type PushSubscriptionDevice = {
	id: string;
	name: string;
	current: boolean;
	enabled: boolean;
	preferences: PushPreferences;
	pausedUntil: number | null;
	pausedIndefinitely: boolean;
	createdAt: number;
	updatedAt: number;
	lastSuccessAt: number | null;
	lastFailureAt: number | null;
	failureCount: number;
};

export type PushSubscriptionDevicePatch = {
	name?: string;
	preferences?: PushPreferencesPatch;
};

const CORRUPT_QUIET_HOURS: PushQuietHours = Object.freeze({
	timezone: "UTC",
	start: "00:00",
	end: "00:00",
	weekdays: [1, 2, 3, 4, 5, 6, 7],
	allow_requests: false,
	allow_problems: false,
});

function parseQuietHours(value: string | null): PushQuietHours | null {
	if (value === null) return null;
	try {
		const candidate = JSON.parse(value) as unknown;
		if (
			typeof candidate === "object" &&
			candidate !== null &&
			!Array.isArray(candidate)
		) {
			// Pre-removal profiles carried catch_up inside this JSON object. Treat
			// it as inert input while preserving the actual quiet-hours schedule.
			delete (candidate as Record<string, unknown>).catch_up;
		}
		const parsed = pushQuietHoursSchema.safeParse(candidate);
		return parsed.success ? parsed.data : CORRUPT_QUIET_HOURS;
	} catch {
		return CORRUPT_QUIET_HOURS;
	}
}

function preferencesFromRow(row: PushSubscriptionDbRow): PushPreferences {
	return pushPreferencesSchema.parse({
		requests: row.requests === 1,
		problems: row.problems === 1,
		work_finished: row.work_finished === 1,
		privacy: row.privacy,
		completion_min_runtime_minutes: row.completion_min_runtime_minutes,
		paused_until: row.paused_until,
		paused_indefinitely: row.paused_indefinitely === 1,
		quiet_hours: parseQuietHours(row.quiet_hours_json),
	});
}

function storedSubscription(
	row: PushSubscriptionDbRow,
): StoredPushSubscription {
	return {
		id: row.id,
		authSessionHash: row.auth_session_hash,
		endpoint: row.endpoint,
		keys: { p256dh: row.p256dh, auth: row.auth },
		expirationTime: row.expiration_time_ms,
		name: row.device_name,
		preferences: preferencesFromRow(row),
		enabled: row.enabled === 1,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
		lastSuccessAt: row.last_success_at,
		lastFailureAt: row.last_failure_at,
		failureCount: row.failure_count,
	};
}

function deviceSummary(
	row: PushSubscriptionDbRow,
	currentEndpoint?: string,
): PushSubscriptionDevice {
	return {
		id: row.id,
		name: row.device_name,
		current: row.endpoint === currentEndpoint,
		enabled: row.enabled === 1,
		preferences: preferencesFromRow(row),
		pausedUntil: row.paused_until,
		pausedIndefinitely: row.paused_indefinitely === 1,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
		lastSuccessAt: row.last_success_at,
		lastFailureAt: row.last_failure_at,
		failureCount: row.failure_count,
	};
}

const SUBSCRIPTION_COLUMNS = `
	id, auth_session_hash, endpoint, p256dh, auth, expiration_time_ms,
	requests, problems, work_finished, privacy, completion_min_runtime_minutes,
		paused_until, paused_indefinitely, quiet_hours_json,
		device_name, enabled, created_at, updated_at,
	last_success_at, last_failure_at, failure_count
`;

const DELIVERABLE_SUBSCRIPTION_COLUMNS = `
	subscription.id, subscription.auth_session_hash, subscription.endpoint,
	subscription.p256dh, subscription.auth, subscription.expiration_time_ms,
	subscription.requests, subscription.problems, subscription.work_finished,
	subscription.privacy, subscription.completion_min_runtime_minutes,
	subscription.paused_until, subscription.paused_indefinitely,
	subscription.quiet_hours_json,
	subscription.device_name, subscription.enabled,
	subscription.created_at, subscription.updated_at,
	subscription.last_success_at, subscription.last_failure_at,
	subscription.failure_count
`;

function normalizedDefaultDeviceName(value: string | null | undefined): string {
	const cleaned = Array.from(value ?? "", (character) => {
		const code = character.charCodeAt(0);
		return code <= 31 || code === 127 ? " " : character;
	})
		.join("")
		.replace(/\s+/g, " ")
		.trim();
	return (cleaned || "Subscribed device").slice(0, 80);
}

async function requireValidAuthSession(authSessionHash: string) {
	const db = await getDb();
	const owner = db
		.query<{ token_hash: string; device_label: string | null }, [string]>(
			`SELECT token_hash, device_label FROM auth_sessions
			 WHERE token_hash = ? AND expires_at > unixepoch()`,
		)
		.get(authSessionHash);
	if (!owner) throw new Error("Authenticated browser session expired");
	return owner;
}

export async function getPushSubscription(
	endpoint: string,
	authSessionHash?: string,
	nowMs = Date.now(),
): Promise<StoredPushSubscription | null> {
	const db = await getDb();
	const row = authSessionHash
		? db
				.query<PushSubscriptionDbRow, [string, string]>(
					`SELECT ${SUBSCRIPTION_COLUMNS}
					 FROM push_subscriptions subscription
					 WHERE endpoint = ? AND auth_session_hash = ?
					   AND EXISTS (
					     SELECT 1 FROM auth_sessions owner
					     WHERE owner.token_hash = subscription.auth_session_hash
					       AND owner.expires_at > unixepoch()
					   )`,
				)
				.get(endpoint, authSessionHash)
		: db
				.query<PushSubscriptionDbRow, [string]>(
					`SELECT ${SUBSCRIPTION_COLUMNS}
					 FROM push_subscriptions WHERE endpoint = ?`,
				)
				.get(endpoint);
	if (!row) return null;
	if (
		row.enabled === 1 &&
		row.expiration_time_ms !== null &&
		row.expiration_time_ms <= nowMs
	) {
		db.run(
			`UPDATE push_subscriptions
			 SET enabled = 0, updated_at = unixepoch()
			 WHERE id = ? AND enabled = 1`,
			[row.id],
		);
		row.enabled = 0;
	}
	return storedSubscription(row);
}

/** Register or rotate this browser endpoint without resetting omitted choices. */
export async function upsertPushSubscription(
	subscription: BrowserPushSubscription,
	authSessionHash: string,
	preferences?: PushPreferences,
	deviceName?: string,
	replacesEndpoint?: string,
): Promise<StoredPushSubscription> {
	const db = await getDb();
	const owner = await requireValidAuthSession(authSessionHash);
	const endpointOwner = db
		.query<{ id: string; auth_session_hash: string | null }, [string]>(
			`SELECT id, auth_session_hash FROM push_subscriptions WHERE endpoint = ?`,
		)
		.get(subscription.endpoint);
	if (
		endpointOwner?.auth_session_hash !== null &&
		endpointOwner?.auth_session_hash !== undefined &&
		endpointOwner.auth_session_hash !== authSessionHash
	) {
		throw new Error("Push endpoint is already registered to another browser");
	}
	let replaced: StoredPushSubscription | null = null;
	if (replacesEndpoint && replacesEndpoint !== subscription.endpoint) {
		replaced = await getPushSubscription(replacesEndpoint, authSessionHash);
	}
	if (!endpointOwner && !replaced) {
		const owned = db
			.query<{ endpoint: string }, [string]>(
				`SELECT endpoint FROM push_subscriptions
				 WHERE auth_session_hash = ? ORDER BY created_at, id LIMIT 2`,
			)
			.all(authSessionHash);
		if (owned.length === 1 && owned[0]) {
			replaced = await getPushSubscription(owned[0].endpoint, authSessionHash);
		} else if (owned.length > 1) {
			throw new Error("Push subscription replacement is ambiguous");
		}
	}
	if (replaced && replaced.endpoint !== subscription.endpoint) {
		if (endpointOwner && endpointOwner.id !== replaced.id) {
			throw new Error("Replacement Push endpoint is already registered");
		}
		const selected = pushPreferencesSchema.parse(
			preferences ?? replaced.preferences,
		);
		const selectedName = normalizedDefaultDeviceName(
			deviceName ?? replaced.name,
		);
		db.run(
			`UPDATE push_subscriptions
			 SET endpoint = ?, p256dh = ?, auth = ?, expiration_time_ms = ?,
			     requests = ?, problems = ?, needs_attention = ?, work_finished = ?,
			     privacy = ?, completion_min_runtime_minutes = ?, paused_until = ?,
			     paused_indefinitely = ?, quiet_hours_json = ?,
			     device_name = ?,
			     enabled = 1, last_success_at = NULL, last_failure_at = NULL,
			     failure_count = 0, updated_at = unixepoch()
			 WHERE id = ? AND auth_session_hash = ?`,
			[
				subscription.endpoint,
				subscription.keys.p256dh,
				subscription.keys.auth,
				subscription.expirationTime ?? null,
				selected.requests ? 1 : 0,
				selected.problems ? 1 : 0,
				selected.requests || selected.problems ? 1 : 0,
				selected.work_finished ? 1 : 0,
				selected.privacy,
				selected.completion_min_runtime_minutes,
				selected.paused_until,
				selected.paused_indefinitely ? 1 : 0,
				selected.quiet_hours === null
					? null
					: JSON.stringify(selected.quiet_hours),
				selectedName,
				replaced.id,
				authSessionHash,
			],
		);
		const rotated = await getPushSubscription(
			subscription.endpoint,
			authSessionHash,
		);
		if (!rotated || rotated.id !== replaced.id) {
			throw new Error("Push subscription rotation was not persisted");
		}
		return rotated;
	}
	if (!endpointOwner) {
		const count =
			db
				.query<{ count: number }, []>(
					`SELECT COUNT(*) AS count FROM push_subscriptions`,
				)
				.get()?.count ?? 0;
		if (count >= MAX_PUSH_SUBSCRIPTION_DEVICES) {
			throw new Error(
				`At most ${MAX_PUSH_SUBSCRIPTION_DEVICES} notification devices can be retained`,
			);
		}
	}
	const expirationTime = subscription.expirationTime ?? null;
	const initialName = normalizedDefaultDeviceName(
		deviceName ?? owner.device_label,
	);
	const selected = pushPreferencesSchema.parse(
		preferences ?? DEFAULT_PUSH_PREFERENCES,
	);
	if (preferences) {
		db.run(
			`INSERT INTO push_subscriptions (
				id, auth_session_hash, endpoint, p256dh, auth, expiration_time_ms,
				requests, problems, needs_attention, work_finished, privacy,
				completion_min_runtime_minutes, paused_until, paused_indefinitely,
				quiet_hours_json,
				device_name
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(endpoint) DO UPDATE SET
				auth_session_hash = excluded.auth_session_hash,
				p256dh = excluded.p256dh,
				auth = excluded.auth,
				expiration_time_ms = excluded.expiration_time_ms,
				requests = excluded.requests,
				problems = excluded.problems,
				needs_attention = excluded.needs_attention,
				work_finished = excluded.work_finished,
				privacy = excluded.privacy,
				completion_min_runtime_minutes = excluded.completion_min_runtime_minutes,
				paused_until = excluded.paused_until,
				paused_indefinitely = excluded.paused_indefinitely,
				quiet_hours_json = excluded.quiet_hours_json,
				device_name = CASE WHEN ? IS NULL THEN device_name ELSE excluded.device_name END,
				enabled = 1,
				updated_at = unixepoch()`,
			[
				randomUUID(),
				authSessionHash,
				subscription.endpoint,
				subscription.keys.p256dh,
				subscription.keys.auth,
				expirationTime,
				selected.requests ? 1 : 0,
				selected.problems ? 1 : 0,
				selected.requests || selected.problems ? 1 : 0,
				selected.work_finished ? 1 : 0,
				selected.privacy,
				selected.completion_min_runtime_minutes,
				selected.paused_until,
				selected.paused_indefinitely ? 1 : 0,
				selected.quiet_hours === null
					? null
					: JSON.stringify(selected.quiet_hours),
				initialName.slice(0, 80),
				deviceName ?? null,
			],
		);
	} else {
		db.run(
			`INSERT INTO push_subscriptions (
				id, auth_session_hash, endpoint, p256dh, auth, expiration_time_ms,
				requests, problems, needs_attention, work_finished, privacy,
				completion_min_runtime_minutes, paused_until, paused_indefinitely,
				quiet_hours_json,
				device_name
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(endpoint) DO UPDATE SET
				auth_session_hash = excluded.auth_session_hash,
				p256dh = excluded.p256dh,
				auth = excluded.auth,
				expiration_time_ms = excluded.expiration_time_ms,
				device_name = CASE WHEN ? IS NULL THEN device_name ELSE excluded.device_name END,
				enabled = 1,
				updated_at = unixepoch()`,
			[
				randomUUID(),
				authSessionHash,
				subscription.endpoint,
				subscription.keys.p256dh,
				subscription.keys.auth,
				expirationTime,
				selected.requests ? 1 : 0,
				selected.problems ? 1 : 0,
				selected.requests || selected.problems ? 1 : 0,
				selected.work_finished ? 1 : 0,
				selected.privacy,
				selected.completion_min_runtime_minutes,
				selected.paused_until,
				selected.paused_indefinitely ? 1 : 0,
				selected.quiet_hours === null
					? null
					: JSON.stringify(selected.quiet_hours),
				initialName.slice(0, 80),
				deviceName ?? null,
			],
		);
	}
	const stored = await getPushSubscription(
		subscription.endpoint,
		authSessionHash,
	);
	if (!stored) throw new Error("Push subscription was not persisted");
	return stored;
}

export async function updatePushSubscriptionPreferences(
	endpoint: string,
	authSessionHash: string,
	patch: PushPreferencesPatch,
): Promise<StoredPushSubscription | null> {
	const current = await getPushSubscription(endpoint, authSessionHash);
	if (!current) return null;
	const preferences = pushPreferencesSchema.parse({
		...current.preferences,
		...patch,
	});
	const db = await getDb();
	db.run(
		`UPDATE push_subscriptions
		 SET requests = ?, problems = ?, needs_attention = ?,
		     work_finished = ?, privacy = ?,
		     completion_min_runtime_minutes = ?, paused_until = ?,
		     paused_indefinitely = ?, quiet_hours_json = ?,
		     updated_at = unixepoch()
		 WHERE endpoint = ? AND auth_session_hash = ?
		   AND EXISTS (
		     SELECT 1 FROM auth_sessions owner
		     WHERE owner.token_hash = push_subscriptions.auth_session_hash
		       AND owner.expires_at > unixepoch()
		   )`,
		[
			preferences.requests ? 1 : 0,
			preferences.problems ? 1 : 0,
			preferences.requests || preferences.problems ? 1 : 0,
			preferences.work_finished ? 1 : 0,
			preferences.privacy,
			preferences.completion_min_runtime_minutes,
			preferences.paused_until,
			preferences.paused_indefinitely ? 1 : 0,
			preferences.quiet_hours === null
				? null
				: JSON.stringify(preferences.quiet_hours),
			endpoint,
			authSessionHash,
		],
	);
	return getPushSubscription(endpoint, authSessionHash);
}

export async function deletePushSubscription(
	endpoint: string,
	authSessionHash: string,
): Promise<boolean> {
	const db = await getDb();
	return (
		db.run(
			`DELETE FROM push_subscriptions
			 WHERE endpoint = ? AND auth_session_hash = ?
			   AND EXISTS (
			     SELECT 1 FROM auth_sessions owner
			     WHERE owner.token_hash = push_subscriptions.auth_session_hash
			       AND owner.expires_at > unixepoch()
			   )`,
			[endpoint, authSessionHash],
		).changes > 0
	);
}

/** List non-secret installation devices for any currently trusted browser. */
export async function listPushSubscriptionDevices(
	authSessionHash: string,
	currentEndpoint?: string,
	nowMs = Date.now(),
): Promise<PushSubscriptionDevice[]> {
	await requireValidAuthSession(authSessionHash);
	await disableExpiredPushSubscriptions(nowMs);
	const db = await getDb();
	return db
		.query<PushSubscriptionDbRow, []>(
			`SELECT ${DELIVERABLE_SUBSCRIPTION_COLUMNS}
			 FROM push_subscriptions subscription
			 JOIN auth_sessions owner
			   ON owner.token_hash = subscription.auth_session_hash
			 WHERE owner.expires_at > unixepoch()
			 ORDER BY subscription.updated_at DESC, subscription.id`,
		)
		.all()
		.map((row) => deviceSummary(row, currentEndpoint));
}

async function getPushDeviceById(
	id: string,
	currentEndpoint?: string,
): Promise<PushSubscriptionDevice | null> {
	const db = await getDb();
	const row = db
		.query<PushSubscriptionDbRow, [string]>(
			`SELECT ${SUBSCRIPTION_COLUMNS} FROM push_subscriptions WHERE id = ?`,
		)
		.get(id);
	return row ? deviceSummary(row, currentEndpoint) : null;
}

// fallow-ignore-next-line unused-export -- Bun DB tests retain the legacy rename wrapper contract.
export async function renamePushSubscriptionDevice(
	id: string,
	name: string,
	authSessionHash: string,
	currentEndpoint?: string,
): Promise<PushSubscriptionDevice | null> {
	return updatePushSubscriptionDevice(
		id,
		authSessionHash,
		{ name },
		currentEndpoint,
	);
}

/** Edit any trusted installation device without exposing endpoint secrets. */
export async function updatePushSubscriptionDevice(
	id: string,
	authSessionHash: string,
	patch: PushSubscriptionDevicePatch,
	currentEndpoint?: string,
): Promise<PushSubscriptionDevice | null> {
	await requireValidAuthSession(authSessionHash);
	const db = await getDb();
	const row = db
		.query<PushSubscriptionDbRow, [string]>(
			`SELECT ${SUBSCRIPTION_COLUMNS} FROM push_subscriptions WHERE id = ?`,
		)
		.get(id);
	if (!row) return null;
	const preferences = pushPreferencesSchema.parse({
		...preferencesFromRow(row),
		...patch.preferences,
	});
	const result = db.run(
		`UPDATE push_subscriptions
		 SET device_name = ?, requests = ?, problems = ?, needs_attention = ?,
		     work_finished = ?, privacy = ?, completion_min_runtime_minutes = ?,
		     paused_until = ?, paused_indefinitely = ?, quiet_hours_json = ?,
		     updated_at = unixepoch()
		 WHERE id = ?`,
		[
			patch.name === undefined
				? row.device_name
				: normalizedDefaultDeviceName(patch.name),
			preferences.requests ? 1 : 0,
			preferences.problems ? 1 : 0,
			preferences.requests || preferences.problems ? 1 : 0,
			preferences.work_finished ? 1 : 0,
			preferences.privacy,
			preferences.completion_min_runtime_minutes,
			preferences.paused_until,
			preferences.paused_indefinitely ? 1 : 0,
			preferences.quiet_hours === null
				? null
				: JSON.stringify(preferences.quiet_hours),
			id,
		],
	);
	return result.changes > 0 ? getPushDeviceById(id, currentEndpoint) : null;
}

export async function revokePushSubscriptionDevice(
	id: string,
	authSessionHash: string,
): Promise<boolean> {
	await requireValidAuthSession(authSessionHash);
	const db = await getDb();
	return (
		db.run(`DELETE FROM push_subscriptions WHERE id = ?`, [id]).changes > 0
	);
}

export async function listDeliverablePushSubscriptions(
	nowMs = Date.now(),
): Promise<StoredPushSubscription[]> {
	const db = await getDb();
	return db
		.query<PushSubscriptionDbRow, [number, number]>(
			`SELECT ${DELIVERABLE_SUBSCRIPTION_COLUMNS}
			 FROM push_subscriptions subscription
			 JOIN auth_sessions owner
			   ON owner.token_hash = subscription.auth_session_hash
			 WHERE subscription.enabled = 1
			   AND (subscription.expiration_time_ms IS NULL
			        OR subscription.expiration_time_ms > ?)
			   AND owner.expires_at > ?
			 ORDER BY subscription.created_at, subscription.id`,
		)
		.all(nowMs, Math.floor(nowMs / 1_000))
		.map(storedSubscription);
}

export async function disableExpiredPushSubscriptions(
	nowMs = Date.now(),
): Promise<number> {
	const db = await getDb();
	return db.run(
		`UPDATE push_subscriptions
		 SET enabled = 0, updated_at = unixepoch()
		 WHERE enabled = 1
		   AND expiration_time_ms IS NOT NULL
		   AND expiration_time_ms <= ?`,
		[nowMs],
	).changes;
}

export async function recordPushDeliverySuccess(
	endpoint: string,
): Promise<void> {
	const db = await getDb();
	db.run(
		`UPDATE push_subscriptions
		 SET last_success_at = unixepoch(), failure_count = 0,
		     updated_at = unixepoch()
		 WHERE endpoint = ?`,
		[endpoint],
	);
}

export async function recordPushDeliveryFailure(
	endpoint: string,
	permanent: boolean,
): Promise<void> {
	const db = await getDb();
	if (permanent) {
		// A push-service 404/410 makes this endpoint undeliverable, but retaining a
		// disabled row lets the browser carry its name, preferences, and health into
		// an explicit replacement. The repair flow removes it after caching those.
		db.run(
			`UPDATE push_subscriptions
			 SET enabled = 0,
			     last_failure_at = unixepoch(),
			     failure_count = failure_count + 1,
			     updated_at = unixepoch()
			 WHERE endpoint = ?`,
			[endpoint],
		);
		return;
	}
	db.run(
		`UPDATE push_subscriptions
		 SET last_failure_at = unixepoch(),
		     failure_count = failure_count + 1,
		     updated_at = unixepoch()
		 WHERE endpoint = ?`,
		[endpoint],
	);
}

type StoredSessionNotificationMode = Exclude<
	SessionNotificationMode,
	"default"
>;

export type InitialPushSessionPolicy = {
	mode: StoredSessionNotificationMode;
	scope: SessionNotificationScope;
	/** null means all devices; an array is exact and never falls back to all. */
	targetDeviceIds: string[] | null;
};

type PushSessionPolicyDbRow = {
	session_id: string;
	mode: StoredSessionNotificationMode;
	scope: SessionNotificationScope;
	target_device_ids_json: string | null;
	updated_at: number;
};

export type PushSessionPolicy = {
	sessionId: string;
	mode: StoredSessionNotificationMode;
	scope: SessionNotificationScope;
	/** null means all devices; an array is exact and never falls back to all. */
	targetDeviceIds: string[] | null;
	updatedAt: number;
};

export type PushSessionPolicyInput = {
	mode: SessionNotificationMode;
	scope?: SessionNotificationScope;
	targetDeviceIds?: string[] | null;
};

export type EffectivePushSessionPolicy = {
	requestedSessionId: string;
	sourceSessionId: string | null;
	mode: SessionNotificationMode;
	scope: SessionNotificationScope;
	targetDeviceIds: string[] | null;
	inherited: boolean;
	/** Opaque monotonic revision of the source override, when one exists. */
	sourceUpdatedAt?: number | null;
};

const PUSH_POLICY_REVISION_SETTING = "_push_notification_policy_revision_v1";

function nextPushPolicyRevision(db: Db): number {
	const raw = db
		.query<{ value: string }, [string]>(
			`SELECT value FROM settings WHERE key = ?`,
		)
		.get(PUSH_POLICY_REVISION_SETTING)?.value;
	const previous = Number.parseInt(raw ?? "0", 10);
	const next = Math.max(
		Date.now(),
		Number.isSafeInteger(previous) ? previous + 1 : 1,
	);
	db.run(
		`INSERT OR REPLACE INTO settings (key, value, updated_at)
		 VALUES (?, ?, unixepoch())`,
		[PUSH_POLICY_REVISION_SETTING, String(next)],
	);
	return next;
}

function validateStoredPushSessionPolicy(
	input: InitialPushSessionPolicy,
): InitialPushSessionPolicy {
	const mode = sessionNotificationModeSchema.parse(input.mode);
	if (mode === "default") {
		throw new Error(
			"A stored session notification policy cannot use default mode",
		);
	}
	return {
		mode,
		scope: sessionNotificationScopeSchema.parse(input.scope),
		targetDeviceIds:
			input.targetDeviceIds === null
				? null
				: pushTargetDeviceIdsSchema.parse(input.targetDeviceIds),
	};
}

/**
 * Insert a fully specified policy using the caller's transaction. This is the
 * first-session path: conflicts and validation failures throw so session
 * creation rolls back instead of starting provider work with widened defaults.
 */
export function insertInitialPushSessionPolicyInDb(
	db: Db,
	sessionId: string,
	input: InitialPushSessionPolicy,
): PushSessionPolicy {
	const policy = validateStoredPushSessionPolicy(input);
	const revision = nextPushPolicyRevision(db);
	const result = db.run(
		`INSERT INTO push_session_overrides
			(session_id, mode, scope, target_device_ids_json, updated_at)
		 VALUES (?, ?, ?, ?, ?)`,
		[
			sessionId,
			policy.mode,
			policy.scope,
			policy.targetDeviceIds === null
				? null
				: JSON.stringify(policy.targetDeviceIds),
			revision,
		],
	);
	if (result.changes !== 1) {
		throw new Error("Failed to insert the initial session notification policy");
	}
	return {
		sessionId,
		...policy,
		updatedAt: revision,
	};
}

function parsedTargetDeviceIds(value: string | null): string[] | null {
	if (value === null) return null;
	try {
		const parsed = pushTargetDeviceIdsSchema.safeParse(JSON.parse(value));
		// Invalid targeted state must not widen to all devices.
		return parsed.success ? parsed.data : [];
	} catch {
		return [];
	}
}

function sessionPolicy(row: PushSessionPolicyDbRow): PushSessionPolicy {
	return {
		sessionId: row.session_id,
		mode: row.mode,
		scope: row.scope,
		targetDeviceIds: parsedTargetDeviceIds(row.target_device_ids_json),
		updatedAt: row.updated_at,
	};
}

export async function getPushSessionPolicy(
	sessionId: string,
): Promise<PushSessionPolicy | null> {
	const db = await getDb();
	const row = db
		.query<PushSessionPolicyDbRow, [string]>(
			`SELECT session_id, mode, scope, target_device_ids_json, updated_at
			 FROM push_session_overrides WHERE session_id = ?`,
		)
		.get(sessionId);
	return row ? sessionPolicy(row) : null;
}

export async function setPushSessionPolicy(
	sessionId: string,
	input: PushSessionPolicyInput,
): Promise<PushSessionPolicy | null> {
	const db = await getDb();
	const session = db
		.query<{ id: string }, [string]>(`SELECT id FROM sessions WHERE id = ?`)
		.get(sessionId);
	if (!session) return null;
	const mode = sessionNotificationModeSchema.parse(input.mode);
	if (mode === "default") {
		db.transaction(() => {
			db.run(`DELETE FROM push_session_overrides WHERE session_id = ?`, [
				sessionId,
			]);
			cancelPushNotificationOneShotDeliveriesInDb(db, sessionId, Date.now());
		})();
		return null;
	}
	const current = await getPushSessionPolicy(sessionId);
	const scope = sessionNotificationScopeSchema.parse(
		input.scope ?? current?.scope ?? "session",
	);
	const targetDeviceIds =
		input.targetDeviceIds === undefined
			? (current?.targetDeviceIds ?? null)
			: input.targetDeviceIds === null
				? null
				: pushTargetDeviceIdsSchema.parse(input.targetDeviceIds);
	const revision = nextPushPolicyRevision(db);
	db.run(
		`INSERT INTO push_session_overrides
			(session_id, mode, scope, target_device_ids_json, updated_at)
		 VALUES (?, ?, ?, ?, ?)
		 ON CONFLICT(session_id) DO UPDATE SET
		   mode = excluded.mode,
		   scope = excluded.scope,
		   target_device_ids_json = excluded.target_device_ids_json,
		   updated_at = excluded.updated_at`,
		[
			sessionId,
			mode,
			scope,
			targetDeviceIds === null ? null : JSON.stringify(targetDeviceIds),
			revision,
		],
	);
	return getPushSessionPolicy(sessionId);
}

/** Resolve exact policy first, then the nearest delegated tree ancestor. */
export async function getEffectivePushSessionPolicy(
	sessionId: string,
): Promise<EffectivePushSessionPolicy> {
	const direct = await getPushSessionPolicy(sessionId);
	if (direct) {
		return {
			requestedSessionId: sessionId,
			sourceSessionId: sessionId,
			mode: direct.mode,
			scope: direct.scope,
			targetDeviceIds: direct.targetDeviceIds,
			inherited: false,
			sourceUpdatedAt: direct.updatedAt,
		};
	}
	const db = await getDb();
	const inherited = db
		.query<PushSessionPolicyDbRow & { distance: number }, [string]>(
			`WITH RECURSIVE lineage(
			   delegation_id, parent_session_id, parent_delegation_id, distance, path
			 ) AS (
			   SELECT id, parent_session_id, parent_delegation_id, 1,
			          ',' || id || ','
			   FROM session_delegations
			   WHERE child_session_id = ?
			   UNION ALL
			   SELECT parent.id, parent.parent_session_id,
			          parent.parent_delegation_id, child.distance + 1,
			          child.path || parent.id || ','
			   FROM session_delegations parent
			   JOIN lineage child ON parent.id = child.parent_delegation_id
			   WHERE child.distance < 32
			     AND instr(child.path, ',' || parent.id || ',') = 0
			 )
			 SELECT policy.session_id, policy.mode, policy.scope,
			        policy.target_device_ids_json, policy.updated_at,
			        lineage.distance
			 FROM lineage
			 JOIN push_session_overrides policy
			   ON policy.session_id = lineage.parent_session_id
			 WHERE policy.scope = 'delegation_tree'
			 ORDER BY lineage.distance ASC
			 LIMIT 1`,
		)
		.get(sessionId);
	if (inherited) {
		const policy = sessionPolicy(inherited);
		return {
			requestedSessionId: sessionId,
			sourceSessionId: policy.sessionId,
			mode: policy.mode,
			scope: policy.scope,
			targetDeviceIds: policy.targetDeviceIds,
			inherited: true,
			sourceUpdatedAt: policy.updatedAt,
		};
	}
	return {
		requestedSessionId: sessionId,
		sourceSessionId: null,
		mode: "default",
		scope: "session",
		targetDeviceIds: null,
		inherited: false,
	};
}

/** Compatibility read: this returns the exact session row, not inheritance. */
export async function getPushSessionOverride(
	sessionId: string,
): Promise<SessionNotificationMode> {
	return (await getPushSessionPolicy(sessionId))?.mode ?? "default";
}

/** Compatibility write: legacy callers own only this exact session. */
export async function setPushSessionOverride(
	sessionId: string,
	mode: SessionNotificationMode,
): Promise<SessionNotificationMode | null> {
	const db = await getDb();
	const session = db
		.query<{ id: string }, [string]>(`SELECT id FROM sessions WHERE id = ?`)
		.get(sessionId);
	if (!session) return null;
	if (mode === "default") {
		await setPushSessionPolicy(sessionId, { mode: "default" });
		return mode;
	}
	const current = await getPushSessionPolicy(sessionId);
	await setPushSessionPolicy(sessionId, {
		mode,
		scope: current?.scope ?? "session",
		targetDeviceIds: current?.targetDeviceIds ?? null,
	});
	return mode;
}

/** Clear only a one-shot value that delivery actually accepted. */
export async function clearPushSessionOneShot(
	sessionId: string,
	mode?: "notify_once" | "notify_completion_once",
): Promise<boolean> {
	const db = await getDb();
	const result = mode
		? db.run(
				`DELETE FROM push_session_overrides
				 WHERE session_id = ? AND mode = ?`,
				[sessionId, mode],
			)
		: db.run(
				`DELETE FROM push_session_overrides
				 WHERE session_id = ?
				   AND mode IN ('notify_once', 'notify_completion_once')`,
				[sessionId],
			);
	return result.changes > 0;
}

// fallow-ignore-next-line unused-export -- Bun DB tests verify legacy notify-once compatibility.
export async function clearPushSessionNotifyOnce(
	sessionId: string,
): Promise<boolean> {
	return clearPushSessionOneShot(sessionId, "notify_once");
}

export const MAX_PUSH_NOTIFICATION_EVENT_HISTORY = 500;
const MAX_PUSH_NOTIFICATION_BATCH_HISTORY = 100;

export type PushNotificationDeliveryAttemptOutcome =
	| "delivered"
	| "failed"
	| "gone";
export type PushNotificationClientReceiptStatus =
	| "displayed"
	| "opened"
	| "dismissed";
export type PushNotificationBatchStatus =
	| "open"
	| "ready"
	| "sent"
	| "read"
	| "expired";

export type PushNotificationEventRecord = PushNotificationEventSummary & {
	metadata: Record<string, unknown>;
	dedupeKey: string | null;
	createdAt: number;
	updatedAt: number;
};

export type EnqueuePushNotificationEventInput = Pick<
	PushNotificationEventSummary,
	"sourceKind" | "sourceId" | "category" | "expiresAt"
> &
	Partial<
		Omit<
			PushNotificationEventSummary,
			"sourceKind" | "sourceId" | "category" | "expiresAt" | "status"
		>
	> & {
		status?: "pending" | "deferred";
		metadata?: Record<string, unknown>;
		dedupeKey?: string | null;
	};

export type PushNotificationDeviceSnapshot = {
	id: string;
	name: string;
	privacy: PushPreferences["privacy"];
	preferences?: PushPreferences;
	/** Durable authorization for this event/device after a one-shot is consumed. */
	oneShot?: {
		sourceSessionId: string;
		mode: "notify_once" | "notify_completion_once";
		policyUpdatedAt?: number;
	};
};

export type PushNotificationDeliveryRecord = {
	id: string;
	eventId: string;
	deviceId: string;
	deviceSnapshot: PushNotificationDeviceSnapshot;
} & PushNotificationDeliveryState;

export type PushNotificationDeliveryAttemptRecord = {
	id: string;
	deliveryId: string;
	attemptedAt: number;
	outcome: PushNotificationDeliveryAttemptOutcome;
	providerStatus: number | null;
	retryAfterMs: number | null;
	reasonCode: string | null;
};

export type RecordPushNotificationDeliveryAttemptInput = {
	deliveryId: string;
	attemptedAt?: number;
	outcome: PushNotificationDeliveryAttemptOutcome;
	providerStatus?: number | null;
	retryAfterMs?: number | null;
	reasonCode?: string | null;
};

export type PushNotificationBatchRecord = {
	id: string;
	category: PushNotificationCategory;
	groupKey: string | null;
	status: PushNotificationBatchStatus;
	createdAt: number;
	updatedAt: number;
	sentAt: number | null;
	readAt: number | null;
};

export type PushNotificationBatchMember = {
	batchId: string;
	eventId: string;
	sessionId: string;
	position: number;
	addedAt: number;
	readAt: number | null;
};

export type PushNotificationHistoryEntry = PushNotificationEventRecord & {
	deliveries: PushNotificationDeliveryRecord[];
};

export type PendingPushNotificationDelivery = {
	event: PushNotificationEventRecord;
	delivery: PushNotificationDeliveryRecord;
};

type PushNotificationEventDbRow = {
	id: string;
	source_kind: PushNotificationSourceKind;
	source_id: string;
	category: PushNotificationCategory;
	reason: string | null;
	label: string | null;
	url: string | null;
	runtime_ms: number | null;
	pending_count: number;
	occurred_at: number;
	expires_at: number;
	group_key: string | null;
	batch_id: string | null;
	status: PushNotificationEventStatus;
	status_reason: string | null;
	next_attempt_at: number | null;
	metadata_json: string;
	dedupe_key: string | null;
	created_at: number;
	updated_at: number;
};

type PushNotificationDeliveryDbRow = {
	id: string;
	event_id: string;
	device_id: string;
	device_snapshot_json: string;
	status: PushNotificationDeliveryStatus;
	reason: string | null;
	next_attempt_at: number | null;
	attempt_count: number;
	provider_status: number | null;
	receipt_at: number | null;
	displayed_at: number | null;
	opened_at: number | null;
	dismissed_at: number | null;
	created_at: number;
	updated_at: number;
};

type PushNotificationDeliveryAttemptDbRow = {
	id: string;
	delivery_id: string;
	attempted_at: number;
	outcome: PushNotificationDeliveryAttemptOutcome;
	provider_status: number | null;
	retry_after_ms: number | null;
	reason_code: string | null;
};

type PushNotificationBatchDbRow = {
	id: string;
	category: PushNotificationCategory;
	group_key: string | null;
	status: PushNotificationBatchStatus;
	created_at: number;
	updated_at: number;
	sent_at: number | null;
	read_at: number | null;
};

type PushNotificationBatchMemberDbRow = {
	batch_id: string;
	event_id: string;
	session_id: string;
	position: number;
	added_at: number;
	read_at: number | null;
};

const EVENT_COLUMNS = `
	id, source_kind, source_id, category, reason, label, url, runtime_ms,
	pending_count, occurred_at, expires_at, group_key, batch_id, status,
	status_reason, next_attempt_at, metadata_json, dedupe_key, created_at, updated_at
`;

const DELIVERY_COLUMNS = `
	id, event_id, device_id, device_snapshot_json, status, reason,
	next_attempt_at, attempt_count, provider_status, receipt_at, displayed_at,
	opened_at, dismissed_at, created_at, updated_at
`;

const DELIVERY_ATTEMPT_COLUMNS = `
	id, delivery_id, attempted_at, outcome, provider_status, retry_after_ms,
	reason_code
`;

function parseMetadata(value: string): Record<string, unknown> {
	try {
		const parsed: unknown = JSON.parse(value);
		return parsed !== null &&
			typeof parsed === "object" &&
			!Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: {};
	} catch {
		return {};
	}
}

function eventRecord(
	row: PushNotificationEventDbRow,
): PushNotificationEventRecord {
	return {
		id: row.id,
		sourceKind: row.source_kind,
		sourceId: row.source_id,
		category: row.category,
		reason: row.reason,
		label: row.label,
		url: row.url,
		runtimeMs: row.runtime_ms,
		pendingCount: row.pending_count,
		occurredAt: row.occurred_at,
		expiresAt: row.expires_at,
		groupKey: row.group_key,
		batchId: row.batch_id,
		status: row.status,
		statusReason: row.status_reason,
		nextAttemptAt: row.next_attempt_at,
		metadata: parseMetadata(row.metadata_json),
		dedupeKey: row.dedupe_key,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

function parseDeviceSnapshot(value: string): PushNotificationDeviceSnapshot {
	try {
		const parsed = JSON.parse(value) as Partial<PushNotificationDeviceSnapshot>;
		if (
			typeof parsed.id === "string" &&
			typeof parsed.name === "string" &&
			(parsed.privacy === "generic" || parsed.privacy === "detailed")
		) {
			const preferences = pushPreferencesInputSchema.safeParse(
				parsed.preferences,
			);
			const oneShot =
				parsed.oneShot &&
				typeof parsed.oneShot.sourceSessionId === "string" &&
				parsed.oneShot.sourceSessionId.length >= 1 &&
				parsed.oneShot.sourceSessionId.length <= 256 &&
				(parsed.oneShot.mode === "notify_once" ||
					parsed.oneShot.mode === "notify_completion_once")
					? {
							sourceSessionId: parsed.oneShot.sourceSessionId,
							mode: parsed.oneShot.mode,
							...(Number.isSafeInteger(parsed.oneShot.policyUpdatedAt) &&
							(parsed.oneShot.policyUpdatedAt ?? 0) > 0
								? { policyUpdatedAt: parsed.oneShot.policyUpdatedAt }
								: {}),
						}
					: undefined;
			return {
				id: parsed.id,
				name: parsed.name,
				privacy: parsed.privacy,
				...(preferences.success ? { preferences: preferences.data } : {}),
				...(oneShot ? { oneShot } : {}),
			};
		}
	} catch {
		// Corrupt history is represented without exposing a different device.
	}
	return { id: "unknown", name: "Unknown device", privacy: "generic" };
}

function deliveryRecord(
	row: PushNotificationDeliveryDbRow,
): PushNotificationDeliveryRecord {
	return {
		id: row.id,
		eventId: row.event_id,
		deviceId: row.device_id,
		deviceSnapshot: parseDeviceSnapshot(row.device_snapshot_json),
		status: row.status,
		reason: row.reason,
		nextAttemptAt: row.next_attempt_at,
		attemptCount: row.attempt_count,
		providerStatus: row.provider_status,
		receiptAt: row.receipt_at,
		displayedAt: row.displayed_at,
		openedAt: row.opened_at,
		dismissedAt: row.dismissed_at,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

function deliveryAttemptRecord(
	row: PushNotificationDeliveryAttemptDbRow,
): PushNotificationDeliveryAttemptRecord {
	return {
		id: row.id,
		deliveryId: row.delivery_id,
		attemptedAt: row.attempted_at,
		outcome: row.outcome,
		providerStatus: row.provider_status,
		retryAfterMs: row.retry_after_ms,
		reasonCode: row.reason_code,
	};
}

function batchRecord(
	row: PushNotificationBatchDbRow,
): PushNotificationBatchRecord {
	return {
		id: row.id,
		category: row.category,
		groupKey: row.group_key,
		status: row.status,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
		sentAt: row.sent_at,
		readAt: row.read_at,
	};
}

function batchMember(
	row: PushNotificationBatchMemberDbRow,
): PushNotificationBatchMember {
	return {
		batchId: row.batch_id,
		eventId: row.event_id,
		sessionId: row.session_id,
		position: row.position,
		addedAt: row.added_at,
		readAt: row.read_at,
	};
}

function boundedField(
	value: string | null | undefined,
	max: number,
): string | null {
	if (value === null || value === undefined) return null;
	if (value.length === 0 || value.length > max) {
		throw new Error(`Notification field must contain 1-${max} characters`);
	}
	return value;
}

function safeJson(value: unknown, maxBytes: number): string {
	let serialized: string;
	try {
		serialized = JSON.stringify(value);
	} catch {
		throw new Error("Notification metadata must be JSON serializable");
	}
	if (!serialized || Buffer.byteLength(serialized, "utf8") > maxBytes) {
		throw new Error(`Notification JSON must not exceed ${maxBytes} bytes`);
	}
	return serialized;
}

export async function prunePushNotificationHistory(): Promise<{
	events: number;
	batches: number;
}> {
	const db = await getDb();
	let events = 0;
	let batches = 0;
	const now = Date.now();
	db.transaction(() => {
		db.run(
			`UPDATE push_notification_batches
			 SET status = 'expired', updated_at = ?
			 WHERE status IN ('open', 'ready') AND updated_at <= ?`,
			[now, now - 24 * 60 * 60_000],
		);
		events = db.run(
			`DELETE FROM push_notification_events
			 WHERE id IN (
			   SELECT id FROM push_notification_events
			   WHERE status IN ('processed', 'expired', 'cancelled')
			   ORDER BY occurred_at DESC, id DESC
			   LIMIT -1 OFFSET ?
			 )`,
			[MAX_PUSH_NOTIFICATION_EVENT_HISTORY],
		).changes;
		batches = db.run(
			`DELETE FROM push_notification_batches
			 WHERE id IN (
			   SELECT id FROM push_notification_batches
			   WHERE status IN ('sent', 'read', 'expired')
			   ORDER BY updated_at DESC, id DESC
			   LIMIT -1 OFFSET ?
			 )`,
			[MAX_PUSH_NOTIFICATION_BATCH_HISTORY],
		).changes;
	})();
	return { events, batches };
}

export async function getPushNotificationEvent(
	id: string,
): Promise<PushNotificationEventRecord | null> {
	const db = await getDb();
	const row = db
		.query<PushNotificationEventDbRow, [string]>(
			`SELECT ${EVENT_COLUMNS} FROM push_notification_events WHERE id = ?`,
		)
		.get(id);
	return row ? eventRecord(row) : null;
}

export async function enqueuePushNotificationEvent(
	input: EnqueuePushNotificationEventInput,
): Promise<PushNotificationEventRecord> {
	const db = await getDb();
	const now = Date.now();
	const id = input.id ?? randomUUID();
	if (id.length < 1 || id.length > 64) {
		throw new Error("Notification event ID must contain 1-64 characters");
	}
	const occurredAt = input.occurredAt ?? now;
	if (
		!Number.isSafeInteger(occurredAt) ||
		!Number.isSafeInteger(input.expiresAt) ||
		input.expiresAt <= occurredAt
	) {
		throw new Error("Notification event expiry must follow its occurrence");
	}
	if (!["session", "routine", "system"].includes(input.sourceKind)) {
		throw new Error("Invalid notification source kind");
	}
	if (input.sourceId.length < 1 || input.sourceId.length > 256) {
		throw new Error("Notification source ID must contain 1-256 characters");
	}
	if (!["request", "problem", "completion"].includes(input.category)) {
		throw new Error("Invalid notification category");
	}
	const runtimeMs = input.runtimeMs ?? null;
	const pendingCount = input.pendingCount ?? 0;
	if (
		(runtimeMs !== null &&
			(!Number.isSafeInteger(runtimeMs) || runtimeMs < 0)) ||
		!Number.isSafeInteger(pendingCount) ||
		pendingCount < 0
	) {
		throw new Error("Notification counters must be non-negative integers");
	}
	const metadataJson = safeJson(input.metadata ?? {}, 8_192);
	const reason = boundedField(input.reason, 64);
	const label = boundedField(input.label, 160);
	const url = boundedField(input.url, 2_048);
	const groupKey = boundedField(input.groupKey, 256);
	const statusReason = boundedField(input.statusReason, 128);
	const dedupeKey = boundedField(input.dedupeKey, 256);
	const status = input.status ?? "pending";
	db.run(
		`INSERT INTO push_notification_events (
		   id, source_kind, source_id, category, reason, label, url, runtime_ms,
		   pending_count, occurred_at, expires_at, group_key, batch_id, status,
		   status_reason, next_attempt_at, metadata_json, dedupe_key, created_at,
		   updated_at
		 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		 ON CONFLICT(dedupe_key) DO NOTHING`,
		[
			id,
			input.sourceKind,
			input.sourceId,
			input.category,
			reason,
			label,
			url,
			runtimeMs,
			pendingCount,
			occurredAt,
			input.expiresAt,
			groupKey,
			input.batchId ?? null,
			status,
			statusReason,
			input.nextAttemptAt ?? null,
			metadataJson,
			dedupeKey,
			now,
			now,
		],
	);
	const stored = dedupeKey
		? db
				.query<PushNotificationEventDbRow, [string]>(
					`SELECT ${EVENT_COLUMNS}
					 FROM push_notification_events WHERE dedupe_key = ?`,
				)
				.get(dedupeKey)
		: db
				.query<PushNotificationEventDbRow, [string]>(
					`SELECT ${EVENT_COLUMNS} FROM push_notification_events WHERE id = ?`,
				)
				.get(id);
	if (!stored) throw new Error("Notification event was not persisted");
	await prunePushNotificationHistory();
	return eventRecord(stored);
}

export async function listPendingPushNotificationEvents(
	nowMs = Date.now(),
	limit = 100,
): Promise<PushNotificationEventRecord[]> {
	await reconcileDeliveredPushNotificationAttempts();
	const db = await getDb();
	db.run(
		`UPDATE push_notification_events
		 SET status = 'expired', status_reason = 'expired', next_attempt_at = NULL,
		     updated_at = ?
			 WHERE status IN ('pending', 'deferred', 'batched') AND expires_at <= ?`,
		[nowMs, nowMs],
	);
	return db
		.query<
			PushNotificationEventDbRow,
			[number, number, number, number, number, number, number, number]
		>(
			`WITH selected AS (
			   SELECT id, batch_id, category, group_key, status_reason, occurred_at
			   FROM push_notification_events
			   WHERE expires_at > ?
			     AND (
			       (status = 'pending' AND COALESCE(next_attempt_at, occurred_at) <= ?)
			       OR (status = 'deferred' AND next_attempt_at IS NOT NULL
			           AND next_attempt_at <= ?)
			       OR (status = 'batched' AND batch_id IN (
			         SELECT id FROM push_notification_batches
			         WHERE status IN ('ready', 'sent')
			       ))
			     )
			   ORDER BY COALESCE(next_attempt_at, occurred_at), occurred_at, id
			   LIMIT ${Math.max(1, Math.min(500, limit))}
			 ), selected_delivery_batches AS (
			   SELECT candidate.batch_id
			   FROM (
			     SELECT event.batch_id,
			            MIN(COALESCE(delivery.next_attempt_at, delivery.created_at)) AS ready_at
			     FROM push_notification_deliveries delivery
			     JOIN push_notification_events event ON event.id = delivery.event_id
			     WHERE event.batch_id IS NOT NULL
			       AND event.expires_at > ?
			       AND event.status NOT IN ('expired', 'cancelled')
			       AND event.batch_id IN (
			         SELECT id FROM push_notification_batches
			         WHERE status IN ('ready', 'sent')
			       )
			       AND (
			         (delivery.status = 'pending'
			          AND COALESCE(delivery.next_attempt_at, delivery.created_at) <= ?)
				         OR (delivery.status IN ('queued', 'failed')
			             AND delivery.next_attempt_at IS NOT NULL
			             AND delivery.next_attempt_at <= ?)
			       )
			     GROUP BY event.batch_id
			     ORDER BY ready_at, event.batch_id
			     LIMIT ${Math.max(1, Math.min(500, limit))}
			   ) candidate
			 )
			 SELECT ${EVENT_COLUMNS}
			 FROM push_notification_events
			 WHERE id IN (SELECT id FROM selected)
			    OR (
			      (
			        status IN ('pending', 'deferred', 'batched')
			        OR EXISTS (
			          SELECT 1 FROM push_notification_deliveries retained_delivery
			          WHERE retained_delivery.event_id = push_notification_events.id
			            AND (
			              retained_delivery.status IN ('pending', 'queued')
				              OR (retained_delivery.status = 'failed'
			                  AND retained_delivery.next_attempt_at IS NOT NULL)
			            )
			        )
			      )
			      AND (
			        batch_id IN (
			          SELECT batch_id FROM selected WHERE batch_id IS NOT NULL
			        )
			        OR batch_id IN (SELECT batch_id FROM selected_delivery_batches)
			      )
			    )
			    OR (
			      category = 'completion'
			      AND status = 'deferred'
			      AND status_reason = 'batch_window'
			      AND expires_at > ?
			      AND occurred_at + 750 <= ?
			      AND EXISTS (
			        SELECT 1 FROM selected anchor
			        WHERE anchor.category = 'completion'
			          AND anchor.status_reason = 'batch_window'
			          AND COALESCE(anchor.group_key, 'session-completions') =
			              COALESCE(push_notification_events.group_key, 'session-completions')
			          AND push_notification_events.occurred_at >= anchor.occurred_at
			          AND push_notification_events.occurred_at <= anchor.occurred_at + 20000
			      )
			    )
			 ORDER BY COALESCE(next_attempt_at, occurred_at), occurred_at, id`,
		)
		.all(nowMs, nowMs, nowMs, nowMs, nowMs, nowMs, nowMs, nowMs)
		.map(eventRecord);
}

export async function updatePushNotificationEventStatus(
	id: string,
	patch: {
		status: PushNotificationEventStatus;
		reason?: string | null;
		nextAttemptAt?: number | null;
		batchId?: string | null;
		onlyIfStatuses?: PushNotificationEventStatus[];
	},
): Promise<PushNotificationEventRecord | null> {
	const db = await getDb();
	const now = Date.now();
	const updatesBatchId = Object.hasOwn(patch, "batchId");
	const allowedStatuses = patch.onlyIfStatuses ?? [];
	const statusGuard =
		allowedStatuses.length > 0
			? ` AND status IN (${allowedStatuses.map(() => "?").join(", ")})`
			: "";
	const result = db.run(
		`UPDATE push_notification_events
		 SET status = ?, status_reason = ?, next_attempt_at = ?,
		     batch_id = CASE WHEN ? = 1 THEN ? ELSE batch_id END, updated_at = ?
		 WHERE id = ?${statusGuard}`,
		[
			patch.status,
			boundedField(patch.reason, 128),
			patch.nextAttemptAt ?? null,
			updatesBatchId ? 1 : 0,
			patch.batchId ?? null,
			now,
			id,
			...allowedStatuses,
		],
	);
	return result.changes > 0 ? getPushNotificationEvent(id) : null;
}

/**
 * Stop an obsolete durable event without rewriting terminal history. Provider
 * accepted rows remain accepted, but any future retry is terminated.
 */
export async function terminatePushNotificationEvent(
	id: string,
	reason: string,
): Promise<PushNotificationEventRecord | null> {
	const db = await getDb();
	const now = Date.now();
	db.transaction(() => {
		const current = db
			.query<{ status: PushNotificationEventStatus }, [string]>(
				`SELECT status FROM push_notification_events WHERE id = ?`,
			)
			.get(id);
		if (
			!current ||
			current.status === "processed" ||
			current.status === "expired" ||
			current.status === "cancelled"
		) {
			return;
		}
		const accepted = Boolean(
			db
				.query<{ accepted: number }, [string]>(
					`SELECT 1 AS accepted FROM push_notification_deliveries
						 WHERE event_id = ? AND status = 'sent' LIMIT 1`,
				)
				.get(id),
		);
		db.run(
			`UPDATE push_notification_deliveries
				 SET status = 'expired', reason = 'state_changed',
				     next_attempt_at = NULL, updated_at = ?
				 WHERE event_id = ?
				   AND status IN ('pending', 'queued', 'failed')`,
			[now, id],
		);
		db.run(
			`UPDATE push_notification_events
			 SET status = ?, status_reason = ?, next_attempt_at = NULL,
			     updated_at = ?
			 WHERE id = ? AND status IN ('pending', 'deferred', 'batched')`,
			[
				accepted ? "processed" : "cancelled",
				accepted ? "provider_accepted" : reason.slice(0, 128),
				now,
				id,
			],
		);
	})();
	return getPushNotificationEvent(id);
}

export async function listPushNotificationDeliveries(
	eventId: string,
): Promise<PushNotificationDeliveryRecord[]> {
	const db = await getDb();
	return db
		.query<PushNotificationDeliveryDbRow, [string]>(
			`SELECT ${DELIVERY_COLUMNS}
			 FROM push_notification_deliveries
			 WHERE event_id = ? ORDER BY created_at, id`,
		)
		.all(eventId)
		.map(deliveryRecord);
}

/**
 * Record one provider call without retaining endpoint, key, or payload data.
 * `reasonCode` is deliberately restricted to a compact machine-readable code.
 */
export async function recordPushNotificationDeliveryAttempt(
	input: RecordPushNotificationDeliveryAttemptInput,
): Promise<PushNotificationDeliveryAttemptRecord> {
	const db = await getDb();
	const attemptedAt = input.attemptedAt ?? Date.now();
	if (!Number.isSafeInteger(attemptedAt) || attemptedAt < 0) {
		throw new Error("Notification attempt time must be a non-negative integer");
	}
	if (!(["delivered", "failed", "gone"] as const).includes(input.outcome)) {
		throw new Error("Invalid notification delivery attempt outcome");
	}
	const providerStatus = input.providerStatus ?? null;
	if (
		providerStatus !== null &&
		(!Number.isSafeInteger(providerStatus) ||
			providerStatus < 100 ||
			providerStatus > 599)
	) {
		throw new Error("Notification provider status must be an HTTP status code");
	}
	const retryAfterMs = input.retryAfterMs ?? null;
	if (
		retryAfterMs !== null &&
		(!Number.isSafeInteger(retryAfterMs) || retryAfterMs < 0)
	) {
		throw new Error("Notification retry delay must be a non-negative integer");
	}
	const reasonCode = boundedField(input.reasonCode, 64);
	if (
		reasonCode !== null &&
		!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(reasonCode)
	) {
		throw new Error(
			"Notification attempt reason must be a machine-readable code",
		);
	}
	const id = randomUUID();
	db.run(
		`INSERT INTO push_notification_delivery_attempts (
		   id, delivery_id, attempted_at, outcome, provider_status, retry_after_ms,
		   reason_code
		 ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
		[
			id,
			input.deliveryId,
			attemptedAt,
			input.outcome,
			providerStatus,
			retryAfterMs,
			reasonCode,
		],
	);
	const row = db
		.query<PushNotificationDeliveryAttemptDbRow, [string]>(
			`SELECT ${DELIVERY_ATTEMPT_COLUMNS}
			 FROM push_notification_delivery_attempts WHERE id = ?`,
		)
		.get(id);
	if (!row) throw new Error("Notification delivery attempt was not persisted");
	return deliveryAttemptRecord(row);
}

// fallow-ignore-next-line unused-export -- Bun DB tests inspect the privacy-safe attempt journal directly.
export async function listPushNotificationDeliveryAttempts(
	deliveryId: string,
): Promise<PushNotificationDeliveryAttemptRecord[]> {
	const db = await getDb();
	return db
		.query<PushNotificationDeliveryAttemptDbRow, [string]>(
			`SELECT ${DELIVERY_ATTEMPT_COLUMNS}
			 FROM push_notification_delivery_attempts
			 WHERE delivery_id = ? ORDER BY attempted_at, id`,
		)
		.all(deliveryId)
		.map(deliveryAttemptRecord);
}

/**
 * Turn a durable provider-accepted attempt into its receipt before another
 * drain can resend it. A `batch_accepted` attempt proves the exact shared
 * payload for every member on that device; ordinary attempts prove only their
 * own delivery, including partial durable batches that were sent as singles.
 */
export async function reconcileDeliveredPushNotificationAttempts(
	limit = 500,
): Promise<number> {
	const db = await getDb();
	type ProofRow = {
		delivery_id: string;
		event_id: string;
		device_id: string;
		attempted_at: number;
		provider_status: number | null;
		reason_code: string | null;
		batch_id: string | null;
	};
	type TargetRow = {
		id: string;
		event_id: string;
		device_snapshot_json: string;
		status: PushNotificationDeliveryStatus;
		reason: string | null;
		receipt_at: number | null;
	};
	const proofs = db
		.query<ProofRow, []>(
			`SELECT attempt.delivery_id, delivery.event_id, delivery.device_id,
			        attempt.attempted_at, attempt.provider_status,
			        attempt.reason_code, event.batch_id
			 FROM push_notification_delivery_attempts attempt
			 JOIN push_notification_deliveries delivery
			   ON delivery.id = attempt.delivery_id
			 JOIN push_notification_events event ON event.id = delivery.event_id
			 WHERE attempt.outcome = 'delivered'
			   AND attempt.attempted_at > COALESCE(delivery.receipt_at, -1)
			   AND (
			     (attempt.reason_code = 'batch_accepted' AND event.batch_id IS NOT NULL
			       AND EXISTS (
			         SELECT 1
			         FROM push_notification_batch_members member
			         JOIN push_notification_deliveries sibling
			           ON sibling.event_id = member.event_id
			          AND sibling.device_id = delivery.device_id
			         WHERE member.batch_id = event.batch_id
			           AND (sibling.status <> 'sent'
			                OR sibling.reason <> 'batch_accepted')
			       ))
				     OR (COALESCE(attempt.reason_code, '') <> 'batch_accepted'
				         AND delivery.status <> 'sent')
			   )
			 ORDER BY attempt.attempted_at, attempt.id
			 LIMIT ${Math.max(1, Math.min(2_000, limit))}`,
		)
		.all();
	if (proofs.length === 0) return 0;
	let changed = 0;
	const handled = new Set<string>();
	db.transaction(() => {
		for (const proof of proofs) {
			const batchAccepted =
				proof.reason_code === "batch_accepted" && proof.batch_id !== null;
			const proofKey = batchAccepted
				? `batch:${proof.batch_id}:${proof.device_id}`
				: `delivery:${proof.delivery_id}`;
			if (handled.has(proofKey)) continue;
			handled.add(proofKey);
			const targets = batchAccepted
				? db
						.query<TargetRow, [string, string]>(
							`SELECT delivery.id, delivery.event_id,
								        delivery.device_snapshot_json, delivery.status,
								        delivery.reason, delivery.receipt_at
							 FROM push_notification_batch_members member
							 JOIN push_notification_deliveries delivery
							   ON delivery.event_id = member.event_id
							 WHERE member.batch_id = ? AND delivery.device_id = ?`,
						)
						.all(proof.batch_id ?? "", proof.device_id)
				: db
						.query<TargetRow, [string]>(
							`SELECT delivery.id, delivery.event_id,
								        delivery.device_snapshot_json, delivery.status,
							        delivery.reason, delivery.receipt_at
							 FROM push_notification_deliveries delivery
							 WHERE delivery.id = ?`,
						)
						.all(proof.delivery_id);
			for (const target of targets) {
				if (
					target.receipt_at !== null &&
					target.receipt_at >= proof.attempted_at
				) {
					continue;
				}
				if (
					target.status === "sent" &&
					(!batchAccepted || target.reason === "batch_accepted")
				) {
					continue;
				}
				const snapshot = parseDeviceSnapshot(target.device_snapshot_json);
				const reason = batchAccepted ? "batch_accepted" : "accepted";
				changed += db.run(
					`UPDATE push_notification_deliveries
					 SET status = 'sent', reason = ?, provider_status = ?,
					     next_attempt_at = NULL,
					     attempt_count = attempt_count + CASE
					       WHEN status = 'sent' THEN 0 ELSE 1 END,
					     receipt_at = ?, updated_at = ?
					 WHERE id = ?`,
					[
						reason,
						proof.provider_status,
						proof.attempted_at,
						proof.attempted_at,
						target.id,
					],
				).changes;
				const oneShot = snapshot.oneShot;
				if (oneShot) {
					db.run(
						`INSERT OR IGNORE INTO push_notification_one_shot_consumptions
						 (event_id, source_session_id, mode, policy_updated_at, created_at)
						 VALUES (?, ?, ?, ?, ?)`,
						[
							target.event_id,
							oneShot.sourceSessionId,
							oneShot.mode,
							oneShot.policyUpdatedAt ?? 0,
							proof.attempted_at,
						],
					);
				}
			}
			if (batchAccepted) {
				db.run(
					`UPDATE push_notification_batches
					 SET status = CASE WHEN status = 'read' THEN 'read' ELSE 'sent' END,
					     sent_at = COALESCE(sent_at, ?), updated_at = ?
					 WHERE id = ?`,
					[proof.attempted_at, proof.attempted_at, proof.batch_id],
				);
			}
		}
	})();
	return changed;
}

/** Recover durable per-device provider retries and other scheduled deferrals. */
export async function listPendingPushNotificationDeliveries(
	nowMs = Date.now(),
	limit = 100,
): Promise<PendingPushNotificationDelivery[]> {
	const db = await getDb();
	db.run(
		`UPDATE push_notification_deliveries
		 SET status = 'expired', reason = 'expired', next_attempt_at = NULL,
		     updated_at = ?
		 WHERE status IN ('pending', 'queued', 'failed')
		   AND event_id IN (
		     SELECT id FROM push_notification_events WHERE expires_at <= ?
		   )`,
		[nowMs, nowMs],
	);
	const deliveries = db
		.query<PushNotificationDeliveryDbRow, [number, number, number]>(
			`SELECT ${DELIVERY_COLUMNS}
			 FROM push_notification_deliveries
			 WHERE event_id IN (
			   SELECT id FROM push_notification_events
			   WHERE expires_at > ? AND status NOT IN ('expired', 'cancelled')
			 )
			 AND (
			   (status = 'pending' AND COALESCE(next_attempt_at, created_at) <= ?)
			   OR (status IN ('queued', 'failed')
			       AND next_attempt_at IS NOT NULL AND next_attempt_at <= ?)
			 )
			 ORDER BY COALESCE(next_attempt_at, created_at), created_at, id
			 LIMIT ${Math.max(1, Math.min(500, limit))}`,
		)
		.all(nowMs, nowMs, nowMs)
		.map(deliveryRecord);
	const pending = await Promise.all(
		deliveries.map(async (delivery) => ({
			event: await getPushNotificationEvent(delivery.eventId),
			delivery,
		})),
	);
	return pending.flatMap((item) =>
		item.event ? [{ event: item.event, delivery: item.delivery }] : [],
	);
}

export async function recordPushNotificationDecision(input: {
	eventId: string;
	device: PushNotificationDeviceSnapshot;
	status: "pending" | "suppressed" | "queued";
	reason?: string | null;
	nextAttemptAt?: number | null;
}): Promise<PushNotificationDeliveryRecord> {
	const db = await getDb();
	const now = Date.now();
	const snapshot = {
		id: input.device.id,
		name: normalizedDefaultDeviceName(input.device.name),
		privacy: input.device.privacy,
		...(input.device.preferences
			? { preferences: pushPreferencesSchema.parse(input.device.preferences) }
			: {}),
		...(input.device.oneShot
			? {
					oneShot: {
						sourceSessionId: input.device.oneShot.sourceSessionId.slice(0, 256),
						mode: input.device.oneShot.mode,
						...(input.device.oneShot.policyUpdatedAt !== undefined &&
						Number.isSafeInteger(input.device.oneShot.policyUpdatedAt) &&
						input.device.oneShot.policyUpdatedAt > 0
							? { policyUpdatedAt: input.device.oneShot.policyUpdatedAt }
							: {}),
					},
				}
			: {}),
	};
	if (snapshot.id.length < 1 || snapshot.id.length > 64) {
		throw new Error("Notification device ID must contain 1-64 characters");
	}
	const existing = db
		.query<{ id: string; device_snapshot_json: string }, [string, string]>(
			`SELECT id, device_snapshot_json FROM push_notification_deliveries
			 WHERE event_id = ? AND device_id = ?`,
		)
		.get(input.eventId, input.device.id);
	const oneShotPolicy = input.device.oneShot
		? db
				.query<{ mode: SessionNotificationMode; updated_at: number }, [string]>(
					`SELECT mode, updated_at FROM push_session_overrides
					 WHERE session_id = ?`,
				)
				.get(input.device.oneShot.sourceSessionId)
		: null;
	const requestedOneShot = input.device.oneShot;
	const retainedOneShot = existing
		? parseDeviceSnapshot(existing.device_snapshot_json).oneShot
		: null;
	const matchesRequestedOneShot = (
		candidate:
			| {
					sourceSessionId: string;
					mode: "notify_once" | "notify_completion_once";
					policyUpdatedAt?: number;
			  }
			| null
			| undefined,
	): boolean =>
		Boolean(
			requestedOneShot &&
				candidate?.sourceSessionId === requestedOneShot.sourceSessionId &&
				candidate.mode === requestedOneShot.mode &&
				(candidate.policyUpdatedAt ?? 0) ===
					(requestedOneShot.policyUpdatedAt ?? 0),
		);
	const liveOneShotMatches = Boolean(
		requestedOneShot &&
			oneShotPolicy?.mode === requestedOneShot.mode &&
			(requestedOneShot.policyUpdatedAt === undefined ||
				oneShotPolicy.updated_at === requestedOneShot.policyUpdatedAt),
	);
	const staleInitialOneShot = Boolean(
		requestedOneShot &&
			!liveOneShotMatches &&
			!matchesRequestedOneShot(retainedOneShot),
	);
	const status = staleInitialOneShot ? "suppressed" : input.status;
	const reason = staleInitialOneShot ? "one_shot_cancelled" : input.reason;
	const nextAttemptAt = staleInitialOneShot ? null : input.nextAttemptAt;
	const snapshotJson = safeJson(snapshot, 2_048);
	db.run(
		`INSERT INTO push_notification_deliveries (
		   id, event_id, device_id, device_snapshot_json, status, reason,
		   next_attempt_at, created_at, updated_at
		 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
		 ON CONFLICT(event_id, device_id) DO UPDATE SET
			device_snapshot_json = CASE
		     WHEN push_notification_deliveries.reason IN (
		       'one_shot_cancelled', 'one_shot_consumed_other_event'
		     )
		     THEN push_notification_deliveries.device_snapshot_json
		     ELSE excluded.device_snapshot_json END,
		   status = CASE
		     WHEN push_notification_deliveries.status = 'sent' THEN 'sent'
		     WHEN push_notification_deliveries.reason IN (
		       'one_shot_cancelled', 'one_shot_consumed_other_event'
		     )
		     THEN push_notification_deliveries.status
		     ELSE excluded.status END,
		   reason = CASE
		     WHEN push_notification_deliveries.reason IN (
		       'one_shot_cancelled', 'one_shot_consumed_other_event'
		     )
		     THEN push_notification_deliveries.reason ELSE excluded.reason END,
		   next_attempt_at = CASE
		     WHEN push_notification_deliveries.reason IN (
		       'one_shot_cancelled', 'one_shot_consumed_other_event'
		     )
		     THEN push_notification_deliveries.next_attempt_at
		     ELSE excluded.next_attempt_at END,
		   updated_at = excluded.updated_at`,
		[
			randomUUID(),
			input.eventId,
			input.device.id,
			snapshotJson,
			status,
			boundedField(reason, 128),
			nextAttemptAt ?? null,
			now,
			now,
		],
	);
	const row = db
		.query<PushNotificationDeliveryDbRow, [string, string]>(
			`SELECT ${DELIVERY_COLUMNS}
			 FROM push_notification_deliveries
			 WHERE event_id = ? AND device_id = ?`,
		)
		.get(input.eventId, input.device.id);
	if (!row) throw new Error("Notification decision was not persisted");
	return deliveryRecord(row);
}

export async function recordPushNotificationReceipt(input: {
	eventId: string;
	deviceId: string;
	status: "sent" | "failed" | "gone" | "expired";
	reason?: string | null;
	providerStatus?: number | null;
	nextAttemptAt?: number | null;
	receiptAt?: number;
	oneShot?: {
		sourceSessionId: string;
		mode: "notify_once" | "notify_completion_once";
		policyUpdatedAt?: number;
	};
}): Promise<PushNotificationDeliveryRecord | null> {
	const db = await getDb();
	const now = input.receiptAt ?? Date.now();
	if (
		input.oneShot &&
		(input.oneShot.sourceSessionId.length < 1 ||
			input.oneShot.sourceSessionId.length > 256)
	) {
		throw new Error("Notification one-shot session ID is invalid");
	}
	if (
		input.oneShot?.policyUpdatedAt !== undefined &&
		(!Number.isSafeInteger(input.oneShot.policyUpdatedAt) ||
			input.oneShot.policyUpdatedAt <= 0)
	) {
		throw new Error("Notification one-shot policy revision is invalid");
	}
	let changed = 0;
	db.transaction(() => {
		changed = db.run(
			`UPDATE push_notification_deliveries
			 SET status = ?, reason = ?, provider_status = ?, next_attempt_at = ?,
			     attempt_count = attempt_count + 1, receipt_at = ?, updated_at = ?
			 WHERE event_id = ? AND device_id = ?
			   AND (
			     ? = 'sent'
			     OR COALESCE(reason, '') NOT IN (
			       'one_shot_cancelled', 'one_shot_consumed_other_event'
			     )
			   )`,
			[
				input.status,
				boundedField(input.reason, 128),
				input.providerStatus ?? null,
				input.nextAttemptAt ?? null,
				now,
				now,
				input.eventId,
				input.deviceId,
				input.status,
			],
		).changes;
		if (changed > 0 && input.status === "sent" && input.oneShot) {
			db.run(
				`INSERT OR IGNORE INTO push_notification_one_shot_consumptions
				 (event_id, source_session_id, mode, policy_updated_at, created_at)
				 VALUES (?, ?, ?, ?, ?)`,
				[
					input.eventId,
					input.oneShot.sourceSessionId,
					input.oneShot.mode,
					input.oneShot.policyUpdatedAt ?? 0,
					now,
				],
			);
		}
	})();
	if (changed === 0) return null;
	const row = db
		.query<PushNotificationDeliveryDbRow, [string, string]>(
			`SELECT ${DELIVERY_COLUMNS}
			 FROM push_notification_deliveries
			 WHERE event_id = ? AND device_id = ?`,
		)
		.get(input.eventId, input.deviceId);
	return row ? deliveryRecord(row) : null;
}

/** Clear a consumed one-shot and its durable recovery marker atomically. */
export async function consumePushNotificationOneShot(
	sessionId: string,
	mode: "notify_once" | "notify_completion_once",
	policyUpdatedAt?: number,
): Promise<boolean> {
	const db = await getDb();
	let cleared = false;
	db.transaction(() => {
		const markerEventIds = db
			.query<{ event_id: string }, [string, string, number]>(
				`SELECT event_id FROM push_notification_one_shot_consumptions
				 WHERE source_session_id = ? AND mode = ?
				   AND policy_updated_at = ?`,
			)
			.all(sessionId, mode, policyUpdatedAt ?? 0)
			.map((row) => row.event_id);
		if (markerEventIds.length > 0) {
			const candidateRows = db
				.query<
					{
						id: string;
						event_id: string;
						device_snapshot_json: string;
					},
					[]
				>(
					`SELECT delivery.id, delivery.event_id,
					        delivery.device_snapshot_json
					 FROM push_notification_deliveries delivery
					 JOIN push_notification_events event ON event.id = delivery.event_id
					 WHERE delivery.status IN ('pending', 'queued')
					    OR (delivery.status = 'failed'
					        AND delivery.next_attempt_at IS NOT NULL)`,
				)
				.all();
			const now = Date.now();
			const affectedEventIds = new Set<string>();
			for (const row of candidateRows) {
				if (markerEventIds.includes(row.event_id)) {
					continue;
				}
				const retained = parseDeviceSnapshot(row.device_snapshot_json).oneShot;
				if (
					retained?.sourceSessionId !== sessionId ||
					retained.mode !== mode ||
					(retained.policyUpdatedAt ?? 0) !== (policyUpdatedAt ?? 0)
				) {
					continue;
				}
				db.run(
					`UPDATE push_notification_deliveries
					 SET status = 'suppressed',
					     reason = 'one_shot_consumed_other_event',
					     next_attempt_at = NULL, updated_at = ?
					 WHERE id = ?`,
					[now, row.id],
				);
				affectedEventIds.add(row.event_id);
			}
			for (const eventId of affectedEventIds) {
				db.run(
					`UPDATE push_notification_events
					 SET status = 'deferred', status_reason = 'one_shot_consumed',
					     next_attempt_at = ?, updated_at = ?
					 WHERE id = ? AND status IN ('pending', 'deferred', 'batched')`,
					[now, now, eventId],
				);
			}
		}
		cleared = policyUpdatedAt
			? db.run(
					`DELETE FROM push_session_overrides
					 WHERE session_id = ? AND mode = ? AND updated_at = ?`,
					[sessionId, mode, policyUpdatedAt],
				).changes > 0
			: db.run(
					`DELETE FROM push_session_overrides
					 WHERE session_id = ? AND mode = ?`,
					[sessionId, mode],
				).changes > 0;
		if (policyUpdatedAt) {
			db.run(
				`DELETE FROM push_notification_one_shot_consumptions
				 WHERE source_session_id = ? AND mode = ? AND policy_updated_at = ?`,
				[sessionId, mode, policyUpdatedAt],
			);
		} else {
			db.run(
				`DELETE FROM push_notification_one_shot_consumptions
				 WHERE source_session_id = ? AND mode = ?`,
				[sessionId, mode],
			);
		}
	})();
	return cleared;
}

/** Cancel deferred authorization when the user explicitly leaves a one-shot. */
function cancelPushNotificationOneShotDeliveriesInDb(
	db: Awaited<ReturnType<typeof getDb>>,
	sourceSessionId: string,
	at: number,
): number {
	const candidates = db
		.query<
			{
				id: string;
				event_id: string;
				device_snapshot_json: string;
			},
			[]
		>(
			`SELECT id, event_id, device_snapshot_json
			 FROM push_notification_deliveries
			 WHERE status IN ('pending', 'queued')
			    OR (status = 'failed' AND next_attempt_at IS NOT NULL)`,
		)
		.all()
		.filter((row) => {
			try {
				const parsed = JSON.parse(row.device_snapshot_json) as {
					oneShot?: { sourceSessionId?: unknown; mode?: unknown };
				};
				return (
					parsed.oneShot?.sourceSessionId === sourceSessionId &&
					(parsed.oneShot.mode === "notify_once" ||
						parsed.oneShot.mode === "notify_completion_once")
				);
			} catch {
				return false;
			}
		});
	if (candidates.length === 0) return 0;
	const eventIds = new Set(candidates.map((row) => row.event_id));
	for (const row of candidates) {
		db.run(
			`UPDATE push_notification_deliveries
			 SET status = 'suppressed', reason = 'one_shot_cancelled',
			     next_attempt_at = NULL, updated_at = ?
			 WHERE id = ? AND status IN ('pending', 'queued', 'failed')`,
			[at, row.id],
		);
	}
	for (const eventId of eventIds) {
		db.run(
			`UPDATE push_notification_events
			 SET status = 'deferred', status_reason = 'one_shot_cancelled',
			     next_attempt_at = ?, updated_at = ?
			 WHERE id = ? AND status IN ('pending', 'deferred', 'batched')`,
			[at, at, eventId],
		);
	}
	return candidates.length;
}

export async function cancelPushNotificationOneShotDeliveries(
	sourceSessionId: string,
	at = Date.now(),
): Promise<number> {
	if (sourceSessionId.length < 1 || sourceSessionId.length > 256) return 0;
	const db = await getDb();
	return db.transaction(() =>
		cancelPushNotificationOneShotDeliveriesInDb(db, sourceSessionId, at),
	)();
}

/** Recover provider-accepted one-shots left between receipt and policy clear. */
export async function reconcilePushNotificationOneShots(): Promise<number> {
	const db = await getDb();
	const pending = db
		.query<
			{
				source_session_id: string;
				mode: "notify_once" | "notify_completion_once";
				policy_updated_at: number;
			},
			[]
		>(
			`SELECT DISTINCT marker.source_session_id, marker.mode,
			        marker.policy_updated_at
			 FROM push_notification_one_shot_consumptions marker`,
		)
		.all();
	for (const item of pending) {
		await consumePushNotificationOneShot(
			item.source_session_id,
			item.mode,
			item.policy_updated_at > 0 ? item.policy_updated_at : undefined,
		);
	}
	return pending.length;
}

/** Retain service-worker display/open/dismiss receipts without changing send state. */
export async function recordPushNotificationClientReceipt(
	deliveryId: string,
	status: PushNotificationClientReceiptStatus,
	at = Date.now(),
): Promise<PushNotificationDeliveryRecord | null> {
	const db = await getDb();
	const result = db.run(
		`UPDATE push_notification_deliveries
		 SET displayed_at = CASE
		       WHEN ? = 'displayed' THEN COALESCE(displayed_at, ?) ELSE displayed_at
		     END,
		     opened_at = CASE
		       WHEN ? = 'opened' THEN COALESCE(opened_at, ?) ELSE opened_at
		     END,
		     dismissed_at = CASE
		       WHEN ? = 'dismissed' THEN COALESCE(dismissed_at, ?) ELSE dismissed_at
		     END,
		     updated_at = ?
		 WHERE id = ?`,
		[status, at, status, at, status, at, at, deliveryId],
	);
	if (result.changes === 0) return null;
	const row = db
		.query<PushNotificationDeliveryDbRow, [string]>(
			`SELECT ${DELIVERY_COLUMNS}
			 FROM push_notification_deliveries WHERE id = ?`,
		)
		.get(deliveryId);
	return row ? deliveryRecord(row) : null;
}

export async function listPushNotificationHistory(
	limit = 20,
): Promise<PushNotificationHistoryEntry[]> {
	const db = await getDb();
	const events = db
		.query<PushNotificationEventDbRow, []>(
			`SELECT ${EVENT_COLUMNS}
			 FROM push_notification_events
			 ORDER BY occurred_at DESC, id DESC
			 LIMIT ${Math.max(1, Math.min(100, limit))}`,
		)
		.all()
		.map(eventRecord);
	return Promise.all(
		events.map(async (event) => ({
			...event,
			deliveries: await listPushNotificationDeliveries(event.id),
		})),
	);
}

export async function createPushNotificationBatch(input: {
	id?: string;
	category: PushNotificationCategory;
	groupKey?: string | null;
	status?: "open" | "ready";
	createdAt?: number;
}): Promise<PushNotificationBatchRecord> {
	const id = pushNotificationBatchIdSchema.parse(input.id ?? randomUUID());
	const db = await getDb();
	const now = input.createdAt ?? Date.now();
	db.run(
		`INSERT INTO push_notification_batches
		   (id, category, group_key, status, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?)`,
		[
			id,
			input.category,
			boundedField(input.groupKey, 256),
			input.status ?? "open",
			now,
			now,
		],
	);
	const batch = await getPushNotificationBatch(id);
	if (!batch) throw new Error("Notification batch was not persisted");
	return batch;
}

export async function getPushNotificationBatch(
	id: string,
): Promise<PushNotificationBatchRecord | null> {
	const db = await getDb();
	const row = db
		.query<PushNotificationBatchDbRow, [string]>(
			`SELECT id, category, group_key, status, created_at, updated_at,
			        sent_at, read_at
			 FROM push_notification_batches WHERE id = ?`,
		)
		.get(id);
	return row ? batchRecord(row) : null;
}

export async function updatePushNotificationBatchStatus(
	id: string,
	status: PushNotificationBatchStatus,
	at = Date.now(),
): Promise<PushNotificationBatchRecord | null> {
	const current = await getPushNotificationBatch(id);
	if (!current) return null;
	const nextStatus: PushNotificationBatchStatus =
		current.status === "read" || current.status === "expired"
			? current.status
			: status === "read"
				? "read"
				: status === "expired"
					? current.status === "open" || current.status === "ready"
						? "expired"
						: current.status
					: status === "sent"
						? current.status === "open" || current.status === "ready"
							? "sent"
							: current.status
						: status === "ready" && current.status === "open"
							? "ready"
							: current.status;
	if (nextStatus === current.status) return current;
	const db = await getDb();
	db.run(
		`UPDATE push_notification_batches
		 SET status = ?, updated_at = ?,
		     sent_at = CASE WHEN ? = 'sent' THEN COALESCE(sent_at, ?) ELSE sent_at END,
		     read_at = CASE WHEN ? = 'read' THEN COALESCE(read_at, ?) ELSE read_at END
		 WHERE id = ? AND status = ?`,
		[nextStatus, at, nextStatus, at, nextStatus, at, id, current.status],
	);
	return getPushNotificationBatch(id);
}

export async function addPushNotificationBatchMembers(
	batchId: string,
	members: readonly { eventId: string; sessionId: string }[],
	addedAt = Date.now(),
): Promise<PushNotificationBatchMember[]> {
	if (members.length === 0 || members.length > 10) {
		throw new Error("Notification batches require 1-10 members");
	}
	if (
		new Set(members.map((member) => member.eventId)).size !== members.length ||
		new Set(members.map((member) => member.sessionId)).size !== members.length
	) {
		throw new Error("Notification batch members must be unique");
	}
	const db = await getDb();
	db.transaction(() => {
		const batch = db
			.query<{ category: PushNotificationCategory }, [string]>(
				`SELECT category FROM push_notification_batches WHERE id = ?`,
			)
			.get(batchId);
		if (!batch) throw new Error("Notification batch not found");
		const start =
			db
				.query<{ next_position: number }, [string]>(
					`SELECT COALESCE(MAX(position) + 1, 0) AS next_position
					 FROM push_notification_batch_members WHERE batch_id = ?`,
				)
				.get(batchId)?.next_position ?? 0;
		if (start + members.length > 10) {
			throw new Error("Notification batches cannot exceed 10 members");
		}
		members.forEach((member, index) => {
			const event = db
				.query<{ category: PushNotificationCategory }, [string]>(
					`SELECT category FROM push_notification_events WHERE id = ?`,
				)
				.get(member.eventId);
			if (!event || event.category !== batch.category) {
				throw new Error("Notification batch category mismatch");
			}
			db.run(
				`INSERT INTO push_notification_batch_members
				   (batch_id, event_id, session_id, position, added_at)
				 VALUES (?, ?, ?, ?, ?)`,
				[batchId, member.eventId, member.sessionId, start + index, addedAt],
			);
			db.run(
				`UPDATE push_notification_events
				 SET batch_id = ?, status = 'batched', updated_at = ?
				 WHERE id = ?`,
				[batchId, addedAt, member.eventId],
			);
		});
		db.run(`UPDATE push_notification_batches SET updated_at = ? WHERE id = ?`, [
			addedAt,
			batchId,
		]);
	})();
	return listPushNotificationBatchMembers(batchId);
}

export async function listPushNotificationBatchMembers(
	batchId: string,
): Promise<PushNotificationBatchMember[]> {
	const db = await getDb();
	return db
		.query<PushNotificationBatchMemberDbRow, [string]>(
			`SELECT batch_id, event_id, session_id, position, added_at, read_at
			 FROM push_notification_batch_members
			 WHERE batch_id = ? ORDER BY position, event_id`,
		)
		.all(batchId)
		.map(batchMember);
}

function pushNotificationBatchAcceptsReads(
	db: Awaited<ReturnType<typeof getDb>>,
	batchId: string,
): boolean {
	const batch = db
		.query<{ status: PushNotificationBatchStatus }, [string]>(
			`SELECT status FROM push_notification_batches WHERE id = ?`,
		)
		.get(batchId);
	return Boolean(batch && batch.status !== "expired");
}

export async function markPushNotificationBatchMemberRead(
	batchId: string,
	sessionId: string,
	readAt = Date.now(),
): Promise<boolean> {
	const db = await getDb();
	let changed = false;
	db.transaction(() => {
		if (!pushNotificationBatchAcceptsReads(db, batchId)) return;
		changed =
			db.run(
				`UPDATE push_notification_batch_members
				 SET read_at = COALESCE(read_at, ?)
				 WHERE batch_id = ? AND session_id = ?`,
				[readAt, batchId, sessionId],
			).changes > 0;
		if (!changed) return;
		const unread = db
			.query<{ count: number }, [string]>(
				`SELECT COUNT(*) AS count FROM push_notification_batch_members
				 WHERE batch_id = ? AND read_at IS NULL`,
			)
			.get(batchId)?.count;
		if (unread === 0) {
			db.run(
				`UPDATE push_notification_batches
				 SET status = 'read', read_at = COALESCE(read_at, ?), updated_at = ?
					 WHERE id = ? AND status <> 'expired'`,
				[readAt, readAt, batchId],
			);
		}
	})();
	return changed;
}

export async function markPushNotificationBatchRead(
	batchId: string,
	readAt = Date.now(),
): Promise<boolean> {
	const db = await getDb();
	let changed = false;
	db.transaction(() => {
		if (!pushNotificationBatchAcceptsReads(db, batchId)) return;
		db.run(
			`UPDATE push_notification_batch_members
			 SET read_at = COALESCE(read_at, ?) WHERE batch_id = ?`,
			[readAt, batchId],
		);
		changed =
			db.run(
				`UPDATE push_notification_batches
				 SET status = 'read', read_at = COALESCE(read_at, ?), updated_at = ?
				 WHERE id = ? AND status <> 'expired'`,
				[readAt, readAt, batchId],
			).changes > 0;
	})();
	return changed;
}

const REQUEST_REASONS = new Set([
	"permission",
	"question",
	"plan_review",
	"routine_action_required",
]);

/** A targeted policy never widens when its exact device list is empty/stale. */
export function pushSessionPolicyTargetsDevice(
	policy: Pick<EffectivePushSessionPolicy, "targetDeviceIds">,
	deviceId: string,
): boolean {
	return (
		policy.targetDeviceIds === null || policy.targetDeviceIds.includes(deviceId)
	);
}

export function pushSubscriptionWantsNotification(
	subscription: Pick<StoredPushSubscription, "preferences">,
	kind: WebPushNotificationPayload["kind"],
	mode: SessionNotificationMode,
	options: { reason?: string | null; runtimeMs?: number; nowMs?: number } = {},
): boolean {
	if (kind === "test") return true;
	const nowSeconds = Math.floor((options.nowMs ?? Date.now()) / 1_000);
	if (
		subscription.preferences.paused_indefinitely ||
		(subscription.preferences.paused_until !== null &&
			subscription.preferences.paused_until > nowSeconds)
	)
		return false;
	if (mode === "mute") return false;
	if (mode === "notify") return true;
	if (mode === "notify_once") return true;
	if (mode === "notify_completion_once" && kind === "work_finished")
		return true;
	if (kind === "needs_attention") {
		return REQUEST_REASONS.has(options.reason ?? "")
			? subscription.preferences.requests
			: subscription.preferences.problems;
	}
	const minimumMs =
		subscription.preferences.completion_min_runtime_minutes * 60_000;
	return (
		subscription.preferences.work_finished &&
		(minimumMs === 0 ||
			(options.runtimeMs !== undefined && options.runtimeMs >= minimumMs))
	);
}
