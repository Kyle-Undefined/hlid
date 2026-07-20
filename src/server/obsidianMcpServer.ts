import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
	executeObsidianAgentTool,
	OBSIDIAN_AGENT_NAMESPACE,
	OBSIDIAN_AGENT_NAMESPACE_DESCRIPTION,
	OBSIDIAN_AGENT_TOOL_SPECS,
	obsidianAgentSchemas,
} from "./obsidianAgentTools";

export const INTERNAL_OBSIDIAN_MCP_FLAG = "--internal-obsidian-mcp";

export function closeObsidianMcpOnInputEnd(
	transport: Pick<StdioServerTransport, "close">,
	input: {
		once(event: "end" | "close", listener: () => void): unknown;
		off(event: "end" | "close", listener: () => void): unknown;
	} = process.stdin,
): () => void {
	let closing = false;
	const close = () => {
		if (closing) return;
		closing = true;
		void transport.close().catch(() => {});
	};
	input.once("end", close);
	input.once("close", close);
	return () => {
		input.off("end", close);
		input.off("close", close);
	};
}

export function obsidianMcpProcessCommand(): {
	command: string;
	args: string[];
	env: Array<{ name: string; value: string }>;
} {
	const compiled = process.execPath.endsWith(".exe");
	const entrypoint = process.argv[1];
	if (!compiled && !entrypoint) {
		throw new Error("Hlid could not resolve its Obsidian MCP entrypoint.");
	}
	return {
		command: process.execPath,
		args: compiled
			? [INTERNAL_OBSIDIAN_MCP_FLAG]
			: [entrypoint as string, INTERNAL_OBSIDIAN_MCP_FLAG],
		env: [{ name: "HLID_SKIP_SELF_INSTALL", value: "1" }],
	};
}

export async function runObsidianMcpServer(): Promise<void> {
	const server = new McpServer(
		{ name: OBSIDIAN_AGENT_NAMESPACE, version: "1" },
		{
			instructions: OBSIDIAN_AGENT_NAMESPACE_DESCRIPTION,
		},
	);
	for (const spec of OBSIDIAN_AGENT_TOOL_SPECS) {
		server.registerTool(
			spec.name,
			{
				description: spec.description,
				// biome-ignore lint/suspicious/noExplicitAny: registerTool accepts each tool's Zod shape, while the loop widens them to a union.
				inputSchema: obsidianAgentSchemas[spec.name].shape as any,
				annotations: {
					readOnlyHint: spec.readOnly,
					destructiveHint: false,
					idempotentHint: spec.readOnly,
				},
			},
			async (input: unknown) => {
				try {
					return {
						content: [
							{
								type: "text" as const,
								text: await executeObsidianAgentTool(spec.name, input),
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
	const stopWatchingInput = closeObsidianMcpOnInputEnd(transport);
	try {
		await server.connect(transport);
		await closed;
	} finally {
		stopWatchingInput();
	}
}
