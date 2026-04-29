import { createFileRoute } from "@tanstack/react-router";
import { getConfig } from "#/config";
import { forbiddenResponse } from "#/lib/originGate";

export const Route = createFileRoute("/api/attachments/$id/raw")({
	server: {
		handlers: {
			GET: async ({ request, params }) => {
				const forbidden = forbiddenResponse(request);
				if (forbidden) return forbidden;
				const { server } = await getConfig();
				const target = `http://127.0.0.1:${server.port + 1}/api/attachments/${encodeURIComponent(params.id)}/raw`;
				try {
					const res = await fetch(target);
					const headers = new Headers();
					const ct = res.headers.get("content-type");
					const cd = res.headers.get("content-disposition");
					if (ct) headers.set("content-type", ct);
					if (cd) headers.set("content-disposition", cd);
					return new Response(res.body, { status: res.status, headers });
				} catch {
					return new Response("Upstream unavailable", { status: 502 });
				}
			},
		},
	},
});
