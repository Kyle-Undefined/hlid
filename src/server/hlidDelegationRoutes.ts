import { ZodError } from "zod";
import { escapeRegExp } from "../lib/utils";
import type { HlidDelegationManager } from "./hlidDelegation";
import {
	cancelHlidAgentSchema,
	delegateHlidAgentSchema,
	inspectHlidAgentSchema,
	listHlidAgentsSchema,
	resumeHlidAgentSchema,
	steerHlidAgentSchema,
	waitHlidAgentSchema,
} from "./hlidDelegationSchemas";

function errorResponse(error: unknown, status = 409): Response {
	return Response.json(
		{ error: error instanceof Error ? error.message : String(error) },
		{ status },
	);
}

function delegationId(pathname: string, suffix = ""): string | null {
	const escapedSuffix = escapeRegExp(suffix);
	const match = pathname.match(
		new RegExp(`^/hlid-agents/([^/]+)${escapedSuffix}$`),
	);
	if (!match) return null;
	try {
		return decodeURIComponent(match[1] ?? "");
	} catch {
		return null;
	}
}

async function bodyWithParentSession(
	request: Request,
): Promise<Record<string, unknown> & { parent_session_id: string }> {
	const parsed = await request.json();
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error("Invalid request body: expected an object");
	}
	const body = parsed as Record<string, unknown>;
	if (
		typeof body.parent_session_id !== "string" ||
		!body.parent_session_id.trim()
	) {
		throw new Error("parent_session_id is required");
	}
	return {
		...body,
		parent_session_id: body.parent_session_id.trim(),
	};
}

export function createHlidDelegationRouteHandler(
	manager: HlidDelegationManager,
): (url: URL, request: Request) => Promise<Response | null> {
	return async (url, request) => {
		if (
			url.pathname !== "/hlid-agents" &&
			!url.pathname.startsWith("/hlid-agents/")
		) {
			return null;
		}
		try {
			if (url.pathname === "/hlid-agents" && request.method === "GET") {
				const parentSessionId = url.searchParams
					.get("parent_session_id")
					?.trim();
				if (!parentSessionId) {
					return errorResponse(new Error("parent_session_id is required"), 400);
				}
				const input = listHlidAgentsSchema.parse({
					limit: url.searchParams.has("limit")
						? Number(url.searchParams.get("limit"))
						: undefined,
				});
				return Response.json(await manager.list(parentSessionId, input.limit));
			}
			if (
				url.pathname === "/hlid-agents/delegate" &&
				request.method === "POST"
			) {
				const body = await bodyWithParentSession(request);
				const input = delegateHlidAgentSchema.parse(body);
				return Response.json(
					await manager.delegate(body.parent_session_id, input),
					{ status: 202 },
				);
			}

			const steerId = delegationId(url.pathname, "/steer");
			if (steerId && request.method === "POST") {
				const body = await bodyWithParentSession(request);
				const input = steerHlidAgentSchema.parse({ ...body, id: steerId });
				return Response.json(
					await manager.steer(
						body.parent_session_id,
						input.id,
						input.instruction,
					),
				);
			}

			const cancelId = delegationId(url.pathname, "/cancel");
			if (cancelId && request.method === "POST") {
				const body = await bodyWithParentSession(request);
				const input = cancelHlidAgentSchema.parse({ ...body, id: cancelId });
				return Response.json(
					await manager.cancel(body.parent_session_id, input.id),
				);
			}

			const resumeId = delegationId(url.pathname, "/resume");
			if (resumeId && request.method === "POST") {
				const body = await bodyWithParentSession(request);
				const input = resumeHlidAgentSchema.parse({ ...body, id: resumeId });
				return Response.json(
					await manager.resume(body.parent_session_id, input.id, input),
					{ status: 202 },
				);
			}

			const waitId = delegationId(url.pathname, "/wait");
			if (waitId && request.method === "POST") {
				const body = await bodyWithParentSession(request);
				const input = waitHlidAgentSchema.parse({ ...body, id: waitId });
				return Response.json(
					await manager.wait(
						body.parent_session_id,
						input.id,
						input.wait_seconds,
					),
				);
			}

			const inspectId = delegationId(url.pathname);
			if (inspectId && request.method === "GET") {
				const input = inspectHlidAgentSchema.parse({ id: inspectId });
				const parentSessionId = url.searchParams
					.get("parent_session_id")
					?.trim();
				if (!parentSessionId) {
					return errorResponse(new Error("parent_session_id is required"), 400);
				}
				return Response.json(await manager.inspect(parentSessionId, input.id));
			}
			return new Response("Method not allowed", { status: 405 });
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			const status =
				error instanceof SyntaxError ||
				error instanceof ZodError ||
				message.includes("required") ||
				message.includes("Invalid") ||
				message.includes("expected")
					? 400
					: message.includes("not found")
						? 404
						: 409;
			return errorResponse(error, status);
		}
	};
}
