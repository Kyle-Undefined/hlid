import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import {
	clearPushSessionNotifyOnce,
	deletePushSubscription,
	disableExpiredPushSubscriptions,
	getPushSessionOverride,
	getPushSubscription,
	listDeliverablePushSubscriptions,
	listPushSubscriptionDevices,
	pushSubscriptionWantsNotification,
	recordPushDeliveryFailure,
	recordPushDeliverySuccess,
	renamePushSubscriptionDevice,
	revokePushSubscriptionDevice,
	setPushSessionOverride,
	updatePushSubscriptionPreferences,
	upsertPushSubscription,
} from "./pushNotifications";
import { getDb, initializeSchema, setDbForTest } from "./schema";

const endpoint = "https://fcm.googleapis.com/fcm/send/device-one";
const AUTH_ONE = "auth-session-one";
const AUTH_TWO = "auth-session-two";

const detailedPreferences = {
	requests: true,
	problems: false,
	work_finished: true,
	privacy: "detailed" as const,
	completion_min_runtime_minutes: 5 as const,
	paused_until: null,
	paused_indefinitely: false,
};

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
			 (token_hash, created_at, expires_at, last_used_at, device_label)
			 VALUES (?, 1, 9999999999, 1, 'Phone'),
			        (?, 1, 9999999999, 1, 'Desktop')`,
			[AUTH_ONE, AUTH_TWO],
		);
	});

	it("uses quiet v2 defaults and preserves choices, names, and health on refresh", async () => {
		const created = await upsertPushSubscription(subscription(), AUTH_ONE);
		expect(created).toMatchObject({
			authSessionHash: AUTH_ONE,
			endpoint,
			name: "Phone",
			preferences: {
				requests: true,
				problems: true,
				work_finished: false,
				privacy: "generic",
				completion_min_runtime_minutes: 0,
				paused_until: null,
				paused_indefinitely: false,
			},
			enabled: true,
		});

		await updatePushSubscriptionPreferences(endpoint, AUTH_ONE, {
			requests: false,
			work_finished: true,
			privacy: "detailed",
			completion_min_runtime_minutes: 5,
			paused_until: 5_000,
		});
		await renamePushSubscriptionDevice(created.id, "Kyle's phone", AUTH_ONE);
		await recordPushDeliveryFailure(endpoint, false);
		await upsertPushSubscription(
			{
				...subscription(),
				keys: { p256dh: "rotated-public", auth: "rotated-auth" },
			},
			AUTH_ONE,
		);

		expect(await getPushSubscription(endpoint)).toMatchObject({
			name: "Kyle's phone",
			keys: { p256dh: "rotated-public", auth: "rotated-auth" },
			failureCount: 1,
			preferences: {
				requests: false,
				problems: true,
				work_finished: true,
				privacy: "detailed",
				completion_min_runtime_minutes: 5,
				paused_until: 5_000,
				paused_indefinitely: false,
			},
		});
		const db = await getDb();
		expect(
			db
				.query<{ needs_attention: number }, [string]>(
					`SELECT needs_attention FROM push_subscriptions WHERE endpoint = ?`,
				)
				.get(endpoint)?.needs_attention,
		).toBe(1);
	});

	it("carries a bounded custom name onto an endpoint replacement", async () => {
		const original = await upsertPushSubscription(subscription(), AUTH_ONE);
		await renamePushSubscriptionDevice(original.id, "Kyle's phone", AUTH_ONE);
		const replacement = await upsertPushSubscription(
			subscription("replacement"),
			AUTH_ONE,
			undefined,
			"Kyle's phone",
		);
		expect(replacement.name).toBe("Kyle's phone");
		expect(replacement.name.length).toBeLessThanOrEqual(80);
	});

	it("records provider health and retains expired or gone devices disabled", async () => {
		await upsertPushSubscription(subscription("one", Date.now() - 1), AUTH_ONE);
		await upsertPushSubscription(
			subscription("two", Date.now() + 60_000),
			AUTH_ONE,
		);
		// The upsert readback already evaluates effective expiration, so a later
		// cleanup pass has nothing left to change.
		expect(await disableExpiredPushSubscriptions()).toBe(0);
		expect(await listDeliverablePushSubscriptions()).toHaveLength(1);
		const devices = await listPushSubscriptionDevices(AUTH_ONE);
		expect(devices).toHaveLength(2);
		const expired = await getPushSubscription(endpoint);
		expect(expired?.enabled).toBe(false);
		expect(devices.find((device) => device.id === expired?.id)?.enabled).toBe(
			false,
		);

		const two = "https://fcm.googleapis.com/fcm/send/device-two";
		await recordPushDeliveryFailure(two, false);
		expect(await getPushSubscription(two)).toMatchObject({ failureCount: 1 });
		await recordPushDeliverySuccess(two);
		expect(await getPushSubscription(two)).toMatchObject({ failureCount: 0 });

		await recordPushDeliveryFailure(two, true);
		expect(await getPushSubscription(two)).toMatchObject({
			enabled: false,
			name: "Phone",
			failureCount: 1,
		});
	});

	it("lists, renames, and remotely revokes opaque devices without secret fields", async () => {
		const phone = await upsertPushSubscription(
			subscription(),
			AUTH_ONE,
			undefined,
			"My phone",
		);
		const desktop = await upsertPushSubscription(subscription("two"), AUTH_TWO);
		const devices = await listPushSubscriptionDevices(AUTH_ONE, endpoint);
		expect(devices).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					id: phone.id,
					name: "My phone",
					current: true,
				}),
				expect.objectContaining({
					id: desktop.id,
					name: "Desktop",
					current: false,
				}),
			]),
		);
		expect(JSON.stringify(devices)).not.toContain("fcm.googleapis.com");
		expect(JSON.stringify(devices)).not.toContain("public-two");

		expect(
			await renamePushSubscriptionDevice(
				phone.id,
				"Renamed phone",
				AUTH_TWO,
				endpoint,
			),
		).toMatchObject({ name: "Renamed phone", current: true });
		expect(await revokePushSubscriptionDevice(desktop.id, AUTH_ONE)).toBe(true);
		expect(await getPushSubscription(subscription("two").endpoint)).toBeNull();
	});

	it("scopes endpoint mutations to their owner while allowing install management", async () => {
		await upsertPushSubscription(subscription(), AUTH_ONE);
		expect(await getPushSubscription(endpoint, AUTH_TWO)).toBeNull();
		expect(
			await updatePushSubscriptionPreferences(endpoint, AUTH_TWO, {
				work_finished: true,
			}),
		).toBeNull();
		expect(await deletePushSubscription(endpoint, AUTH_TWO)).toBe(false);

		await upsertPushSubscription(subscription(), AUTH_TWO);
		expect(await getPushSubscription(endpoint)).toMatchObject({
			authSessionHash: AUTH_TWO,
		});
		const db = await getDb();
		db.run(`DELETE FROM auth_sessions WHERE token_hash = ?`, [AUTH_TWO]);
		expect(await getPushSubscription(endpoint)).toBeNull();
	});

	it("migrates legacy needs-attention choices into both v2 categories", async () => {
		const db = await getDb();
		db.run(`DROP INDEX idx_push_subscriptions_auth_session`);
		db.run(`DROP INDEX idx_push_subscriptions_delivery`);
		db.run(`DROP TABLE push_subscriptions`);
		db.run(`DROP TABLE push_session_overrides`);
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
				failure_count INTEGER NOT NULL DEFAULT 0,
				auth_session_hash TEXT REFERENCES auth_sessions(token_hash)
			)
		`);
		db.run(
			`CREATE INDEX idx_push_subscriptions_delivery
			 ON push_subscriptions(enabled, expiration_time_ms)`,
		);
		db.run(
			`CREATE INDEX idx_push_subscriptions_auth_session
			 ON push_subscriptions(auth_session_hash)`,
		);
		db.run(`
			CREATE TABLE push_session_overrides (
				session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
				mode TEXT NOT NULL CHECK(mode IN ('notify', 'mute')),
				updated_at INTEGER NOT NULL DEFAULT (unixepoch())
			)
		`);
		db.run(
			`INSERT INTO push_subscriptions
			 (id, endpoint, p256dh, auth, needs_attention, auth_session_hash)
			 VALUES ('legacy-device', ?, 'public', 'auth', 0, ?)`,
			[endpoint, AUTH_ONE],
		);
		db.run(`UPDATE auth_sessions SET device_label = ? WHERE token_hash = ?`, [
			`${"Phone".repeat(25)}\nspoofed`,
			AUTH_ONE,
		]);
		db.run(
			`DELETE FROM settings WHERE key = '_migrated_web_push_preferences_v3'`,
		);
		db.run(
			`DELETE FROM settings WHERE key = '_migrated_web_push_manual_pause_v4'`,
		);

		initializeSchema(db);
		expect(await getPushSubscription(endpoint)).toMatchObject({
			id: "legacy-device",
			name: "Phone".repeat(16),
			preferences: {
				requests: false,
				problems: false,
				paused_indefinitely: false,
			},
		});
	});

	it("never delivers or mutates through an expired auth session", async () => {
		await upsertPushSubscription(subscription(), AUTH_ONE);
		const db = await getDb();
		const nowMs = Date.now();
		db.run(`UPDATE auth_sessions SET expires_at = ? WHERE token_hash = ?`, [
			Math.floor(nowMs / 1_000) + 60,
			AUTH_ONE,
		]);
		expect(await listDeliverablePushSubscriptions(nowMs + 120_000)).toEqual([]);

		db.run(`UPDATE auth_sessions SET expires_at = 1 WHERE token_hash = ?`, [
			AUTH_ONE,
		]);
		await expect(listPushSubscriptionDevices(AUTH_ONE)).rejects.toThrow(
			"expired",
		);
	});

	it("stores and conditionally clears a one-shot session override", async () => {
		const db = await getDb();
		db.run(`INSERT INTO sessions (id, started_at) VALUES ('session-1', 1)`);

		expect(await getPushSessionOverride("session-1")).toBe("default");
		expect(await setPushSessionOverride("session-1", "notify_once")).toBe(
			"notify_once",
		);
		expect(await clearPushSessionNotifyOnce("session-1")).toBe(true);
		expect(await getPushSessionOverride("session-1")).toBe("default");

		await setPushSessionOverride("session-1", "notify");
		expect(await clearPushSessionNotifyOnce("session-1")).toBe(false);
		expect(await getPushSessionOverride("session-1")).toBe("notify");
	});

	it("applies split categories, pause, thresholds, and override precedence", () => {
		const device = { preferences: detailedPreferences };
		expect(
			pushSubscriptionWantsNotification(device, "needs_attention", "default", {
				reason: "permission",
				nowMs: 1_000,
			}),
		).toBe(true);
		expect(
			pushSubscriptionWantsNotification(device, "needs_attention", "default", {
				reason: "error",
				nowMs: 1_000,
			}),
		).toBe(false);
		expect(
			pushSubscriptionWantsNotification(device, "work_finished", "default", {
				runtimeMs: 299_999,
				nowMs: 1_000,
			}),
		).toBe(false);
		expect(
			pushSubscriptionWantsNotification(device, "work_finished", "default", {
				runtimeMs: 300_000,
				nowMs: 1_000,
			}),
		).toBe(true);

		const paused = {
			preferences: { ...detailedPreferences, paused_until: 10 },
		};
		expect(
			pushSubscriptionWantsNotification(
				paused,
				"needs_attention",
				"notify_once",
				{ reason: "error", nowMs: 1_000 },
			),
		).toBe(false);
		const manuallyPaused = {
			preferences: { ...detailedPreferences, paused_indefinitely: true },
		};
		expect(
			pushSubscriptionWantsNotification(
				manuallyPaused,
				"needs_attention",
				"notify",
				{ reason: "permission", nowMs: 1_000 },
			),
		).toBe(false);
		expect(
			pushSubscriptionWantsNotification(
				device,
				"needs_attention",
				"notify_once",
				{ reason: "error", nowMs: 1_000 },
			),
		).toBe(true);
		expect(
			pushSubscriptionWantsNotification(device, "needs_attention", "mute", {
				reason: "permission",
				nowMs: 1_000,
			}),
		).toBe(false);
	});
});
