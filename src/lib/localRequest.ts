import { getRequestIP } from "@tanstack/react-start/server";
import { effectivePeerIp } from "#/server/auth";
import { isAllowedOrigin } from "./allowedOrigin";
import { loadToken } from "./token";

/** Allow CLI updates from loopback or an authenticated Tailscale peer. */
export function isCliUpdateUiRequest(request: Request): boolean {
	const directPeerIp = getRequestIP();
	const peerIp = effectivePeerIp(request, directPeerIp, loadToken());
	// false excludes optional RFC1918 LAN access while retaining loopback and
	// Tailscale CGNAT/IPv6 ranges from the base origin allowlist.
	return isAllowedOrigin(peerIp, false);
}

export function cliUpdateAccessResponse(request: Request): Response | null {
	if (isCliUpdateUiRequest(request)) return null;
	return Response.json(
		{
			ok: false,
			error: "CLI updates can only be started locally or over Tailscale",
		},
		{ status: 403 },
	);
}
