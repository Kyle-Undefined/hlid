import { useEffect } from "react";
import { closePushNotificationsForSession } from "#/lib/pushNotifications";
import type { ClientMessage } from "../server/protocol";

type NotificationPresenceMessage = Extract<
	ClientMessage,
	{ type: "notification_presence" }
>;

const PRESENCE_HEARTBEAT_MS = 5_000;

export function notificationPageIsVisible(
	doc: Pick<Document, "visibilityState" | "hasFocus"> = document,
): boolean {
	return doc.visibilityState === "visible" && doc.hasFocus();
}

/**
 * Renews the server's short visibility lease while a Raven session is
 * genuinely in front of the user. Hidden/backgrounded pages explicitly clear
 * the lease, and the server also expires it if the browser is frozen first.
 */
export function useNotificationPresence(
	sessionId: string,
	notificationSessionId: string | null,
	wsStatus: string,
	send: (message: NotificationPresenceMessage) => boolean,
): void {
	useEffect(() => {
		if (!sessionId || wsStatus !== "connected") return;

		let lastVisible = false;
		const announce = (heartbeat = false) => {
			const visible = notificationPageIsVisible();
			const becameVisible = visible && !lastVisible;
			if (heartbeat || visible !== lastVisible) {
				send({
					type: "notification_presence",
					session_id: sessionId,
					visible,
				});
			}
			if (becameVisible && notificationSessionId) {
				void closePushNotificationsForSession(notificationSessionId);
			}
			lastVisible = visible;
		};
		const handleVisibility = () => announce();
		const clearPresence = () => {
			if (!lastVisible) return;
			send({
				type: "notification_presence",
				session_id: sessionId,
				visible: false,
			});
			lastVisible = false;
		};

		announce(true);
		const heartbeat = window.setInterval(() => {
			if (notificationPageIsVisible()) announce(true);
		}, PRESENCE_HEARTBEAT_MS);
		document.addEventListener("visibilitychange", handleVisibility);
		window.addEventListener("focus", handleVisibility);
		window.addEventListener("blur", handleVisibility);
		window.addEventListener("pagehide", clearPresence);

		return () => {
			window.clearInterval(heartbeat);
			document.removeEventListener("visibilitychange", handleVisibility);
			window.removeEventListener("focus", handleVisibility);
			window.removeEventListener("blur", handleVisibility);
			window.removeEventListener("pagehide", clearPresence);
			clearPresence();
		};
	}, [notificationSessionId, send, sessionId, wsStatus]);
}
