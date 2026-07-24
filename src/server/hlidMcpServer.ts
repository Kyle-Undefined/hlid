import {
	executeHlidAgentTool,
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
	]);
}

function processContext(): HlidAgentToolContext {
	return {
		runtimeCwd: process.env[RUNTIME_CWD_ENV] || undefined,
		sessionId: process.env[SESSION_ID_ENV] || undefined,
	};
}

export async function runHlidMcpServer(): Promise<void> {
	const context = processContext();
	await runInternalMcpToolServer({
		namespace: HLID_AGENT_NAMESPACE,
		description: HLID_AGENT_NAMESPACE_DESCRIPTION,
		specs: HLID_AGENT_TOOL_SPECS,
		schemaFor: (spec) => hlidAgentSchemas[spec.name].shape,
		idempotentHint: () => false,
		execute: (spec, input) => executeHlidAgentTool(spec.name, input, context),
	});
}
