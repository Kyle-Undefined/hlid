import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { toAgentToolCallResult } from "./agentToolResult";
import {
	executeObsidianAgentTool,
	OBSIDIAN_AGENT_NAMESPACE,
	OBSIDIAN_AGENT_NAMESPACE_DESCRIPTION,
	OBSIDIAN_AGENT_TOOL_SPECS,
	obsidianAgentSchemas,
} from "./obsidianAgentTools";

export const INTERNAL_OBSIDIAN_MCP_FLAG = "--internal-obsidian-mcp";

export function closeInternalMcpOnInputEnd(
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

export function internalMcpProcessCommand(
	flag: string,
	env: Array<{ name: string; value: string }> = [],
): {
	command: string;
	args: string[];
	env: Array<{ name: string; value: string }>;
} {
	const compiled = process.execPath.endsWith(".exe");
	const entrypoint = process.argv[1];
	if (!compiled && !entrypoint) {
		throw new Error("Hlid could not resolve its internal MCP entrypoint.");
	}
	return {
		command: process.execPath,
		args: compiled ? [flag] : [entrypoint as string, flag],
		env: [{ name: "HLID_SKIP_SELF_INSTALL", value: "1" }, ...env],
	};
}

export function obsidianMcpProcessCommand(): {
	command: string;
	args: string[];
	env: Array<{ name: string; value: string }>;
} {
	return internalMcpProcessCommand(INTERNAL_OBSIDIAN_MCP_FLAG);
}

export type InternalMcpToolSpec = {
	name: string;
	description: string;
	readOnly: boolean;
};

/**
 * Runs one of Hlid's internal MCP servers over stdio: register every tool
 * spec, wrap each call in the standard MCP success/error result shape,
 * connect, and stay up until stdin closes. Shared by every internal MCP
 * server Hlid spawns for itself — currently the Obsidian vault tools and the
 * Hlid agent tools — so this wiring only exists once.
 */
export async function runInternalMcpToolServer<
	Spec extends InternalMcpToolSpec,
>(options: {
	namespace: string;
	description: string;
	specs: readonly Spec[];
	// biome-ignore lint/suspicious/noExplicitAny: registerTool accepts each tool's own Zod shape; callers narrow this per tool.
	schemaFor: (spec: Spec) => any;
	idempotentHint: (spec: Spec) => boolean;
	execute: (spec: Spec, input: unknown) => Promise<string>;
}): Promise<void> {
	const server = new McpServer(
		{ name: options.namespace, version: "1" },
		{ instructions: options.description },
	);
	for (const spec of options.specs) {
		server.registerTool(
			spec.name,
			{
				description: spec.description,
				inputSchema: options.schemaFor(spec),
				annotations: {
					readOnlyHint: spec.readOnly,
					destructiveHint: false,
					idempotentHint: options.idempotentHint(spec),
				},
			},
			(input: unknown) =>
				toAgentToolCallResult(() => options.execute(spec, input)),
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

export async function runObsidianMcpServer(): Promise<void> {
	await runInternalMcpToolServer({
		namespace: OBSIDIAN_AGENT_NAMESPACE,
		description: OBSIDIAN_AGENT_NAMESPACE_DESCRIPTION,
		specs: OBSIDIAN_AGENT_TOOL_SPECS,
		schemaFor: (spec) => obsidianAgentSchemas[spec.name].shape,
		idempotentHint: (spec) => spec.readOnly,
		execute: (spec, input) => executeObsidianAgentTool(spec.name, input),
	});
}
