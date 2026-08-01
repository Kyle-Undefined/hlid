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
	["getContextUsage", "integrated"],
	["stopTask", "integrated"],
	["accountInfo", "integrated"],
	["supportedAgents", "provider-native"],
	["reloadPlugins", "provider-native"],
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
		evidence.push({
			id: providerCapabilityId(input.providerId, "sdk-control", method),
			label: `SDK control: ${controlLabel(method)}`,
			scope: "session",
			support: "advertised",
			integration,
			readiness: "ready",
			source: "provider-sdk",
			maturity: "unknown",
			operations: [method],
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
