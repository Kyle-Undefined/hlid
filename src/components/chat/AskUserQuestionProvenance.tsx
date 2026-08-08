import { ExternalLink } from "lucide-react";
import { PrivacyMask } from "#/components/PrivacyMask";
import type { AskUserQuestionProvenance as Provenance } from "#/server/protocol";

export function AskUserQuestionProvenance({
	provenance,
	peerReviewState = "held",
}: {
	provenance: Provenance;
	peerReviewState?: "held" | "delivered" | "denied" | "cancelled";
}) {
	const deliveredBody = provenance.peer?.body;
	const kind =
		provenance.peer !== undefined
			? "Claude peer inbox"
			: provenance.kind === "mcp_elicitation"
				? "MCP input"
				: "Provider dialog";
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
			{provenance.peer && (
				<div className="mt-1 flex flex-col gap-2 border border-border/70 bg-background/45 p-3">
					<div>
						<div className="text-[9px] font-bold uppercase tracking-widest text-primary/75">
							{peerReviewState === "held"
								? "Held for review"
								: peerReviewState === "delivered"
									? "Approved for delivery"
									: peerReviewState === "denied"
										? "Delivery denied"
										: "Delivery cancelled"}
						</div>
						<div className="mt-0.5 text-[10px] leading-relaxed text-muted-foreground/75">
							{peerReviewState === "held"
								? "Claude has not acted on this message."
								: peerReviewState === "delivered"
									? "This review approved the message for delivery to Claude."
									: peerReviewState === "denied"
										? "The held message was not delivered to Claude."
										: "The review ended before the held message was delivered."}
						</div>
					</div>
					{(provenance.peer.claimed_name || provenance.peer.from_address) && (
						<div>
							<div className="text-[9px] uppercase tracking-widest text-muted-foreground/60">
								Claimed sender
							</div>
							<PrivacyMask className="mt-0.5 flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-xs text-foreground/75">
								{provenance.peer.claimed_name && (
									<span>{provenance.peer.claimed_name}</span>
								)}
								{provenance.peer.from_address && (
									<span className="break-all font-mono text-[10px] text-muted-foreground/70">
										{provenance.peer.from_address}
									</span>
								)}
							</PrivacyMask>
						</div>
					)}
					{provenance.peer.from_session && (
						<div>
							<div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
								<span className="text-[9px] uppercase tracking-widest text-muted-foreground/60">
									Claimed source session
								</span>
								<span className="text-[9px] text-muted-foreground/45">
									navigation claim only
								</span>
							</div>
							<PrivacyMask className="mt-0.5 break-all font-mono text-[10px] text-muted-foreground/70">
								{provenance.peer.from_session}
							</PrivacyMask>
						</div>
					)}
					<div>
						<div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
							<span className="text-[9px] uppercase tracking-widest text-muted-foreground/60">
								{deliveredBody !== undefined
									? "Delivered message"
									: "Provider preview"}
							</span>
							<span className="text-[9px] text-muted-foreground/45">
								{deliveredBody !== undefined
									? "exact body supplied by Claude Code after delivery"
									: "sanitized and truncated by Claude Code"}
							</span>
						</div>
						<PrivacyMask className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-words text-xs leading-relaxed text-foreground/80">
							{deliveredBody ?? provenance.peer.preview}
						</PrivacyMask>
					</div>
					<div className="flex flex-wrap gap-x-3 gap-y-1 text-[9px] font-mono text-muted-foreground/55">
						{provenance.peer.hold_cause && (
							<span>hold reason {provenance.peer.hold_cause}</span>
						)}
						{provenance.peer.verified_peer_pid !== undefined && (
							<span>
								connecting PID {provenance.peer.verified_peer_pid} (provenance
								only)
							</span>
						)}
					</div>
					<div className="text-[10px] leading-relaxed text-muted-foreground/70">
						Sender names and addresses are provider-reported claims, not human
						authority.
					</div>
					<div className="text-[10px] font-medium leading-relaxed text-foreground/70">
						{peerReviewState === "held"
							? "Any approval covers message delivery only, not tool authority."
							: "This decision covered message delivery only, not tool authority."}
					</div>
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
