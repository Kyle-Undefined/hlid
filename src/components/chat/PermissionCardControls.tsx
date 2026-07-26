import { Check, CornerDownLeft, X } from "lucide-react";
import { useState } from "react";
import type { PermissionMessage } from "./chatReducer";

export type PermissionDecisionHandler = (
	id: string,
	approved: boolean,
	saveScope?: "session" | "local",
	denyMessage?: string,
) => void;

function PermissionDecisionButtons({
	message,
	onDecide,
}: {
	message: PermissionMessage;
	onDecide: PermissionDecisionHandler;
}) {
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
		<div className={`grid grid-cols-2 ${actionGrid}`}>
			<button
				type="button"
				onClick={() => onDecide(message.id, false)}
				aria-label="Deny"
				className="flex min-w-0 items-center justify-center gap-1.5 border-r border-b border-border px-1 py-2 text-[10px] tracking-widest text-destructive/70 uppercase transition-colors hover:bg-destructive/5 sm:gap-2 sm:border-r-0 sm:border-b-0"
			>
				<X className="h-3 w-3 shrink-0" />
				Deny
			</button>
			{message.allowOnce !== false && (
				<button
					type="button"
					onClick={() => onDecide(message.id, true)}
					aria-label="Approve"
					className="flex min-w-0 items-center justify-center gap-1.5 border-b border-border px-1 py-2 text-[10px] tracking-widest text-status-success/70 uppercase transition-colors hover:bg-status-success/5 sm:gap-2 sm:border-b-0 sm:border-l"
				>
					<Check className="h-3 w-3 shrink-0" />
					Approve
				</button>
			)}
			<button
				type="button"
				onClick={() => onDecide(message.id, true, "session")}
				aria-label="Approve for this session"
				className={`flex min-w-0 items-center justify-center gap-1.5 border-border px-1 py-2 text-[10px] tracking-widest text-blue-500/70 uppercase transition-colors hover:bg-blue-500/5 sm:gap-2 sm:border-r-0 sm:border-l ${message.allowOnce === false ? "border-b sm:border-b-0" : "border-r"}`}
			>
				<Check className="h-3 w-3 shrink-0" />
				Session
			</button>
			{message.allowAlways !== false && (
				<button
					type="button"
					onClick={() => onDecide(message.id, true, "local")}
					aria-label="Approve always"
					className={`flex min-w-0 items-center justify-center gap-1.5 border-border px-1 py-2 text-[10px] tracking-widest text-purple-500/70 uppercase transition-colors hover:bg-purple-500/5 sm:gap-2 sm:border-l ${message.allowOnce === false ? "col-span-2 sm:col-span-1" : ""}`}
				>
					<Check className="h-3 w-3 shrink-0" />
					Always
				</button>
			)}
		</div>
	);
}

function PermissionRedirect({
	message,
	onDecide,
}: {
	message: PermissionMessage;
	onDecide: PermissionDecisionHandler;
}) {
	const [instruction, setInstruction] = useState("");
	const redirect = () => {
		const value = instruction.trim();
		if (value) onDecide(message.id, false, undefined, value);
	};
	return (
		<div className="flex items-stretch border-t border-border">
			<textarea
				value={instruction}
				onChange={(event) => setInstruction(event.target.value)}
				onKeyDown={(event) => {
					if (event.key !== "Enter" || event.shiftKey) return;
					event.preventDefault();
					redirect();
				}}
				placeholder="Tell Claude what to do instead…"
				rows={1}
				className="flex-1 resize-none bg-transparent px-3 py-2 font-mono text-xs text-foreground/80 outline-none placeholder:text-muted-foreground/40"
			/>
			<button
				type="button"
				disabled={!instruction.trim()}
				onClick={redirect}
				aria-label="Deny with instruction"
				className="flex shrink-0 items-center gap-1 border-l border-border px-3 text-[10px] tracking-widest text-muted-foreground/50 uppercase transition-colors hover:text-foreground/70 disabled:cursor-not-allowed disabled:opacity-30"
			>
				<CornerDownLeft className="h-3 w-3" />
				Redirect
			</button>
		</div>
	);
}

export function PermissionCardControls({
	message,
	onDecide,
}: {
	message: PermissionMessage;
	onDecide: PermissionDecisionHandler;
}) {
	return (
		<>
			<PermissionDecisionButtons message={message} onDecide={onDecide} />
			<PermissionRedirect message={message} onDecide={onDecide} />
		</>
	);
}
