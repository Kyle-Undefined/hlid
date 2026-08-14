import { createFileRoute } from "@tanstack/react-router";
import { dbFetch } from "#/lib/dbClient";
import { forbiddenResponse } from "#/lib/originGate";
import { authenticateSessionRequest } from "#/server/auth";
import { readRequestBodyLimited } from "#/server/requestLimits";

const MAX_PUSH_BRIDGE_BODY_BYTES = 16 * 1024;

type PushBridgeDependencies = {
	forbidden: (request: Request) => Response | null;
	authenticate: (request: Request) => Promise<boolean>;
	forward: typeof dbFetch;
};

const defaultDependencies: PushBridgeDependencies = {
	forbidden: forbiddenResponse,
	authenticate: authenticateSessionRequest,
	forward: dbFetch,
};

function jsonError(error: string, status: number): Response {
	return Response.json({ error }, { status });
}

/** Narrow authenticated same-origin bridge used by the service worker. */
export async function handlePushBridge(
	request: Request,
	action: string,
	overrides: Partial<PushBridgeDependencies> = {},
): Promise<Response> {
	const dependencies = { ...defaultDependencies, ...overrides };
	const forbidden = dependencies.forbidden(request);
	if (forbidden) return forbidden;
	if (!(await dependencies.authenticate(request))) {
		return jsonError("Unauthorized", 401);
	}
	const method = request.method.toUpperCase();
	const allowed =
		(action === "config" && method === "GET") ||
		((action === "subscriptions" || action === "receipts") &&
			method === "POST");
	if (!allowed) return jsonError("Not found", 404);

	const headers = new Headers();
	for (const name of ["content-type", "cookie", "origin", "user-agent"]) {
		const value = request.headers.get(name);
		if (value) headers.set(name, value);
	}
	let body: ArrayBuffer | undefined;
	if (method === "POST") {
		const limited = await readRequestBodyLimited(
			request,
			MAX_PUSH_BRIDGE_BODY_BYTES,
		);
		if (!limited.ok) return limited.response;
		body = limited.body;
	}
	try {
		const response = await dependencies.forward(`/api/push/${action}`, {
			method,
			headers,
			...(body ? { body } : {}),
		});
		const responseHeaders = new Headers();
		for (const name of ["content-type", "cache-control", "retry-after"]) {
			const value = response.headers.get(name);
			if (value) responseHeaders.set(name, value);
		}
		return new Response(response.body, {
			status: response.status,
			headers: responseHeaders,
		});
	} catch {
		return jsonError("Push service unavailable", 502);
	}
}

export const Route = createFileRoute("/api/push/$action")({
	server: {
		handlers: {
			GET: ({ request, params }) => handlePushBridge(request, params.action),
			POST: ({ request, params }) => handlePushBridge(request, params.action),
		},
	},
});
