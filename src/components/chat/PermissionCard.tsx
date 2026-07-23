import { Check, CornerDownLeft, X } from "lucide-react";
import { useState } from "react";
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
		denyMessage?: string,
	) => void;
}) {
	const pending = message.decision === "pending";
	const [instruction, setInstruction] = useState("");

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

	const appName =
		typeof message.input?.appName === "string"
			? message.input.appName
			: undefined;
	const appId =
		typeof message.input?.appId === "string" ? message.input.appId : undefined;
	const appIdentity = appName ?? appId;
	const activeNote =
		typeof message.input?.activeNote === "string"
			? message.input.activeNote
			: undefined;
	const inputPreview =
		message.input && !appIdentity
			? ((message.input.command as string | undefined) ??
				(message.input.file_path as string | undefined) ??
				(message.input.path as string | undefined) ??
				Object.values(message.input).find(
					(v): v is string => typeof v === "string",
				))
			: undefined;
	const actionCount =
		1 +
		(message.allowOnce === false ? 0 : 1) +
		1 +
		(message.allowAlways === false ? 0 : 1);
	const actionGrid =
		actionCount === 4
			? "sm:grid-cols-4"
			: actionCount === 3
				? "sm:grid-cols-3"
				: "sm:grid-cols-2";

	return (
		<div className="flex w-full min-w-0 max-w-full overflow-hidden gap-0">
			<div className="w-12 shrink-0 text-[9px] tracking-widest text-primary/60 pt-0.5 uppercase">
				PERM
			</div>
			<div className="flex-1 min-w-0 border border-border bg-card">
				<div className="min-w-0 max-w-full overflow-hidden px-4 py-3 border-b border-border">
					<div className="text-[9px] tracking-widest text-muted-foreground/65 uppercase mb-1">
						PERMISSION REQUEST
					</div>
					<div className="text-sm text-foreground">{message.title}</div>
					{appIdentity && (
						<div className="min-w-0 max-w-full mt-2 px-2 py-2 bg-secondary/60 border border-border overflow-hidden">
							<div className="text-[8px] tracking-widest text-muted-foreground/55 uppercase">
								Application
							</div>
							<div className="mt-0.5 text-xs text-foreground/90 break-all">
								{appIdentity}
							</div>
							{appId && appId !== appName && (
								<div className="mt-1 font-mono text-[10px] text-muted-foreground/65 whitespace-pre-wrap break-all">
									{appId}
								</div>
							)}
							<div className="mt-1.5 text-[9px] text-muted-foreground/55">
								Always applies only to this application.
							</div>
						</div>
					)}
					{activeNote && (
						<div className="min-w-0 max-w-full mt-2 px-2 py-2 bg-secondary/60 border border-border overflow-hidden">
							<div className="text-[8px] tracking-widest text-muted-foreground/55 uppercase">
								Active note
							</div>
							<div className="mt-0.5 font-mono text-[11px] text-foreground/85 whitespace-pre-wrap break-all">
								{activeNote}
							</div>
						</div>
					)}
					{inputPreview && (
						<div className="min-w-0 max-w-full mt-2 px-2 py-1.5 bg-secondary/60 border border-border font-mono text-[11px] text-foreground/80 whitespace-pre-wrap break-all overflow-hidden">
							{inputPreview}
						</div>
					)}
					{message.description && (
						<div className="text-xs text-muted-foreground/75 mt-1">
							{message.description}
						</div>
					)}
				</div>
				<div className={`grid grid-cols-2 ${actionGrid}`}>
					<button
						type="button"
						onClick={() => onDecide(message.id, false)}
						aria-label="Deny"
						className="min-w-0 flex items-center justify-center gap-1.5 sm:gap-2 px-1 py-2 text-[10px] tracking-widest text-destructive/70 hover:bg-destructive/5 transition-colors uppercase border-b border-r border-border sm:border-b-0 sm:border-r-0"
					>
						<X className="w-3 h-3 shrink-0" />
						DENY
					</button>
					{message.allowOnce !== false && (
						<button
							type="button"
							onClick={() => onDecide(message.id, true)}
							aria-label="Approve"
							className="min-w-0 flex items-center justify-center gap-1.5 sm:gap-2 px-1 py-2 text-[10px] tracking-widest text-green-500/70 hover:bg-green-500/5 transition-colors uppercase border-b border-border sm:border-b-0 sm:border-l"
						>
							<Check className="w-3 h-3 shrink-0" />
							APPROVE
						</button>
					)}
					<button
						type="button"
						onClick={() => onDecide(message.id, true, "session")}
						aria-label="Approve for this session"
						className={`min-w-0 flex items-center justify-center gap-1.5 sm:gap-2 px-1 py-2 text-[10px] tracking-widest text-blue-500/70 hover:bg-blue-500/5 transition-colors uppercase border-border sm:border-r-0 sm:border-l ${message.allowOnce === false ? "border-b sm:border-b-0" : "border-r"}`}
					>
						<Check className="w-3 h-3 shrink-0" />
						SESSION
					</button>
					{message.allowAlways !== false && (
						<button
							type="button"
							onClick={() => onDecide(message.id, true, "local")}
							aria-label="Approve always"
							className={`min-w-0 flex items-center justify-center gap-1.5 sm:gap-2 px-1 py-2 text-[10px] tracking-widest text-purple-500/70 hover:bg-purple-500/5 transition-colors uppercase sm:border-l border-border ${message.allowOnce === false ? "col-span-2 sm:col-span-1" : ""}`}
						>
							<Check className="w-3 h-3 shrink-0" />
							ALWAYS
						</button>
					)}
				</div>
				<div className="flex items-stretch border-t border-border">
					<textarea
						value={instruction}
						onChange={(e) => setInstruction(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === "Enter" && !e.shiftKey) {
								e.preventDefault();
								const msg = instruction.trim();
								if (msg) onDecide(message.id, false, undefined, msg);
							}
						}}
						placeholder="Tell Claude what to do instead…"
						rows={1}
						className="flex-1 resize-none bg-transparent px-3 py-2 text-xs text-foreground/80 placeholder:text-muted-foreground/40 outline-none font-mono"
					/>
					<button
						type="button"
						disabled={!instruction.trim()}
						onClick={() => {
							const msg = instruction.trim();
							if (msg) onDecide(message.id, false, undefined, msg);
						}}
						aria-label="Deny with instruction"
						className="shrink-0 flex items-center gap-1 px-3 text-[10px] tracking-widest text-muted-foreground/50 hover:text-foreground/70 disabled:opacity-30 disabled:cursor-not-allowed transition-colors border-l border-border uppercase"
					>
						<CornerDownLeft className="w-3 h-3" />
						REDIRECT
					</button>
				</div>
			</div>
		</div>
	);
}
