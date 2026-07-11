import { createFileRoute } from "@tanstack/react-router";
import { dbFetch } from "#/lib/dbClient";
import { forbiddenResponse } from "#/lib/originGate";

const FORWARDED_HEADERS = [
	"content-type",
	"content-disposition",
	"content-length",
	"cache-control",
	"etag",
	"last-modified",
	"x-content-type-options",
] as const;

export async function handleRawAttachment(
	request: Request,
	id: string,
): Promise<Response> {
	const forbidden = forbiddenResponse(request);
	if (forbidden) return forbidden;
	try {
		const res = await dbFetch(`/api/attachments/${encodeURIComponent(id)}/raw`);
		const headers = new Headers();
		for (const name of FORWARDED_HEADERS) {
			const value = res.headers.get(name);
			if (value) headers.set(name, value);
		}
		return new Response(res.body, { status: res.status, headers });
	} catch {
		return new Response("Upstream unavailable", { status: 502 });
	}
}

export const Route = createFileRoute("/api/attachments/$id/raw")({
	server: {
		handlers: {
			GET: ({ request, params }) => handleRawAttachment(request, params.id),
		},
	},
});
