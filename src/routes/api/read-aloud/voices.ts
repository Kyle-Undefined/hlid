import { createFileRoute } from "@tanstack/react-router";
import { dbFetch } from "#/lib/dbClient";
import { forbiddenResponse } from "#/lib/originGate";

export async function handleMicrosoftVoices(
	request: Request,
): Promise<Response> {
	const forbidden = forbiddenResponse(request);
	if (forbidden) return forbidden;
	const requestUrl = new URL(request.url);
	const query = new URLSearchParams();
	if (requestUrl.searchParams.get("refresh") === "1") query.set("refresh", "1");
	const suffix = query.size > 0 ? `?${query}` : "";
	return dbFetch(`/read-aloud/voices${suffix}`, {
		signal: request.signal,
	});
}

export const Route = createFileRoute("/api/read-aloud/voices")({
	server: {
		handlers: { GET: ({ request }) => handleMicrosoftVoices(request) },
	},
});
