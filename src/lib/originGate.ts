import { getRequestIP } from "@tanstack/react-start/server";
import { loadConfig } from "#/server/config";
import { isAllowedOrigin, isAllowedOriginHeader } from "./allowedOrigin";

export function forbiddenResponse(request?: Request): Response | null {
	const { server } = loadConfig();
	const allow = server.local_network_access;
	if (!isAllowedOrigin(getRequestIP(), allow)) {
		return new Response("Forbidden", { status: 403 });
	}
	if (request && request.method !== "GET" && request.method !== "HEAD") {
		if (!isAllowedOriginHeader(request.headers.get("origin"), allow)) {
			return new Response("Forbidden", { status: 403 });
		}
	}
	return null;
}
