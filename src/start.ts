import { createMiddleware, createStart } from "@tanstack/react-start";
import { getRequestIP, setResponseHeader } from "@tanstack/react-start/server";
import { isAllowedOrigin, isAllowedOriginHeader } from "./lib/allowedOrigin";

const STATIC_PATH =
	/\.(?:js|css|png|jpe?g|gif|webp|svg|ico|woff2?|webmanifest)$/i;

function isPublicPath(pathname: string): boolean {
	return (
		pathname === "/login" ||
		pathname === "/api/health" ||
		pathname === "/manifest.json" ||
		pathname === "/sw.js" ||
		pathname === "/favicon.svg" ||
		pathname === "/apple-touch-icon.png" ||
		pathname.startsWith("/api/auth/") ||
		(pathname.startsWith("/assets/") && STATIC_PATH.test(pathname))
	);
}

const securityBoundary = createMiddleware().server(
	async ({ next, request }) => {
		const [{ loadConfig }, auth, token] = await Promise.all([
			import("./server/config"),
			import("./server/auth"),
			import("./lib/token"),
		]);
		const config = loadConfig();
		const directPeerIp = getRequestIP();
		const internalToken = token.loadToken();
		const peerIp = auth.effectivePeerIp(request, directPeerIp, internalToken);
		const url = new URL(request.url);
		const pathname =
			url.pathname.length > 1 ? url.pathname.replace(/\/+$/, "") : url.pathname;
		const buildLoginShell =
			pathname === "/login" &&
			(request.headers.get("x-tss-shell")?.toLowerCase() === "true" ||
				request.headers.get("x-hlid-login-shell") === "build");
		if (
			!buildLoginShell &&
			!isAllowedOrigin(peerIp, config.server.local_network_access)
		) {
			return new Response("Forbidden", { status: 403 });
		}
		if (
			request.method !== "GET" &&
			request.method !== "HEAD" &&
			!isAllowedOriginHeader(
				request.headers.get("origin"),
				config.server.local_network_access,
			)
		) {
			return new Response("Forbidden", { status: 403 });
		}

		const publicPath = isPublicPath(pathname);
		const internal =
			auth.isLoopback(directPeerIp) &&
			token.verifyToken(request.headers.get("x-hlid-internal"), internalToken);
		const authenticated = internal || (await auth.authenticateRequest(request));

		if (pathname === "/login" && authenticated) {
			return new Response(null, {
				status: 302,
				headers: { location: "/", "cache-control": "no-store" },
			});
		}
		if (!publicPath && !authenticated) {
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

		if (!STATIC_PATH.test(pathname)) {
			setResponseHeader("cache-control", "no-store");
		}
		return next();
	},
);

export const startInstance = createStart(() => ({
	requestMiddleware: [securityBoundary],
}));
