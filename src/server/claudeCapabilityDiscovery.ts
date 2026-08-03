import type {
	ProviderCapabilityDiscovery,
	ProviderCapabilityEvidence,
	ProviderCapabilityIntegration,
} from "../lib/providerCapabilityTypes";
import type { ClaudeWarmupSnapshot } from "./claudeWarmup";
import { providerCapabilityId } from "./providerCapabilities";

const CONTROL_INTEGRATION = new Map<string, ProviderCapabilityIntegration>([
	["interrupt", "integrated"],
	["setModel", "integrated"],
	["setPermissionMode", "integrated"],
	["supportedCommands", "integrated"],
	["supportedModels", "integrated"],
	["mcpServerStatus", "integrated"],
	["reconnectMcpServer", "integrated"],
	["toggleMcpServer", "integrated"],
	["setMcpServers", "integrated"],
	["setMcpPermissionModeOverride", "integrated"],
	["getContextUsage", "integrated"],
	["stopTask", "integrated"],
	["backgroundTasks", "integrated"],
	["accountInfo", "integrated"],
	["supportedAgents", "provider-native"],
	["reloadPlugins", "provider-native"],
	["reloadSkills", "integrated"],
	["rewindFiles", "integrated"],
]);

function controlLabel(method: string): string {
	return method.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
}

function catalogEvidence(
	providerId: string,
	snapshot: ClaudeWarmupSnapshot,
): ProviderCapabilityEvidence[] {
	const mcpIssues = snapshot.mcpServers.filter(
		(server) => server.status !== "connected" && server.status !== "disabled",
	);
	return [
		{
			id: providerCapabilityId(providerId, "command-catalog"),
			label: `Command catalog (${snapshot.commands.length})`,
			scope: "workspace",
			support: "advertised",
			integration: "integrated",
			readiness: "ready",
			source: "provider-sdk",
			maturity: "stable",
			operations: ["list"],
		},
		{
			id: providerCapabilityId(providerId, "agent-catalog"),
			label: `Agent catalog (${snapshot.agents.length})`,
			scope: "workspace",
			support: "advertised",
			integration: "provider-native",
			readiness: "ready",
			source: "provider-sdk",
			maturity: "stable",
			operations: ["list"],
		},
		{
			id: providerCapabilityId(providerId, "mcp-catalog"),
			label: `MCP server catalog (${snapshot.mcpServers.length})`,
			scope: "workspace",
			support: "advertised",
			integration: "integrated",
			readiness: mcpIssues.length ? "gated" : "ready",
			source: "provider-sdk",
			maturity: "stable",
			operations: ["list", "status"],
			...(mcpIssues.length
				? {
						reason: `${mcpIssues.length} MCP server connection(s) need attention.`,
					}
				: {}),
		},
		{
			id: providerCapabilityId(providerId, "sdk-model-catalog"),
			label: `SDK model catalog (${snapshot.modelCount})`,
			scope: "provider",
			support: "advertised",
			integration: "integrated",
			readiness: "ready",
			source: "provider-sdk",
			maturity: "stable",
			operations: ["list"],
		},
		{
			id: providerCapabilityId(providerId, "mcp-elicitation"),
			label: "MCP form elicitation host callbacks",
			scope: "session",
			support: "advertised",
			integration: "integrated",
			readiness: "ready",
			source: "provider-sdk",
			maturity: "beta",
			operations: ["form", "respond", "cancel"],
		},
		{
			id: providerCapabilityId(providerId, "mcp-url-elicitation"),
			label: "MCP URL elicitation host callbacks",
			scope: "session",
			support: "not-advertised",
			integration: "integrated",
			readiness: "unavailable",
			source: "provider-runtime",
			maturity: "experimental",
			operations: ["url", "respond", "cancel"],
			reason:
				"The Claude Agent SDK callback type includes URL requests, but this headless Claude MCP client does not advertise URL elicitation to servers.",
		},
		{
			id: providerCapabilityId(providerId, "host-dialog", "refusal-fallback"),
			label: "Host dialog: refusal fallback prompt",
			scope: "session",
			support: "advertised",
			integration: "integrated",
			readiness: "ready",
			source: "provider-sdk",
			maturity: "experimental",
			operations: ["refusal_fallback_prompt", "respond", "cancel"],
		},
	];
}

export function discoverClaudeProviderCapabilities(input: {
	providerId: string;
	cwd: string;
	snapshot: ClaudeWarmupSnapshot | null;
}): ProviderCapabilityDiscovery {
	const snapshot = input.snapshot;
	if (!snapshot) {
		return {
			observedAt: Date.now(),
			context: { cwd: input.cwd },
			evidence: [],
			issues: [
				"Claude startup metadata is not ready; no hidden chat process was started for discovery.",
			],
		};
	}
	const evidence = catalogEvidence(input.providerId, snapshot);
	for (const method of snapshot.controlMethods ?? []) {
		const integration = CONTROL_INTEGRATION.get(method) ?? "not-integrated";
		const isFileRewind = method === "rewindFiles";
		const isMcpServerApply = method === "setMcpServers";
		const isMcpPermissionOverride = method === "setMcpPermissionModeOverride";
		evidence.push({
			id: providerCapabilityId(input.providerId, "sdk-control", method),
			label: `SDK control: ${controlLabel(method)}`,
			scope: "session",
			support: "advertised",
			integration,
			readiness: isFileRewind || isMcpPermissionOverride ? "gated" : "ready",
			source: "provider-sdk",
			maturity:
				isFileRewind || isMcpServerApply || isMcpPermissionOverride
					? "beta"
					: "unknown",
			operations: isFileRewind
				? ["preview", "rewind"]
				: isMcpPermissionOverride
					? ["default", "auto", "clear"]
					: [method],
			...(isFileRewind
				? {
						reason:
							"Available only in live direct Claude sessions with tracked user checkpoints; imported session-store histories are excluded.",
					}
				: isMcpServerApply
					? {
							reason:
								"Hlid applies its canonical workspace MCP configuration only through existing live Claude sessions; cold sessions load the file on their next turn.",
						}
					: isMcpPermissionOverride
						? {
								reason:
									"Claude's per-server override is tighten-only and session-scoped. It is available only in a live direct session whose native mode already auto-allows MCP tools; Hlid policy enforcement remains authoritative and disables this provider control.",
							}
						: {}),
		});
	}
	return {
		observedAt: snapshot.warmedAt,
		context: { cwd: input.cwd },
		evidence,
		...(snapshot.controlMethods
			? {}
			: {
					issues: [
						"The cached Claude metadata predates SDK control-method discovery.",
					],
				}),
	};
}
