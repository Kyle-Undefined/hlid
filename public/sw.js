// The build token below is stamped with the app version + build id at build time
// (swStampPlugin in vite.config.ts). Every deploy changes these bytes, so the
// browser sees a new worker, installs it (skipWaiting/claim below), and the
// activate handler drops every previous cache — no manual cache clearing.
const BUILD = "__HLID_BUILD__";
const CACHE = `hlid-${BUILD}`;
const CLIENT_PRESENTATION_CACHE = "hlid-client-presentation-v1";
const STANDALONE_CLIENT_RECORD_PATH = "/__hlid-internal/standalone-client";
const STATIC_EXTS = [".js", ".css", ".png", ".svg", ".ico", ".woff2"];
const OFFLINE_URL = "/offline.html";
const DYNAMIC_RETRY_DELAYS_MS = [150, 500];
const NOTIFICATION_NAVIGATION = "hlid:navigate-notification";
const NOTIFICATION_NAVIGATION_ACK = "hlid:navigate-notification-ack";
const NOTIFICATION_NAVIGATION_ACK_TIMEOUT_MS = 2_000;
const MAX_PUSH_PAYLOAD_CHARS = 8 * 1024;
const MAX_PUSH_AGE_MS = 24 * 60 * 60 * 1000;
const MAX_PUSH_FUTURE_SKEW_MS = 5 * 60 * 1000;
// Keep these bounds aligned with src/lib/pushNotificationSchemas.ts. The
// worker is intentionally dependency-free because public/ is copied verbatim.
const MAX_SESSION_ID_CHARS = 256;
const MAX_NOTIFICATION_TITLE_CHARS = 160;
const MAX_NOTIFICATION_BODY_CHARS = 500;
const MAX_NOTIFICATION_URL_CHARS = 2048;
const MAX_NOTIFICATION_REASON_CHARS = 64;
const MAX_NOTIFICATION_LABEL_CHARS = 160;
const MAX_NOTIFICATION_ATTENTION_ID_CHARS = 128;
const MAX_BATCH_SESSION_IDS = 10;
const MIN_BATCH_ID_CHARS = 8;
const MAX_BATCH_ID_CHARS = 64;
const MAX_PUSH_ENDPOINT_CHARS = 4096;
const NOTIFICATION_BADGE_URL = "/notification-badge.svg";
const FORGE_NOTIFICATIONS_URL = "/forge?category=experience&section=notifications";
const FALLBACK_NOTIFICATION = Object.freeze({
	title: "Hlid notification",
	body: "Open Hlid to check for updates.",
	tag: "hlid-generic",
	url: "/",
});

function isRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSafeSessionId(value) {
	if (
		typeof value !== "string" ||
		value.length === 0 ||
		value.length > MAX_SESSION_ID_CHARS
	)
		return false;
	for (let index = 0; index < value.length; index++) {
		const code = value.charCodeAt(index);
		if (code <= 31 || code === 127) return false;
	}
	return true;
}

function safeRavenTarget(sessionId, candidate) {
	const fallback = new URL("/raven", self.location.origin);
	fallback.searchParams.set("session", sessionId);
	if (typeof candidate !== "string" || candidate.length > MAX_NOTIFICATION_URL_CHARS)
		return `${fallback.pathname}${fallback.search}`;
	try {
		const url = new URL(candidate, self.location.origin);
		if (
			url.origin !== self.location.origin ||
			url.pathname !== "/raven" ||
			url.searchParams.get("session") !== sessionId ||
			url.searchParams.getAll("session").length !== 1 ||
			url.searchParams.getAll("attention").length > 1 ||
			url.searchParams.getAll("attention_id").length > 1
		)
			return `${fallback.pathname}${fallback.search}`;
		const attention = url.searchParams.get("attention");
		const attentionId = url.searchParams.get("attention_id");
		const validAttention =
			attention === "permission" ||
			attention === "question" ||
			attention === "plan_review";
		const validAttentionId =
			attentionId !== null &&
			attentionId.length >= 1 &&
			attentionId.length <= MAX_NOTIFICATION_ATTENTION_ID_CHARS &&
			/^[A-Za-z0-9._:-]+$/.test(attentionId);
		if (validAttention && attentionId === null) {
			fallback.searchParams.set("attention", attention);
		} else if (validAttention && validAttentionId) {
			fallback.searchParams.set("attention", attention);
			fallback.searchParams.set("attention_id", attentionId);
		}
		return `${fallback.pathname}${fallback.search}`;
	} catch {
		return `${fallback.pathname}${fallback.search}`;
	}
}

function safeRavenBatchTarget(batchId) {
	const target = new URL("/raven", self.location.origin);
	target.searchParams.set("notification_batch", batchId);
	return `${target.pathname}${target.search}`;
}

function safeRoutineTarget(routineId, routineRunId, candidate) {
	if (
		!isOpaqueUuid(routineId) ||
		!isOpaqueUuid(routineRunId) ||
		typeof candidate !== "string" ||
		candidate.length === 0 ||
		candidate.length > MAX_NOTIFICATION_URL_CHARS
	)
		return null;
	try {
		const url = new URL(candidate, self.location.origin);
		const entries = [...url.searchParams.entries()];
		if (
			url.origin !== self.location.origin ||
			url.pathname !== "/" ||
			url.hash !== "" ||
			entries.length !== 2 ||
			entries[0]?.[0] !== "routine" ||
			entries[0]?.[1] !== routineId ||
			entries[1]?.[0] !== "routine_run" ||
			entries[1]?.[1] !== routineRunId
		)
			return null;
		const target = new URL("/", self.location.origin);
		target.searchParams.set("routine", routineId);
		target.searchParams.set("routine_run", routineRunId);
		return `${target.pathname}${target.search}`;
	} catch {
		return null;
	}
}

function safeForgeNotificationsTarget() {
	return FORGE_NOTIFICATIONS_URL;
}

function parseBatchSessionIds(value, primarySessionId) {
	if (value === undefined) return null;
	if (
		!Array.isArray(value) ||
		value.length < 2 ||
		value.length > MAX_BATCH_SESSION_IDS ||
		!value.every(isSafeSessionId) ||
		new Set(value).size !== value.length ||
		!value.includes(primarySessionId)
	)
		return undefined;
	return value;
}

function parseBatchId(value) {
	if (value === undefined) return null;
	if (
		typeof value !== "string" ||
		value.length < MIN_BATCH_ID_CHARS ||
		value.length > MAX_BATCH_ID_CHARS ||
		!/^[A-Za-z0-9_-]+$/.test(value)
	)
		return undefined;
	return value;
}

function isOpaqueUuid(value) {
	return (
		typeof value === "string" &&
		(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
			value,
		) || value === "00000000-0000-0000-0000-000000000000")
	);
}

function parseDeliveryId(value) {
	if (value === undefined) return null;
	return isOpaqueUuid(value) ? value : undefined;
}

function parseBatchDeliveryIds(value, sessionIds) {
	if (value === undefined) return null;
	if (
		!sessionIds ||
		!Array.isArray(value) ||
		value.length !== sessionIds.length ||
		value.length < 2 ||
		value.length > MAX_BATCH_SESSION_IDS ||
		!value.every(isOpaqueUuid) ||
		new Set(value).size !== value.length
	)
		return undefined;
	return value;
}

function boundedOptionalString(value, maxChars) {
	if (value === undefined) return null;
	if (typeof value !== "string" || value.length === 0 || value.length > maxChars)
		return undefined;
	return value;
}

function parsePayloadValue(value, now = Date.now()) {
	const isTest = isRecord(value) && value.kind === "test";
	const isRoutine = isRecord(value) && value.source === "routine";
	if (
		!isRecord(value) ||
		value.version !== 1 ||
		(value.kind !== "needs_attention" &&
			value.kind !== "work_finished" &&
			value.kind !== "test") ||
		typeof value.title !== "string" ||
		value.title.length === 0 ||
		value.title.length > MAX_NOTIFICATION_TITLE_CHARS ||
		typeof value.body !== "string" ||
		value.body.length === 0 ||
		value.body.length > MAX_NOTIFICATION_BODY_CHARS ||
		!Number.isSafeInteger(value.createdAt) ||
		!Number.isSafeInteger(value.expiresAt) ||
		value.createdAt > now + MAX_PUSH_FUTURE_SKEW_MS ||
		value.createdAt < now - MAX_PUSH_AGE_MS ||
		value.expiresAt <= value.createdAt ||
		value.expiresAt > value.createdAt + MAX_PUSH_AGE_MS ||
		value.expiresAt <= now
	)
		return null;
	const deliveryId = parseDeliveryId(value.deliveryId);
	if (deliveryId === undefined) return null;
	if (isRoutine) {
		if (
			isTest ||
			value.sessionId !== undefined ||
			value.sessionIds !== undefined ||
			value.deliveryIds !== undefined ||
			value.batchId !== undefined ||
			!isOpaqueUuid(value.routineId) ||
			!isOpaqueUuid(value.routineRunId)
		)
			return null;
		const url = safeRoutineTarget(
			value.routineId,
			value.routineRunId,
			value.url,
		);
		const reason = boundedOptionalString(
			value.reason,
			MAX_NOTIFICATION_REASON_CHARS,
		);
		if (!url || reason === undefined) return null;
		return {
			version: 1,
			source: "routine",
			kind: value.kind,
			routineId: value.routineId,
			routineRunId: value.routineRunId,
			...(deliveryId ? { deliveryId } : {}),
			...(reason ? { reason } : {}),
			title: value.title,
			body: value.body,
			createdAt: value.createdAt,
			expiresAt: value.expiresAt,
			url,
		};
	}
	if (
		value.source !== undefined ||
		value.routineId !== undefined ||
		value.routineRunId !== undefined ||
		(!isTest && !isSafeSessionId(value.sessionId)) ||
		(isTest && value.sessionId !== undefined)
	)
		return null;
	if (isTest) {
		if (value.deliveryIds !== undefined) return null;
		return {
			version: 1,
			kind: "test",
			...(deliveryId ? { deliveryId } : {}),
			title: value.title,
			body: value.body,
			createdAt: value.createdAt,
			expiresAt: value.expiresAt,
			url: safeForgeNotificationsTarget(),
		};
	}
	const sessionIds = parseBatchSessionIds(value.sessionIds, value.sessionId);
	const deliveryIds = parseBatchDeliveryIds(value.deliveryIds, sessionIds);
	const batchId = parseBatchId(value.batchId);
	const reason = boundedOptionalString(value.reason, MAX_NOTIFICATION_REASON_CHARS);
	const sessionLabel = boundedOptionalString(
		value.sessionLabel,
		MAX_NOTIFICATION_LABEL_CHARS,
	);
	if (
		sessionIds === undefined ||
		deliveryIds === undefined ||
		batchId === undefined ||
		Boolean(sessionIds) !== Boolean(batchId) ||
		(sessionIds && value.kind !== "work_finished") ||
		Boolean(deliveryIds) && Boolean(deliveryId)
	)
		return null;
	if (
		reason === undefined ||
		sessionLabel === undefined ||
		(value.durationMs !== undefined &&
			(!Number.isSafeInteger(value.durationMs) || value.durationMs < 0))
	)
		return null;
	return {
		version: 1,
		kind: value.kind,
		sessionId: value.sessionId,
		...(sessionIds ? { sessionIds } : {}),
		...(deliveryIds ? { deliveryIds } : {}),
		...(batchId ? { batchId } : {}),
		...(deliveryId ? { deliveryId } : {}),
		...(reason ? { reason } : {}),
		...(sessionLabel ? { sessionLabel } : {}),
		...(value.durationMs !== undefined ? { durationMs: value.durationMs } : {}),
		title: value.title,
		body: value.body,
		createdAt: value.createdAt,
		expiresAt: value.expiresAt,
		url: sessionIds
			? safeRavenBatchTarget(batchId)
			: safeRavenTarget(value.sessionId, value.url),
	};
}

function parseDeclarativePayload(value, now = Date.now()) {
	if (
		!isRecord(value) ||
		value.web_push !== 8030 ||
		!isRecord(value.notification)
	)
		return null;
	const notification = value.notification;
	if (notification.mutable !== true || !isRecord(notification.data)) return null;
	const data = notification.data;
	return parsePayloadValue(
		{
			...data,
			title: notification.title ?? data.title,
			body: notification.body ?? data.body,
			url: notification.navigate ?? data.url,
			createdAt: notification.timestamp ?? data.createdAt,
		},
		now,
	);
}

function parseRawPushPayload(raw, now = Date.now()) {
	if (
		typeof raw !== "string" ||
		raw.length === 0 ||
		raw.length > MAX_PUSH_PAYLOAD_CHARS
	)
		return null;
	let value;
	try {
		value = JSON.parse(raw);
	} catch {
		return null;
	}
	return parseDeclarativePayload(value, now) ?? parsePayloadValue(value, now);
}

function parseDeclarativeNotification(notification, now = Date.now()) {
	if (!isRecord(notification) || !isRecord(notification.data)) return null;
	return parsePayloadValue(
		{
			...notification.data,
			title: notification.title ?? notification.data.title,
			body: notification.body ?? notification.data.body,
			url: notification.navigate ?? notification.data.url,
			createdAt: notification.timestamp ?? notification.data.createdAt,
		},
		now,
	);
}

async function showPushNotification(payload) {
	const tag =
		payload.source === "routine"
			? `hlid-routine:${payload.routineRunId}`
			: payload.kind === "test"
			? "hlid-test"
			: payload.sessionIds
				? `hlid-work-finished-batch:${payload.batchId}`
				: `hlid-session:${payload.sessionId}`;
	await self.registration.showNotification(payload.title, {
		body: payload.body,
		icon: "/logo192.png",
		badge: NOTIFICATION_BADGE_URL,
		tag,
		renotify: false,
		timestamp: payload.createdAt,
		data: {
			kind: payload.kind,
			...(payload.source ? { source: payload.source } : {}),
			...(payload.routineId ? { routineId: payload.routineId } : {}),
			...(payload.routineRunId
				? { routineRunId: payload.routineRunId }
				: {}),
			...(payload.sessionId ? { sessionId: payload.sessionId } : {}),
			...(payload.sessionIds ? { sessionIds: payload.sessionIds } : {}),
			...(payload.deliveryIds ? { deliveryIds: payload.deliveryIds } : {}),
			...(payload.batchId ? { batchId: payload.batchId } : {}),
			...(payload.deliveryId ? { deliveryId: payload.deliveryId } : {}),
			...(payload.reason ? { reason: payload.reason } : {}),
			...(payload.sessionLabel ? { sessionLabel: payload.sessionLabel } : {}),
			...(payload.durationMs !== undefined
				? { durationMs: payload.durationMs }
				: {}),
			url: payload.url,
			createdAt: payload.createdAt,
			expiresAt: payload.expiresAt,
		},
	});
}

async function showFallbackNotification() {
	await self.registration.showNotification(FALLBACK_NOTIFICATION.title, {
		body: FALLBACK_NOTIFICATION.body,
		icon: "/logo192.png",
		badge: NOTIFICATION_BADGE_URL,
		tag: FALLBACK_NOTIFICATION.tag,
		renotify: false,
		data: { fallback: true, url: FALLBACK_NOTIFICATION.url },
	});
}

async function showValidatedNotification(payload) {
	try {
		await showPushNotification(payload);
		return true;
	} catch {
		await showFallbackNotification();
		return false;
	}
}

function deliveryReceiptIds(data) {
	if (!isRecord(data)) return [];
	const deliveryId = parseDeliveryId(data.deliveryId);
	if (deliveryId === undefined) return [];
	if (data.deliveryIds === undefined) return deliveryId ? [deliveryId] : [];
	const sessionIds = parseBatchSessionIds(data.sessionIds, data.sessionId);
	const deliveryIds = parseBatchDeliveryIds(data.deliveryIds, sessionIds);
	const batchId = parseBatchId(data.batchId);
	if (
		deliveryId !== null ||
		!deliveryIds ||
		!sessionIds ||
		!batchId ||
		data.kind !== "work_finished"
	)
		return [];
	return deliveryIds;
}

async function sendDeliveryReceipt(deliveryId, status) {
	try {
		await fetch("/api/push/receipts", {
			method: "POST",
			credentials: "same-origin",
			cache: "no-store",
			headers: {
				accept: "application/json",
				"content-type": "application/json",
			},
			body: JSON.stringify({ delivery_id: deliveryId, status }),
		});
	} catch {
		// Delivery receipts are diagnostic only and never gate notification UX.
	}
}

async function sendDeliveryReceipts(data, status) {
	await Promise.all(
		deliveryReceiptIds(data).map((deliveryId) =>
			sendDeliveryReceipt(deliveryId, status),
		),
	);
}

function notificationTarget(data) {
	if (!isRecord(data)) return null;
	if (data.fallback === true && data.url === "/") return "/";
	if (data.kind === "test") return safeForgeNotificationsTarget();
	if (data.source === "routine") {
		if (
			(data.kind !== "needs_attention" && data.kind !== "work_finished") ||
			data.sessionId !== undefined ||
			data.sessionIds !== undefined ||
			data.deliveryIds !== undefined ||
			data.batchId !== undefined
		)
			return null;
		return safeRoutineTarget(data.routineId, data.routineRunId, data.url);
	}
	if (
		data.source !== undefined ||
		data.routineId !== undefined ||
		data.routineRunId !== undefined
	)
		return null;
	if (!isSafeSessionId(data.sessionId)) return null;
	const sessionIds = parseBatchSessionIds(data.sessionIds, data.sessionId);
	const deliveryIds = parseBatchDeliveryIds(data.deliveryIds, sessionIds);
	const batchId = parseBatchId(data.batchId);
	if (
		sessionIds === undefined ||
		deliveryIds === undefined ||
		batchId === undefined ||
		Boolean(sessionIds) !== Boolean(batchId) ||
		(Boolean(deliveryIds) && parseDeliveryId(data.deliveryId) !== null)
	)
		return null;
	if (sessionIds && data.kind !== "work_finished") return null;
	if (sessionIds) return safeRavenBatchTarget(batchId);
	return safeRavenTarget(data.sessionId, data.url);
}

function isBadgeRoutineNotification(notification) {
	const data = notification?.data;
	return (
		isRecord(data) &&
		data.source === "routine" &&
		(data.kind === "needs_attention" || data.kind === "work_finished") &&
		data.sessionId === undefined &&
		data.sessionIds === undefined &&
		data.batchId === undefined &&
		safeRoutineTarget(data.routineId, data.routineRunId, data.url) !== null &&
		notification.tag === `hlid-routine:${data.routineRunId}`
	);
}

function isBadgeHlidNotification(notification) {
	if (isBadgeRoutineNotification(notification)) return true;
	const data = notification?.data;
	if (!isRecord(data) || !isSafeSessionId(data.sessionId)) return false;
	if (data.kind !== "needs_attention" && data.kind !== "work_finished")
		return false;
	const sessionIds = parseBatchSessionIds(data.sessionIds, data.sessionId);
	const batchId = parseBatchId(data.batchId);
	if (
		sessionIds === undefined ||
		batchId === undefined ||
		Boolean(sessionIds) !== Boolean(batchId)
	)
		return false;
	if (sessionIds && data.kind !== "work_finished") return false;
	const expectedTag = sessionIds
		? `hlid-work-finished-batch:${batchId}`
		: `hlid-session:${data.sessionId}`;
	return notification.tag === expectedTag;
}

async function reconcileNotificationBadge() {
	try {
		const notifications = await self.registration.getNotifications();
		const count = notifications.filter(isBadgeHlidNotification).length;
		if (count > 0 && typeof self.navigator?.setAppBadge === "function") {
			await self.navigator.setAppBadge(count);
			return;
		}
		if (typeof self.navigator?.clearAppBadge === "function")
			await self.navigator.clearAppBadge();
	} catch {
		// Badging is a progressive enhancement and must never affect delivery.
	}
}

function isExpiredHlidNotification(notification, now = Date.now()) {
	const data = notification?.data;
	return (
		isRecord(data) &&
		((data.kind === "test" && notification.tag === "hlid-test") ||
			isBadgeHlidNotification(notification)) &&
		Number.isSafeInteger(data.createdAt) &&
		Number.isSafeInteger(data.expiresAt) &&
		data.expiresAt > data.createdAt &&
		data.expiresAt <= now
	);
}

async function pruneExpiredNotifications(now = Date.now()) {
	try {
		const notifications = await self.registration.getNotifications();
		for (const notification of notifications) {
			if (isExpiredHlidNotification(notification, now)) notification.close();
		}
	} catch {
		// Notification cleanup must not prevent a newly received push from showing.
	}
}

async function closeSessionNotifications(sessionId) {
	if (!isSafeSessionId(sessionId)) return;
	const tag = `hlid-session:${sessionId}`;
	try {
		const directNotifications = await self.registration.getNotifications({ tag });
		for (const notification of directNotifications) {
			if (
				notification.tag === tag &&
				isRecord(notification.data) &&
				notification.data.sessionId === sessionId
			)
				notification.close();
		}
	} catch {
		// Visibility-driven cleanup is best-effort.
	}
	// A grouped completion represents multiple unread sessions. Showing one
	// member must not dismiss the shared notification or emit dismissal receipts
	// for the unread remainder.
}

function decodeApplicationServerKey(value) {
	if (typeof value !== "string" || !/^[A-Za-z0-9_-]{80,120}$/.test(value))
		return null;
	try {
		const padded = `${value.replaceAll("-", "+").replaceAll("_", "/")}${"=".repeat((4 - (value.length % 4)) % 4)}`;
		const decoded = atob(padded);
		if (decoded.length !== 65) return null;
		const bytes = new Uint8Array(decoded.length);
		for (let index = 0; index < decoded.length; index++)
			bytes[index] = decoded.charCodeAt(index);
		return bytes.buffer;
	} catch {
		return null;
	}
}

function isSafePushEndpoint(value) {
	if (
		typeof value !== "string" ||
		value.length === 0 ||
		value.length > MAX_PUSH_ENDPOINT_CHARS
	)
		return false;
	try {
		const endpoint = new URL(value);
		return (
			endpoint.protocol === "https:" &&
			!endpoint.username &&
			!endpoint.password &&
			!endpoint.hash
		);
	} catch {
		return false;
	}
}

function serializePushSubscription(subscription) {
	let value;
	try {
		value =
			typeof subscription?.toJSON === "function"
				? subscription.toJSON()
				: subscription;
	} catch {
		return null;
	}
	if (
		!isRecord(value) ||
		!isSafePushEndpoint(value.endpoint) ||
		(value.expirationTime !== undefined &&
			value.expirationTime !== null &&
			(!Number.isSafeInteger(value.expirationTime) || value.expirationTime <= 0)) ||
		!isRecord(value.keys) ||
		typeof value.keys.p256dh !== "string" ||
		value.keys.p256dh.length === 0 ||
		value.keys.p256dh.length > 512 ||
		!/^[A-Za-z0-9_-]+$/.test(value.keys.p256dh) ||
		typeof value.keys.auth !== "string" ||
		value.keys.auth.length === 0 ||
		value.keys.auth.length > 512 ||
		!/^[A-Za-z0-9_-]+$/.test(value.keys.auth)
	)
		return null;
	return {
		endpoint: value.endpoint,
		...(value.expirationTime !== undefined
			? { expirationTime: value.expirationTime }
			: {}),
		keys: { p256dh: value.keys.p256dh, auth: value.keys.auth },
	};
}

async function resubscribeAfterPushSubscriptionChange(
	oldSubscription,
	newSubscription,
) {
	try {
		const replacesEndpoint = isSafePushEndpoint(oldSubscription?.endpoint)
			? oldSubscription.endpoint
			: null;
		let serialized = serializePushSubscription(newSubscription);
		if (!serialized) {
			// When the browser does not provide the replacement, an exact old
			// endpoint is required before Hlid creates one. This keeps an ambiguous
			// background event from silently registering a new default device.
			if (!replacesEndpoint) return;
			const configResponse = await fetch("/api/push/config", {
				method: "GET",
				credentials: "same-origin",
				cache: "no-store",
				headers: { accept: "application/json" },
			});
			if (!configResponse.ok) return;
			const config = await configResponse.json();
			if (!isRecord(config) || config.available !== true) return;
			const applicationServerKey = decodeApplicationServerKey(config.publicKey);
			if (!applicationServerKey) return;
			const subscribe = self.registration.pushManager?.subscribe;
			if (typeof subscribe !== "function") return;
			const subscription = await subscribe.call(self.registration.pushManager, {
				userVisibleOnly: true,
				applicationServerKey,
			});
			serialized = serializePushSubscription(subscription);
		}
		if (!serialized) return;
		const registrationResponse = await fetch("/api/push/subscriptions", {
			method: "POST",
			credentials: "same-origin",
			cache: "no-store",
			headers: {
				accept: "application/json",
				"content-type": "application/json",
			},
			body: JSON.stringify({
				subscription: serialized,
				...(replacesEndpoint
					? { replaces_endpoint: replacesEndpoint }
					: {}),
			}),
		});
		if (!registrationResponse.ok) return;
	} catch {
		// Foreground reconciliation remains the fallback for rotation failures.
	}
}

function sameOriginWindow(client) {
	try {
		return new URL(client.url).origin === self.location.origin;
	} catch {
		return false;
	}
}

function isSafeClientId(value) {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		value.length <= 256 &&
		!/[\u0000-\u001f\u007f]/.test(value)
	);
}

async function rememberClientPresentation(source, standalone) {
	if (
		!source ||
		!isSafeClientId(source.id) ||
		!sameOriginWindow(source) ||
		typeof standalone !== "boolean"
	)
		return;
	try {
		const cache = await caches.open(CLIENT_PRESENTATION_CACHE);
		const recordUrl = new URL(
			STANDALONE_CLIENT_RECORD_PATH,
			self.location.origin,
		).href;
		if (standalone) {
			await cache.put(recordUrl, new Response(source.id));
			return;
		}
		const current = await cache.match(recordUrl);
		if (current && (await current.text()) === source.id) {
			await cache.delete(recordUrl);
		}
	} catch {
		// Client targeting is a best-effort launch enhancement.
	}
}

async function knownStandaloneClient(windowClients) {
	try {
		const cache = await caches.open(CLIENT_PRESENTATION_CACHE);
		const recordUrl = new URL(
			STANDALONE_CLIENT_RECORD_PATH,
			self.location.origin,
		).href;
		const stored = await cache.match(recordUrl);
		if (!stored) return null;
		const clientId = await stored.text();
		if (!isSafeClientId(clientId)) {
			await cache.delete(recordUrl);
			return null;
		}
		const client = windowClients.find(
			(candidate) => candidate.id === clientId && sameOriginWindow(candidate),
		);
		if (client) return client;
		await cache.delete(recordUrl);
	} catch {
		// Continue through the browser's normal installed-app launch path.
	}
	return null;
}

function isPositiveNotificationNavigationAck(value) {
	return (
		isRecord(value) &&
		value.type === NOTIFICATION_NAVIGATION_ACK &&
		value.accepted === true
	);
}

async function requestLiveClientNavigation(client, target) {
	if (
		typeof client.postMessage !== "function" ||
		typeof MessageChannel !== "function"
	)
		return false;
	const channel = new MessageChannel();
	return await new Promise((resolve) => {
		let settled = false;
		const finish = (accepted) => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			try {
				channel.port1.close();
			} catch {
				// The acknowledgement already settled this best-effort channel.
			}
			resolve(accepted);
		};
		const timeout = setTimeout(
			() => finish(false),
			NOTIFICATION_NAVIGATION_ACK_TIMEOUT_MS,
		);
		channel.port1.onmessage = (event) =>
			finish(isPositiveNotificationNavigationAck(event.data));
		try {
			client.postMessage(
				{ type: NOTIFICATION_NAVIGATION, version: 1, url: target },
				[channel.port2],
			);
		} catch {
			try {
				channel.port2.close();
			} catch {
				// The port may already have transferred before the client disappeared.
			}
			finish(false);
		}
	});
}

function uniqueClients(clients) {
	return clients.filter(
		(client, index) =>
			client &&
			clients.findIndex(
				(candidate) =>
					candidate === client ||
					(isSafeClientId(candidate?.id) && candidate.id === client.id),
			) === index,
	);
}

function notificationDocumentTarget(target) {
	try {
		const parsed = new URL(target, self.location.origin);
		if (parsed.origin !== self.location.origin || parsed.pathname !== "/raven")
			return target;
		parsed.searchParams.set("notification_open", "1");
		return `${parsed.pathname}${parsed.search}${parsed.hash}`;
	} catch {
		return target;
	}
}

async function navigateAndFocus(client, target) {
	let focused = client;
	let focusSucceeded = false;
	try {
		if (typeof client.focus === "function") {
			focused = (await client.focus()) ?? client;
			focusSucceeded = true;
		}
	} catch {
		// Messaging or navigation below can still recover a stale focus handle.
	}
	const candidates = uniqueClients([focused, client]);
	for (const candidate of candidates) {
		if (await requestLiveClientNavigation(candidate, target)) return true;
	}
	// An older page will not acknowledge the router message. Fall back to the
	// WindowClient navigation contract only after the bounded handshake expires.
	const documentTarget = notificationDocumentTarget(target);
	for (const candidate of candidates) {
		if (typeof candidate.navigate !== "function") continue;
		try {
			const navigated = await candidate.navigate(documentTarget);
			if (!navigated) continue;
			if (navigated !== focused && typeof navigated.focus === "function") {
				await navigated.focus();
			}
			return true;
		} catch {
			// A background client can expose a stale pre-focus navigation handle.
		}
	}
	// If the app was successfully foregrounded, do not counteract that by opening
	// the same target in a competing browser tab after both navigation paths fail.
	return focusSucceeded;
}

async function openNotificationTarget(target) {
	const absoluteTarget = new URL(
		notificationDocumentTarget(target),
		self.location.origin,
	).href;
	const windowClients = await self.clients.matchAll({
		type: "window",
		includeUncontrolled: true,
	});
	const standalone = await knownStandaloneClient(windowClients);

	// Notification clicks should reuse an existing Hlid window before asking the
	// browser to create one. This is also the standards-recommended ordering, and
	// avoids browsers that implement openWindow() as a normal tab even while the
	// installed standalone PWA is alive in the background.
	const exact = windowClients.find((client) => {
		try {
			return new URL(client.url).href === absoluteTarget;
		} catch {
			return false;
		}
	});
	const existing = windowClients.find(sameOriginWindow);
	for (const client of uniqueClients([standalone, exact, existing])) {
		if (await navigateAndFocus(client, target)) return;
	}

	try {
		const opened = await self.clients.openWindow(absoluteTarget);
		if (opened) {
			if (typeof opened.focus === "function") await opened.focus();
			return;
		}
	} catch {
		// There is no remaining same-origin client to recover.
	}
}

async function fetchDynamic(request) {
	let lastError;
	for (let attempt = 0; attempt <= DYNAMIC_RETRY_DELAYS_MS.length; attempt++) {
		try {
			return await fetch(request);
		} catch (error) {
			lastError = error;
			const delay = DYNAMIC_RETRY_DELAYS_MS[attempt];
			if (delay === undefined) break;
			await new Promise((resolve) => setTimeout(resolve, delay));
		}
	}
	throw lastError;
}

self.addEventListener("install", (e) => {
	e.waitUntil(caches.open(CACHE).then((c) => c.add(OFFLINE_URL)));
	self.skipWaiting();
});

self.addEventListener("activate", (e) => {
	e.waitUntil(
		(async () => {
			await Promise.all([
				caches
				.keys()
				.then((keys) =>
					Promise.all(
						keys
							.filter(
								(k) => k !== CACHE && k !== CLIENT_PRESENTATION_CACHE,
							)
							.map((k) => caches.delete(k)),
					),
				),
				self.registration.navigationPreload?.enable?.(),
				self.clients.claim(),
			]);
			await pruneExpiredNotifications();
			await reconcileNotificationBadge();
		})(),
	);
});

self.addEventListener("message", (e) => {
	if (e.data?.type === "hlid:client-presentation") {
		e.waitUntil(rememberClientPresentation(e.source, e.data.standalone));
		return;
	}
	if (e.data?.type === "hlid:get-build") {
		e.ports[0]?.postMessage({ type: "hlid:build", build: BUILD });
		return;
	}
	if (e.data?.type === "hlid:reconcile-notification-badge") {
		e.waitUntil(
			(async () => {
				await pruneExpiredNotifications();
				await reconcileNotificationBadge();
			})(),
		);
		return;
	}
	if (e.data?.type !== "hlid:close-session-notifications") return;
	e.waitUntil(
		(async () => {
			await pruneExpiredNotifications();
			await closeSessionNotifications(e.data.sessionId);
			await reconcileNotificationBadge();
		})(),
	);
});

self.addEventListener("push", (e) => {
	e.waitUntil(
		(async () => {
			await pruneExpiredNotifications();
			const declarativePayload = parseDeclarativeNotification(e.notification);
			if (declarativePayload) {
				const displayed = await showValidatedNotification(declarativePayload);
				if (displayed)
					await sendDeliveryReceipts(declarativePayload, "displayed");
				await reconcileNotificationBadge();
				return;
			}
			let raw;
			try {
				raw = e.data?.text();
			} catch {
				await showFallbackNotification();
				await reconcileNotificationBadge();
				return;
			}
			const payload = parseRawPushPayload(raw);
			if (!payload) {
				// WebKit revokes push permission when a received push does not result in
				// a visible notification. Never expose rejected payload content; show a
				// bounded generic fallback that can only navigate to Hlid's root.
				await showFallbackNotification();
				await reconcileNotificationBadge();
				return;
			}
			const displayed = await showValidatedNotification(payload);
			if (displayed) await sendDeliveryReceipts(payload, "displayed");
			await reconcileNotificationBadge();
		})(),
	);
});

self.addEventListener("notificationclick", (e) => {
	e.notification.close();
	const target = notificationTarget(e.notification.data);
	e.waitUntil(
		Promise.all([
			sendDeliveryReceipts(e.notification.data, "opened"),
			(async () => {
				await pruneExpiredNotifications();
				await reconcileNotificationBadge();
				if (target) await openNotificationTarget(target);
			})(),
		]),
	);
});

self.addEventListener("notificationclose", (e) => {
	e.waitUntil(
		Promise.all([
			sendDeliveryReceipts(e.notification.data, "dismissed"),
			(async () => {
				await pruneExpiredNotifications();
				await reconcileNotificationBadge();
			})(),
		]),
	);
});

self.addEventListener("pushsubscriptionchange", (e) => {
	e.waitUntil(
		resubscribeAfterPushSubscriptionChange(
			e.oldSubscription,
			e.newSubscription,
		),
	);
});

self.addEventListener("fetch", (e) => {
	const url = new URL(e.request.url);
	if (e.request.method !== "GET") return;
	if (url.protocol !== "http:" && url.protocol !== "https:") return;
	if (url.pathname.startsWith("/api/")) return;

	const isStatic = STATIC_EXTS.some((ext) => url.pathname.endsWith(ext));

	if (e.request.mode === "navigate") {
		e.respondWith(
			(async () => {
				try {
					// Navigation preload starts the network request while a dormant
					// worker is still waking up, avoiding a cold-worker TTFB penalty.
					const preloaded = await e.preloadResponse;
					if (preloaded) return preloaded;
					return await fetchDynamic(e.request);
				} catch {
					const offline = await caches.match(OFFLINE_URL);
					if (offline) return offline;
					return new Response("Hlið is temporarily unavailable.", {
						status: 503,
						headers: { "content-type": "text/plain; charset=utf-8" },
					});
				}
			})(),
		);
		return;
	}

	if (isStatic) {
		e.respondWith(
			caches.match(e.request).then((cached) => {
				if (cached) return cached;
				return fetch(e.request)
					.then((res) => {
						if (res.ok) {
							const clone = res.clone();
							caches.open(CACHE).then((c) => c.put(e.request, clone));
						}
						return res;
					})
					.catch(async () => {
						const fallback = await caches.match(e.request);
						return fallback ?? new Response("Offline", { status: 503 });
					});
			}),
		);
	} else {
		e.respondWith(
			fetchDynamic(e.request).catch(async () => {
				const fallback = await caches.match(e.request);
				if (fallback) return fallback;
				return new Response("Hlið is temporarily unavailable.", {
					status: 503,
					headers: { "content-type": "text/plain; charset=utf-8" },
				});
			}),
		);
	}
});
