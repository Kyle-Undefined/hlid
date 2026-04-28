import { createFileRoute } from "@tanstack/react-router";
import { getConfig } from "#/config";
import { forbiddenResponse } from "#/lib/originGate";

export const Route = createFileRoute("/api/attachments/upload")({
	server: {
		handlers: {
			POST: async ({ request }) => {
				const forbidden = await forbiddenResponse();
				if (forbidden) return forbidden;
				const { server } = await getConfig();
				const target = `http://127.0.0.1:${server.port + 1}/api/attachments/upload`;
				const contentType = request.headers.get("content-type");
				const headers = new Headers();
				if (contentType) headers.set("content-type", contentType);
				try {
					const res = await fetch(target, {
						method: "POST",
						headers,
						body: request.body,
					});
					const respHeaders = new Headers();
					const ct = res.headers.get("content-type");
					if (ct) respHeaders.set("content-type", ct);
					return new Response(res.body, {
						status: res.status,
						headers: respHeaders,
					});
				} catch (err) {
					return Response.json(
						{ error: "proxy_failed", detail: String(err) },
						{ status: 502 },
					);
				}
			},
		},
	},
});
