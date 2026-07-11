import { createMiddleware, createStart } from "@tanstack/react-start";
import { getRequestIP, setResponseHeader } from "@tanstack/react-start/server";
import { isStaticPath } from "./lib/publicPath";
import { uiSecurityRejection } from "./lib/uiRequestSecurity";

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
		const url = new URL(request.url);
		const pathname =
			url.pathname.length > 1 ? url.pathname.replace(/\/+$/, "") : url.pathname;
		const rejection = await uiSecurityRejection(
			request,
			directPeerIp,
			config.server.local_network_access,
			{
				effectivePeerIp: (candidate, peer) =>
					auth.effectivePeerIp(candidate, peer, internalToken),
				isInternal: (peer, candidate) =>
					auth.isLoopback(peer) &&
					token.verifyToken(
						candidate.headers.get("x-hlid-internal"),
						internalToken,
					),
				authenticate: auth.authenticateRequest,
			},
		);
		if (rejection) return rejection;

		if (!isStaticPath(pathname)) {
			setResponseHeader("cache-control", "no-store");
		}
		return next();
	},
);

export const startInstance = createStart(() => ({
	requestMiddleware: [securityBoundary],
}));
