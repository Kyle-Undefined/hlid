import { randomUUID } from "node:crypto";
import type {
	BrowserPushSubscription,
	PushPreferences,
	PushPreferencesPatch,
	SessionNotificationMode,
	WebPushNotificationPayload,
} from "../lib/pushNotificationSchemas";
import { DEFAULT_PUSH_PREFERENCES } from "../lib/pushNotificationSchemas";
import { getDb } from "./schema";

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
	pausedUntil: number | null;
	pausedIndefinitely: boolean;
	createdAt: number;
	updatedAt: number;
	lastSuccessAt: number | null;
	lastFailureAt: number | null;
	failureCount: number;
};

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
		preferences: {
			requests: row.requests === 1,
			problems: row.problems === 1,
			work_finished: row.work_finished === 1,
			privacy: row.privacy,
			completion_min_runtime_minutes: row.completion_min_runtime_minutes,
			paused_until: row.paused_until,
			paused_indefinitely: row.paused_indefinitely === 1,
		},
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
	paused_until, paused_indefinitely, device_name, enabled, created_at, updated_at,
	last_success_at, last_failure_at, failure_count
`;

const DELIVERABLE_SUBSCRIPTION_COLUMNS = `
	subscription.id, subscription.auth_session_hash, subscription.endpoint,
	subscription.p256dh, subscription.auth, subscription.expiration_time_ms,
	subscription.requests, subscription.problems, subscription.work_finished,
	subscription.privacy, subscription.completion_min_runtime_minutes,
	subscription.paused_until, subscription.paused_indefinitely,
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
): Promise<StoredPushSubscription> {
	const db = await getDb();
	const owner = await requireValidAuthSession(authSessionHash);
	const expirationTime = subscription.expirationTime ?? null;
	const initialName = normalizedDefaultDeviceName(
		deviceName ?? owner.device_label,
	);
	const selected = preferences ?? DEFAULT_PUSH_PREFERENCES;
	if (preferences) {
		db.run(
			`INSERT INTO push_subscriptions (
				id, auth_session_hash, endpoint, p256dh, auth, expiration_time_ms,
				requests, problems, needs_attention, work_finished, privacy,
				completion_min_runtime_minutes, paused_until, paused_indefinitely,
				device_name
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
				device_name
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
	const preferences: PushPreferences = { ...current.preferences, ...patch };
	const db = await getDb();
	db.run(
		`UPDATE push_subscriptions
		 SET requests = ?, problems = ?, needs_attention = ?,
		     work_finished = ?, privacy = ?,
		     completion_min_runtime_minutes = ?, paused_until = ?,
		     paused_indefinitely = ?,
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

export async function renamePushSubscriptionDevice(
	id: string,
	name: string,
	authSessionHash: string,
	currentEndpoint?: string,
): Promise<PushSubscriptionDevice | null> {
	await requireValidAuthSession(authSessionHash);
	const db = await getDb();
	const result = db.run(
		`UPDATE push_subscriptions
		 SET device_name = ?, updated_at = unixepoch()
		 WHERE id = ?`,
		[normalizedDefaultDeviceName(name), id],
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

export async function getPushSessionOverride(
	sessionId: string,
): Promise<SessionNotificationMode> {
	const db = await getDb();
	return (
		db
			.query<{ mode: "notify" | "notify_once" | "mute" }, [string]>(
				`SELECT mode FROM push_session_overrides WHERE session_id = ?`,
			)
			.get(sessionId)?.mode ?? "default"
	);
}

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
		db.run(`DELETE FROM push_session_overrides WHERE session_id = ?`, [
			sessionId,
		]);
		return mode;
	}
	db.run(
		`INSERT INTO push_session_overrides (session_id, mode)
		 VALUES (?, ?)
		 ON CONFLICT(session_id) DO UPDATE SET
		   mode = excluded.mode, updated_at = unixepoch()`,
		[sessionId, mode],
	);
	return mode;
}

/** Clear only the one-shot value that was actually observed by delivery. */
export async function clearPushSessionNotifyOnce(
	sessionId: string,
): Promise<boolean> {
	const db = await getDb();
	return (
		db.run(
			`DELETE FROM push_session_overrides
			 WHERE session_id = ? AND mode = 'notify_once'`,
			[sessionId],
		).changes > 0
	);
}

const REQUEST_REASONS = new Set([
	"permission",
	"question",
	"plan_review",
	"routine_action_required",
]);

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
