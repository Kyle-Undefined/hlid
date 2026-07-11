const CACHE = "hlid-v4";
const STATIC_EXTS = [".js", ".css", ".png", ".svg", ".ico", ".woff2"];

self.addEventListener("install", () => {
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
				return (
					fallback ??
					new Response("Hlið is temporarily unavailable.", {
						status: 503,
						headers: { "content-type": "text/plain; charset=utf-8" },
					})
				);
			}),
		);
	}
});
