import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
	executeHlidAgentTool,
	HLID_AGENT_NAMESPACE,
	HLID_AGENT_NAMESPACE_DESCRIPTION,
	HLID_AGENT_TOOL_SPECS,
	type HlidAgentToolContext,
	hlidAgentSchemas,
} from "./hlidAgentTools";
import {
	closeInternalMcpOnInputEnd,
	internalMcpProcessCommand,
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
	const server = new McpServer(
		{ name: HLID_AGENT_NAMESPACE, version: "1" },
		{ instructions: HLID_AGENT_NAMESPACE_DESCRIPTION },
	);
	const context = processContext();
	for (const spec of HLID_AGENT_TOOL_SPECS) {
		server.registerTool(
			spec.name,
			{
				description: spec.description,
				// biome-ignore lint/suspicious/noExplicitAny: registerTool accepts each tool's Zod shape, while the loop widens them to a union.
				inputSchema: hlidAgentSchemas[spec.name].shape as any,
				annotations: {
					readOnlyHint: spec.readOnly,
					destructiveHint: false,
					idempotentHint: false,
				},
			},
			async (input: unknown) => {
				try {
					return {
						content: [
							{
								type: "text" as const,
								text: await executeHlidAgentTool(spec.name, input, context),
							},
						],
					};
				} catch (error) {
					return {
						isError: true,
						content: [
							{
								type: "text" as const,
								text: error instanceof Error ? error.message : String(error),
							},
						],
					};
				}
			},
		);
	}
	const transport = new StdioServerTransport();
	const closed = new Promise<void>((resolve) => {
		server.server.onclose = resolve;
	});
	const stopWatchingInput = closeInternalMcpOnInputEnd(transport);
	try {
		await server.connect(transport);
		await closed;
	} finally {
		stopWatchingInput();
	}
}
