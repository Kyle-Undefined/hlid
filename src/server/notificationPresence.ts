/**
 * Browser visibility is deliberately a lease instead of durable connection
 * state. Mobile browsers can freeze a page without promptly closing its
 * WebSocket, so a missed `visible: false` must expire on its own.
 */
export const NOTIFICATION_PRESENCE_LEASE_MS = 15_000;

type Presence = {
	sessionId: string;
	visibleUntil: number;
};

const presenceByClient = new Map<object, Presence>();

export function updateNotificationPresence(
	client: object,
	sessionId: string,
	visible: boolean,
	now = Date.now(),
): void {
	if (!visible) {
		presenceByClient.delete(client);
		return;
	}
	presenceByClient.set(client, {
		sessionId,
		visibleUntil: now + NOTIFICATION_PRESENCE_LEASE_MS,
	});
}

export function removeNotificationPresence(client: object): void {
	presenceByClient.delete(client);
}

/**
 * Returns the newest live lease for any alias of a durable Raven session.
 * Expired entries are pruned while scanning.
 */
export function getNotificationVisibleUntil(
	sessionIds: Iterable<string>,
	now = Date.now(),
): number | null {
	const wanted = new Set(sessionIds);
	let visibleUntil: number | null = null;
	for (const [client, presence] of presenceByClient) {
		if (presence.visibleUntil <= now) {
			presenceByClient.delete(client);
			continue;
		}
		if (!wanted.has(presence.sessionId)) continue;
		visibleUntil = Math.max(visibleUntil ?? 0, presence.visibleUntil);
	}
	return visibleUntil;
}
