import { createFileRoute } from "@tanstack/react-router";
import { dbFetch } from "#/lib/dbClient";
import { forbiddenResponse } from "#/lib/originGate";
import { getConfig } from "#/lib/serverFns/config";
import {
	contentLengthExceeds,
	createConcurrencyGate,
	MULTIPART_OVERHEAD_BYTES,
	payloadTooLarge,
	readRequestBodyLimited,
} from "#/server/requestLimits";

const uploadGate = createConcurrencyGate(4);

export async function handleAttachmentUpload(
	request: Request,
): Promise<Response> {
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
		const { attachments } = await getConfig();
		const maxBodyBytes = attachments.max_bytes + MULTIPART_OVERHEAD_BYTES;
		if (contentLengthExceeds(request, maxBodyBytes)) {
			return payloadTooLarge(maxBodyBytes);
		}
		const limited = await readRequestBodyLimited(request, maxBodyBytes);
		if (!limited.ok) return limited.response;
		const contentType = request.headers.get("content-type");
		const headers = new Headers();
		if (contentType) headers.set("content-type", contentType);
		const res = await dbFetch("/api/attachments/upload", {
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
}

export const Route = createFileRoute("/api/attachments/upload")({
	server: {
		handlers: {
			POST: ({ request }) => handleAttachmentUpload(request),
		},
	},
});
