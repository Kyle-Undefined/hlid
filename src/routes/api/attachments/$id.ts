import { createFileRoute } from "@tanstack/react-router";
import { dbFetch } from "#/lib/dbClient";
import { forbiddenResponse } from "#/lib/originGate";

export async function handleDeleteAttachment(
	request: Request,
	id: string,
): Promise<Response> {
	const forbidden = forbiddenResponse(request);
	if (forbidden) return forbidden;
	const url = new URL(request.url);
	try {
		const res = await dbFetch(
			`/api/attachments/${encodeURIComponent(id)}${url.search}`,
			{ method: "DELETE" },
		);
		return new Response(res.body, {
			status: res.status,
			headers: {
				"content-type": res.headers.get("content-type") ?? "application/json",
			},
		});
	} catch {
		return Response.json({ error: "upstream_unavailable" }, { status: 502 });
	}
}

export const Route = createFileRoute("/api/attachments/$id")({
	server: {
		handlers: {
			DELETE: ({ request, params }) =>
				handleDeleteAttachment(request, params.id),
		},
	},
});
