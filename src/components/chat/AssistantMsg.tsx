import { MarkdownBody } from "#/components/MarkdownBody";
import { PrivacyMask } from "#/components/PrivacyMask";
import { useCopyToClipboard } from "#/hooks/useCopyToClipboard";
import { CopyButton } from "./CopyButton";
import type { AssistantMessage } from "./chatReducer";
import { ToolBlock } from "./ToolBlock";

export function normalizeMd(text: string): string {
	// CommonMark: "**foo:**bar" — closer after punctuation, before word char,
	// is left-flanking only and cannot close strong. Insert a space after closer.
	return text.replace(
		/(\*\*[^\s*](?:[^*\n]|\*(?!\*))*?[^\w\s*])\*\*(?=\w)/gu,
		"$1** ",
	);
}

export function AssistantMsg({
	message,
	permissionLabels,
}: {
	message: AssistantMessage;
	permissionLabels?: Map<string, string>;
}) {
	const { copy, copied } = useCopyToClipboard();
	return (
		<div className="group py-3 border-b border-border/40 space-y-1.5">
			{message.toolEvents.map((e) => (
				<ToolBlock
					key={e.id}
					event={e}
					permissionLabel={permissionLabels?.get(e.id)}
				/>
			))}
			{(message.text || message.streaming) && (
				<div className="flex items-start gap-0">
					<div className="shrink-0 pt-0.5 w-12 flex">
						<svg
							xmlns="http://www.w3.org/2000/svg"
							viewBox="0 0 32 32"
							className="w-4 h-4 opacity-60"
							role="img"
							aria-label="Assistant"
						>
							<path
								d="M2 16 C7 6 25 6 30 16 C25 26 7 26 2 16Z"
								fill="none"
								style={{ stroke: "var(--data)" }}
								strokeWidth="1.5"
								strokeLinejoin="round"
							/>
							<circle
								cx="16"
								cy="16"
								r="5.5"
								fill="none"
								style={{ stroke: "var(--data)" }}
								strokeWidth="1.5"
							/>
							<circle cx="16" cy="16" r="2" style={{ fill: "var(--data)" }} />
						</svg>
					</div>
					<PrivacyMask className="flex-1 text-sm leading-relaxed pr-4 min-w-0 text-[var(--agent-msg)]">
						<MarkdownBody
							content={normalizeMd(message.text ?? "")}
							streaming={message.streaming}
						/>
						{message.streaming && (
							<span className="inline-block w-[7px] h-[1em] ml-0.5 align-middle bg-primary/50 cursor-blink" />
						)}
					</PrivacyMask>
					{!message.streaming && message.text && (
						<div className="flex items-center gap-1 shrink-0">
							{message.cost !== null && (
								<PrivacyMask
									inline
									className="text-[9px] tabular-nums text-muted-foreground/40 pt-0.5 font-mono"
								>
									${message.cost.toFixed(4)}
								</PrivacyMask>
							)}
							<CopyButton
								onCopy={() => copy(message.text ?? "")}
								copied={copied}
								className="opacity-0 group-hover:opacity-100 [@media(hover:none)]:opacity-100 transition-opacity"
							/>
						</div>
					)}
				</div>
			)}
			{message.recap && !message.streaming && (
				<div className="my-0.5">
					<div className="flex items-baseline gap-2.5 w-full px-3 py-1.5">
						<span className="text-muted-foreground/30 text-[11px] shrink-0 leading-none select-none">
							—
						</span>
						<span className="text-[9px] font-medium tracking-wider text-muted-foreground/40 uppercase shrink-0">
							RECAP
						</span>
						<span className="text-[11px] text-primary/55 leading-relaxed">
							{message.recap}
						</span>
					</div>
				</div>
			)}
		</div>
	);
}
