import { type ReactNode, useEffect, useRef, useState } from "react";

/**
 * Inline confirm/cancel guard. Wraps any trigger; on click shows
 * "label confirm cancel" inline, then calls onConfirm and resets.
 *
 * Usage:
 *   <ConfirmAction label="remove?" onConfirm={() => handleRemove(id)}
 *     trigger={(open) => <button onClick={open}>×</button>} />
 */
export function ConfirmAction({
	label,
	confirmText = "confirm",
	variant = "destructive",
	onConfirm,
	trigger,
	className,
}: {
	label?: string;
	/** Text on the destructive button (default "confirm"). */
	confirmText?: string;
	/** Color of the confirm button. Defaults to destructive. */
	variant?: "destructive" | "primary";
	onConfirm: () => void;
	trigger: (open: () => void) => ReactNode;
	/** Extra classes on the confirming wrapper div. */
	className?: string;
}) {
	const [confirming, setConfirming] = useState(false);
	const confirmBtnRef = useRef<HTMLButtonElement>(null);

	useEffect(() => {
		if (confirming) confirmBtnRef.current?.focus();
	}, [confirming]);

	useEffect(() => {
		if (!confirming) return;
		const handler = (e: KeyboardEvent) => {
			if (e.key === "Escape") setConfirming(false);
		};
		window.addEventListener("keydown", handler);
		return () => window.removeEventListener("keydown", handler);
	}, [confirming]);

	if (confirming) {
		const confirmCls =
			variant === "primary"
				? "text-primary/60 hover:text-primary"
				: "text-destructive/60 hover:text-destructive";
		return (
			<div
				aria-live="polite"
				className={`flex items-center gap-2 ${className ?? ""}`}
			>
				{label && (
					<span className="text-[9px] text-muted-foreground/50">{label}</span>
				)}
				<button
					ref={confirmBtnRef}
					type="button"
					onClick={() => {
						setConfirming(false);
						onConfirm();
					}}
					className={`text-[9px] tracking-widest uppercase transition-colors ${confirmCls}`}
				>
					{confirmText}
				</button>
				<button
					type="button"
					onClick={() => setConfirming(false)}
					className="text-[9px] tracking-widest text-muted-foreground/50 hover:text-muted-foreground/80 uppercase transition-colors"
				>
					cancel
				</button>
			</div>
		);
	}

	return <>{trigger(() => setConfirming(true))}</>;
}
