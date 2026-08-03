/** Shared MCP types and mapping logic used by both UI and server functions. */

export type McpServerEntry = {
	name: string;
	displayName: string;
	source: "cloud" | "vault" | "agent" | "global";
	providerId?: string;
	error?: string;
	permissionModeOverride?: "default" | "auto";
	status:
		| "connected"
		| "failed"
		| "needs-auth"
		| "pending"
		| "disabled"
		| "unknown";
};

export type McpProjectSource = Extract<
	McpServerEntry["source"],
	"vault" | "agent"
>;

const VALID_MCP_STATUSES = new Set<McpServerEntry["status"]>([
	"connected",
	"failed",
	"needs-auth",
	"pending",
	"disabled",
	"unknown",
]);

/** Maps a raw MCP server object (from protocol or static config) to the UI McpServerEntry shape. */
export function mapMcpServer(
	s: {
		name: string;
		status: string;
		scope?: string;
		providerId?: string;
		error?: string;
		permission_mode_override?: "default" | "auto";
	},
	projectSource: McpProjectSource = "vault",
): McpServerEntry {
	return {
		name: s.name,
		displayName: s.name.startsWith("claude.ai ")
			? s.name.slice("claude.ai ".length)
			: s.name,
		source:
			s.scope === "claudeai"
				? "cloud"
				: s.scope === "project"
					? projectSource
					: "global",
		status: VALID_MCP_STATUSES.has(s.status as McpServerEntry["status"])
			? (s.status as McpServerEntry["status"])
			: "unknown",
		...(s.providerId ? { providerId: s.providerId } : {}),
		...(s.error ? { error: s.error } : {}),
		...(s.permission_mode_override
			? { permissionModeOverride: s.permission_mode_override }
			: {}),
	};
}
