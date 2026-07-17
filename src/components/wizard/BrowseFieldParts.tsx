import { type ReactNode, useId } from "react";
import { useFieldControlProps } from "#/components/form/FieldControlContext";
import { useDialogFocus } from "#/hooks/useDialogFocus";

export function BrowseFieldControl({
	value,
	onChange,
	placeholder,
	onBrowse,
	fullWidth = false,
	disabled = false,
}: {
	value: string;
	onChange: (value: string) => void;
	placeholder?: string;
	onBrowse: () => void;
	fullWidth?: boolean;
	disabled?: boolean;
}) {
	const fieldA11y = useFieldControlProps();
	return (
		<div className="flex items-center gap-2">
			<input
				{...fieldA11y}
				type="text"
				value={value}
				onChange={(event) => onChange(event.target.value)}
				placeholder={placeholder}
				className={`${fullWidth ? "flex-1 min-w-0" : "w-32 sm:w-48"} bg-secondary border border-border px-2.5 py-1.5 text-xs font-mono text-foreground placeholder:text-muted-foreground/40 focus:outline-none focus:border-primary/50 transition-colors`}
			/>
			<button
				type="button"
				onClick={onBrowse}
				disabled={disabled}
				className="text-[10px] tracking-widest px-2 py-1.5 border border-border text-muted-foreground hover:bg-accent hover:text-foreground transition-colors shrink-0 uppercase disabled:opacity-30"
			>
				BROWSE
			</button>
		</div>
	);
}

export function BrowseDialog({
	title,
	onClose,
	children,
}: {
	title: string;
	onClose: () => void;
	children: ReactNode;
}) {
	const titleId = `browse-dialog-title-${useId()}`;
	const { dialogRef, onDialogKeyDown } =
		useDialogFocus<HTMLDivElement>(onClose);
	return (
		<div className="fixed inset-0 z-50 bg-background/90 backdrop-blur-sm flex items-center justify-center p-4">
			<div
				ref={dialogRef}
				tabIndex={-1}
				role="dialog"
				aria-modal="true"
				aria-labelledby={titleId}
				onKeyDown={onDialogKeyDown}
				className="w-full max-w-md bg-card border border-border shadow-2xl p-5 space-y-4"
			>
				<div className="flex items-center justify-between">
					<div
						id={titleId}
						className="text-[10px] tracking-widest text-muted-foreground uppercase"
					>
						{title}
					</div>
					<button
						type="button"
						onClick={onClose}
						className="text-[10px] tracking-widest text-muted-foreground hover:text-foreground transition-colors uppercase"
					>
						CANCEL
					</button>
				</div>
				{children}
			</div>
		</div>
	);
}
