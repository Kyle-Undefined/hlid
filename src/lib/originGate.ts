import { getRequestIP } from "@tanstack/react-start/server";
import { isAllowedOrigin } from "./allowedOrigin";

export function forbiddenResponse(): Response | null {
	return isAllowedOrigin(getRequestIP())
		? null
		: new Response("Forbidden", { status: 403 });
}
