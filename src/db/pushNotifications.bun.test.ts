import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import {
	deletePushSubscription,
	disableExpiredPushSubscriptions,
	getPushSessionOverride,
	getPushSubscription,
	listDeliverablePushSubscriptions,
	pushSubscriptionWantsNotification,
	recordPushDeliveryFailure,
	recordPushDeliverySuccess,
	setPushSessionOverride,
	updatePushSubscriptionPreferences,
	upsertPushSubscription,
} from "./pushNotifications";
import { getDb, initializeSchema, setDbForTest } from "./schema";

const endpoint = "https://fcm.googleapis.com/fcm/send/device-one";
const AUTH_ONE = "auth-session-one";
const AUTH_TWO = "auth-session-two";

function subscription(suffix = "one", expirationTime: number | null = null) {
	return {
		endpoint: `https://fcm.googleapis.com/fcm/send/device-${suffix}`,
		expirationTime,
		keys: { p256dh: `public-${suffix}`, auth: `auth-${suffix}` },
	};
}

describe("Web Push subscription storage", () => {
	beforeEach(() => {
		const db = new Database(":memory:");
		setDbForTest(db);
		db.run(
			`INSERT INTO auth_sessions
			 (token_hash, created_at, expires_at, last_used_at)
			 VALUES (?, 1, 9999999999, 1), (?, 1, 9999999999, 1)`,
			[AUTH_ONE, AUTH_TWO],
		);
	});

	it("opts a device into quiet defaults and preserves choices on key refresh", async () => {
		const created = await upsertPushSubscription(subscription(), AUTH_ONE);
		expect(created).toMatchObject({
			authSessionHash: AUTH_ONE,
			endpoint,
			preferences: {
				needs_attention: true,
				work_finished: false,
				privacy: "generic",
			},
			enabled: true,
		});

		await updatePushSubscriptionPreferences(endpoint, AUTH_ONE, {
			needs_attention: false,
			work_finished: true,
			privacy: "detailed",
		});
		await upsertPushSubscription(
			{
				...subscription(),
				keys: { p256dh: "rotated-public", auth: "rotated-auth" },
			},
			AUTH_ONE,
		);

		expect(await getPushSubscription(endpoint)).toMatchObject({
			keys: { p256dh: "rotated-public", auth: "rotated-auth" },
			preferences: {
				needs_attention: false,
				work_finished: true,
				privacy: "detailed",
			},
		});
	});

	it("updates preferences, disables expired devices, and removes revoked keys", async () => {
		await upsertPushSubscription(subscription("one", Date.now() - 1), AUTH_ONE);
		await upsertPushSubscription(
			subscription("two", Date.now() + 60_000),
			AUTH_ONE,
		);
		expect(await disableExpiredPushSubscriptions()).toBe(1);
		expect(await listDeliverablePushSubscriptions()).toHaveLength(1);

		await recordPushDeliveryFailure(
			"https://fcm.googleapis.com/fcm/send/device-two",
			false,
		);
		expect(
			await getPushSubscription(
				"https://fcm.googleapis.com/fcm/send/device-two",
			),
		).toMatchObject({ failureCount: 1, enabled: true });
		await recordPushDeliverySuccess(
			"https://fcm.googleapis.com/fcm/send/device-two",
		);
		expect(
			await getPushSubscription(
				"https://fcm.googleapis.com/fcm/send/device-two",
			),
		).toMatchObject({ failureCount: 0 });

		await upsertPushSubscription(subscription("three"), AUTH_ONE);
		await recordPushDeliveryFailure(
			"https://fcm.googleapis.com/fcm/send/device-three",
			true,
		);
		expect(
			await getPushSubscription(
				"https://fcm.googleapis.com/fcm/send/device-three",
			),
		).toBeNull();

		expect(
			await deletePushSubscription(
				"https://fcm.googleapis.com/fcm/send/device-two",
				AUTH_ONE,
			),
		).toBe(true);
		expect(
			await getPushSubscription(
				"https://fcm.googleapis.com/fcm/send/device-two",
			),
		).toBeNull();
	});

	it("scopes device mutations and cascades the owning auth session", async () => {
		await upsertPushSubscription(subscription(), AUTH_ONE);
		expect(await getPushSubscription(endpoint, AUTH_TWO)).toBeNull();
		expect(
			await updatePushSubscriptionPreferences(endpoint, AUTH_TWO, {
				work_finished: true,
			}),
		).toBeNull();
		expect(await deletePushSubscription(endpoint, AUTH_TWO)).toBe(false);

		// Re-authenticating the same browser claims its stable endpoint for the new
		// durable trusted-device session.
		await upsertPushSubscription(subscription(), AUTH_TWO);
		expect(await getPushSubscription(endpoint)).toMatchObject({
			authSessionHash: AUTH_TWO,
		});
		const db = await getDb();
		db.run(`DELETE FROM auth_sessions WHERE token_hash = ?`, [AUTH_ONE]);
		expect(await getPushSubscription(endpoint)).not.toBeNull();
		db.run(`DELETE FROM auth_sessions WHERE token_hash = ?`, [AUTH_TWO]);
		expect(await getPushSubscription(endpoint)).toBeNull();
	});

	it("keeps nullable v1 subscriptions readable until a browser claims them", async () => {
		const db = await getDb();
		db.run(
			`INSERT INTO push_subscriptions
			 (id, endpoint, p256dh, auth)
			 VALUES ('legacy-device', ?, 'public', 'auth')`,
			[endpoint],
		);
		expect(await getPushSubscription(endpoint)).toMatchObject({
			authSessionHash: null,
			enabled: true,
		});

		await upsertPushSubscription(subscription(), AUTH_ONE);
		expect(await getPushSubscription(endpoint)).toMatchObject({
			authSessionHash: AUTH_ONE,
		});
	});

	it("upgrades the v1 subscription table without dropping existing devices", async () => {
		const db = await getDb();
		db.run(`DROP INDEX idx_push_subscriptions_auth_session`);
		db.run(`DROP TABLE push_subscriptions`);
		db.run(`
			CREATE TABLE push_subscriptions (
				id TEXT PRIMARY KEY,
				endpoint TEXT NOT NULL UNIQUE,
				p256dh TEXT NOT NULL,
				auth TEXT NOT NULL,
				expiration_time_ms INTEGER,
				needs_attention INTEGER NOT NULL DEFAULT 1,
				work_finished INTEGER NOT NULL DEFAULT 0,
				privacy TEXT NOT NULL DEFAULT 'generic',
				enabled INTEGER NOT NULL DEFAULT 1,
				created_at INTEGER NOT NULL DEFAULT (unixepoch()),
				updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
				last_success_at INTEGER,
				last_failure_at INTEGER,
				failure_count INTEGER NOT NULL DEFAULT 0
			)
		`);
		db.run(
			`INSERT INTO push_subscriptions (id, endpoint, p256dh, auth)
			 VALUES ('legacy-device', ?, 'public', 'auth')`,
			[endpoint],
		);
		db.run(
			`DELETE FROM settings WHERE key = '_migrated_web_push_auth_session_v2'`,
		);

		initializeSchema(db);
		expect(
			db
				.query<{ name: string }, []>(`PRAGMA table_info(push_subscriptions)`)
				.all()
				.map((column) => column.name),
		).toContain("auth_session_hash");
		expect(await getPushSubscription(endpoint)).toMatchObject({
			id: "legacy-device",
			authSessionHash: null,
		});
	});

	it("never delivers or claims through an expired auth session", async () => {
		await upsertPushSubscription(subscription(), AUTH_ONE);
		const db = await getDb();
		const nowMs = Date.now();
		db.run(`UPDATE auth_sessions SET expires_at = ? WHERE token_hash = ?`, [
			Math.floor(nowMs / 1_000) + 60,
			AUTH_ONE,
		]);
		// Delivery evaluates the event's supplied clock, rather than waiting for a
		// later login to prune the otherwise-still-present auth row.
		expect(await listDeliverablePushSubscriptions(nowMs + 120_000)).toEqual([]);
		expect(await getPushSubscription(endpoint, AUTH_ONE)).not.toBeNull();

		db.run(`UPDATE auth_sessions SET expires_at = 1 WHERE token_hash = ?`, [
			AUTH_ONE,
		]);

		expect(await listDeliverablePushSubscriptions()).toEqual([]);
		expect(await getPushSubscription(endpoint, AUTH_ONE)).toBeNull();
		await expect(
			upsertPushSubscription(subscription("expired-owner"), AUTH_ONE),
		).rejects.toThrow("Authenticated browser session expired");
	});

	it("stores installation-wide session overrides and cascades deleted sessions", async () => {
		const db = await getDb();
		db.run(`INSERT INTO sessions (id, started_at) VALUES ('session-1', 1)`);

		expect(await getPushSessionOverride("session-1")).toBe("default");
		expect(await setPushSessionOverride("missing", "notify")).toBeNull();
		expect(await setPushSessionOverride("session-1", "notify")).toBe("notify");
		expect(await getPushSessionOverride("session-1")).toBe("notify");
		expect(await setPushSessionOverride("session-1", "default")).toBe(
			"default",
		);
		expect(await getPushSessionOverride("session-1")).toBe("default");

		await setPushSessionOverride("session-1", "mute");
		db.run(`DELETE FROM sessions WHERE id = 'session-1'`);
		expect(await getPushSessionOverride("session-1")).toBe("default");
	});

	it("gives meaningful Notify and Mute semantics over device categories", () => {
		const device = {
			preferences: {
				needs_attention: false,
				work_finished: false,
				privacy: "generic" as const,
			},
		};
		expect(
			pushSubscriptionWantsNotification(device, "needs_attention", "default"),
		).toBe(false);
		expect(
			pushSubscriptionWantsNotification(device, "work_finished", "notify"),
		).toBe(true);
		expect(
			pushSubscriptionWantsNotification(device, "needs_attention", "mute"),
		).toBe(false);
	});
});
