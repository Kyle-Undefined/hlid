import {
	type ReactNode,
	useCallback,
	useEffect,
	useRef,
	useState,
} from "react";

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
	stacked = false,
	onOpenChange,
	disabled = false,
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
	/** Put the explanation on its own row above the action buttons. */
	stacked?: boolean;
	/** Observe the inline confirmation opening or closing. */
	onOpenChange?: (open: boolean) => void;
	/** Prevent opening or completing the confirmation. */
	disabled?: boolean;
}) {
	const [confirming, setConfirming] = useState(false);
	const confirmBtnRef = useRef<HTMLButtonElement>(null);
	const setOpen = useCallback(
		(open: boolean) => {
			if (open && disabled) return;
			setConfirming(open);
			onOpenChange?.(open);
		},
		[disabled, onOpenChange],
	);

	useEffect(() => {
		if (confirming) confirmBtnRef.current?.focus();
	}, [confirming]);

	useEffect(() => {
		if (disabled && confirming) setOpen(false);
	}, [confirming, disabled, setOpen]);

	useEffect(() => {
		if (!confirming) return;
		const handler = (e: KeyboardEvent) => {
			if (e.key === "Escape") setOpen(false);
		};
		window.addEventListener("keydown", handler);
		return () => window.removeEventListener("keydown", handler);
	}, [confirming, setOpen]);

	if (confirming) {
		const confirmCls =
			variant === "primary"
				? "text-primary/60 hover:text-primary"
				: "text-destructive/60 hover:text-destructive";
		return (
			<div
				aria-live="polite"
				className={`flex items-center gap-2 ${
					stacked ? "w-full flex-wrap justify-end gap-y-1.5" : ""
				} ${className ?? ""}`}
			>
				{label && (
					<span
						className={`text-[9px] text-muted-foreground/50 ${
							stacked
								? "w-full min-w-0 text-right leading-relaxed break-all"
								: ""
						}`}
					>
						{label}
					</span>
				)}
				<button
					ref={confirmBtnRef}
					type="button"
					disabled={disabled}
					onClick={() => {
						if (disabled) return;
						setOpen(false);
						onConfirm();
					}}
					className={`shrink-0 text-[9px] tracking-widest uppercase transition-colors disabled:opacity-40 ${confirmCls}`}
				>
					{confirmText}
				</button>
				<button
					type="button"
					onClick={() => setOpen(false)}
					className="shrink-0 text-[9px] tracking-widest text-muted-foreground/50 hover:text-muted-foreground/80 uppercase transition-colors"
				>
					cancel
				</button>
			</div>
		);
	}

	return <>{trigger(() => setOpen(true))}</>;
}
