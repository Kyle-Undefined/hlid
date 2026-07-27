import { registerInternalApiBase } from "#/lib/internalApiTransport";
import { loadConfig } from "./config";
import {
	executeHlidAgentToolRich,
	HLID_AGENT_NAMESPACE,
	HLID_AGENT_NAMESPACE_DESCRIPTION,
	HLID_AGENT_TOOL_SPECS,
	type HlidAgentToolContext,
	hlidAgentSchemas,
} from "./hlidAgentTools";
import {
	internalMcpProcessCommand,
	runInternalMcpToolServer,
} from "./obsidianMcpServer";

export const INTERNAL_HLID_MCP_FLAG = "--internal-hlid-mcp";
const RUNTIME_CWD_ENV = "HLID_INTERNAL_MCP_RUNTIME_CWD";
const SESSION_ID_ENV = "HLID_INTERNAL_MCP_SESSION_ID";
const PROVIDER_ID_ENV = "HLID_INTERNAL_MCP_PROVIDER_ID";
const MODEL_ENV = "HLID_INTERNAL_MCP_MODEL";
const EFFORT_ENV = "HLID_INTERNAL_MCP_EFFORT";
const PERMISSION_MODE_ENV = "HLID_INTERNAL_MCP_PERMISSION_MODE";
const POLICY_ENFORCED_ENV = "HLID_INTERNAL_MCP_POLICY_ENFORCED";
const CODEX_REALTIME_ENABLED_ENV = "HLID_INTERNAL_MCP_CODEX_REALTIME_ENABLED";
const VAULT_NAME_ENV = "HLID_INTERNAL_MCP_VAULT_NAME";
const AGENT_MODE_ENV = "HLID_INTERNAL_MCP_AGENT_MODE";

export function hlidMcpProcessCommand(context: HlidAgentToolContext = {}): {
	command: string;
	args: string[];
	env: Array<{ name: string; value: string }>;
} {
	return internalMcpProcessCommand(INTERNAL_HLID_MCP_FLAG, [
		...(context.runtimeCwd
			? [{ name: RUNTIME_CWD_ENV, value: context.runtimeCwd }]
			: []),
		...(context.sessionId
			? [{ name: SESSION_ID_ENV, value: context.sessionId }]
			: []),
		...(context.providerId
			? [{ name: PROVIDER_ID_ENV, value: context.providerId }]
			: []),
		...(context.model ? [{ name: MODEL_ENV, value: context.model }] : []),
		...(context.effort ? [{ name: EFFORT_ENV, value: context.effort }] : []),
		...(context.permissionMode
			? [{ name: PERMISSION_MODE_ENV, value: context.permissionMode }]
			: []),
		...(context.policyEnforced
			? [{ name: POLICY_ENFORCED_ENV, value: "true" }]
			: []),
		...(context.codexRealtimeEnabled
			? [{ name: CODEX_REALTIME_ENABLED_ENV, value: "true" }]
			: []),
		...(context.vaultName
			? [{ name: VAULT_NAME_ENV, value: context.vaultName }]
			: []),
		...(context.agentMode
			? [{ name: AGENT_MODE_ENV, value: context.agentMode }]
			: []),
	]);
}

function processContext(): HlidAgentToolContext {
	return {
		runtimeCwd: process.env[RUNTIME_CWD_ENV] || undefined,
		sessionId: process.env[SESSION_ID_ENV] || undefined,
		providerId: process.env[PROVIDER_ID_ENV] || undefined,
		model: process.env[MODEL_ENV] || undefined,
		effort: process.env[EFFORT_ENV] || undefined,
		permissionMode: process.env[PERMISSION_MODE_ENV] || undefined,
		policyEnforced: process.env[POLICY_ENFORCED_ENV] === "true",
		codexRealtimeEnabled: process.env[CODEX_REALTIME_ENABLED_ENV] === "true",
		vaultName: process.env[VAULT_NAME_ENV] || undefined,
		agentMode:
			process.env[AGENT_MODE_ENV] === "cwd" ||
			process.env[AGENT_MODE_ENV] === "context"
				? process.env[AGENT_MODE_ENV]
				: undefined,
	};
}

export async function runHlidMcpServer(): Promise<void> {
	const { server, vault } = loadConfig();
	registerInternalApiBase(`http://127.0.0.1:${server.port + 1}`);
	const context = processContext();
	context.vaultName ??= vault.name;
	await runInternalMcpToolServer({
		namespace: HLID_AGENT_NAMESPACE,
		description: HLID_AGENT_NAMESPACE_DESCRIPTION,
		specs: HLID_AGENT_TOOL_SPECS,
		schemaFor: (spec) => hlidAgentSchemas[spec.name].shape,
		idempotentHint: (spec) => spec.readOnly,
		execute: (spec, input) =>
			executeHlidAgentToolRich(spec.name, input, context),
	});
}
