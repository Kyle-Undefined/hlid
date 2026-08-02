import { ExternalLink } from "lucide-react";
import type { AskUserQuestionProvenance as Provenance } from "#/server/protocol";

export function AskUserQuestionProvenance({
	provenance,
}: {
	provenance: Provenance;
}) {
	const kind =
		provenance.kind === "mcp_elicitation" ? "MCP input" : "Provider dialog";
	return (
		<div className="px-4 py-3 bg-secondary/20 border-b border-border flex flex-col gap-1.5">
			<div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[9px] tracking-widest uppercase">
				<span className="font-bold text-primary/75">
					{provenance.provider_id}
				</span>
				<span className="text-muted-foreground/45">·</span>
				<span className="text-muted-foreground/70">{kind}</span>
				<span className="text-muted-foreground/45">·</span>
				<span className="text-foreground/65 normal-case tracking-normal font-mono break-all">
					{provenance.source_name}
				</span>
				{provenance.tool_name && (
					<span className="text-muted-foreground/60 normal-case tracking-normal">
						{provenance.tool_name}
					</span>
				)}
			</div>
			{provenance.summary && (
				<div className="text-xs text-foreground/75 leading-relaxed whitespace-pre-wrap break-words">
					{provenance.summary}
				</div>
			)}
			<div className="flex flex-wrap items-center gap-x-3 gap-y-1">
				{provenance.url && (
					<a
						href={provenance.url}
						target="_blank"
						rel="noreferrer noopener"
						className="inline-flex items-center gap-1 text-[10px] text-primary/80 hover:text-primary underline underline-offset-2 break-all"
					>
						Open provider link
						<ExternalLink className="w-3 h-3 shrink-0" />
					</a>
				)}
				{provenance.turn_id && (
					<span
						title={provenance.turn_id}
						className="text-[9px] text-muted-foreground/45 font-mono"
					>
						turn {provenance.turn_id.slice(0, 8)}
					</span>
				)}
				{provenance.tool_use_id && (
					<span
						title={provenance.tool_use_id}
						className="text-[9px] text-muted-foreground/45 font-mono"
					>
						tool {provenance.tool_use_id.slice(0, 8)}
					</span>
				)}
			</div>
		</div>
	);
}
