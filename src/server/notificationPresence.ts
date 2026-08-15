/**
 * Browser visibility is deliberately a lease instead of durable connection
 * state. Mobile browsers can freeze a page without promptly closing its
 * WebSocket, so a missed `visible: false` must expire on its own.
 */
export const NOTIFICATION_PRESENCE_LEASE_MS = 15_000;

type Presence = {
	visibleUntil: number;
};

const presenceByClient = new Map<object, Presence>();

export function updateNotificationPresence(
	client: object,
	visible: boolean,
	now = Date.now(),
): void {
	if (!visible) {
		presenceByClient.delete(client);
		return;
	}
	presenceByClient.set(client, {
		visibleUntil: now + NOTIFICATION_PRESENCE_LEASE_MS,
	});
}

export function removeNotificationPresence(client: object): void {
	presenceByClient.delete(client);
}

/**
 * Returns the newest live lease for any focused Hlid client. Presence is app
 * global: a focused client silences Web Push for every chat and target device.
 * Expired entries are pruned while scanning so a frozen mobile renderer cannot
 * keep notifications quiet indefinitely.
 */
export function getNotificationAppVisibleUntil(
	now = Date.now(),
): number | null {
	let visibleUntil: number | null = null;
	for (const [client, presence] of presenceByClient) {
		if (presence.visibleUntil <= now) {
			presenceByClient.delete(client);
			continue;
		}
		visibleUntil = Math.max(visibleUntil ?? 0, presence.visibleUntil);
	}
	return visibleUntil;
}
