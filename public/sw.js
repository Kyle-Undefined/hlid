// The build token below is stamped with the app version + build id at build time
// (swStampPlugin in vite.config.ts). Every deploy changes these bytes, so the
// browser sees a new worker, installs it (skipWaiting/claim below), and the
// activate handler drops every previous cache — no manual cache clearing.
const BUILD = "__HLID_BUILD__";
const CACHE = `hlid-${BUILD}`;
const STATIC_EXTS = [".js", ".css", ".png", ".svg", ".ico", ".woff2"];
const OFFLINE_URL = "/offline.html";

self.addEventListener("install", (e) => {
	e.waitUntil(caches.open(CACHE).then((c) => c.add(OFFLINE_URL)));
	self.skipWaiting();
});

self.addEventListener("activate", (e) => {
	e.waitUntil(
		caches
			.keys()
			.then((keys) =>
				Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))),
			),
	);
	self.clients.claim();
});

self.addEventListener("message", (e) => {
	if (e.data?.type !== "hlid:get-build") return;
	e.ports[0]?.postMessage({ type: "hlid:build", build: BUILD });
});

self.addEventListener("fetch", (e) => {
	const url = new URL(e.request.url);
	if (e.request.method !== "GET") return;
	if (url.protocol !== "http:" && url.protocol !== "https:") return;
	if (url.pathname.startsWith("/api/")) return;

	const isStatic = STATIC_EXTS.some((ext) => url.pathname.endsWith(ext));

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
			fetch(e.request).catch(async () => {
				const fallback = await caches.match(e.request);
				if (fallback) return fallback;
				if (e.request.mode === "navigate") {
					const offline = await caches.match(OFFLINE_URL);
					if (offline) return offline;
				}
				return new Response("Hlið is temporarily unavailable.", {
					status: 503,
					headers: { "content-type": "text/plain; charset=utf-8" },
				});
			}),
		);
	}
});
