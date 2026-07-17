import {
	Children,
	cloneElement,
	isValidElement,
	type ReactElement,
	type ReactNode,
	useId,
	useState,
} from "react";
import {
	FieldControlProvider,
	useFieldControlProps,
} from "#/components/form/FieldControlContext";
import { StatusDot } from "#/components/McpStatusDot";
import {
	BrowseDialog,
	BrowseFieldControl,
} from "#/components/wizard/BrowseFieldParts";
import { FileBrowser } from "#/components/wizard/FileBrowser";
import { FolderBrowser } from "#/components/wizard/FolderBrowser";

export { useFieldControlProps } from "#/components/form/FieldControlContext";
// Section moved to the shared shell; re-exported so existing imports keep working.
export { Section } from "#/components/shell/Section";

function labelNativeControls(
	node: ReactNode,
	labelId: string,
	hintId?: string,
): ReactNode {
	return Children.map(node, (child) => {
		if (!isValidElement(child) || typeof child.type !== "string") return child;
		const element = child as ReactElement<Record<string, unknown>>;
		const isControl = ["input", "select", "textarea"].includes(child.type);
		const props: Record<string, unknown> = {};
		if (
			isControl &&
			!element.props["aria-label"] &&
			!element.props["aria-labelledby"]
		) {
			props["aria-labelledby"] = labelId;
		}
		if (isControl && hintId && !element.props["aria-describedby"]) {
			props["aria-describedby"] = hintId;
		}
		if (element.props.children) {
			props.children = labelNativeControls(
				element.props.children as ReactNode,
				labelId,
				hintId,
			);
		}
		return cloneElement(element, props);
	});
}

export function Field({
	label,
	hint,
	children,
}: {
	label: string;
	hint?: string;
	children: ReactNode;
}) {
	const uniqueId = useId();
	const labelId = `forge-field-label-${uniqueId}`;
	const hintId = hint ? `forge-field-hint-${uniqueId}` : undefined;
	const controlA11y = {
		"aria-labelledby": labelId,
		...(hintId ? { "aria-describedby": hintId } : {}),
	};
	return (
		<div className="flex flex-col md:flex-row md:items-center md:justify-between gap-2 md:gap-6 px-4 py-3">
			<div className="min-w-0">
				<div id={labelId} className="text-sm text-foreground">
					{label}
				</div>
				{hint && (
					<div
						id={hintId}
						className="text-xs text-muted-foreground mt-0.5 break-all"
					>
						{hint}
					</div>
				)}
			</div>
			<FieldControlProvider value={controlA11y}>
				<div className="shrink-0">
					{labelNativeControls(children, labelId, hintId)}
				</div>
			</FieldControlProvider>
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
	const fieldA11y = useFieldControlProps();
	return (
		<input
			{...fieldA11y}
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
	const inputId = useId();
	return (
		<div className="px-4 py-3 space-y-1.5">
			<label
				htmlFor={inputId}
				className="block text-[9px] tracking-widest text-muted-foreground uppercase"
			>
				{label}
			</label>
			<input
				id={inputId}
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

	return (
		<>
			<BrowseFieldControl
				value={value}
				onChange={onChange}
				placeholder={placeholder}
				onBrowse={() => setOpen(true)}
			/>
			{open && (
				<BrowseDialog
					title={mode === "folder" ? "PICK VAULT FOLDER" : "PICK FILE"}
					onClose={() => setOpen(false)}
				>
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
				</BrowseDialog>
			)}
		</>
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
