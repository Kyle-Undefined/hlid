import { isAllowedOrigin, isAllowedOriginHeader } from "./allowedOrigin";
import { isPublicPath } from "./publicPath";

export type UiSecurityDependencies = {
	effectivePeerIp(
		request: Request,
		directPeerIp: string | undefined,
	): string | undefined;
	isInternal(directPeerIp: string | undefined, request: Request): boolean;
	authenticate(request: Request): Promise<boolean>;
};

/**
 * Decide whether a UI/server-function request may reach TanStack Start.
 * Transport-specific dependency loading stays in start.ts; the security policy
 * itself is centralized here so production and tests exercise the same rules.
 */
export async function uiSecurityRejection(
	request: Request,
	directPeerIp: string | undefined,
	allowLocalNetwork: boolean,
	dependencies: UiSecurityDependencies,
): Promise<Response | null> {
	const peerIp = dependencies.effectivePeerIp(request, directPeerIp);
	const url = new URL(request.url);
	const pathname =
		url.pathname.length > 1 ? url.pathname.replace(/\/+$/, "") : url.pathname;
	const buildLoginShell =
		pathname === "/login" &&
		(request.headers.get("x-tss-shell")?.toLowerCase() === "true" ||
			request.headers.get("x-hlid-login-shell") === "build");

	if (!buildLoginShell && !isAllowedOrigin(peerIp, allowLocalNetwork)) {
		return new Response("Forbidden", { status: 403 });
	}
	if (
		request.method !== "GET" &&
		request.method !== "HEAD" &&
		!isAllowedOriginHeader(request.headers.get("origin"), allowLocalNetwork)
	) {
		return new Response("Forbidden", { status: 403 });
	}

	const authenticated =
		dependencies.isInternal(directPeerIp, request) ||
		(await dependencies.authenticate(request));
	if (pathname === "/login" && authenticated) {
		return new Response(null, {
			status: 302,
			headers: { location: "/", "cache-control": "no-store" },
		});
	}
	if (isPublicPath(pathname) || authenticated) return null;

	const wantsDocument =
		request.method === "GET" &&
		(request.headers.get("accept")?.includes("text/html") ?? false) &&
		request.headers.get("x-tsr-serverfn") !== "true";
	if (wantsDocument) {
		return new Response(null, {
			status: 302,
			headers: { location: "/login", "cache-control": "no-store" },
		});
	}
	return Response.json(
		{ error: "Unauthorized" },
		{ status: 401, headers: { "cache-control": "no-store" } },
	);
}
