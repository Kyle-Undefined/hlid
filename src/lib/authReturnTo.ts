const MAX_RETURN_TO_LENGTH = 2_048;

const APP_PATHS = new Set([
	"/",
	"/einherjar",
	"/forge",
	"/ledger",
	"/raven",
	"/relics",
	"/vault",
]);

/**
 * Keep post-login navigation inside Hlid's authenticated application surface.
 *
 * This intentionally accepts only known document routes. API, server-function,
 * login, protocol-relative, absolute, and oversized targets all fall back to
 * the application root.
 */
export function safeAuthReturnTo(value: string | null | undefined): string {
	if (!value || value.length > MAX_RETURN_TO_LENGTH) return "/";
	if (!value.startsWith("/") || value.startsWith("//")) return "/";
	try {
		const parsed = new URL(value, "https://hlid.invalid");
		if (parsed.origin !== "https://hlid.invalid") return "/";
		const pathname =
			parsed.pathname.length > 1
				? parsed.pathname.replace(/\/+$/, "")
				: parsed.pathname;
		if (!APP_PATHS.has(pathname)) return "/";
		return `${pathname}${parsed.search}${parsed.hash}`;
	} catch {
		return "/";
	}
}

export function loginLocationForReturnTo(
	value: string | null | undefined,
): string {
	const target = safeAuthReturnTo(value);
	return target === "/"
		? "/login"
		: `/login?next=${encodeURIComponent(target)}`;
}

export function requestAuthReturnTo(request: Request): string {
	const url = new URL(request.url);
	return safeAuthReturnTo(`${url.pathname}${url.search}`);
}
