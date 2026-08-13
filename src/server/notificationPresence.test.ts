import { afterEach, describe, expect, it } from "vitest";
import {
	getNotificationVisibleUntil,
	NOTIFICATION_PRESENCE_LEASE_MS,
	removeNotificationPresence,
	updateNotificationPresence,
} from "./notificationPresence";

describe("notification presence leases", () => {
	const clients: object[] = [];
	const client = (): object => {
		const value = {};
		clients.push(value);
		return value;
	};
	afterEach(() => {
		for (const value of clients) removeNotificationPresence(value);
		clients.length = 0;
	});

	it("tracks a visible session for a bounded lease", () => {
		const current = client();
		updateNotificationPresence(current, "session-1", true, 1_000);
		expect(getNotificationVisibleUntil(["session-1"], 1_001)).toBe(
			1_000 + NOTIFICATION_PRESENCE_LEASE_MS,
		);
		expect(getNotificationVisibleUntil(["session-2"], 1_001)).toBeNull();
	});

	it("expires stale mobile connections", () => {
		const current = client();
		updateNotificationPresence(current, "session-1", true, 1_000);
		expect(
			getNotificationVisibleUntil(
				["session-1"],
				1_000 + NOTIFICATION_PRESENCE_LEASE_MS,
			),
		).toBeNull();
	});

	it("clears presence when hidden or disconnected", () => {
		const firstClient = client();
		const secondClient = client();
		updateNotificationPresence(firstClient, "session-1", true, 1_000);
		updateNotificationPresence(firstClient, "session-1", false, 1_001);
		expect(getNotificationVisibleUntil(["session-1"], 1_002)).toBeNull();

		updateNotificationPresence(secondClient, "session-1", true, 1_000);
		removeNotificationPresence(secondClient);
		expect(getNotificationVisibleUntil(["session-1"], 1_002)).toBeNull();
	});

	it("uses the newest lease across tabs and session aliases", () => {
		updateNotificationPresence(client(), "pool-1", true, 1_000);
		updateNotificationPresence(client(), "db-1", true, 2_000);
		expect(getNotificationVisibleUntil(["pool-1", "db-1"], 2_001)).toBe(
			2_000 + NOTIFICATION_PRESENCE_LEASE_MS,
		);
	});
});
