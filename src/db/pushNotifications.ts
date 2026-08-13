import { randomUUID } from "node:crypto";
import type {
	BrowserPushSubscription,
	PushPreferences,
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
	needs_attention: number;
	work_finished: number;
	privacy: PushPreferences["privacy"];
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
	preferences: PushPreferences;
	enabled: boolean;
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
		preferences: {
			needs_attention: row.needs_attention === 1,
			work_finished: row.work_finished === 1,
			privacy: row.privacy,
		},
		enabled: row.enabled === 1,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
		lastSuccessAt: row.last_success_at,
		lastFailureAt: row.last_failure_at,
		failureCount: row.failure_count,
	};
}

const SUBSCRIPTION_COLUMNS = `
	id, auth_session_hash, endpoint, p256dh, auth, expiration_time_ms, needs_attention,
	work_finished, privacy, enabled, created_at, updated_at,
	last_success_at, last_failure_at, failure_count
`;

const DELIVERABLE_SUBSCRIPTION_COLUMNS = `
	subscription.id, subscription.auth_session_hash, subscription.endpoint,
	subscription.p256dh, subscription.auth, subscription.expiration_time_ms,
	subscription.needs_attention, subscription.work_finished, subscription.privacy,
	subscription.enabled, subscription.created_at, subscription.updated_at,
	subscription.last_success_at, subscription.last_failure_at,
	subscription.failure_count
`;

export async function getPushSubscription(
	endpoint: string,
	authSessionHash?: string,
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
	return row ? storedSubscription(row) : null;
}

/**
 * Register the browser's current endpoint and encryption keys. Re-subscribing
 * is idempotent. Omitted preferences preserve an existing device's choices and
 * use the deliberately quiet defaults only for a new endpoint.
 */
export async function upsertPushSubscription(
	subscription: BrowserPushSubscription,
	authSessionHash: string,
	preferences?: PushPreferences,
): Promise<StoredPushSubscription> {
	const db = await getDb();
	const validOwner = db
		.query<{ token_hash: string }, [string]>(
			`SELECT token_hash FROM auth_sessions
			 WHERE token_hash = ? AND expires_at > unixepoch()`,
		)
		.get(authSessionHash);
	if (!validOwner) throw new Error("Authenticated browser session expired");
	const expirationTime = subscription.expirationTime ?? null;
	if (preferences) {
		db.run(
			`INSERT INTO push_subscriptions (
				id, auth_session_hash, endpoint, p256dh, auth, expiration_time_ms,
				needs_attention, work_finished, privacy
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(endpoint) DO UPDATE SET
				auth_session_hash = excluded.auth_session_hash,
				p256dh = excluded.p256dh,
				auth = excluded.auth,
				expiration_time_ms = excluded.expiration_time_ms,
				needs_attention = excluded.needs_attention,
				work_finished = excluded.work_finished,
				privacy = excluded.privacy,
				enabled = 1,
				updated_at = unixepoch(),
				failure_count = 0`,
			[
				randomUUID(),
				authSessionHash,
				subscription.endpoint,
				subscription.keys.p256dh,
				subscription.keys.auth,
				expirationTime,
				preferences.needs_attention ? 1 : 0,
				preferences.work_finished ? 1 : 0,
				preferences.privacy,
			],
		);
	} else {
		db.run(
			`INSERT INTO push_subscriptions (
				id, auth_session_hash, endpoint, p256dh, auth, expiration_time_ms,
				needs_attention, work_finished, privacy
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(endpoint) DO UPDATE SET
				auth_session_hash = excluded.auth_session_hash,
				p256dh = excluded.p256dh,
				auth = excluded.auth,
				expiration_time_ms = excluded.expiration_time_ms,
				enabled = 1,
				updated_at = unixepoch(),
				failure_count = 0`,
			[
				randomUUID(),
				authSessionHash,
				subscription.endpoint,
				subscription.keys.p256dh,
				subscription.keys.auth,
				expirationTime,
				DEFAULT_PUSH_PREFERENCES.needs_attention ? 1 : 0,
				DEFAULT_PUSH_PREFERENCES.work_finished ? 1 : 0,
				DEFAULT_PUSH_PREFERENCES.privacy,
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
	patch: Partial<PushPreferences>,
): Promise<StoredPushSubscription | null> {
	const current = await getPushSubscription(endpoint, authSessionHash);
	if (!current) return null;
	const preferences = { ...current.preferences, ...patch };
	const db = await getDb();
	db.run(
		`UPDATE push_subscriptions
		 SET needs_attention = ?, work_finished = ?, privacy = ?,
		     updated_at = unixepoch()
		 WHERE endpoint = ? AND auth_session_hash = ?
		   AND EXISTS (
		     SELECT 1 FROM auth_sessions owner
		     WHERE owner.token_hash = push_subscriptions.auth_session_hash
		       AND owner.expires_at > unixepoch()
		   )`,
		[
			preferences.needs_attention ? 1 : 0,
			preferences.work_finished ? 1 : 0,
			preferences.privacy,
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
		// Push services use 404/410 to revoke the endpoint capability. Retaining
		// its URL and encryption material would serve no recovery purpose.
		db.run(`DELETE FROM push_subscriptions WHERE endpoint = ?`, [endpoint]);
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
			.query<{ mode: "notify" | "mute" }, [string]>(
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

export function pushSubscriptionWantsNotification(
	subscription: Pick<StoredPushSubscription, "preferences">,
	kind: WebPushNotificationPayload["kind"],
	mode: SessionNotificationMode,
): boolean {
	if (mode === "mute") return false;
	if (mode === "notify") return true;
	return kind === "needs_attention"
		? subscription.preferences.needs_attention
		: subscription.preferences.work_finished;
}
