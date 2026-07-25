/**
 * The MCP tool-call result shape, produced the same way regardless of which
 * transport carries it: Hlid's stdio MCP servers (`obsidianMcpServer.ts`)
 * and the Claude Agent SDK's in-process tool servers (`claudeProvider.ts`)
 * both need "run this, wrap a success or a thrown error the same way."
 */
export type AgentToolPayload = {
	text: string;
	images?: Array<{
		data: string;
		mimeType: "image/png" | "image/jpeg" | "image/webp";
	}>;
};

type AgentToolContent =
	| { type: "text"; text: string }
	| {
			type: "image";
			data: string;
			mimeType: "image/png" | "image/jpeg" | "image/webp";
	  };

export type AgentToolCallResult =
	| { content: AgentToolContent[] }
	| { isError: true; content: [{ type: "text"; text: string }] };

export async function toAgentToolCallResult(
	execute: () => Promise<string | AgentToolPayload>,
): Promise<AgentToolCallResult> {
	try {
		const result = await execute();
		if (typeof result === "string") {
			return { content: [{ type: "text" as const, text: result }] };
		}
		return {
			content: [
				{ type: "text" as const, text: result.text },
				...(result.images ?? []).map((image) => ({
					type: "image" as const,
					data: image.data,
					mimeType: image.mimeType,
				})),
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
}
