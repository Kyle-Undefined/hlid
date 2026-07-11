import { createFileRoute } from "@tanstack/react-router";
import { getConfig } from "#/config";
import { forbiddenResponse } from "#/lib/originGate";
import {
	contentLengthExceeds,
	createConcurrencyGate,
	MULTIPART_OVERHEAD_BYTES,
	payloadTooLarge,
	readRequestBodyLimited,
} from "#/server/requestLimits";

const uploadGate = createConcurrencyGate(4);

export const Route = createFileRoute("/api/attachments/upload")({
	server: {
		handlers: {
			POST: async ({ request }) => {
				const forbidden = forbiddenResponse(request);
				if (forbidden) return forbidden;
				const release = uploadGate.tryEnter();
				if (!release) {
					return Response.json(
						{ error: "upload_capacity_reached" },
						{ status: 429, headers: { "retry-after": "1" } },
					);
				}
				try {
					const { server, attachments } = await getConfig();
					const maxBodyBytes = attachments.max_bytes + MULTIPART_OVERHEAD_BYTES;
					if (contentLengthExceeds(request, maxBodyBytes)) {
						return payloadTooLarge(maxBodyBytes);
					}
					const limited = await readRequestBodyLimited(request, maxBodyBytes);
					if (!limited.ok) return limited.response;
					const target = `http://127.0.0.1:${server.port + 1}/api/attachments/upload`;
					const contentType = request.headers.get("content-type");
					const headers = new Headers();
					if (contentType) headers.set("content-type", contentType);
					const res = await fetch(target, {
						method: "POST",
						headers,
						body: limited.body,
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
				} finally {
					release();
				}
			},
		},
	},
});
