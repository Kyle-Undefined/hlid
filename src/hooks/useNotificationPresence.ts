import { useEffect } from "react";
import { closePushNotificationsForSession } from "#/lib/pushNotifications";
import type { ClientMessage } from "../server/protocol";

type NotificationPresenceMessage = Extract<
	ClientMessage,
	{ type: "notification_presence" }
>;

const PRESENCE_HEARTBEAT_MS = 5_000;
const PRESENCE_BLUR_GRACE_MS = 1_500;
const PRESENCE_SEND_RETRY_DELAYS_MS = [250, 250, 500, 1_000, 1_000] as const;

export function notificationPageIsVisible(
	doc: Pick<Document, "visibilityState" | "hasFocus"> = document,
): boolean {
	return doc.visibilityState === "visible" && doc.hasFocus();
}

/** Renews the server's short foreground lease while any authenticated Hlid
 * route is genuinely in front of the user. Frozen/unloaded pages clear it
 * immediately. A short attention-loss grace avoids notifications while a
 * native picker or another transient browser surface briefly owns focus. */
export function useNotificationPresence(
	wsStatus: string,
	send: (message: NotificationPresenceMessage) => boolean,
): void {
	useEffect(() => {
		if (wsStatus !== "connected") return;

		let announcedVisible: boolean | null = null;
		let blurTimer: number | null = null;
		let retryTimer: number | null = null;
		let retryAttempt = 0;
		let active = true;

		const clearBlurTimer = () => {
			if (blurTimer === null) return;
			window.clearTimeout(blurTimer);
			blurTimer = null;
		};
		const clearRetryTimer = () => {
			if (retryTimer === null) return;
			window.clearTimeout(retryTimer);
			retryTimer = null;
		};
		const announce = (visible: boolean, force = false, isRetry = false) => {
			clearRetryTimer();
			if (!isRetry) retryAttempt = 0;
			if (force || visible !== announcedVisible) {
				if (!send({ type: "notification_presence", visible })) {
					// Focus may start a WebSocket liveness probe before this listener runs.
					// Do not claim the transition locally until the transport accepts it.
					const retryDelay = PRESENCE_SEND_RETRY_DELAYS_MS[retryAttempt];
					if (active && retryDelay !== undefined) {
						retryAttempt += 1;
						retryTimer = window.setTimeout(() => {
							retryTimer = null;
							announce(visible, true, true);
						}, retryDelay);
					}
					return;
				}
			}
			retryAttempt = 0;
			announcedVisible = visible;
		};
		const clearPresence = () => {
			clearBlurTimer();
			announce(false);
		};
		const restorePresence = (force = false) => {
			clearBlurTimer();
			if (notificationPageIsVisible()) {
				announce(true, force);
				return;
			}
			announce(false, force);
		};
		const deferLostPresence = () => {
			// Initial/unfocused mounts must not claim presence. The grace applies only
			// after this page has already established a foreground lease.
			if (announcedVisible !== true) {
				announce(false);
				return;
			}
			clearBlurTimer();
			blurTimer = window.setTimeout(() => {
				blurTimer = null;
				// Re-read both signals. A hidden page must never be restored by a timer
				// that was armed before backgrounding.
				if (notificationPageIsVisible()) return;
				announce(false);
			}, PRESENCE_BLUR_GRACE_MS);
		};
		const handleVisibility = () => {
			if (document.visibilityState !== "visible") {
				// Native pickers can briefly hide a mobile PWA. Preserve the lease long
				// enough to collapse that transition, while pagehide/freeze still clear it.
				deferLostPresence();
				return;
			}
			restorePresence();
		};
		const handleFocus = () => restorePresence();
		const handleBlur = () => deferLostPresence();

		restorePresence(true);
		const heartbeat = window.setInterval(() => {
			if (notificationPageIsVisible()) restorePresence(true);
		}, PRESENCE_HEARTBEAT_MS);
		document.addEventListener("visibilitychange", handleVisibility);
		document.addEventListener("freeze", clearPresence);
		document.addEventListener("resume", handleVisibility);
		window.addEventListener("focus", handleFocus);
		window.addEventListener("blur", handleBlur);
		window.addEventListener("pagehide", clearPresence);
		window.addEventListener("pageshow", handleVisibility);

		return () => {
			active = false;
			window.clearInterval(heartbeat);
			clearBlurTimer();
			clearRetryTimer();
			document.removeEventListener("visibilitychange", handleVisibility);
			document.removeEventListener("freeze", clearPresence);
			document.removeEventListener("resume", handleVisibility);
			window.removeEventListener("focus", handleFocus);
			window.removeEventListener("blur", handleBlur);
			window.removeEventListener("pagehide", clearPresence);
			window.removeEventListener("pageshow", handleVisibility);
			if (announcedVisible === true) {
				send({ type: "notification_presence", visible: false });
			}
		};
	}, [send, wsStatus]);
}

/** Closes already-displayed alerts only for the durable Raven session the user
 * actually opened. App-wide foreground presence must not dismiss alerts from
 * other sessions or completion batches. */
export function useRavenNotificationCleanup(
	notificationSessionId: string | null,
): void {
	useEffect(() => {
		if (!notificationSessionId) return;

		let wasVisible = false;
		const reconcile = () => {
			const visible = notificationPageIsVisible();
			if (visible && !wasVisible) {
				void closePushNotificationsForSession(notificationSessionId);
			}
			wasVisible = visible;
		};
		const clearVisible = () => {
			wasVisible = false;
		};

		reconcile();
		document.addEventListener("visibilitychange", reconcile);
		document.addEventListener("freeze", clearVisible);
		document.addEventListener("resume", reconcile);
		window.addEventListener("focus", reconcile);
		window.addEventListener("blur", reconcile);
		window.addEventListener("pagehide", clearVisible);
		window.addEventListener("pageshow", reconcile);

		return () => {
			document.removeEventListener("visibilitychange", reconcile);
			document.removeEventListener("freeze", clearVisible);
			document.removeEventListener("resume", reconcile);
			window.removeEventListener("focus", reconcile);
			window.removeEventListener("blur", reconcile);
			window.removeEventListener("pagehide", clearVisible);
			window.removeEventListener("pageshow", reconcile);
		};
	}, [notificationSessionId]);
}
