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
const MAX_BATCH_SESSION_IDS = 10;
const MIN_BATCH_ID_CHARS = 8;
const MAX_BATCH_ID_CHARS = 64;
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
			url.searchParams.get("session") !== sessionId
		)
			return `${fallback.pathname}${fallback.search}`;
		const attention = url.searchParams.get("attention");
		if (
			attention === "permission" ||
			attention === "question" ||
			attention === "plan_review"
		)
			fallback.searchParams.set("attention", attention);
		return `${fallback.pathname}${fallback.search}`;
	} catch {
		return `${fallback.pathname}${fallback.search}`;
	}
}

function safeRavenOverviewTarget() {
	return "/raven";
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

function boundedOptionalString(value, maxChars) {
	if (value === undefined) return null;
	if (typeof value !== "string" || value.length === 0 || value.length > maxChars)
		return undefined;
	return value;
}

function parsePayloadValue(value, now = Date.now()) {
	const isTest = isRecord(value) && value.kind === "test";
	if (
		!isRecord(value) ||
		value.version !== 1 ||
		(value.kind !== "needs_attention" &&
			value.kind !== "work_finished" &&
			value.kind !== "test") ||
		(!isTest && !isSafeSessionId(value.sessionId)) ||
		(isTest && value.sessionId !== undefined) ||
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
	if (isTest) {
		return {
			version: 1,
			kind: "test",
			title: value.title,
			body: value.body,
			createdAt: value.createdAt,
			expiresAt: value.expiresAt,
			url: safeForgeNotificationsTarget(),
		};
	}
	const sessionIds = parseBatchSessionIds(value.sessionIds, value.sessionId);
	const batchId = parseBatchId(value.batchId);
	const reason = boundedOptionalString(value.reason, MAX_NOTIFICATION_REASON_CHARS);
	const sessionLabel = boundedOptionalString(
		value.sessionLabel,
		MAX_NOTIFICATION_LABEL_CHARS,
	);
	if (
		sessionIds === undefined ||
		batchId === undefined ||
		Boolean(sessionIds) !== Boolean(batchId) ||
		(sessionIds && value.kind !== "work_finished")
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
		...(batchId ? { batchId } : {}),
		...(reason ? { reason } : {}),
		...(sessionLabel ? { sessionLabel } : {}),
		...(value.durationMs !== undefined ? { durationMs: value.durationMs } : {}),
		title: value.title,
		body: value.body,
		createdAt: value.createdAt,
		expiresAt: value.expiresAt,
		url: sessionIds
			? safeRavenOverviewTarget()
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
		payload.kind === "test"
			? "hlid-test"
			: payload.sessionIds
				? `hlid-work-finished-batch:${payload.batchId}`
				: `hlid-session:${payload.sessionId}`;
	await self.registration.showNotification(payload.title, {
		body: payload.body,
		icon: "/logo192.png",
		tag,
		renotify: false,
		timestamp: payload.createdAt,
		data: {
			kind: payload.kind,
			...(payload.sessionId ? { sessionId: payload.sessionId } : {}),
			...(payload.sessionIds ? { sessionIds: payload.sessionIds } : {}),
			...(payload.batchId ? { batchId: payload.batchId } : {}),
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
		tag: FALLBACK_NOTIFICATION.tag,
		renotify: false,
		data: { fallback: true, url: FALLBACK_NOTIFICATION.url },
	});
}

async function showValidatedNotification(payload) {
	try {
		await showPushNotification(payload);
	} catch {
		await showFallbackNotification();
	}
}

function notificationTarget(data) {
	if (!isRecord(data)) return null;
	if (data.fallback === true && data.url === "/") return "/";
	if (data.kind === "test") return safeForgeNotificationsTarget();
	if (!isSafeSessionId(data.sessionId)) return null;
	const sessionIds = parseBatchSessionIds(data.sessionIds, data.sessionId);
	const batchId = parseBatchId(data.batchId);
	if (
		sessionIds === undefined ||
		batchId === undefined ||
		Boolean(sessionIds) !== Boolean(batchId)
	)
		return null;
	if (sessionIds && data.kind !== "work_finished") return null;
	if (sessionIds) return safeRavenOverviewTarget();
	return safeRavenTarget(data.sessionId, data.url);
}

function isBadgeHlidNotification(notification) {
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
	try {
		const tag = `hlid-session:${sessionId}`;
		const notifications = await self.registration.getNotifications({ tag });
		for (const notification of notifications) {
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

async function navigateAndFocus(client, target) {
	if (typeof client.navigate !== "function") return false;
	try {
		const navigated = await client.navigate(target);
		const focused = navigated ?? client;
		if (typeof focused.focus === "function") await focused.focus();
		return true;
	} catch {
		return false;
	}
}

async function openNotificationTarget(target) {
	const absoluteTarget = new URL(target, self.location.origin).href;
	const windowClients = await self.clients.matchAll({
		type: "window",
		includeUncontrolled: true,
	});
	const standalone = await knownStandaloneClient(windowClients);
	if (standalone && (await navigateAndFocus(standalone, target))) return;

	try {
		// Give the browser the first chance to launch or reuse the installed PWA.
		// Chromium and WebKit associate this call with the installed web app, while
		// manually navigating an arbitrary same-origin client can select a browser tab.
		const opened = await self.clients.openWindow(target);
		if (opened) {
			if (typeof opened.focus === "function") await opened.focus();
			return;
		}
	} catch {
		// Fall back to an already open browser client when app launch is unavailable.
	}

	const exact = windowClients.find((client) => {
		try {
			return new URL(client.url).href === absoluteTarget;
		} catch {
			return false;
		}
	});
	if (exact && typeof exact.focus === "function") {
		await exact.focus();
		return;
	}

	const existing = windowClients.find(sameOriginWindow);
	if (existing) await navigateAndFocus(existing, target);
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
				await showValidatedNotification(declarativePayload);
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
			await showValidatedNotification(payload);
			await reconcileNotificationBadge();
		})(),
	);
});

self.addEventListener("notificationclick", (e) => {
	e.notification.close();
	const target = notificationTarget(e.notification.data);
	e.waitUntil(
		(async () => {
			await pruneExpiredNotifications();
			await reconcileNotificationBadge();
			if (target) await openNotificationTarget(target);
		})(),
	);
});

self.addEventListener("notificationclose", (e) => {
	e.waitUntil(
		(async () => {
			await pruneExpiredNotifications();
			await reconcileNotificationBadge();
		})(),
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
