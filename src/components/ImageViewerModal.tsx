import { X } from "lucide-react";
import { useState } from "react";
import { createPortal } from "react-dom";
import { useDialogFocus } from "#/hooks/useDialogFocus";

export function ImageViewerModal({
	src,
	alt,
	onClose,
}: {
	src: string;
	alt: string;
	onClose: () => void;
}) {
	const { dialogRef, onDialogKeyDown } =
		useDialogFocus<HTMLDivElement>(onClose);

	return (
		// biome-ignore lint/a11y/useKeyWithClickEvents: backdrop Escape handled by inner dialog
		// biome-ignore lint/a11y/noStaticElementInteractions: modal backdrop pattern
		<div
			className="fixed inset-0 z-50 bg-background/90 backdrop-blur-sm flex items-center justify-center p-4"
			onClick={onClose}
		>
			<div
				ref={dialogRef}
				tabIndex={-1}
				role="dialog"
				aria-modal="true"
				aria-label="Image viewer"
				className="relative flex flex-col items-center gap-3 focus:outline-none"
				onClick={(e) => e.stopPropagation()}
				onKeyDown={onDialogKeyDown}
			>
				<button
					type="button"
					onClick={onClose}
					aria-label="Close image viewer"
					className="absolute -top-2 -right-2 z-10 bg-card border border-border text-muted-foreground hover:text-foreground transition-colors p-1 shadow"
				>
					<X className="w-4 h-4" />
				</button>
				<img
					src={src}
					alt={alt}
					className="max-h-[85vh] max-w-[90vw] object-contain shadow-2xl"
				/>
				{alt && (
					<p className="text-[11px] font-mono text-muted-foreground/70 max-w-[90vw] truncate">
						{alt}
					</p>
				)}
			</div>
		</div>
	);
}

/**
 * Renders an image that opens `ImageViewerModal` on click.
 * Calls e.preventDefault() + e.stopPropagation() so it works
 * safely inside markdown anchor wrappers.
 */
export function ClickableImage({
	src,
	alt,
	className,
}: {
	src: string;
	alt: string;
	className?: string;
}) {
	const [open, setOpen] = useState(false);
	return (
		<>
			{/* A semantic button is invalid inside Markdown's paragraph element. */}
			{/* biome-ignore lint/a11y/useSemanticElements: inline interactive image must remain phrasing content */}
			<span
				role="button"
				tabIndex={0}
				className={`cursor-zoom-in p-0 border-0 bg-transparent${className ? ` ${className}` : ""}`}
				onClick={(e) => {
					e.preventDefault();
					e.stopPropagation();
					setOpen(true);
				}}
				onKeyDown={(e) => {
					if (e.key !== "Enter" && e.key !== " ") return;
					e.preventDefault();
					e.stopPropagation();
					setOpen(true);
				}}
				aria-label={`View ${alt || "image"}`}
			>
				<img src={src} alt={alt} className="block max-w-full" />
			</span>
			{open &&
				createPortal(
					<ImageViewerModal
						src={src}
						alt={alt}
						onClose={() => setOpen(false)}
					/>,
					document.body,
				)}
		</>
	);
}
