import { loadToken, verifyToken } from "./token";

/**
 * Verify an exact browser-origin mutation, including the public HTTPS origin
 * preserved by Hlid's authenticated loopback TLS proxy.
 */
export function isExactSameOriginMutation(request: Request): boolean {
	const requestUrl = new URL(request.url);
	const forwardedHost = request.headers.get("x-hlid-forwarded-host");
	const trustedProxy = verifyToken(
		request.headers.get("x-hlid-proxy-token"),
		loadToken(),
	);
	const expectedOrigin =
		trustedProxy &&
		request.headers.get("x-hlid-forwarded-proto") === "https" &&
		forwardedHost &&
		!/[\r\n/@]/.test(forwardedHost)
			? `https://${forwardedHost}`
			: requestUrl.origin;
	if (request.headers.get("origin") !== expectedOrigin) return false;
	const fetchSite = request.headers.get("sec-fetch-site");
	return !fetchSite || fetchSite === "same-origin";
}
