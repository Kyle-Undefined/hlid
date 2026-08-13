// The build token below is stamped with the app version + build id at build time
// (swStampPlugin in vite.config.ts). Every deploy changes these bytes, so the
// browser sees a new worker, installs it (skipWaiting/claim below), and the
// activate handler drops every previous cache — no manual cache clearing.
const BUILD = "__HLID_BUILD__";
const CACHE = `hlid-${BUILD}`;
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
		return `${url.pathname}${url.search}`;
	} catch {
		return `${fallback.pathname}${fallback.search}`;
	}
}

function parsePayloadValue(value, now = Date.now()) {
	if (
		!isRecord(value) ||
		value.version !== 1 ||
		(value.kind !== "needs_attention" && value.kind !== "work_finished") ||
		!isSafeSessionId(value.sessionId) ||
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
	return {
		version: 1,
		kind: value.kind,
		sessionId: value.sessionId,
		title: value.title,
		body: value.body,
		createdAt: value.createdAt,
		expiresAt: value.expiresAt,
		url: safeRavenTarget(value.sessionId, value.url),
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
	await self.registration.showNotification(payload.title, {
		body: payload.body,
		icon: "/logo192.png",
		tag: `hlid-session:${payload.sessionId}`,
		renotify: false,
		timestamp: payload.createdAt,
		data: {
			kind: payload.kind,
			sessionId: payload.sessionId,
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
	if (!isSafeSessionId(data.sessionId)) return null;
	return safeRavenTarget(data.sessionId, data.url);
}

function isExpiredHlidNotification(notification, now = Date.now()) {
	const data = notification?.data;
	return (
		isRecord(data) &&
		isSafeSessionId(data.sessionId) &&
		notification.tag === `hlid-session:${data.sessionId}` &&
		(data.kind === "needs_attention" || data.kind === "work_finished") &&
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

async function focusNotificationTarget(target) {
	const absoluteTarget = new URL(target, self.location.origin).href;
	const windowClients = await self.clients.matchAll({
		type: "window",
		includeUncontrolled: true,
	});
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
	if (existing && typeof existing.navigate === "function") {
		try {
			const navigated = await existing.navigate(target);
			const focused = navigated ?? existing;
			if (typeof focused.focus === "function") await focused.focus();
			return;
		} catch {
			// A stale or non-navigable window should not prevent a fresh app window.
		}
	}
	await self.clients.openWindow(target);
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
		Promise.all([
			caches
				.keys()
				.then((keys) =>
					Promise.all(
						keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)),
					),
				),
			self.registration.navigationPreload?.enable?.(),
			self.clients.claim(),
			pruneExpiredNotifications(),
		]),
	);
});

self.addEventListener("message", (e) => {
	if (e.data?.type === "hlid:get-build") {
		e.ports[0]?.postMessage({ type: "hlid:build", build: BUILD });
		return;
	}
	if (e.data?.type !== "hlid:close-session-notifications") return;
	e.waitUntil(
		Promise.all([
			pruneExpiredNotifications(),
			closeSessionNotifications(e.data.sessionId),
		]),
	);
});

self.addEventListener("push", (e) => {
	e.waitUntil(
		(async () => {
			await pruneExpiredNotifications();
			const declarativePayload = parseDeclarativeNotification(e.notification);
			if (declarativePayload) {
				await showValidatedNotification(declarativePayload);
				return;
			}
			let raw;
			try {
				raw = e.data?.text();
			} catch {
				await showFallbackNotification();
				return;
			}
			const payload = parseRawPushPayload(raw);
			if (!payload) {
				// WebKit revokes push permission when a received push does not result in
				// a visible notification. Never expose rejected payload content; show a
				// bounded generic fallback that can only navigate to Hlid's root.
				await showFallbackNotification();
				return;
			}
			await showValidatedNotification(payload);
		})(),
	);
});

self.addEventListener("notificationclick", (e) => {
	e.notification.close();
	const target = notificationTarget(e.notification.data);
	e.waitUntil(
		Promise.all([
			pruneExpiredNotifications(),
			target ? focusNotificationTarget(target) : Promise.resolve(),
		]),
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
