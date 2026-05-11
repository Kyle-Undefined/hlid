import { resolve } from "node:path";
import { createFileRoute } from "@tanstack/react-router";
import {
	readAgentMcpFile,
	toggleAgentMcpFile,
	validateAgentPath,
	writeAgentMcpFile,
} from "#/lib/agentMcp";
import { forbiddenResponse } from "#/lib/originGate";
import { expandTilde } from "#/lib/paths";
import { loadConfig } from "#/server/config";

// ─── Handlers (exported for unit tests) ──────────────────────────────────────

export async function handleGetAgentMcp(request: Request): Promise<Response> {
	const forbidden = forbiddenResponse(request);
	if (forbidden) return forbidden;

	const url = new URL(request.url);
	const agentPath = url.searchParams.get("path");
	if (!agentPath) {
		return Response.json({ error: "Missing path param" }, { status: 400 });
	}

	const config = loadConfig();
	try {
		validateAgentPath(agentPath, config);
	} catch {
		return Response.json({ error: "Unauthorized" }, { status: 403 });
	}

	const resolvedPath = resolve(expandTilde(agentPath));
	try {
		return Response.json(readAgentMcpFile(resolvedPath));
	} catch (err) {
		const msg = err instanceof Error ? err.message : "Internal error";
		return Response.json({ error: msg }, { status: 500 });
	}
}

export async function handlePostAgentMcp(request: Request): Promise<Response> {
	const forbidden = forbiddenResponse(request);
	if (forbidden) return forbidden;

	try {
		const body = (await request.json()) as {
			agentPath?: string;
			servers?: Record<string, unknown>;
		};

		if (!body.agentPath) {
			return Response.json({ error: "Missing agentPath" }, { status: 400 });
		}

		const config = loadConfig();
		try {
			validateAgentPath(body.agentPath, config);
		} catch {
			return Response.json({ error: "Unauthorized" }, { status: 403 });
		}

		if (typeof body.servers !== "object" || body.servers === null) {
			return Response.json(
				{ error: "Invalid body: servers required" },
				{ status: 400 },
			);
		}

		const resolvedPath = resolve(expandTilde(body.agentPath));
		writeAgentMcpFile(resolvedPath, body.servers);
		return Response.json({ ok: true });
	} catch (err) {
		const msg = err instanceof Error ? err.message : "Bad request";
		return Response.json({ error: msg }, { status: 400 });
	}
}

export async function handleToggleAgentMcp(
	request: Request,
): Promise<Response> {
	const forbidden = forbiddenResponse(request);
	if (forbidden) return forbidden;

	try {
		const body = (await request.json()) as {
			agentPath?: string;
			name?: string;
			disabled?: boolean;
		};

		if (!body.agentPath) {
			return Response.json({ error: "Missing agentPath" }, { status: 400 });
		}

		const config = loadConfig();
		try {
			validateAgentPath(body.agentPath, config);
		} catch {
			return Response.json({ error: "Unauthorized" }, { status: 403 });
		}

		if (typeof body.name !== "string" || typeof body.disabled !== "boolean") {
			return Response.json(
				{
					error: "Invalid body: name (string) and disabled (boolean) required",
				},
				{ status: 400 },
			);
		}

		const resolvedPath = resolve(expandTilde(body.agentPath));
		toggleAgentMcpFile(resolvedPath, body.name, body.disabled);
		return Response.json({ ok: true });
	} catch (err) {
		const msg = err instanceof Error ? err.message : "Bad request";
		return Response.json({ error: msg }, { status: 400 });
	}
}

// ─── Route ───────────────────────────────────────────────────────────────────

export const Route = createFileRoute("/api/mcp/agent")({
	server: {
		handlers: {
			GET: ({ request }) => handleGetAgentMcp(request),
			POST: ({ request }) => handlePostAgentMcp(request),
		},
	},
});
