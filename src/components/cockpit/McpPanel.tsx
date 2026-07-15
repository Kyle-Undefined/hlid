import { McpIndicator } from "#/components/McpIndicator";
import type { McpServerEntry } from "#/lib/mcp";

export type { McpServerEntry } from "#/lib/mcp";
export { mapMcpServer } from "#/lib/mcp";

export function McpPanel({ servers }: { servers: McpServerEntry[] }) {
	return (
		<div className="border-b border-border shrink-0 flex items-center justify-between gap-3 px-4 py-2">
			<span className="text-[9px] tracking-widest text-muted-foreground/35 uppercase">
				Provider tools
			</span>
			<McpIndicator servers={servers} label="MCP inventory · known providers" />
		</div>
	);
}
