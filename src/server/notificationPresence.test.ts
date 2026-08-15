import { afterEach, describe, expect, it } from "vitest";
import {
	getNotificationAppVisibleUntil,
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

	it("tracks app-global foreground presence for a bounded lease", () => {
		const current = client();
		updateNotificationPresence(current, true, 1_000);
		expect(getNotificationAppVisibleUntil(1_001)).toBe(
			1_000 + NOTIFICATION_PRESENCE_LEASE_MS,
		);
	});

	it("expires stale mobile connections", () => {
		const current = client();
		updateNotificationPresence(current, true, 1_000);
		expect(
			getNotificationAppVisibleUntil(1_000 + NOTIFICATION_PRESENCE_LEASE_MS),
		).toBeNull();
	});

	it("clears presence when hidden or disconnected", () => {
		const firstClient = client();
		const secondClient = client();
		updateNotificationPresence(firstClient, true, 1_000);
		updateNotificationPresence(firstClient, false, 1_001);
		expect(getNotificationAppVisibleUntil(1_002)).toBeNull();

		updateNotificationPresence(secondClient, true, 1_000);
		removeNotificationPresence(secondClient);
		expect(getNotificationAppVisibleUntil(1_002)).toBeNull();
	});

	it("uses the newest lease across focused clients", () => {
		updateNotificationPresence(client(), true, 1_000);
		updateNotificationPresence(client(), true, 2_000);
		expect(getNotificationAppVisibleUntil(2_001)).toBe(
			2_000 + NOTIFICATION_PRESENCE_LEASE_MS,
		);
	});

	it("clears only the client reporting itself hidden", () => {
		const first = client();
		const second = client();
		updateNotificationPresence(first, true, 1_000);
		updateNotificationPresence(second, true, 2_000);
		updateNotificationPresence(first, false, 2_001);
		expect(getNotificationAppVisibleUntil(2_002)).toBe(
			2_000 + NOTIFICATION_PRESENCE_LEASE_MS,
		);
	});
});
