import { createFileRoute } from "@tanstack/react-router";
import {
	readVaultMcpFile,
	toggleVaultMcpFile,
	writeVaultMcpFile,
} from "#/lib/vaultMcp";
import { loadConfig } from "#/server/config";
import {
	handleMcpGet,
	handleMcpMutation,
	parseServers,
	parseToggle,
} from "./-mcpRouteHelpers";

function resolveVaultPath(): string | Response {
	const path = loadConfig().vault.path;
	return (
		path || Response.json({ error: "No vault configured" }, { status: 400 })
	);
}

export function handleGetVaultMcp(request: Request): Promise<Response> {
	return handleMcpGet(request, resolveVaultPath, readVaultMcpFile);
}

export function handlePostVaultMcp(request: Request): Promise<Response> {
	return handleMcpMutation(
		request,
		resolveVaultPath,
		parseServers,
		writeVaultMcpFile,
	);
}

export function handleToggleVaultMcp(request: Request): Promise<Response> {
	return handleMcpMutation(
		request,
		resolveVaultPath,
		parseToggle,
		(path, toggle) => toggleVaultMcpFile(path, toggle.name, toggle.disabled),
	);
}

export const Route = createFileRoute("/api/mcp/vault")({
	server: {
		handlers: {
			GET: ({ request }) => handleGetVaultMcp(request),
			POST: ({ request }) => handlePostVaultMcp(request),
		},
	},
});
