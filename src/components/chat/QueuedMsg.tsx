import { X } from "lucide-react";
import { PrivacyMask } from "#/components/PrivacyMask";
import type { QueuedChatMessage } from "#/hooks/wsStore";
import { AttachmentChip } from "./AttachmentChip";

export function QueuedMsg({
	message,
	index,
	onCancel,
}: {
	message: QueuedChatMessage;
	index: number;
	onCancel: (id: string) => void;
}) {
	return (
		<div className="flex items-start justify-end gap-3 py-3 border-b border-dashed border-border/25">
			<div className="flex flex-col items-end gap-1.5 min-w-0 max-w-[78%] opacity-50">
				{message.attachments && message.attachments.length > 0 && (
					<PrivacyMask className="flex flex-wrap gap-1.5 justify-end">
						{message.attachments.map((a) => (
							<AttachmentChip key={a.id} a={a} />
						))}
					</PrivacyMask>
				)}
				{message.text && (
					<PrivacyMask className="w-full">
						<div
							className="text-sm text-foreground whitespace-pre-wrap text-right leading-relaxed w-full"
							style={{ overflowWrap: "anywhere" }}
						>
							{message.text}
						</div>
					</PrivacyMask>
				)}
			</div>
			<div className="flex flex-col items-end gap-1 shrink-0 pt-0.5 w-11">
				<span className="text-[9px] tracking-widest text-muted-foreground/40 text-right opacity-50">
					Q{index + 1}
				</span>
				<button
					type="button"
					onClick={() => onCancel(message.id)}
					className="text-muted-foreground/30 hover:text-destructive/70 transition-colors"
					aria-label={`Cancel queued message ${index + 1}`}
				>
					<X className="w-3 h-3" />
				</button>
			</div>
		</div>
	);
}
