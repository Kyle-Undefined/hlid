import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import { StatusDot } from "#/components/McpStatusDot";
import { FileBrowser } from "#/components/wizard/FileBrowser";
import { FolderBrowser } from "#/components/wizard/FolderBrowser";

// Section moved to the shared shell; re-exported so existing imports keep working.
export { Section } from "#/components/shell/Section";

export function Field({
	label,
	hint,
	children,
}: {
	label: string;
	hint?: string;
	children: ReactNode;
}) {
	return (
		<div className="flex flex-col md:flex-row md:items-center md:justify-between gap-2 md:gap-6 px-4 py-3">
			<div className="min-w-0">
				<div className="text-sm text-foreground">{label}</div>
				{hint && (
					<div className="text-xs text-muted-foreground mt-0.5 break-all">
						{hint}
					</div>
				)}
			</div>
			<div className="shrink-0">{children}</div>
		</div>
	);
}

export function StatusIndicator({
	ok,
	children,
	label,
}: {
	ok: boolean | null;
	children: ReactNode;
	label?: string;
}) {
	return (
		<span className="inline-flex items-center gap-3">
			<StatusDot ok={ok} label={label} />
			<span className="text-xs text-muted-foreground">{children}</span>
		</span>
	);
}

export function TextInput({
	value,
	onChange,
	placeholder,
	mono,
}: {
	value: string;
	onChange: (v: string) => void;
	placeholder?: string;
	mono?: boolean;
}) {
	return (
		<input
			type="text"
			value={value}
			onChange={(e) => onChange(e.target.value)}
			placeholder={placeholder}
			className={`w-32 sm:w-48 bg-secondary border border-border px-2.5 py-1.5 text-sm text-foreground placeholder:text-muted-foreground/40 focus:outline-none focus:border-primary/50 transition-colors ${mono ? "font-mono text-xs" : ""}`}
		/>
	);
}

export function VocabRow({
	label,
	value,
	onChange,
}: {
	label: string;
	value: string;
	onChange: (v: string) => void;
}) {
	return (
		<div className="px-4 py-3 space-y-1.5">
			<div className="text-[9px] tracking-widest text-muted-foreground uppercase">
				{label}
			</div>
			<input
				type="text"
				value={value}
				onChange={(e) => onChange(e.target.value)}
				className="w-full bg-secondary border border-border px-2.5 py-1.5 text-xs font-mono text-foreground placeholder:text-muted-foreground/40 focus:outline-none focus:border-primary/50 transition-colors"
				placeholder="comma separated values"
			/>
		</div>
	);
}

function BrowsableField({
	value,
	onChange,
	placeholder,
	mode,
	extensions,
	external,
}: {
	value: string;
	onChange: (v: string) => void;
	placeholder?: string;
	mode: "folder" | "file";
	extensions?: string[];
	external?: boolean;
}) {
	const [open, setOpen] = useState(false);
	const uniqueId = useId();
	const dialogId = `${mode}-field-dialog-title-${uniqueId}`;
	const browseButtonRef = useRef<HTMLButtonElement>(null);
	const dialogRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		if (open) {
			// Move focus into dialog when it opens
			const firstFocusable = dialogRef.current?.querySelector<HTMLElement>(
				'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
			);
			(firstFocusable ?? dialogRef.current)?.focus();
		} else {
			// Return focus to trigger button when dialog closes
			browseButtonRef.current?.focus();
		}
	}, [open]);

	return (
		<div className="flex items-center gap-2">
			<input
				type="text"
				value={value}
				onChange={(e) => onChange(e.target.value)}
				placeholder={placeholder}
				className="w-32 sm:w-48 bg-secondary border border-border px-2.5 py-1.5 text-xs font-mono text-foreground placeholder:text-muted-foreground/40 focus:outline-none focus:border-primary/50 transition-colors"
			/>
			<button
				ref={browseButtonRef}
				type="button"
				onClick={() => setOpen(true)}
				className="text-[10px] tracking-widest px-2 py-1.5 border border-border text-muted-foreground hover:bg-accent hover:text-foreground transition-colors shrink-0 uppercase"
			>
				BROWSE
			</button>

			{open && (
				<div className="fixed inset-0 z-50 bg-background/90 backdrop-blur-sm flex items-center justify-center p-4">
					<div
						ref={dialogRef}
						tabIndex={-1}
						role="dialog"
						aria-modal="true"
						aria-labelledby={dialogId}
						className="w-full max-w-md bg-card border border-border shadow-2xl p-5 space-y-4"
						onKeyDown={(e) => {
							if (e.key === "Escape") setOpen(false);
						}}
					>
						<div className="flex items-center justify-between">
							<div
								id={dialogId}
								className="text-[10px] tracking-widest text-muted-foreground uppercase"
							>
								{mode === "folder" ? "PICK VAULT FOLDER" : "PICK FILE"}
							</div>
							<button
								type="button"
								onClick={() => setOpen(false)}
								className="text-[10px] tracking-widest text-muted-foreground hover:text-foreground transition-colors uppercase"
							>
								CANCEL
							</button>
						</div>
						{mode === "folder" ? (
							<FolderBrowser
								initialPath={value || undefined}
								onSelect={(path) => {
									onChange(path);
									setOpen(false);
								}}
							/>
						) : (
							<FileBrowser
								initialPath={value || undefined}
								extensions={extensions}
								external={external}
								onSelect={(path) => {
									onChange(path);
									setOpen(false);
								}}
							/>
						)}
					</div>
				</div>
			)}
		</div>
	);
}

export function PathField({
	value,
	onChange,
}: {
	value: string;
	onChange: (v: string) => void;
}) {
	return (
		<BrowsableField
			value={value}
			onChange={onChange}
			placeholder="~/vault"
			mode="folder"
		/>
	);
}

export function FilePathField({
	value,
	onChange,
	placeholder,
	extensions,
	external,
}: {
	value: string;
	onChange: (v: string) => void;
	placeholder?: string;
	extensions?: string[];
	external?: boolean;
}) {
	return (
		<BrowsableField
			value={value}
			onChange={onChange}
			placeholder={placeholder}
			mode="file"
			extensions={extensions}
			external={external}
		/>
	);
}
