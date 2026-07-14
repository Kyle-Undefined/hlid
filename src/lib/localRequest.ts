import { getRequestIP } from "@tanstack/react-start/server";
import { effectivePeerIp, isLoopback } from "#/server/auth";
import { loadToken } from "./token";

/** Resolve the original browser address, including requests forwarded by Hlid TLS. */
export function isLocalUiRequest(request: Request): boolean {
	const directPeerIp = getRequestIP();
	return isLoopback(effectivePeerIp(request, directPeerIp, loadToken()));
}

export function localOnlyResponse(request: Request): Response | null {
	if (isLocalUiRequest(request)) return null;
	return Response.json(
		{ ok: false, error: "CLI updates can only be started from this computer" },
		{ status: 403 },
	);
}
