import { createFileRoute } from "@tanstack/react-router";
import { getConfig } from "#/config";
import { forbiddenResponse } from "#/lib/originGate";

export const Route = createFileRoute("/api/attachments/$id")({
	server: {
		handlers: {
			DELETE: async ({ request, params }) => {
				const forbidden = await forbiddenResponse();
				if (forbidden) return forbidden;
				const { server } = await getConfig();
				const url = new URL(request.url);
				const qs = url.search;
				const target = `http://127.0.0.1:${server.port + 1}/api/attachments/${encodeURIComponent(params.id)}${qs}`;
				try {
					const res = await fetch(target, { method: "DELETE" });
					return new Response(res.body, {
						status: res.status,
						headers: {
							"content-type":
								res.headers.get("content-type") ?? "application/json",
						},
					});
				} catch {
					return Response.json(
						{ error: "upstream_unavailable" },
						{ status: 502 },
					);
				}
			},
		},
	},
});
