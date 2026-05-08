import type { McpServerEntry } from "#/lib/mcp";

export type { McpServerEntry } from "#/lib/mcp";
export { mapMcpServer } from "#/lib/mcp";

const MCP_STATUS_ORDER: Record<McpServerEntry["status"], number> = {
	connected: 0,
	pending: 1,
	"needs-auth": 2,
	failed: 3,
	disabled: 4,
	unknown: 5,
};

function dotClass(status: McpServerEntry["status"]): string {
	switch (status) {
		case "connected":
			return "bg-green-500/80";
		case "needs-auth":
			return "bg-amber-400/70";
		case "failed":
			return "bg-red-500/70";
		case "pending":
			return "bg-orange-500/60 animate-pulse";
		default:
			return "bg-primary/30";
	}
}

export function McpPanel({ servers }: { servers: McpServerEntry[] }) {
	const sorted = [...servers].sort(
		(a, b) => MCP_STATUS_ORDER[a.status] - MCP_STATUS_ORDER[b.status],
	);

	return (
		<div className="border-b border-border shrink-0 flex items-center gap-3 px-4 py-2 overflow-x-auto">
			<span className="text-[9px] tracking-widest text-muted-foreground/40 uppercase shrink-0">
				MCP
			</span>
			<span className="w-px h-3 bg-border/60 shrink-0" />
			{sorted.length === 0 ? (
				<span className="text-[9px] tracking-widest text-muted-foreground/50">
					no mcp configured
				</span>
			) : (
				sorted.map((s) => (
					<span key={s.name} className="flex items-center gap-1.5 shrink-0">
						<span
							className={`w-1.5 h-1.5 rounded-full shrink-0 ${dotClass(s.status)}`}
						/>
						<span className="text-[9px] tracking-widest uppercase text-foreground/50">
							{s.displayName}
							{s.source === "vault" && (
								<span className="text-muted-foreground/30 ml-0.5">·v</span>
							)}
							{s.source === "global" && (
								<span className="text-muted-foreground/30 ml-0.5">·g</span>
							)}
						</span>
					</span>
				))
			)}
		</div>
	);
}
