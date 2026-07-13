const STATIC_PATH =
	/\.(?:js|css|png|jpe?g|gif|webp|svg|ico|woff2?|webmanifest)$/i;

export function isStaticPath(pathname: string): boolean {
	return STATIC_PATH.test(pathname);
}

/** Paths that must remain reachable before a user has an authenticated session. */
export function isPublicPath(pathname: string): boolean {
	const normalized =
		pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
	return (
		normalized === "/login" ||
		normalized === "/api/health" ||
		normalized === "/manifest.json" ||
		normalized === "/sw.js" ||
		normalized === "/offline.html" ||
		normalized === "/favicon.svg" ||
		normalized === "/apple-touch-icon.png" ||
		normalized.startsWith("/api/auth/") ||
		(normalized.startsWith("/assets/") && isStaticPath(normalized))
	);
}
