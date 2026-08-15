const BUILD_REQUEST = "hlid:get-build";
const BUILD_RESPONSE = "hlid:build";
const NOTIFICATION_NAVIGATION = "hlid:navigate-notification";
const NOTIFICATION_NAVIGATION_ACK = "hlid:navigate-notification-ack";
export const SERVICE_WORKER_NOTIFICATION_NAVIGATION_EVENT =
	"hlid:service-worker-notification-navigation";
const NOTIFICATION_NAVIGATION_MARKER =
	"hlid:notification-navigation-override:v1";
const NOTIFICATION_NAVIGATION_MARKER_TTL_MS = 30_000;

type BuildResponse = { type?: string; build?: string };
type ServiceWorkerMessenger = {
	postMessage(message: unknown, transfer: Transferable[]): void;
};

type NotificationNavigationPort = {
	postMessage(message: unknown): void;
	close?(): void;
};

type NotificationNavigationEvent = {
	data: unknown;
	ports?: readonly NotificationNavigationPort[];
};

type NotificationNavigationStorage = Pick<
	Storage,
	"getItem" | "setItem" | "removeItem"
>;

function hasControlCharacters(value: string): boolean {
	for (let index = 0; index < value.length; index++) {
		const code = value.charCodeAt(index);
		if (code <= 31 || code === 127) return true;
	}
	return false;
}

function browserSessionStorage(): NotificationNavigationStorage | null {
	try {
		return typeof window === "undefined" ? null : window.sessionStorage;
	} catch {
		return null;
	}
}

/** Mark one exact, already-validated notification navigation without storing
 * its session id or URL. Raven can consume this once to bypass a stale anchor. */
export function markServiceWorkerNotificationNavigation(
	storage: NotificationNavigationStorage | null = browserSessionStorage(),
	now = Date.now(),
): void {
	if (!storage || !Number.isSafeInteger(now) || now < 0) return;
	try {
		storage.setItem(NOTIFICATION_NAVIGATION_MARKER, String(now));
	} catch {
		// The navigation itself remains available when session storage is blocked.
	}
}

/** Consume the short-lived, content-free notification-origin marker once. */
export function consumeServiceWorkerNotificationNavigation(
	storage: NotificationNavigationStorage | null = browserSessionStorage(),
	now = Date.now(),
): boolean {
	if (!storage || !Number.isSafeInteger(now) || now < 0) return false;
	try {
		const raw = storage.getItem(NOTIFICATION_NAVIGATION_MARKER);
		storage.removeItem(NOTIFICATION_NAVIGATION_MARKER);
		if (!raw || !/^\d+$/.test(raw)) return false;
		const recordedAt = Number(raw);
		return (
			Number.isSafeInteger(recordedAt) &&
			recordedAt <= now &&
			now - recordedAt <= NOTIFICATION_NAVIGATION_MARKER_TTL_MS
		);
	} catch {
		return false;
	}
}

export async function serviceWorkerBuild(
	worker: ServiceWorkerMessenger,
	timeoutMs = 1_000,
): Promise<string | null> {
	const channel = new MessageChannel();
	return await new Promise((resolve) => {
		let settled = false;
		const finish = (build: string | null) => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			channel.port1.close();
			resolve(build);
		};
		const timeout = setTimeout(() => finish(null), timeoutMs);
		channel.port1.onmessage = (event: MessageEvent<BuildResponse>) => {
			const response = event.data;
			finish(
				response?.type === BUILD_RESPONSE && typeof response.build === "string"
					? response.build
					: null,
			);
		};
		try {
			worker.postMessage({ type: BUILD_REQUEST }, [channel.port2]);
		} catch {
			finish(null);
		}
	});
}

/** Reload only when the active worker proves this page is an older build. */
export function shouldReloadForServiceWorkerBuild(
	pageBuild: string,
	workerBuild: string | null,
): boolean {
	// A worker without the build handshake predates this safeguard. Preserve the
	// old conservative behavior for that one-time upgrade.
	return workerBuild === null || workerBuild !== pageBuild;
}

/** Accept only the same-origin path sent by Hlid's notification worker. */
export function serviceWorkerNotificationTarget(
	value: unknown,
	origin: string,
): string | null {
	if (
		typeof value !== "object" ||
		value === null ||
		(value as { type?: unknown }).type !== NOTIFICATION_NAVIGATION
	)
		return null;
	const candidate = (value as { url?: unknown }).url;
	if (
		typeof candidate !== "string" ||
		!candidate.startsWith("/") ||
		candidate.length > 2_048 ||
		hasControlCharacters(candidate)
	)
		return null;
	try {
		const base = new URL(origin);
		const target = new URL(candidate, base);
		if (target.origin !== base.origin) return null;
		return `${target.pathname}${target.search}${target.hash}`;
	} catch {
		return null;
	}
}

/** Add a one-navigation Raven hint only after the worker target has passed the
 * same-origin validator. The route consumes it immediately after choosing the
 * notification destination, so normal Raven links remain unchanged. */
export function serviceWorkerNotificationRouteTarget(
	target: string,
	origin: string,
): string {
	const safeTarget = serviceWorkerNotificationTarget(
		{ type: NOTIFICATION_NAVIGATION, url: target },
		origin,
	);
	if (!safeTarget) return "/";
	try {
		const parsed = new URL(safeTarget, origin);
		if (parsed.pathname !== "/raven") return safeTarget;
		parsed.searchParams.set("notification_open", "1");
		return `${parsed.pathname}${parsed.search}${parsed.hash}`;
	} catch {
		return "/";
	}
}

function acknowledgeNotificationNavigation(
	port: NotificationNavigationPort | undefined,
	accepted: boolean,
): void {
	if (!port) return;
	try {
		port.postMessage({
			type: NOTIFICATION_NAVIGATION_ACK,
			accepted,
		});
	} catch {
		// A closed message channel means the worker already took its fallback path.
	} finally {
		try {
			port.close?.();
		} catch {
			// Closing a transferred port is best-effort cleanup.
		}
	}
}

/**
 * Accept a notification target from Hlid's worker and acknowledge it as soon as
 * the live router has taken ownership. The acknowledgement deliberately does
 * not wait for route loaders: a slow loader must not make the worker replace a
 * healthy PWA document with a full navigation.
 */
export function handleServiceWorkerNotificationNavigation(
	event: NotificationNavigationEvent,
	origin: string,
	navigate: (target: string) => unknown,
): string | null {
	const port = event.ports?.[0];
	const target = serviceWorkerNotificationTarget(event.data, origin);
	if (!target) {
		acknowledgeNotificationNavigation(port, false);
		return null;
	}
	try {
		navigate(target);
		acknowledgeNotificationNavigation(port, true);
		return target;
	} catch {
		acknowledgeNotificationNavigation(port, false);
		return null;
	}
}
