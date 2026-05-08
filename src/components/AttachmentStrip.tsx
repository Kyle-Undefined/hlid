import { File as FileIcon, X } from "lucide-react";
import type { ChatAttachment } from "#/server/protocol";

/**
 * Attachment chips row + uploading/error pills.
 * Renders nothing when there's nothing to show.
 */
export function AttachmentStrip({
	attachments,
	uploadingCount,
	uploadError,
	onRemove,
	className = "px-4 py-2",
}: {
	attachments: ChatAttachment[];
	uploadingCount: number;
	uploadError: string | null;
	onRemove: (id: string) => void;
	/** Padding classes on the wrapper div (default "px-4 py-2"). */
	className?: string;
}) {
	if (attachments.length === 0 && uploadingCount === 0 && !uploadError)
		return null;

	return (
		<div
			className={`${className} flex flex-wrap items-center gap-1.5 border-b border-border/40`}
		>
			{attachments.map((a) => (
				<span
					key={a.id}
					className="inline-flex items-center gap-1.5 max-w-[220px] border border-border/60 bg-secondary/30 px-2 py-1 text-[10px] text-foreground/80"
				>
					{(a.mime?.startsWith("image/") ?? false) ? (
						<img
							src={`/api/attachments/${a.id}/raw`}
							alt={a.filename}
							className="w-5 h-5 object-cover shrink-0"
							onError={(e) => {
								(e.currentTarget as HTMLImageElement).style.display = "none";
							}}
						/>
					) : (
						<FileIcon className="w-3 h-3 shrink-0 opacity-60" />
					)}
					<span className="truncate font-mono">{a.filename}</span>
					<button
						type="button"
						onClick={() => onRemove(a.id)}
						className="opacity-50 hover:opacity-100 shrink-0"
						aria-label={`Remove ${a.filename}`}
					>
						<X className="w-3 h-3" />
					</button>
				</span>
			))}
			{uploadingCount > 0 && (
				<output className="text-[10px] tracking-widest text-muted-foreground/60 uppercase">
					uploading {uploadingCount}…
				</output>
			)}
			{uploadError && (
				<span role="alert" className="text-[10px] text-destructive/80">
					{uploadError}
				</span>
			)}
		</div>
	);
}
