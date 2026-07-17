import { useState } from "react";
import { BrowseDialog, BrowseFieldControl } from "./BrowseFieldParts";
import { FolderBrowser } from "./FolderBrowser";

export function RelativeFolderField({
	value,
	onChange,
	basePath,
	placeholder,
	fullWidth,
}: {
	value: string;
	onChange: (v: string) => void;
	basePath: string;
	placeholder?: string;
	fullWidth?: boolean;
}) {
	const [open, setOpen] = useState(false);

	return (
		<>
			<BrowseFieldControl
				value={value}
				onChange={onChange}
				placeholder={placeholder}
				onBrowse={() => setOpen(true)}
				fullWidth={fullWidth}
				disabled={!basePath}
			/>
			{open && (
				<BrowseDialog title="PICK FOLDER" onClose={() => setOpen(false)}>
					<FolderBrowser
						initialPath={basePath}
						onSelect={(path) => {
							// Normalize separators for prefix comparison; preserve original
							// path when slicing so the returned relative path keeps its style.
							const normPath = path.replace(/\\/g, "/");
							const normBase = basePath.replace(/\\/g, "/");
							const prefix = normBase.endsWith("/") ? normBase : `${normBase}/`;
							const rel = normPath.startsWith(prefix)
								? path.slice(prefix.length)
								: (path.split(/[/\\]/).pop() ?? path);
							onChange(rel);
							setOpen(false);
						}}
					/>
				</BrowseDialog>
			)}
		</>
	);
}
