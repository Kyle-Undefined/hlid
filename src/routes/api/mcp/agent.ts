import { createFileRoute } from "@tanstack/react-router";
import {
	readAgentMcpFile,
	resolveAuthorizedAgentPath,
	toggleAgentMcpFile,
	writeAgentMcpFile,
} from "#/lib/agentMcp";
import { loadConfig } from "#/server/config";
import {
	handleMcpGet,
	handleMcpMutation,
	parseServers,
	parseToggle,
} from "./-mcpRouteHelpers";

function resolveAgentPath(agentPath: unknown): string | Response {
	if (typeof agentPath !== "string" || !agentPath) {
		return Response.json({ error: "Missing agentPath" }, { status: 400 });
	}
	try {
		return resolveAuthorizedAgentPath(agentPath, loadConfig());
	} catch {
		return Response.json({ error: "Unauthorized" }, { status: 403 });
	}
}

export function handleGetAgentMcp(request: Request): Promise<Response> {
	return handleMcpGet(
		request,
		(req) => {
			const agentPath = new URL(req.url).searchParams.get("path");
			if (!agentPath) {
				return Response.json({ error: "Missing path param" }, { status: 400 });
			}
			return resolveAgentPath(agentPath);
		},
		readAgentMcpFile,
	);
}

export function handlePostAgentMcp(request: Request): Promise<Response> {
	return handleMcpMutation(
		request,
		(body) => resolveAgentPath(body.agentPath),
		parseServers,
		writeAgentMcpFile,
	);
}

export function handleToggleAgentMcp(request: Request): Promise<Response> {
	return handleMcpMutation(
		request,
		(body) => resolveAgentPath(body.agentPath),
		parseToggle,
		(path, toggle) => toggleAgentMcpFile(path, toggle.name, toggle.disabled),
	);
}

export const Route = createFileRoute("/api/mcp/agent")({
	server: {
		handlers: {
			GET: ({ request }) => handleGetAgentMcp(request),
			POST: ({ request }) => handlePostAgentMcp(request),
		},
	},
});
