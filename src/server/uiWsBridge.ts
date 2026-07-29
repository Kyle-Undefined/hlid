import { isAllowedOrigin, isAllowedOriginHeader } from "../lib/allowedOrigin";
import { authenticateRequest } from "./auth";
import type { WebSocketBridgeData } from "./webSocketBridge";

export type UiWsBridgeOptions = {
	/** WS/API server port (UI port + 1) that /ws upgrades are bridged to. */
	wsPort: number;
	/** Internal token the bridge presents so the API server authorizes it as loopback. */
	internalToken: string;
	localNetworkAccess: boolean;
};

export type UiWsUpgradeServer = {
	requestIP(request: Request): { address: string } | null;
	upgrade(req: Request, opts: { data: WebSocketBridgeData }): boolean;
};

/**
 * Authenticate and bridge a same-origin `/ws*` upgrade on the UI port to the
 * WS/API server. Keeping chat/terminal/shell WebSockets same-origin means the
 * browser never opens a cross-port `ws://` connection — which content filters
 * (adblockers) are known to kill silently. The UI and TLS listeners share this
 * `/ws` handling; the API server re-authorizes the bridged connection via
 * loopback + internal token.
 *
 * Returns `null` for non-WebSocket requests (caller continues normal HTTP
 * handling), `undefined` when the upgrade succeeded, or an error Response.
 */
export async function handleUiWsUpgrade(
	req: Request,
	server: UiWsUpgradeServer,
	url: URL,
	{ wsPort, localNetworkAccess }: UiWsBridgeOptions,
): Promise<Response | undefined | null> {
	if (req.headers.get("upgrade")?.toLowerCase() !== "websocket") return null;
	if (url.pathname !== "/ws" && !url.pathname.startsWith("/ws/")) {
		return new Response("Bad Request", { status: 400 });
	}
	const peerIp = server.requestIP(req)?.address;
	if (!isAllowedOrigin(peerIp, localNetworkAccess)) {
		return new Response("Forbidden", { status: 403 });
	}
	if (!isAllowedOriginHeader(req.headers.get("origin"), localNetworkAccess)) {
		return new Response("Forbidden", { status: 403 });
	}
	if (!(await authenticateRequest(req))) {
		return new Response("Unauthorized", { status: 401 });
	}
	const upgraded = server.upgrade(req, {
		data: {
			wsTarget: `ws://127.0.0.1:${wsPort}${url.pathname}${url.search}`,
			back: null,
			queue: [],
		},
	});
	if (!upgraded) {
		return new Response("WebSocket upgrade failed", { status: 500 });
	}
	return undefined;
}
