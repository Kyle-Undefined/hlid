/**
 * The MCP tool-call result shape, produced the same way regardless of which
 * transport carries it: Hlid's stdio MCP servers (`obsidianMcpServer.ts`)
 * and the Claude Agent SDK's in-process tool servers (`claudeProvider.ts`)
 * both need "run this, wrap a success or a thrown error the same way."
 */
export type AgentToolCallResult =
	| { content: [{ type: "text"; text: string }] }
	| { isError: true; content: [{ type: "text"; text: string }] };

export async function toAgentToolCallResult(
	execute: () => Promise<string>,
): Promise<AgentToolCallResult> {
	try {
		return { content: [{ type: "text" as const, text: await execute() }] };
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
}
