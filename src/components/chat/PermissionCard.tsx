import { Check, X } from "lucide-react";
import { approvedLabel } from "#/server/protocol";
import type { PermissionMessage } from "./chatReducer";

export function PermissionCard({
	message,
	onDecide,
}: {
	message: PermissionMessage;
	onDecide: (
		id: string,
		approved: boolean,
		saveScope?: "session" | "local",
	) => void;
}) {
	const pending = message.decision === "pending";

	if (!pending) {
		const approvedText = approvedLabel(message.decision);
		const approved = approvedText !== null;
		const label = approvedText ?? "DENIED";
		return (
			<div className="flex gap-0">
				<div className="w-12 shrink-0 text-[9px] tracking-widest text-muted-foreground/50 pt-0.5 uppercase">
					PERM
				</div>
				<div className="flex items-center gap-2 text-xs text-muted-foreground/65">
					{approved ? (
						<Check className="w-3 h-3 text-green-600/60" />
					) : (
						<X className="w-3 h-3 text-destructive/60" />
					)}
					<span className="tracking-wider text-[10px]">
						{(
							message.displayName ??
							message.toolName ??
							"UNKNOWN"
						).toUpperCase()}{" "}
						{label}
					</span>
				</div>
			</div>
		);
	}

	const inputPreview = message.input
		? ((message.input.command as string | undefined) ??
			(message.input.file_path as string | undefined) ??
			(message.input.path as string | undefined) ??
			Object.values(message.input).find(
				(v): v is string => typeof v === "string",
			))
		: undefined;

	return (
		<div className="flex gap-0">
			<div className="w-12 shrink-0 text-[9px] tracking-widest text-primary/60 pt-0.5 uppercase">
				PERM
			</div>
			<div className="flex-1 min-w-0 border border-border bg-card">
				<div className="px-4 py-3 border-b border-border">
					<div className="text-[9px] tracking-widest text-muted-foreground/65 uppercase mb-1">
						PERMISSION REQUEST
					</div>
					<div className="text-sm text-foreground">{message.title}</div>
					{inputPreview && (
						<div className="mt-2 px-2 py-1.5 bg-secondary/60 border border-border font-mono text-[11px] text-foreground/80 whitespace-pre-wrap break-all overflow-x-hidden">
							{inputPreview}
						</div>
					)}
					{message.description && (
						<div className="text-xs text-muted-foreground/75 mt-1">
							{message.description}
						</div>
					)}
				</div>
				<div className="grid grid-cols-2 sm:grid-cols-4">
					<button
						type="button"
						onClick={() => onDecide(message.id, false)}
						aria-label="Deny"
						className="min-w-0 flex items-center justify-center gap-1.5 sm:gap-2 px-1 py-2 text-[10px] tracking-widest text-destructive/70 hover:bg-destructive/5 transition-colors uppercase border-b border-r border-border sm:border-b-0 sm:border-r-0"
					>
						<X className="w-3 h-3 shrink-0" />
						DENY
					</button>
					<button
						type="button"
						onClick={() => onDecide(message.id, true)}
						aria-label="Approve"
						className="min-w-0 flex items-center justify-center gap-1.5 sm:gap-2 px-1 py-2 text-[10px] tracking-widest text-green-500/70 hover:bg-green-500/5 transition-colors uppercase border-b border-border sm:border-b-0 sm:border-l"
					>
						<Check className="w-3 h-3 shrink-0" />
						APPROVE
					</button>
					<button
						type="button"
						onClick={() => onDecide(message.id, true, "session")}
						aria-label="Approve for this session"
						className="min-w-0 flex items-center justify-center gap-1.5 sm:gap-2 px-1 py-2 text-[10px] tracking-widest text-blue-500/70 hover:bg-blue-500/5 transition-colors uppercase border-r border-border sm:border-r-0 sm:border-l"
					>
						<Check className="w-3 h-3 shrink-0" />
						SESSION
					</button>
					<button
						type="button"
						onClick={() => onDecide(message.id, true, "local")}
						aria-label="Approve always"
						className="min-w-0 flex items-center justify-center gap-1.5 sm:gap-2 px-1 py-2 text-[10px] tracking-widest text-purple-500/70 hover:bg-purple-500/5 transition-colors uppercase sm:border-l border-border"
					>
						<Check className="w-3 h-3 shrink-0" />
						ALWAYS
					</button>
				</div>
			</div>
		</div>
	);
}
