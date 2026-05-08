import type { UserMessage } from "#/components/chat/chatReducer";
import { PrivacyMask } from "#/components/PrivacyMask";
import { AttachmentChip } from "./AttachmentChip";

export function UserMsg({ message }: { message: UserMessage }) {
	return (
		<div className="flex items-start justify-end gap-3 py-3 border-b border-border/40">
			<div className="flex flex-col items-end gap-1.5 min-w-0 max-w-[78%]">
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
			<div className="text-[9px] tracking-widest text-primary/60 shrink-0 pt-0.5 w-11 text-right">
				ME
			</div>
		</div>
	);
}
