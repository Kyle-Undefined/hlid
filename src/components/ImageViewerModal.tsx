import {
	ChevronLeft,
	ChevronRight,
	Download,
	Minus,
	Plus,
	X,
} from "lucide-react";
import { useState } from "react";
import { createPortal } from "react-dom";
import { useDialogFocus } from "#/hooks/useDialogFocus";

type ImageViewerZoom = "fit" | number;

export type ImageViewerNavigation = {
	position: number;
	total: number;
	onPrevious?: () => void;
	onNext?: () => void;
	previousLabel?: string;
	nextLabel?: string;
};

const MIN_ZOOM = 0.25;
const MAX_ZOOM = 4;
const ZOOM_STEP = 0.25;

function boundedZoom(zoom: number): number {
	return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
}

function imageExtension(src: string): string {
	const mime = /^data:image\/([^;,]+)/i.exec(src)?.[1]?.toLowerCase();
	if (mime === "jpeg") return "jpg";
	if (mime?.match(/^[a-z0-9.+-]+$/)) return mime;
	return "png";
}

function imageFilename(src: string, alt: string): string {
	const stem = alt
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-|-$/g, "")
		.slice(0, 80);
	return `${stem || "image"}.${imageExtension(src)}`;
}

export function ImageViewerModal({
	src,
	alt,
	onClose,
	downloadFilename,
	navigation,
}: {
	src: string;
	alt: string;
	onClose: () => void;
	downloadFilename?: string;
	navigation?: ImageViewerNavigation;
}) {
	const { dialogRef, onDialogKeyDown } =
		useDialogFocus<HTMLDivElement>(onClose);
	const [zoom, setZoom] = useState<ImageViewerZoom>("fit");
	const [naturalSize, setNaturalSize] = useState<{
		width: number;
		height: number;
	} | null>(null);
	const numericZoom = zoom === "fit" ? null : zoom;
	const scaledSize =
		numericZoom !== null && naturalSize
			? {
					width: naturalSize.width * numericZoom,
					height: naturalSize.height * numericZoom,
				}
			: null;
	const changeZoom = (delta: number) => {
		setZoom((current) =>
			boundedZoom((current === "fit" ? 1 : current) + delta),
		);
	};
	return (
		// biome-ignore lint/a11y/useKeyWithClickEvents: backdrop Escape handled by inner dialog
		// biome-ignore lint/a11y/noStaticElementInteractions: modal backdrop pattern
		<div
			className="fixed inset-0 z-50 flex items-center justify-center bg-background/90 p-4 backdrop-blur-sm"
			onClick={onClose}
		>
			<div
				ref={dialogRef}
				tabIndex={-1}
				role="dialog"
				aria-modal="true"
				aria-label="Image viewer"
				className="relative flex h-full min-h-0 w-full flex-col gap-3 focus:outline-none"
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
				<fieldset className="flex min-h-8 shrink-0 flex-wrap items-center justify-center gap-1 border-0 pr-7">
					<legend className="sr-only">Image controls</legend>
					{navigation && (
						<>
							<button
								type="button"
								onClick={navigation.onPrevious}
								disabled={!navigation.onPrevious}
								aria-label={navigation.previousLabel ?? "Previous image"}
								className="inline-flex h-8 w-8 items-center justify-center text-muted-foreground/55 transition-colors hover:text-foreground disabled:opacity-25 disabled:hover:text-muted-foreground/55"
							>
								<ChevronLeft className="h-4 w-4" aria-hidden="true" />
							</button>
							<span
								aria-live="polite"
								aria-atomic="true"
								className="min-w-10 text-center font-mono text-[9px] tabular-nums text-muted-foreground/55"
							>
								{navigation.position} / {navigation.total}
							</span>
							<button
								type="button"
								onClick={navigation.onNext}
								disabled={!navigation.onNext}
								aria-label={navigation.nextLabel ?? "Next image"}
								className="inline-flex h-8 w-8 items-center justify-center text-muted-foreground/55 transition-colors hover:text-foreground disabled:opacity-25 disabled:hover:text-muted-foreground/55"
							>
								<ChevronRight className="h-4 w-4" aria-hidden="true" />
							</button>
							<span className="mx-1 h-4 border-l border-border" aria-hidden />
						</>
					)}
					<button
						type="button"
						onClick={() => setZoom("fit")}
						aria-label="Fit image"
						aria-pressed={zoom === "fit"}
						className={`border px-2 py-1 text-[10px] ${
							zoom === "fit"
								? "border-primary bg-primary text-primary-foreground"
								: "border-border bg-card text-muted-foreground hover:text-foreground"
						}`}
					>
						Fit
					</button>
					<button
						type="button"
						onClick={() => setZoom(1)}
						aria-label="View image at 1:1"
						aria-pressed={zoom === 1}
						className={`border px-2 py-1 text-[10px] ${
							zoom === 1
								? "border-primary bg-primary text-primary-foreground"
								: "border-border bg-card text-muted-foreground hover:text-foreground"
						}`}
					>
						1:1
					</button>
					<button
						type="button"
						onClick={() => changeZoom(-ZOOM_STEP)}
						disabled={numericZoom === MIN_ZOOM}
						aria-label="Zoom out"
						className="border border-border bg-card p-1 text-muted-foreground hover:text-foreground disabled:opacity-30"
					>
						<Minus className="h-3.5 w-3.5" />
					</button>
					<span
						className="w-10 text-center font-mono text-[9px] text-muted-foreground"
						aria-live="polite"
					>
						{numericZoom === null ? "Fit" : `${Math.round(numericZoom * 100)}%`}
					</span>
					<button
						type="button"
						onClick={() => changeZoom(ZOOM_STEP)}
						disabled={numericZoom === MAX_ZOOM}
						aria-label="Zoom in"
						className="border border-border bg-card p-1 text-muted-foreground hover:text-foreground disabled:opacity-30"
					>
						<Plus className="h-3.5 w-3.5" />
					</button>
					<a
						href={src}
						download={downloadFilename || imageFilename(src, alt)}
						aria-label="Download image"
						className="ml-1 border border-border bg-card p-1 text-muted-foreground hover:text-foreground"
					>
						<Download className="h-3.5 w-3.5" />
					</a>
				</fieldset>
				<div
					className="min-h-0 flex-1 overflow-auto"
					data-testid="image-viewer-viewport"
				>
					<div
						className={`flex items-center justify-center ${
							zoom === "fit" ? "h-full w-full" : "min-h-full min-w-full"
						}`}
						style={
							scaledSize
								? {
										width: scaledSize.width,
										height: scaledSize.height,
									}
								: undefined
						}
					>
						<img
							src={src}
							alt={alt}
							onLoad={(event) =>
								setNaturalSize({
									width: event.currentTarget.naturalWidth,
									height: event.currentTarget.naturalHeight,
								})
							}
							className={`shrink-0 object-contain shadow-2xl ${
								zoom === "fit" ? "max-h-full max-w-full" : "max-w-none"
							}`}
							style={
								scaledSize
									? {
											width: scaledSize.width,
											height: scaledSize.height,
										}
									: undefined
							}
						/>
					</div>
				</div>
				{alt && (
					<p className="max-w-full shrink-0 truncate text-center font-mono text-[11px] text-muted-foreground/70">
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
	imageClassName,
	displayWidth,
	downloadFilename,
	navigation,
}: {
	src: string;
	alt: string;
	className?: string;
	imageClassName?: string;
	displayWidth?: number;
	downloadFilename?: string;
	navigation?: ImageViewerNavigation;
}) {
	const [open, setOpen] = useState(false);
	const logicalWidth =
		typeof displayWidth === "number" &&
		Number.isFinite(displayWidth) &&
		displayWidth > 0
			? displayWidth
			: undefined;
	return (
		<>
			{/* A semantic button is invalid inside Markdown's paragraph element. */}
			{/* biome-ignore lint/a11y/useSemanticElements: inline interactive image must remain phrasing content */}
			<span
				role="button"
				tabIndex={0}
				className={`cursor-zoom-in p-0 border-0 bg-transparent${className ? ` ${className}` : ""}`}
				style={logicalWidth ? { width: logicalWidth } : undefined}
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
				<img
					src={src}
					alt={alt}
					className={`block max-w-full${imageClassName ? ` ${imageClassName}` : ""}`}
				/>
			</span>
			{open &&
				createPortal(
					<ImageViewerModal
						key={src}
						src={src}
						alt={alt}
						onClose={() => setOpen(false)}
						downloadFilename={downloadFilename}
						navigation={navigation}
					/>,
					document.body,
				)}
		</>
	);
}
