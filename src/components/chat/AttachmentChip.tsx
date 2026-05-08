import { File as FileIcon } from "lucide-react";
import type { ChatAttachment } from "#/server/protocol";

export function AttachmentChip({ a }: { a: ChatAttachment }) {
	const isImage = a.mime?.startsWith("image/") ?? false;
	const href = `/api/attachments/${a.id}/raw`;
	return (
		<a
			href={href}
			target="_blank"
			rel="noreferrer"
			className="inline-flex items-center gap-1.5 max-w-[200px] border border-border/60 bg-secondary/30 hover:bg-secondary/60 transition-colors px-2 py-1 text-[10px] text-foreground/80"
			title={a.filename}
		>
			{isImage ? (
				<img
					src={href}
					alt={a.filename}
					className="w-6 h-6 object-cover shrink-0"
				/>
			) : (
				<FileIcon className="w-3 h-3 shrink-0 opacity-60" />
			)}
			<span className="truncate font-mono">{a.filename}</span>
		</a>
	);
}
