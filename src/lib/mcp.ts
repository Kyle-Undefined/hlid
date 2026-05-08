/** Shared MCP types and mapping logic used by both UI and server functions. */

export type McpServerEntry = {
	name: string;
	displayName: string;
	source: "cloud" | "vault" | "global";
	status:
		| "connected"
		| "failed"
		| "needs-auth"
		| "pending"
		| "disabled"
		| "unknown";
};

const VALID_MCP_STATUSES = new Set<McpServerEntry["status"]>([
	"connected",
	"failed",
	"needs-auth",
	"pending",
	"disabled",
	"unknown",
]);

/** Maps a raw MCP server object (from protocol or static config) to the UI McpServerEntry shape. */
export function mapMcpServer(s: {
	name: string;
	status: string;
	scope?: string;
}): McpServerEntry {
	return {
		name: s.name,
		displayName: s.name.startsWith("claude.ai ")
			? s.name.slice("claude.ai ".length)
			: s.name,
		source:
			s.scope === "claudeai"
				? "cloud"
				: s.scope === "project"
					? "vault"
					: "global",
		status: VALID_MCP_STATUSES.has(s.status as McpServerEntry["status"])
			? (s.status as McpServerEntry["status"])
			: "unknown",
	};
}
