import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import {
	pushPreferencesSchema,
	updatePushSessionOverrideSchema,
} from "../lib/pushNotificationSchemas";
import {
	addPushNotificationBatchMembers,
	cancelPushNotificationOneShotDeliveries,
	clearPushSessionNotifyOnce,
	clearPushSessionOneShot,
	createPushNotificationBatch,
	deletePushSubscription,
	disableExpiredPushSubscriptions,
	enqueuePushNotificationEvent,
	getEffectivePushSessionPolicy,
	getPushNotificationBatch,
	getPushNotificationEvent,
	getPushSessionOverride,
	getPushSessionPolicy,
	getPushSubscription,
	listDeliverablePushSubscriptions,
	listPendingPushNotificationDeliveries,
	listPendingPushNotificationEvents,
	listPushNotificationBatchMembers,
	listPushNotificationDeliveries,
	listPushNotificationDeliveryAttempts,
	listPushNotificationHistory,
	listPushSubscriptionDevices,
	MAX_PUSH_NOTIFICATION_EVENT_HISTORY,
	MAX_PUSH_SUBSCRIPTION_DEVICES,
	markPushNotificationBatchMemberRead,
	markPushNotificationBatchRead,
	prunePushNotificationHistory,
	pushSessionPolicyTargetsDevice,
	pushSubscriptionWantsNotification,
	reconcileDeliveredPushNotificationAttempts,
	reconcilePushNotificationOneShots,
	recordPushDeliveryFailure,
	recordPushDeliverySuccess,
	recordPushNotificationClientReceipt,
	recordPushNotificationDecision,
	recordPushNotificationDeliveryAttempt,
	recordPushNotificationReceipt,
	renamePushSubscriptionDevice,
	revokePushSubscriptionDevice,
	setPushSessionOverride,
	setPushSessionPolicy,
	terminatePushNotificationEvent,
	updatePushNotificationBatchStatus,
	updatePushNotificationEventStatus,
	updatePushSubscriptionDevice,
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
	quiet_hours: null,
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
		expect(replacement.id).toBe(original.id);
		expect(replacement.name).toBe("Kyle's phone");
		expect(replacement.name.length).toBeLessThanOrEqual(80);
	});

	it("rotates an endpoint in place at the device cap", async () => {
		const original = await upsertPushSubscription(
			subscription("rotation-original"),
			AUTH_ONE,
			detailedPreferences,
			"Targeted phone",
		);
		const db = await getDb();
		for (let index = 1; index < MAX_PUSH_SUBSCRIPTION_DEVICES; index += 1) {
			const authSessionHash = `cap-auth-${index}`;
			db.run(
				`INSERT INTO auth_sessions
				 (token_hash, created_at, expires_at, last_used_at, device_label)
				 VALUES (?, 1, 9999999999, 1, ?)`,
				[authSessionHash, `Device ${index}`],
			);
			await upsertPushSubscription(
				subscription(`cap-${index}`),
				authSessionHash,
			);
		}
		db.run(
			`INSERT INTO sessions (id, started_at) VALUES ('rotation-session', 1)`,
		);
		await setPushSessionPolicy("rotation-session", {
			mode: "notify",
			targetDeviceIds: [original.id],
		});

		const rotated = await upsertPushSubscription(
			subscription("rotation-next"),
			AUTH_ONE,
			undefined,
			undefined,
			original.endpoint,
		);

		expect(rotated).toMatchObject({
			id: original.id,
			name: "Targeted phone",
			preferences: detailedPreferences,
		});
		expect(await getPushSubscription(original.endpoint, AUTH_ONE)).toBeNull();
		expect(
			await getEffectivePushSessionPolicy("rotation-session"),
		).toMatchObject({ targetDeviceIds: [original.id] });
		expect(await listPushSubscriptionDevices(AUTH_ONE)).toHaveLength(
			MAX_PUSH_SUBSCRIPTION_DEVICES,
		);
	});

	it("records provider health and retains expired or gone devices disabled", async () => {
		await upsertPushSubscription(subscription("one", Date.now() - 1), AUTH_ONE);
		await upsertPushSubscription(
			subscription("two", Date.now() + 60_000),
			AUTH_TWO,
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
			name: "Desktop",
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

	it("round-trips the full quiet-hours profile through remote device edits", async () => {
		const phone = await upsertPushSubscription(subscription(), AUTH_ONE);
		const quietHours = {
			timezone: "America/New_York",
			start: "22:30",
			end: "07:15",
			weekdays: [1, 2, 3, 4, 5],
			allow_requests: true,
			allow_problems: false,
		};
		const updated = await updatePushSubscriptionDevice(
			phone.id,
			AUTH_TWO,
			{
				name: "Night phone",
				preferences: {
					quiet_hours: quietHours,
					requests: false,
				},
			},
			endpoint,
		);
		expect(updated).toMatchObject({
			id: phone.id,
			name: "Night phone",
			current: true,
			preferences: {
				requests: false,
				problems: true,
				quiet_hours: quietHours,
			},
		});
		expect((await listPushSubscriptionDevices(AUTH_ONE))[0]).toMatchObject({
			preferences: updated?.preferences,
		});
		expect((await getPushSubscription(endpoint))?.preferences).toEqual(
			updated?.preferences,
		);

		expect(() =>
			pushPreferencesSchema.parse({
				...detailedPreferences,
				quiet_hours: { ...quietHours, timezone: "Mars/Olympus_Mons" },
			}),
		).toThrow();
		expect(() =>
			pushPreferencesSchema.parse({
				...detailedPreferences,
				quiet_hours: { ...quietHours, start: "25:00" },
			}),
		).toThrow();
		expect(() =>
			pushPreferencesSchema.parse({
				...detailedPreferences,
				quiet_hours: { ...quietHours, weekdays: [1, 1] },
			}),
		).toThrow();
		const db = await getDb();
		db.run(`UPDATE push_subscriptions SET quiet_hours_json = 'not-json'`);
		expect(
			(await getPushSubscription(endpoint))?.preferences.quiet_hours,
		).toEqual({
			timezone: "UTC",
			start: "00:00",
			end: "00:00",
			weekdays: [1, 2, 3, 4, 5, 6, 7],
			allow_requests: false,
			allow_problems: false,
		});
	});

	it("scopes endpoint mutations to their owner while allowing install management", async () => {
		const original = await upsertPushSubscription(subscription(), AUTH_ONE);
		expect(await getPushSubscription(endpoint, AUTH_TWO)).toBeNull();
		expect(
			await updatePushSubscriptionPreferences(endpoint, AUTH_TWO, {
				work_finished: true,
			}),
		).toBeNull();
		expect(await deletePushSubscription(endpoint, AUTH_TWO)).toBe(false);

		await expect(
			upsertPushSubscription(subscription(), AUTH_TWO),
		).rejects.toThrow("already registered to another browser");
		expect(await getPushSubscription(endpoint)).toMatchObject({
			id: original.id,
			authSessionHash: AUTH_ONE,
		});
		const db = await getDb();
		db.run(`DELETE FROM auth_sessions WHERE token_hash = ?`, [AUTH_ONE]);
		expect(await getPushSubscription(endpoint)).toBeNull();
	});

	it("repairs a server-unknown replacement through the sole owned device", async () => {
		const original = await upsertPushSubscription(
			subscription("repair-a"),
			AUTH_ONE,
			detailedPreferences,
			"Travel phone",
		);

		const repaired = await upsertPushSubscription(
			subscription("repair-c"),
			AUTH_ONE,
			undefined,
			undefined,
			subscription("repair-b").endpoint,
		);

		expect(repaired).toMatchObject({
			id: original.id,
			name: "Travel phone",
			preferences: detailedPreferences,
		});
		expect(
			await getPushSubscription(subscription("repair-a").endpoint),
		).toBeNull();
		expect(
			await getPushSubscription(subscription("repair-c").endpoint, AUTH_ONE),
		).toMatchObject({ id: original.id });
	});

	it("registers a fresh identity when stale repair metadata has no owned row", async () => {
		const original = await upsertPushSubscription(
			subscription("expired-owner"),
			AUTH_ONE,
		);
		const db = await getDb();
		db.run(`DELETE FROM auth_sessions WHERE token_hash = ?`, [AUTH_ONE]);
		expect(await getPushSubscription(original.endpoint)).toBeNull();

		const fresh = await upsertPushSubscription(
			subscription("fresh-owner"),
			AUTH_TWO,
			detailedPreferences,
			"Replacement desktop",
			subscription("server-missing").endpoint,
		);
		expect(fresh).toMatchObject({
			name: "Replacement desktop",
			preferences: detailedPreferences,
			authSessionHash: AUTH_TWO,
		});
		expect(fresh.id).not.toBe(original.id);
	});

	it("fails closed when an implicit endpoint replacement is ambiguous", async () => {
		await upsertPushSubscription(subscription("ambiguous-a"), AUTH_ONE);
		const second = await upsertPushSubscription(
			subscription("ambiguous-b"),
			AUTH_TWO,
		);
		const db = await getDb();
		db.run(`UPDATE push_subscriptions SET auth_session_hash = ? WHERE id = ?`, [
			AUTH_ONE,
			second.id,
		]);

		await expect(
			upsertPushSubscription(subscription("ambiguous-c"), AUTH_ONE),
		).rejects.toThrow("replacement is ambiguous");
		expect(
			await getPushSubscription(subscription("ambiguous-c").endpoint),
		).toBeNull();
	});

	it("claims a legacy unowned endpoint without allowing a live-owner takeover", async () => {
		const legacy = await upsertPushSubscription(
			subscription("legacy-claim"),
			AUTH_ONE,
			detailedPreferences,
			"Legacy phone",
		);
		const db = await getDb();
		db.run(
			`UPDATE push_subscriptions SET auth_session_hash = NULL WHERE id = ?`,
			[legacy.id],
		);

		const claimed = await upsertPushSubscription(
			{
				...subscription("legacy-claim"),
				keys: { p256dh: "claimed-public", auth: "claimed-auth" },
			},
			AUTH_TWO,
		);
		expect(claimed).toMatchObject({
			id: legacy.id,
			authSessionHash: AUTH_TWO,
			name: "Legacy phone",
			keys: { p256dh: "claimed-public", auth: "claimed-auth" },
		});
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
		db.run(`INSERT INTO sessions (id, started_at) VALUES ('legacy-policy', 1)`);
		db.run(
			`INSERT INTO push_session_overrides (session_id, mode)
			 VALUES ('legacy-policy', 'mute')`,
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
		db.run(`DELETE FROM settings WHERE key = '_migrated_web_push_policy_v5'`);

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
		expect(await getPushSessionPolicy("legacy-policy")).toMatchObject({
			mode: "mute",
			scope: "session",
			targetDeviceIds: null,
		});
	});

	it("removes durable repeats without discarding another device's retry or visible deferral", async () => {
		const db = await getDb();
		const tabletAuth = "auth-session-tablet";
		db.run(
			`INSERT INTO auth_sessions
			 (token_hash, created_at, expires_at, last_used_at, device_label)
			 VALUES (?, 1, 9999999999, 1, 'Tablet')`,
			[tabletAuth],
		);
		const phone = await upsertPushSubscription(
			subscription("removed-repeat-phone"),
			AUTH_ONE,
		);
		const desktop = await upsertPushSubscription(
			subscription("removed-repeat-desktop"),
			AUTH_TWO,
		);
		const tablet = await upsertPushSubscription(
			subscription("removed-repeat-tablet"),
			tabletAuth,
		);

		const repeatOnly = await enqueuePushNotificationEvent({
			id: "removed-repeat-only-event",
			sourceKind: "session",
			sourceId: "removed-repeat-only-session",
			category: "request",
			occurredAt: 1_000,
			expiresAt: 100_000,
		});
		const repeatOnlyDelivery = await recordPushNotificationDecision({
			eventId: repeatOnly.id,
			device: {
				id: phone.id,
				name: phone.name,
				privacy: phone.preferences.privacy,
				preferences: phone.preferences,
			},
			status: "pending",
			reason: "eligible",
		});
		await recordPushNotificationReceipt({
			eventId: repeatOnly.id,
			deviceId: phone.id,
			status: "sent",
			reason: "reminder_scheduled",
			nextAttemptAt: 5_000,
			receiptAt: 2_000,
		});
		await updatePushNotificationEventStatus(repeatOnly.id, {
			status: "deferred",
			reason: "device_retry",
			nextAttemptAt: 5_000,
		});

		const mixed = await enqueuePushNotificationEvent({
			id: "removed-repeat-mixed-event",
			sourceKind: "session",
			sourceId: "removed-repeat-mixed-session",
			category: "problem",
			occurredAt: 1_100,
			expiresAt: 100_000,
		});
		for (const device of [phone, desktop, tablet]) {
			await recordPushNotificationDecision({
				eventId: mixed.id,
				device: {
					id: device.id,
					name: device.name,
					privacy: device.preferences.privacy,
					preferences: device.preferences,
				},
				status: "pending",
				reason: "eligible",
			});
		}
		await recordPushNotificationReceipt({
			eventId: mixed.id,
			deviceId: phone.id,
			status: "sent",
			reason: "reminder_scheduled",
			nextAttemptAt: 5_000,
			receiptAt: 2_000,
		});
		await recordPushNotificationReceipt({
			eventId: mixed.id,
			deviceId: desktop.id,
			status: "failed",
			reason: "provider_failure",
			nextAttemptAt: 7_000,
			receiptAt: 2_100,
		});
		await recordPushNotificationDecision({
			eventId: mixed.id,
			device: {
				id: tablet.id,
				name: tablet.name,
				privacy: tablet.preferences.privacy,
				preferences: tablet.preferences,
			},
			status: "queued",
			reason: "visible",
			nextAttemptAt: 8_000,
		});
		await updatePushNotificationEventStatus(mixed.id, {
			status: "deferred",
			reason: "device_retry",
			nextAttemptAt: 5_000,
		});

		const legacySnapshot = {
			id: phone.id,
			name: phone.name,
			privacy: phone.preferences.privacy,
			preferences: { ...phone.preferences, reminder_minutes: 15 },
		};
		db.run(
			`UPDATE push_notification_deliveries
			 SET device_snapshot_json = ? WHERE id = ?`,
			[JSON.stringify(legacySnapshot), repeatOnlyDelivery.id],
		);
		db.run(`
			ALTER TABLE push_subscriptions
			ADD COLUMN reminder_minutes INTEGER NOT NULL DEFAULT 0
				CHECK(reminder_minutes IN (0, 5, 15, 30, 60))
		`);
		db.run(
			`DELETE FROM settings
			 WHERE key = '_migrated_web_push_remove_reminders_v11'`,
		);

		initializeSchema(db);

		const subscriptionColumns = db
			.query<{ name: string }, []>(`PRAGMA table_info(push_subscriptions)`)
			.all()
			.map((column) => column.name);
		expect(subscriptionColumns).not.toContain("reminder_minutes");
		expect(await getPushNotificationEvent(repeatOnly.id)).toMatchObject({
			status: "processed",
			statusReason: "delivery_complete",
			nextAttemptAt: null,
		});
		expect(await listPushNotificationDeliveries(repeatOnly.id)).toEqual([
			expect.objectContaining({
				status: "sent",
				reason: "accepted",
				nextAttemptAt: null,
				deviceSnapshot: expect.objectContaining({
					preferences: phone.preferences,
				}),
			}),
		]);

		expect(await getPushNotificationEvent(mixed.id)).toMatchObject({
			status: "deferred",
			statusReason: "device_retry",
			nextAttemptAt: 7_000,
		});
		const mixedDeliveries = await listPushNotificationDeliveries(mixed.id);
		expect(
			mixedDeliveries.find((row) => row.deviceId === phone.id),
		).toMatchObject({
			status: "sent",
			reason: "accepted",
			nextAttemptAt: null,
		});
		expect(
			mixedDeliveries.find((row) => row.deviceId === desktop.id),
		).toMatchObject({
			status: "failed",
			reason: "provider_failure",
			nextAttemptAt: 7_000,
		});
		expect(
			mixedDeliveries.find((row) => row.deviceId === tablet.id),
		).toMatchObject({
			status: "queued",
			reason: "visible",
			nextAttemptAt: 8_000,
		});
	});

	it("removes delayed catch-up without discarding provider retries or unrelated deferrals", async () => {
		const db = await getDb();
		const tabletAuth = "auth-session-catch-up-tablet";
		db.run(
			`INSERT INTO auth_sessions
			 (token_hash, created_at, expires_at, last_used_at, device_label)
			 VALUES (?, 1, 9999999999, 1, 'Tablet')`,
			[tabletAuth],
		);
		const phone = await upsertPushSubscription(
			subscription("removed-catch-up-phone"),
			AUTH_ONE,
		);
		const desktop = await upsertPushSubscription(
			subscription("removed-catch-up-desktop"),
			AUTH_TWO,
		);
		const tablet = await upsertPushSubscription(
			subscription("removed-catch-up-tablet"),
			tabletAuth,
		);

		const suppressedOnly = await enqueuePushNotificationEvent({
			id: "removed-catch-up-only-event",
			sourceKind: "session",
			sourceId: "removed-catch-up-only-session",
			category: "request",
			occurredAt: 1_000,
			expiresAt: 100_000,
			status: "deferred",
			statusReason: "pause",
			nextAttemptAt: null,
		});
		await recordPushNotificationDecision({
			eventId: suppressedOnly.id,
			device: {
				id: phone.id,
				name: phone.name,
				privacy: phone.preferences.privacy,
				preferences: phone.preferences,
			},
			status: "queued",
			reason: "pause",
			nextAttemptAt: null,
		});

		const mixed = await enqueuePushNotificationEvent({
			id: "removed-catch-up-mixed-event",
			sourceKind: "session",
			sourceId: "removed-catch-up-mixed-session",
			category: "problem",
			occurredAt: 1_100,
			expiresAt: 100_000,
			status: "deferred",
			statusReason: "quiet_hours",
			nextAttemptAt: 5_000,
		});
		await recordPushNotificationDecision({
			eventId: mixed.id,
			device: {
				id: phone.id,
				name: phone.name,
				privacy: phone.preferences.privacy,
				preferences: phone.preferences,
			},
			status: "queued",
			reason: "quiet_hours",
			nextAttemptAt: 5_000,
		});
		await recordPushNotificationDecision({
			eventId: mixed.id,
			device: {
				id: desktop.id,
				name: desktop.name,
				privacy: desktop.preferences.privacy,
				preferences: desktop.preferences,
			},
			status: "pending",
			reason: "eligible",
		});
		await recordPushNotificationReceipt({
			eventId: mixed.id,
			deviceId: desktop.id,
			status: "failed",
			reason: "provider_failure",
			nextAttemptAt: 7_000,
			receiptAt: 2_000,
		});
		await recordPushNotificationDecision({
			eventId: mixed.id,
			device: {
				id: tablet.id,
				name: tablet.name,
				privacy: tablet.preferences.privacy,
				preferences: tablet.preferences,
			},
			status: "queued",
			reason: "visible",
			nextAttemptAt: 8_000,
		});

		await enqueuePushNotificationEvent({
			id: "removed-catch-up-event-only",
			sourceKind: "system",
			sourceId: "removed-catch-up-system",
			category: "completion",
			occurredAt: 1_200,
			expiresAt: 100_000,
			status: "deferred",
			statusReason: "quiet_hours",
			nextAttemptAt: 9_000,
		});

		db.run(`
			ALTER TABLE push_subscriptions
			ADD COLUMN catch_up_after_pause INTEGER NOT NULL DEFAULT 0
				CHECK(catch_up_after_pause IN (0, 1))
		`);
		db.run(
			`UPDATE push_subscriptions
			 SET catch_up_after_pause = 1, quiet_hours_json = ? WHERE id = ?`,
			[
				JSON.stringify({
					timezone: "America/New_York",
					start: "22:00",
					end: "07:00",
					weekdays: [1, 2, 3, 4, 5],
					allow_requests: true,
					allow_problems: false,
					catch_up: true,
				}),
				phone.id,
			],
		);
		db.run(
			`DELETE FROM settings
			 WHERE key = '_migrated_web_push_remove_catch_up_v12'`,
		);

		initializeSchema(db);

		const subscriptionColumns = db
			.query<{ name: string }, []>(`PRAGMA table_info(push_subscriptions)`)
			.all()
			.map((column) => column.name);
		expect(subscriptionColumns).not.toContain("catch_up_after_pause");
		expect(
			db
				.query<{ quiet_hours_json: string }, [string]>(
					`SELECT quiet_hours_json FROM push_subscriptions WHERE id = ?`,
				)
				.get(phone.id)?.quiet_hours_json,
		).not.toContain("catch_up");
		const migratedPreferences = (await getPushSubscription(phone.endpoint))
			?.preferences;
		expect(migratedPreferences).not.toHaveProperty("catch_up_after_pause");
		expect(migratedPreferences?.quiet_hours).not.toHaveProperty("catch_up");
		expect(migratedPreferences).toMatchObject({
			quiet_hours: {
				timezone: "America/New_York",
				start: "22:00",
				end: "07:00",
				weekdays: [1, 2, 3, 4, 5],
				allow_requests: true,
				allow_problems: false,
			},
		});
		expect(await getPushNotificationEvent(suppressedOnly.id)).toMatchObject({
			status: "processed",
			statusReason: "delivery_complete",
			nextAttemptAt: null,
		});
		expect(await listPushNotificationDeliveries(suppressedOnly.id)).toEqual([
			expect.objectContaining({
				status: "suppressed",
				reason: "pause",
				nextAttemptAt: null,
			}),
		]);
		expect(
			await getPushNotificationEvent("removed-catch-up-event-only"),
		).toMatchObject({
			status: "processed",
			statusReason: "delivery_complete",
			nextAttemptAt: null,
		});

		expect(await getPushNotificationEvent(mixed.id)).toMatchObject({
			status: "deferred",
			statusReason: "device_retry",
			nextAttemptAt: 7_000,
		});
		const mixedDeliveries = await listPushNotificationDeliveries(mixed.id);
		expect(
			mixedDeliveries.find((row) => row.deviceId === phone.id),
		).toMatchObject({
			status: "suppressed",
			reason: "quiet_hours",
			nextAttemptAt: null,
		});
		expect(
			mixedDeliveries.find((row) => row.deviceId === desktop.id),
		).toMatchObject({
			status: "failed",
			reason: "provider_failure",
			nextAttemptAt: 7_000,
		});
		expect(
			mixedDeliveries.find((row) => row.deviceId === tablet.id),
		).toMatchObject({
			status: "queued",
			reason: "visible",
			nextAttemptAt: 8_000,
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

	it("consumes an accepted one-shot while preserving authorization on remaining fanout", async () => {
		const db = await getDb();
		db.run(
			`INSERT INTO sessions (id, started_at) VALUES ('one-shot-fanout', 1)`,
		);
		const phone = await upsertPushSubscription(
			subscription("one-shot-phone"),
			AUTH_ONE,
		);
		const desktop = await upsertPushSubscription(
			subscription("one-shot-desktop"),
			AUTH_TWO,
		);
		const oneShotPolicy = await setPushSessionPolicy("one-shot-fanout", {
			mode: "notify_once",
		});
		if (!oneShotPolicy) throw new Error("Expected a one-shot policy");
		const notification = await enqueuePushNotificationEvent({
			id: "one-shot-fanout-event",
			sourceKind: "session",
			sourceId: "one-shot-fanout",
			category: "request",
			reason: "permission",
			occurredAt: 1_000,
			expiresAt: 100_000,
		});
		for (const device of [phone, desktop]) {
			await recordPushNotificationDecision({
				eventId: notification.id,
				device: {
					id: device.id,
					name: device.name,
					privacy: device.preferences.privacy,
					preferences: device.preferences,
					oneShot: {
						sourceSessionId: "one-shot-fanout",
						mode: "notify_once",
						policyUpdatedAt: oneShotPolicy.updatedAt,
					},
				},
				status: "pending",
			});
		}
		await recordPushNotificationReceipt({
			eventId: notification.id,
			deviceId: phone.id,
			status: "sent",
			reason: "accepted",
			receiptAt: 2_000,
			oneShot: {
				sourceSessionId: "one-shot-fanout",
				mode: "notify_once",
				policyUpdatedAt: oneShotPolicy.updatedAt,
			},
		});
		await recordPushNotificationReceipt({
			eventId: notification.id,
			deviceId: desktop.id,
			status: "failed",
			reason: "provider_failure",
			nextAttemptAt: 3_000,
			receiptAt: 2_000,
		});

		expect(await reconcilePushNotificationOneShots()).toBe(1);
		expect(await getPushSessionOverride("one-shot-fanout")).toBe("default");
		expect(
			(await listPushNotificationDeliveries(notification.id)).find(
				(row) => row.deviceId === desktop.id,
			),
		).toMatchObject({
			status: "failed",
			nextAttemptAt: 3_000,
			deviceSnapshot: {
				oneShot: {
					sourceSessionId: "one-shot-fanout",
					mode: "notify_once",
					policyUpdatedAt: oneShotPolicy.updatedAt,
				},
			},
		});
	});

	it("does not let an old acceptance clear a re-armed one-shot revision", async () => {
		const db = await getDb();
		db.run(`INSERT INTO sessions (id, started_at) VALUES ('one-shot-aba', 1)`);
		const phone = await upsertPushSubscription(
			subscription("one-shot-aba"),
			AUTH_ONE,
		);
		const firstPolicy = await setPushSessionPolicy("one-shot-aba", {
			mode: "notify_once",
			targetDeviceIds: [phone.id],
		});
		if (!firstPolicy) throw new Error("Expected the first one-shot policy");
		const notification = await enqueuePushNotificationEvent({
			id: "one-shot-aba-event",
			sourceKind: "session",
			sourceId: "one-shot-aba",
			category: "request",
			occurredAt: 1_000,
			expiresAt: 100_000,
		});
		await recordPushNotificationDecision({
			eventId: notification.id,
			device: {
				id: phone.id,
				name: phone.name,
				privacy: phone.preferences.privacy,
			},
			status: "pending",
		});
		await recordPushNotificationReceipt({
			eventId: notification.id,
			deviceId: phone.id,
			status: "sent",
			oneShot: {
				sourceSessionId: "one-shot-aba",
				mode: "notify_once",
				policyUpdatedAt: firstPolicy.updatedAt,
			},
		});

		const rearmed = await setPushSessionPolicy("one-shot-aba", {
			mode: "notify_once",
			scope: "delegation_tree",
			targetDeviceIds: null,
		});
		if (!rearmed) throw new Error("Expected the re-armed one-shot policy");
		expect(rearmed.updatedAt).toBeGreaterThan(firstPolicy.updatedAt);
		expect(await reconcilePushNotificationOneShots()).toBe(1);
		expect(await getPushSessionPolicy("one-shot-aba")).toMatchObject({
			mode: "notify_once",
			scope: "delegation_tree",
			updatedAt: rearmed.updatedAt,
		});
	});

	it("retains distinct crash markers when one event spans two one-shot revisions", async () => {
		const db = await getDb();
		db.run(
			`INSERT INTO sessions (id, started_at) VALUES ('one-shot-revision-event', 1)`,
		);
		const phone = await upsertPushSubscription(
			subscription("revision-phone"),
			AUTH_ONE,
		);
		const desktop = await upsertPushSubscription(
			subscription("revision-desktop"),
			AUTH_TWO,
		);
		const first = await setPushSessionPolicy("one-shot-revision-event", {
			mode: "notify_once",
		});
		if (!first) throw new Error("Expected the first one-shot revision");
		const notification = await enqueuePushNotificationEvent({
			id: "one-shot-revision-event-row",
			sourceKind: "session",
			sourceId: "one-shot-revision-event",
			category: "request",
			occurredAt: 1_000,
			expiresAt: 100_000,
		});
		for (const device of [phone, desktop]) {
			await recordPushNotificationDecision({
				eventId: notification.id,
				device: {
					id: device.id,
					name: device.name,
					privacy: device.preferences.privacy,
					oneShot: {
						sourceSessionId: notification.sourceId,
						mode: "notify_once",
						policyUpdatedAt: first.updatedAt,
					},
				},
				status: "pending",
			});
		}
		await recordPushNotificationReceipt({
			eventId: notification.id,
			deviceId: phone.id,
			status: "sent",
			oneShot: {
				sourceSessionId: notification.sourceId,
				mode: "notify_once",
				policyUpdatedAt: first.updatedAt,
			},
		});
		const second = await setPushSessionPolicy("one-shot-revision-event", {
			mode: "notify_once",
			scope: "delegation_tree",
		});
		if (!second) throw new Error("Expected the re-armed one-shot revision");
		await recordPushNotificationDecision({
			eventId: notification.id,
			device: {
				id: desktop.id,
				name: desktop.name,
				privacy: desktop.preferences.privacy,
				oneShot: {
					sourceSessionId: notification.sourceId,
					mode: "notify_once",
					policyUpdatedAt: second.updatedAt,
				},
			},
			status: "pending",
		});
		await recordPushNotificationReceipt({
			eventId: notification.id,
			deviceId: desktop.id,
			status: "sent",
			oneShot: {
				sourceSessionId: notification.sourceId,
				mode: "notify_once",
				policyUpdatedAt: second.updatedAt,
			},
		});

		expect(await reconcilePushNotificationOneShots()).toBe(2);
		expect(await getPushSessionOverride(notification.sourceId)).toBe("default");
	});

	it("does not retain a consumed tree one-shot on an unrelated sibling event", async () => {
		const db = await getDb();
		db.run(
			`INSERT INTO sessions (id, started_at)
			 VALUES ('one-shot-tree-root', 1),
			        ('one-shot-tree-child-a', 1),
			        ('one-shot-tree-child-b', 1)`,
		);
		const phone = await upsertPushSubscription(
			subscription("one-shot-tree-phone"),
			AUTH_ONE,
		);
		const rootPolicy = await setPushSessionPolicy("one-shot-tree-root", {
			mode: "notify_once",
			scope: "delegation_tree",
		});
		if (!rootPolicy) throw new Error("Expected the tree one-shot policy");
		const first = await enqueuePushNotificationEvent({
			id: "one-shot-tree-event-a",
			sourceKind: "session",
			sourceId: "one-shot-tree-child-a",
			category: "request",
			occurredAt: 1_000,
			expiresAt: 100_000,
		});
		const second = await enqueuePushNotificationEvent({
			id: "one-shot-tree-event-b",
			sourceKind: "session",
			sourceId: "one-shot-tree-child-b",
			category: "request",
			occurredAt: 1_001,
			expiresAt: 100_000,
		});
		const partialBatch = await createPushNotificationBatch({
			id: "one-shot-tree-partial-batch",
			category: "request",
			status: "ready",
			createdAt: 1_100,
		});
		await addPushNotificationBatchMembers(
			partialBatch.id,
			[
				{ eventId: first.id, sessionId: first.sourceId },
				{ eventId: second.id, sessionId: second.sourceId },
			],
			1_100,
		);
		const snapshot = {
			sourceSessionId: "one-shot-tree-root",
			mode: "notify_once" as const,
			policyUpdatedAt: rootPolicy.updatedAt,
		};
		for (const event of [first, second]) {
			await recordPushNotificationDecision({
				eventId: event.id,
				device: {
					id: phone.id,
					name: phone.name,
					privacy: phone.preferences.privacy,
					oneShot: snapshot,
				},
				status: "pending",
			});
		}
		await recordPushNotificationReceipt({
			eventId: first.id,
			deviceId: phone.id,
			status: "failed",
			reason: "provider_failure",
			nextAttemptAt: 5_000,
			receiptAt: 2_000,
		});
		await recordPushNotificationReceipt({
			eventId: second.id,
			deviceId: phone.id,
			status: "sent",
			reason: "accepted",
			receiptAt: 2_001,
			oneShot: snapshot,
		});

		expect(await reconcilePushNotificationOneShots()).toBe(1);
		expect(await getPushSessionOverride("one-shot-tree-root")).toBe("default");
		expect(await listPushNotificationDeliveries(first.id)).toEqual([
			expect.objectContaining({
				status: "suppressed",
				reason: "one_shot_consumed_other_event",
				nextAttemptAt: null,
			}),
		]);
		expect(await listPushNotificationDeliveries(second.id)).toEqual([
			expect.objectContaining({ status: "sent", reason: "accepted" }),
		]);
	});

	it("cancels queued one-shot authorization when the user returns to Default", async () => {
		const db = await getDb();
		db.run(
			`INSERT INTO sessions (id, started_at) VALUES ('one-shot-cancel', 1)`,
		);
		const phone = await upsertPushSubscription(
			subscription("one-shot-cancel"),
			AUTH_ONE,
		);
		await setPushSessionPolicy("one-shot-cancel", { mode: "notify_once" });
		const notification = await enqueuePushNotificationEvent({
			id: "one-shot-cancel-event",
			sourceKind: "session",
			sourceId: "one-shot-cancel",
			category: "request",
			reason: "question",
			occurredAt: 1_000,
			expiresAt: 100_000,
			status: "deferred",
			statusReason: "quiet_hours",
			nextAttemptAt: 50_000,
		});
		await recordPushNotificationDecision({
			eventId: notification.id,
			device: {
				id: phone.id,
				name: phone.name,
				privacy: phone.preferences.privacy,
				preferences: phone.preferences,
				oneShot: {
					sourceSessionId: "one-shot-cancel",
					mode: "notify_once",
				},
			},
			status: "queued",
			reason: "quiet_hours",
			nextAttemptAt: 50_000,
		});

		await setPushSessionOverride("one-shot-cancel", "default");
		expect(
			await cancelPushNotificationOneShotDeliveries("one-shot-cancel", 2_000),
		).toBe(0);
		expect(await listPushNotificationDeliveries(notification.id)).toEqual([
			expect.objectContaining({
				status: "suppressed",
				reason: "one_shot_cancelled",
				nextAttemptAt: null,
			}),
		]);
		expect(await getPushNotificationEvent(notification.id)).toMatchObject({
			status: "deferred",
			statusReason: "one_shot_cancelled",
			nextAttemptAt: expect.any(Number),
		});
		// A worker that read the old row before cancellation cannot resurrect it.
		expect(
			await recordPushNotificationDecision({
				eventId: notification.id,
				device: {
					id: phone.id,
					name: phone.name,
					privacy: phone.preferences.privacy,
					oneShot: {
						sourceSessionId: "one-shot-cancel",
						mode: "notify_once",
					},
				},
				status: "pending",
				reason: "eligible",
			}),
		).toMatchObject({
			status: "suppressed",
			reason: "one_shot_cancelled",
			nextAttemptAt: null,
		});
		expect(
			await recordPushNotificationReceipt({
				eventId: notification.id,
				deviceId: phone.id,
				status: "failed",
				reason: "provider_failure",
				nextAttemptAt: 10_000,
				receiptAt: 3_000,
			}),
		).toBeNull();
		expect(await listPushNotificationDeliveries(notification.id)).toEqual([
			expect.objectContaining({
				status: "suppressed",
				reason: "one_shot_cancelled",
				nextAttemptAt: null,
			}),
		]);
	});

	it("rejects a stale first one-shot decision after Default or Mute", async () => {
		const db = await getDb();
		db.run(
			`INSERT INTO sessions (id, started_at) VALUES ('one-shot-first-row', 1)`,
		);
		const phone = await upsertPushSubscription(
			subscription("one-shot-first-row-phone"),
			AUTH_ONE,
		);
		const stalePolicy = await setPushSessionPolicy("one-shot-first-row", {
			mode: "notify_once",
		});
		if (!stalePolicy) throw new Error("Expected the initial one-shot policy");
		const first = await enqueuePushNotificationEvent({
			id: "one-shot-first-row-default-event",
			sourceKind: "session",
			sourceId: "one-shot-first-row",
			category: "request",
			occurredAt: 1_000,
			expiresAt: 100_000,
		});
		await setPushSessionOverride(first.sourceId, "default");
		expect(
			await recordPushNotificationDecision({
				eventId: first.id,
				device: {
					id: phone.id,
					name: phone.name,
					privacy: phone.preferences.privacy,
					oneShot: {
						sourceSessionId: first.sourceId,
						mode: "notify_once",
						policyUpdatedAt: stalePolicy.updatedAt,
					},
				},
				status: "pending",
				reason: "eligible",
			}),
		).toMatchObject({
			status: "suppressed",
			reason: "one_shot_cancelled",
			nextAttemptAt: null,
		});

		const rearmed = await setPushSessionPolicy(first.sourceId, {
			mode: "notify_once",
		});
		if (!rearmed) throw new Error("Expected the re-armed one-shot policy");
		const second = await enqueuePushNotificationEvent({
			id: "one-shot-first-row-mute-event",
			sourceKind: "session",
			sourceId: first.sourceId,
			category: "request",
			occurredAt: 2_000,
			expiresAt: 100_000,
		});
		await setPushSessionPolicy(first.sourceId, { mode: "mute" });
		expect(
			await recordPushNotificationDecision({
				eventId: second.id,
				device: {
					id: phone.id,
					name: phone.name,
					privacy: phone.preferences.privacy,
					oneShot: {
						sourceSessionId: second.sourceId,
						mode: "notify_once",
						policyUpdatedAt: rearmed.updatedAt,
					},
				},
				status: "pending",
				reason: "eligible",
			}),
		).toMatchObject({
			status: "suppressed",
			reason: "one_shot_cancelled",
			nextAttemptAt: null,
		});

		const existingEvent = await enqueuePushNotificationEvent({
			id: "one-shot-existing-default-event",
			sourceKind: "session",
			sourceId: first.sourceId,
			category: "request",
			occurredAt: 3_000,
			expiresAt: 100_000,
		});
		await recordPushNotificationDecision({
			eventId: existingEvent.id,
			device: {
				id: phone.id,
				name: phone.name,
				privacy: phone.preferences.privacy,
			},
			status: "queued",
			reason: "quiet_hours",
			nextAttemptAt: 10_000,
		});
		const existingPolicy = await setPushSessionPolicy(first.sourceId, {
			mode: "notify_once",
		});
		if (!existingPolicy) throw new Error("Expected the existing-row policy");
		await setPushSessionOverride(first.sourceId, "default");
		expect(
			await recordPushNotificationDecision({
				eventId: existingEvent.id,
				device: {
					id: phone.id,
					name: phone.name,
					privacy: phone.preferences.privacy,
					oneShot: {
						sourceSessionId: existingEvent.sourceId,
						mode: "notify_once",
						policyUpdatedAt: existingPolicy.updatedAt,
					},
				},
				status: "pending",
				reason: "eligible",
			}),
		).toMatchObject({
			status: "suppressed",
			reason: "one_shot_cancelled",
			nextAttemptAt: null,
		});
	});

	it("terminates retries without rewriting failed receipts as accepted history", async () => {
		const phone = await upsertPushSubscription(
			subscription("termination-history"),
			AUTH_ONE,
		);
		const accepted = await enqueuePushNotificationEvent({
			id: "accepted-event",
			sourceKind: "session",
			sourceId: "accepted-session",
			category: "request",
			reason: "permission",
			occurredAt: 1_000,
			expiresAt: 100_000,
		});
		await recordPushNotificationDecision({
			eventId: accepted.id,
			device: {
				id: phone.id,
				name: phone.name,
				privacy: phone.preferences.privacy,
			},
			status: "pending",
		});
		await recordPushNotificationReceipt({
			eventId: accepted.id,
			deviceId: phone.id,
			status: "sent",
			reason: "accepted",
			receiptAt: 2_000,
		});
		expect(
			await terminatePushNotificationEvent(accepted.id, "state_resolved"),
		).toMatchObject({
			status: "processed",
			statusReason: "provider_accepted",
		});
		expect(await listPushNotificationDeliveries(accepted.id)).toEqual([
			expect.objectContaining({
				status: "sent",
				reason: "accepted",
				nextAttemptAt: null,
			}),
		]);

		const failed = await enqueuePushNotificationEvent({
			id: "failed-receipt-event",
			sourceKind: "session",
			sourceId: "failed-receipt-session",
			category: "problem",
			reason: "error",
			occurredAt: 1_000,
			expiresAt: 100_000,
		});
		await recordPushNotificationDecision({
			eventId: failed.id,
			device: {
				id: phone.id,
				name: phone.name,
				privacy: phone.preferences.privacy,
			},
			status: "pending",
		});
		await recordPushNotificationReceipt({
			eventId: failed.id,
			deviceId: phone.id,
			status: "failed",
			reason: "provider_failure",
			nextAttemptAt: 5_000,
			receiptAt: 2_000,
		});
		expect(
			await terminatePushNotificationEvent(failed.id, "state_resolved"),
		).toMatchObject({ status: "cancelled" });
		expect(await listPushNotificationDeliveries(failed.id)).toEqual([
			expect.objectContaining({
				status: "expired",
				reason: "state_changed",
				nextAttemptAt: null,
			}),
		]);
	});

	it("keeps accepted history while terminally quieting remaining focused completion retries", async () => {
		const phone = await upsertPushSubscription(
			subscription("focused-completion-phone"),
			AUTH_ONE,
		);
		const tablet = await upsertPushSubscription(
			subscription("focused-completion-tablet"),
			AUTH_TWO,
		);
		const completion = await enqueuePushNotificationEvent({
			id: "focused-completion-event",
			sourceKind: "session",
			sourceId: "focused-completion-session",
			category: "completion",
			reason: "ready",
			occurredAt: 1_000,
			expiresAt: 100_000,
		});
		for (const device of [phone, tablet]) {
			await recordPushNotificationDecision({
				eventId: completion.id,
				device: {
					id: device.id,
					name: device.name,
					privacy: device.preferences.privacy,
				},
				status: "pending",
			});
		}
		await recordPushNotificationReceipt({
			eventId: completion.id,
			deviceId: phone.id,
			status: "sent",
			reason: "accepted",
			receiptAt: 2_000,
		});
		await recordPushNotificationReceipt({
			eventId: completion.id,
			deviceId: tablet.id,
			status: "failed",
			reason: "provider_failure",
			nextAttemptAt: 5_000,
			receiptAt: 2_000,
		});
		await updatePushNotificationEventStatus(completion.id, {
			status: "processed",
			reason: "provider_accepted",
		});

		expect(
			await terminatePushNotificationEvent(completion.id, "app_focused"),
		).toMatchObject({
			status: "processed",
			statusReason: "provider_accepted",
		});
		expect(await listPushNotificationDeliveries(completion.id)).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					deviceId: phone.id,
					status: "sent",
					reason: "accepted",
				}),
				expect.objectContaining({
					deviceId: tablet.id,
					status: "expired",
					reason: "app_focused",
					nextAttemptAt: null,
				}),
			]),
		);
	});

	it("resolves the nearest delegation-tree policy and keeps exact targets fail closed", async () => {
		const db = await getDb();
		for (const id of ["root", "child", "grandchild", "unrelated"]) {
			db.run(`INSERT INTO sessions (id, started_at) VALUES (?, 1)`, [id]);
		}
		db.run(
			`INSERT INTO session_delegations
			 (id, parent_session_id, parent_delegation_id, child_session_id,
			  depth, task, target_provider_id, selected_permission_mode,
			  timeout_seconds, status)
			 VALUES ('d-root', 'root', NULL, 'child', 1, 'child', 'codex',
			         'default', 60, 'completed'),
			        ('d-child', 'child', 'd-root', 'grandchild', 2, 'grandchild',
			         'codex', 'default', 60, 'completed')`,
		);
		const phone = await upsertPushSubscription(subscription(), AUTH_ONE);
		const missingDevice = "00000000-0000-4000-8000-000000000999";

		expect(
			await setPushSessionPolicy("root", {
				mode: "notify_completion_once",
				scope: "delegation_tree",
				targetDeviceIds: [missingDevice],
			}),
		).toMatchObject({
			sessionId: "root",
			mode: "notify_completion_once",
			scope: "delegation_tree",
			targetDeviceIds: [missingDevice],
		});
		const inheritedRoot = await getEffectivePushSessionPolicy("grandchild");
		expect(inheritedRoot).toMatchObject({
			requestedSessionId: "grandchild",
			sourceSessionId: "root",
			mode: "notify_completion_once",
			inherited: true,
		});
		expect(pushSessionPolicyTargetsDevice(inheritedRoot, phone.id)).toBe(false);
		expect(
			updatePushSessionOverrideSchema.parse({
				session_id: "root",
				mode: "notify",
			}),
		).toEqual({ session_id: "root", mode: "notify" });
		await setPushSessionPolicy("root", { mode: "notify" });
		expect(await getPushSessionPolicy("root")).toMatchObject({
			mode: "notify",
			scope: "delegation_tree",
			targetDeviceIds: [missingDevice],
		});
		await setPushSessionPolicy("root", {
			mode: "notify_completion_once",
		});

		await setPushSessionPolicy("child", { mode: "mute", scope: "session" });
		expect(await getEffectivePushSessionPolicy("child")).toMatchObject({
			sourceSessionId: "child",
			mode: "mute",
			inherited: false,
		});
		// A session-only parent row is skipped when resolving a descendant.
		expect(await getEffectivePushSessionPolicy("grandchild")).toMatchObject({
			sourceSessionId: "root",
		});

		await setPushSessionPolicy("child", {
			mode: "notify_once",
			scope: "delegation_tree",
			targetDeviceIds: [phone.id],
		});
		const nearest = await getEffectivePushSessionPolicy("grandchild");
		expect(nearest).toMatchObject({
			sourceSessionId: "child",
			mode: "notify_once",
			targetDeviceIds: [phone.id],
		});
		expect(pushSessionPolicyTargetsDevice(nearest, phone.id)).toBe(true);
		expect(await clearPushSessionOneShot("child", "notify_once")).toBe(true);
		expect(await getPushSessionPolicy("child")).toBeNull();
		await setPushSessionOverride("root", "notify");
		expect(await getPushSessionPolicy("root")).toMatchObject({
			mode: "notify",
			scope: "delegation_tree",
			targetDeviceIds: [missingDevice],
		});
		expect(await getEffectivePushSessionPolicy("unrelated")).toEqual({
			requestedSessionId: "unrelated",
			sourceSessionId: null,
			mode: "default",
			scope: "session",
			targetDeviceIds: null,
			inherited: false,
		});
		expect(
			await setPushSessionPolicy("missing", { mode: "notify" }),
		).toBeNull();
	});

	it("durably recovers events, exact device decisions, receipts, and batch reads", async () => {
		const phone = await upsertPushSubscription(subscription(), AUTH_ONE);
		const event = await enqueuePushNotificationEvent({
			id: "event-request",
			sourceKind: "session",
			sourceId: "session-1",
			category: "request",
			reason: "permission",
			label: "Permission waiting",
			url: "/raven?session=session-1&attention=permission",
			runtimeMs: 12_345,
			pendingCount: 2,
			occurredAt: 1_000,
			expiresAt: 10_000,
			groupKey: "session:session-1",
			metadata: { attention: "permission" },
			dedupeKey: "session-1:permission:1",
		});
		expect(event).toMatchObject({
			id: "event-request",
			sourceKind: "session",
			sourceId: "session-1",
			category: "request",
			reason: "permission",
			label: "Permission waiting",
			url: "/raven?session=session-1&attention=permission",
			runtimeMs: 12_345,
			pendingCount: 2,
			occurredAt: 1_000,
			expiresAt: 10_000,
			status: "pending",
			metadata: { attention: "permission" },
		});
		// A stable dedupe key returns the original durable intent unchanged.
		expect(
			await enqueuePushNotificationEvent({
				sourceKind: "session",
				sourceId: "session-1",
				category: "request",
				label: "duplicate",
				occurredAt: 1_001,
				expiresAt: 10_000,
				dedupeKey: "session-1:permission:1",
			}),
		).toMatchObject({ id: "event-request", label: "Permission waiting" });

		await enqueuePushNotificationEvent({
			id: "event-scheduled",
			sourceKind: "routine",
			sourceId: "run-1",
			category: "completion",
			occurredAt: 1_200,
			expiresAt: 10_000,
			status: "deferred",
			statusReason: "visible",
			nextAttemptAt: 4_000,
		});
		expect(
			(await listPendingPushNotificationEvents(3_000)).map((item) => item.id),
		).toEqual(["event-request"]);
		expect(
			(await listPendingPushNotificationEvents(4_000)).map((item) => item.id),
		).toEqual(["event-request", "event-scheduled"]);

		const decision = await recordPushNotificationDecision({
			eventId: event.id,
			device: {
				id: phone.id,
				name: phone.name,
				privacy: phone.preferences.privacy,
			},
			status: "queued",
			reason: "accepted",
			nextAttemptAt: 3_500,
		});
		expect(decision).toMatchObject({
			eventId: event.id,
			deviceId: phone.id,
			deviceSnapshot: {
				id: phone.id,
				name: "Phone",
				privacy: "generic",
			},
			status: "queued",
			reason: "accepted",
		});
		await recordPushNotificationDecision({
			eventId: "event-scheduled",
			device: {
				id: phone.id,
				name: phone.name,
				privacy: phone.preferences.privacy,
			},
			status: "queued",
			reason: "visible",
			nextAttemptAt: 4_500,
		});
		expect(
			(await listPendingPushNotificationDeliveries(3_500)).map(
				(item) => item.event.id,
			),
		).toEqual(["event-request"]);
		expect(
			(await listPendingPushNotificationDeliveries(4_500)).map(
				(item) => item.event.id,
			),
		).toEqual(["event-request", "event-scheduled"]);
		expect(
			await recordPushNotificationReceipt({
				eventId: event.id,
				deviceId: phone.id,
				status: "sent",
				providerStatus: 201,
				receiptAt: 3_600,
			}),
		).toMatchObject({
			status: "sent",
			providerStatus: 201,
			attemptCount: 1,
			receiptAt: 3_600,
			nextAttemptAt: null,
		});
		expect(
			await recordPushNotificationClientReceipt(
				decision.id,
				"displayed",
				3_700,
			),
		).toMatchObject({ displayedAt: 3_700, openedAt: null });
		expect(
			await recordPushNotificationClientReceipt(decision.id, "opened", 3_800),
		).toMatchObject({ displayedAt: 3_700, openedAt: 3_800 });
		expect(
			(await listPendingPushNotificationDeliveries(5_000)).some(
				(item) => item.event.id === event.id,
			),
		).toBe(false);
		expect((await listPushNotificationHistory(1))[0]).toMatchObject({
			id: "event-scheduled",
		});
		const history = await listPushNotificationHistory(10);
		expect(history.find((item) => item.id === event.id)?.deliveries).toEqual([
			expect.objectContaining({ status: "sent", deviceId: phone.id }),
		]);

		const completionOne = await enqueuePushNotificationEvent({
			id: "completion-one",
			sourceKind: "session",
			sourceId: "session-3",
			category: "completion",
			occurredAt: 5_000,
			expiresAt: 20_000,
		});
		const completionTwo = await enqueuePushNotificationEvent({
			id: "completion-two",
			sourceKind: "session",
			sourceId: "session-4",
			category: "completion",
			occurredAt: 5_001,
			expiresAt: 20_000,
		});
		await expect(
			createPushNotificationBatch({
				id: "short",
				category: "completion",
			}),
		).rejects.toThrow();
		await expect(
			createPushNotificationBatch({
				id: "batch with spaces",
				category: "completion",
			}),
		).rejects.toThrow();
		const batch = await createPushNotificationBatch({
			id: "batch-completions",
			category: "completion",
			groupKey: "completion-window",
			createdAt: 5_100,
		});
		expect(
			await addPushNotificationBatchMembers(
				batch.id,
				[
					{ eventId: completionOne.id, sessionId: "session-3" },
					{ eventId: completionTwo.id, sessionId: "session-4" },
				],
				5_100,
			),
		).toHaveLength(2);
		expect(await getPushNotificationEvent(completionOne.id)).toMatchObject({
			batchId: batch.id,
			status: "batched",
		});
		expect(
			await updatePushNotificationBatchStatus(batch.id, "sent", 5_200),
		).toMatchObject({ status: "sent", sentAt: 5_200 });
		expect(
			(await listPendingPushNotificationEvents(5_200)).map((item) => item.id),
		).toEqual(expect.arrayContaining([completionOne.id, completionTwo.id]));
		expect(
			await markPushNotificationBatchMemberRead(batch.id, "session-3", 5_300),
		).toBe(true);
		expect(await getPushNotificationBatch(batch.id)).toMatchObject({
			status: "sent",
			readAt: null,
		});
		expect(await markPushNotificationBatchRead(batch.id, 5_400)).toBe(true);
		expect(await getPushNotificationBatch(batch.id)).toMatchObject({
			status: "read",
			readAt: 5_400,
		});
		expect(
			await updatePushNotificationBatchStatus(batch.id, "sent", 5_500),
		).toMatchObject({ status: "read", sentAt: 5_200, readAt: 5_400 });
		expect(
			(await listPushNotificationBatchMembers(batch.id)).every(
				(member) => member.readAt !== null,
			),
		).toBe(true);

		expect(
			await updatePushNotificationEventStatus(event.id, {
				status: "processed",
				reason: "delivered",
			}),
		).toMatchObject({ status: "processed", statusReason: "delivered" });
	});

	it("does not revive an expired batch through a late read receipt", async () => {
		const completion = await enqueuePushNotificationEvent({
			id: "expired-batch-event",
			sourceKind: "session",
			sourceId: "expired-batch-session",
			category: "completion",
			occurredAt: 1_000,
			expiresAt: 10_000,
		});
		const expiredBatch = await createPushNotificationBatch({
			id: "expired-batch",
			category: "completion",
			status: "ready",
			createdAt: 1_000,
		});
		await addPushNotificationBatchMembers(expiredBatch.id, [
			{ eventId: completion.id, sessionId: completion.sourceId },
		]);
		expect(
			await updatePushNotificationBatchStatus(
				expiredBatch.id,
				"expired",
				2_000,
			),
		).toMatchObject({ status: "expired" });

		expect(
			await markPushNotificationBatchMemberRead(
				expiredBatch.id,
				completion.sourceId,
				3_000,
			),
		).toBe(false);
		expect(await markPushNotificationBatchRead(expiredBatch.id, 3_000)).toBe(
			false,
		);
		expect(await getPushNotificationBatch(expiredBatch.id)).toMatchObject({
			status: "expired",
			readAt: null,
		});
		expect(await listPushNotificationBatchMembers(expiredBatch.id)).toEqual([
			expect.objectContaining({ readAt: null }),
		]);
	});

	it("bounds terminal outbox history without deleting pending work", async () => {
		const db = await getDb();
		db.transaction(() => {
			for (
				let index = 0;
				index < MAX_PUSH_NOTIFICATION_EVENT_HISTORY + 3;
				index++
			) {
				db.run(
					`INSERT INTO push_notification_events
					 (id, source_kind, source_id, category, occurred_at, expires_at,
					  status, created_at, updated_at)
					 VALUES (?, 'system', ?, 'problem', ?, ?, 'processed', ?, ?)`,
					[
						`terminal-${index}`,
						`source-${index}`,
						index + 1,
						index + 2,
						index + 1,
						index + 1,
					],
				);
			}
			db.run(
				`INSERT INTO push_notification_events
				 (id, source_kind, source_id, category, occurred_at, expires_at,
				  status, created_at, updated_at)
				 VALUES ('pending-old', 'system', 'pending-old', 'problem', 0, 999999,
				         'pending', 0, 0)`,
			);
		})();
		expect(await prunePushNotificationHistory()).toMatchObject({ events: 3 });
		expect(
			db
				.query<{ count: number }, []>(
					`SELECT COUNT(*) AS count FROM push_notification_events
					 WHERE status = 'processed'`,
				)
				.get()?.count,
		).toBe(MAX_PUSH_NOTIFICATION_EVENT_HISTORY);
		expect(await getPushNotificationEvent("pending-old")).toMatchObject({
			status: "pending",
		});
	});

	it("adds the attempt journal after the durable outbox migration", async () => {
		const db = await getDb();
		db.run(`DROP TABLE push_notification_delivery_attempts`);
		db.run(
			`DELETE FROM settings
			 WHERE key = '_migrated_web_push_delivery_attempts_v7'`,
		);

		initializeSchema(db);
		initializeSchema(db);

		expect(
			db
				.query<{ name: string }, []>(
					`SELECT name FROM sqlite_master
					 WHERE type = 'table'
					   AND name = 'push_notification_delivery_attempts'`,
				)
				.get()?.name,
		).toBe("push_notification_delivery_attempts");
	});

	it("journals privacy-safe provider attempts and cascades them with delivery retention", async () => {
		const phone = await upsertPushSubscription(subscription(), AUTH_ONE);
		const event = await enqueuePushNotificationEvent({
			id: "attempt-event",
			sourceKind: "session",
			sourceId: "attempt-session",
			category: "problem",
			occurredAt: 1_000,
			expiresAt: 10_000,
		});
		const delivery = await recordPushNotificationDecision({
			eventId: event.id,
			device: {
				id: phone.id,
				name: phone.name,
				privacy: phone.preferences.privacy,
			},
			status: "pending",
		});

		expect(
			await recordPushNotificationDeliveryAttempt({
				deliveryId: delivery.id,
				attemptedAt: 1_100,
				outcome: "failed",
				providerStatus: 429,
				retryAfterMs: 30_000,
				reasonCode: "provider_rate_limited",
			}),
		).toMatchObject({
			deliveryId: delivery.id,
			attemptedAt: 1_100,
			outcome: "failed",
			providerStatus: 429,
			retryAfterMs: 30_000,
			reasonCode: "provider_rate_limited",
		});
		await recordPushNotificationDeliveryAttempt({
			deliveryId: delivery.id,
			attemptedAt: 1_200,
			outcome: "delivered",
			providerStatus: 201,
		});
		expect(await listPushNotificationDeliveryAttempts(delivery.id)).toEqual([
			expect.objectContaining({
				attemptedAt: 1_100,
				outcome: "failed",
				retryAfterMs: 30_000,
			}),
			expect.objectContaining({
				attemptedAt: 1_200,
				outcome: "delivered",
				retryAfterMs: null,
				reasonCode: null,
			}),
		]);
		expect(await listPushNotificationDeliveries(event.id)).toEqual([
			expect.objectContaining({
				id: delivery.id,
				status: "pending",
				attemptCount: 0,
				providerStatus: null,
			}),
		]);

		await expect(
			recordPushNotificationDeliveryAttempt({
				deliveryId: delivery.id,
				outcome: "failed",
				reasonCode: "raw provider error body",
			}),
		).rejects.toThrow("machine-readable code");
		await expect(
			recordPushNotificationDeliveryAttempt({
				deliveryId: delivery.id,
				outcome: "failed",
				providerStatus: 42,
			}),
		).rejects.toThrow("HTTP status code");

		const db = await getDb();
		const columns = db
			.query<{ name: string }, []>(
				`PRAGMA table_info(push_notification_delivery_attempts)`,
			)
			.all()
			.map((column) => column.name);
		expect(columns).toEqual([
			"id",
			"delivery_id",
			"attempted_at",
			"outcome",
			"provider_status",
			"retry_after_ms",
			"reason_code",
		]);

		db.run(`DELETE FROM push_notification_events WHERE id = ?`, [event.id]);
		expect(await listPushNotificationDeliveryAttempts(delivery.id)).toEqual([]);
	});

	it("recovers one durable batch acceptance proof without resending its members", async () => {
		const db = await getDb();
		db.run(
			`INSERT INTO sessions (id, started_at)
			 VALUES ('attempt-batch-one', 1), ('attempt-batch-two', 1)`,
		);
		const phone = await upsertPushSubscription(
			subscription("attempt-batch-phone"),
			AUTH_ONE,
		);
		const policies = await Promise.all([
			setPushSessionPolicy("attempt-batch-one", {
				mode: "notify_completion_once",
			}),
			setPushSessionPolicy("attempt-batch-two", {
				mode: "notify_completion_once",
			}),
		]);
		if (!policies[0] || !policies[1]) {
			throw new Error("Expected completion one-shot policies");
		}
		const events = await Promise.all(
			["attempt-batch-one", "attempt-batch-two"].map((sourceId, index) =>
				enqueuePushNotificationEvent({
					id: `attempt-batch-event-${index + 1}`,
					sourceKind: "session",
					sourceId,
					category: "completion",
					occurredAt: 1_000 + index,
					expiresAt: 100_000,
				}),
			),
		);
		const selectedBatch = await createPushNotificationBatch({
			id: "attempt-batch-proof",
			category: "completion",
			status: "ready",
			createdAt: 1_100,
		});
		await addPushNotificationBatchMembers(
			selectedBatch.id,
			events.map((event, index) => ({
				eventId: event.id,
				sessionId: event.sourceId,
				position: index,
			})),
			1_100,
		);
		const deliveries = [];
		for (const [index, event] of events.entries()) {
			deliveries.push(
				await recordPushNotificationDecision({
					eventId: event.id,
					device: {
						id: phone.id,
						name: phone.name,
						privacy: phone.preferences.privacy,
						oneShot: {
							sourceSessionId: event.sourceId,
							mode: "notify_completion_once",
							policyUpdatedAt: policies[index]?.updatedAt,
						},
					},
					status: "pending",
				}),
			);
		}
		await recordPushNotificationDeliveryAttempt({
			deliveryId: deliveries[0]?.id ?? "",
			attemptedAt: 2_000,
			outcome: "delivered",
			providerStatus: 201,
			reasonCode: "batch_accepted",
		});

		expect(await reconcileDeliveredPushNotificationAttempts()).toBe(2);
		for (const event of events) {
			expect(await listPushNotificationDeliveries(event.id)).toEqual([
				expect.objectContaining({
					status: "sent",
					reason: "batch_accepted",
					nextAttemptAt: null,
				}),
			]);
		}
		expect(await getPushNotificationBatch(selectedBatch.id)).toMatchObject({
			status: "sent",
			sentAt: 2_000,
		});
		expect(await reconcilePushNotificationOneShots()).toBe(2);
		expect(await getPushSessionOverride(events[0]?.sourceId ?? "")).toBe(
			"default",
		);
		expect(await getPushSessionOverride(events[1]?.sourceId ?? "")).toBe(
			"default",
		);
		expect(await reconcileDeliveredPushNotificationAttempts()).toBe(0);
	});

	it("keeps a ready batch whole when the event page boundary cuts through it", async () => {
		for (let index = 0; index < 99; index++) {
			await enqueuePushNotificationEvent({
				id: `page-prior-${String(index).padStart(3, "0")}`,
				sourceKind: "system",
				sourceId: `page-prior-${index}`,
				category: "problem",
				occurredAt: 1_000 + index,
				expiresAt: 100_000,
			});
		}
		const members = [];
		for (let index = 0; index < 10; index++) {
			members.push(
				await enqueuePushNotificationEvent({
					id: `page-batch-${index}`,
					sourceKind: "session",
					sourceId: `page-batch-session-${index}`,
					category: "completion",
					occurredAt: 2_000 + index,
					expiresAt: 100_000,
				}),
			);
		}
		const selectedBatch = await createPushNotificationBatch({
			id: "page-boundary-batch",
			category: "completion",
			status: "ready",
			createdAt: 2_100,
		});
		await addPushNotificationBatchMembers(
			selectedBatch.id,
			members.map((event, position) => ({
				eventId: event.id,
				sessionId: event.sourceId,
				position,
			})),
			2_100,
		);

		const due = await listPendingPushNotificationEvents(3_000, 100);
		expect(due).toHaveLength(109);
		expect(
			due
				.filter((event) => event.batchId === selectedBatch.id)
				.map((event) => event.id),
		).toEqual(members.map((event) => event.id));
	});

	it("expands a processed batch selected only by one due delivery page", async () => {
		for (let index = 0; index < 100; index++) {
			await enqueuePushNotificationEvent({
				id: `delivery-page-prior-${String(index).padStart(3, "0")}`,
				sourceKind: "system",
				sourceId: `delivery-page-prior-${index}`,
				category: "problem",
				occurredAt: 1_000 + index,
				expiresAt: 100_000,
			});
		}
		const phone = await upsertPushSubscription(
			subscription("delivery-page-phone"),
			AUTH_ONE,
		);
		const members = await Promise.all(
			[0, 1].map((index) =>
				enqueuePushNotificationEvent({
					id: `delivery-page-batch-${index}`,
					sourceKind: "session",
					sourceId: `delivery-page-session-${index}`,
					category: "completion",
					occurredAt: 10_000 + index,
					expiresAt: 100_000,
				}),
			),
		);
		const selectedBatch = await createPushNotificationBatch({
			id: "delivery-page-boundary-batch",
			category: "completion",
			status: "ready",
			createdAt: 10_100,
		});
		await addPushNotificationBatchMembers(
			selectedBatch.id,
			members.map((event) => ({
				eventId: event.id,
				sessionId: event.sourceId,
			})),
			10_100,
		);
		for (const [index, event] of members.entries()) {
			await recordPushNotificationDecision({
				eventId: event.id,
				device: {
					id: phone.id,
					name: phone.name,
					privacy: phone.preferences.privacy,
				},
				status: "pending",
			});
			await recordPushNotificationReceipt({
				eventId: event.id,
				deviceId: phone.id,
				status: "failed",
				reason: "provider_failure",
				nextAttemptAt: index === 0 ? 3_000 : 4_000,
				receiptAt: 2_000 + index,
			});
			await updatePushNotificationEventStatus(event.id, {
				status: "processed",
				reason: "provider_accepted_other_device",
			});
		}

		expect(
			(await listPendingPushNotificationDeliveries(3_000, 100)).map(
				(item) => item.event.id,
			),
		).toEqual([members[0]?.id]);
		expect(
			(await listPendingPushNotificationEvents(3_000, 100))
				.filter((event) => event.batchId === selectedBatch.id)
				.map((event) => event.id),
		).toEqual(members.map((event) => event.id));
	});

	it("releases staggered completions as one durable window cohort", async () => {
		const first = await enqueuePushNotificationEvent({
			id: "cohort-first",
			sourceKind: "session",
			sourceId: "cohort-session-first",
			category: "completion",
			occurredAt: 1_000,
			expiresAt: 100_000,
			groupKey: "session-completions",
			status: "deferred",
			statusReason: "batch_window",
			nextAttemptAt: 21_750,
		});
		const second = await enqueuePushNotificationEvent({
			id: "cohort-second",
			sourceKind: "session",
			sourceId: "cohort-session-second",
			category: "completion",
			occurredAt: 11_000,
			expiresAt: 100_000,
			groupKey: "session-completions",
			status: "deferred",
			statusReason: "batch_window",
			nextAttemptAt: 31_000,
		});

		expect(
			(await listPendingPushNotificationEvents(21_750)).map(
				(event) => event.id,
			),
		).toEqual([first.id, second.id]);
	});

	it("does not pull an unsettled late completion into a durable cohort", async () => {
		const first = await enqueuePushNotificationEvent({
			id: "cohort-settle-first",
			sourceKind: "session",
			sourceId: "cohort-settle-session-first",
			category: "completion",
			occurredAt: 1_000,
			expiresAt: 100_000,
			groupKey: "session-completions",
			status: "deferred",
			statusReason: "batch_window",
			nextAttemptAt: 21_000,
		});
		const late = await enqueuePushNotificationEvent({
			id: "cohort-settle-late",
			sourceKind: "session",
			sourceId: "cohort-settle-session-late",
			category: "completion",
			occurredAt: 20_700,
			expiresAt: 100_000,
			groupKey: "session-completions",
			status: "deferred",
			statusReason: "batch_window",
			nextAttemptAt: 40_700,
		});

		expect(
			(await listPendingPushNotificationEvents(21_000)).map(
				(event) => event.id,
			),
		).toEqual([first.id]);
		expect(
			(await listPendingPushNotificationEvents(21_450)).map(
				(event) => event.id,
			),
		).toEqual([first.id, late.id]);
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
		const completionOnly = {
			preferences: { ...detailedPreferences, work_finished: false },
		};
		expect(
			pushSubscriptionWantsNotification(
				completionOnly,
				"work_finished",
				"notify_completion_once",
				{ nowMs: 1_000 },
			),
		).toBe(true);
		expect(
			pushSubscriptionWantsNotification(
				completionOnly,
				"needs_attention",
				"notify_completion_once",
				{ reason: "error", nowMs: 1_000 },
			),
		).toBe(false);
		expect(
			pushSubscriptionWantsNotification(
				completionOnly,
				"needs_attention",
				"notify_completion_once",
				{ reason: "permission", nowMs: 1_000 },
			),
		).toBe(true);
	});
});
