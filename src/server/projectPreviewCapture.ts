export const PROJECT_PREVIEW_CAPTURE_VIEWPORTS = {
	desktop: { width: 1440, height: 1000 },
	tablet: { width: 768, height: 1024 },
	mobile: { width: 390, height: 844 },
} as const;

export type ProjectPreviewCaptureViewport =
	keyof typeof PROJECT_PREVIEW_CAPTURE_VIEWPORTS;

export type ProjectPreviewCaptureSize = {
	width: number;
	height: number;
};

export type ProjectPreviewCaptureInput = {
	previewId: string;
	sessionId: string;
	port: number;
	path: string;
	viewport: ProjectPreviewCaptureViewport;
	size?: ProjectPreviewCaptureSize;
	scrollX?: number;
	scrollY?: number;
	fullPage: boolean;
};

export type ProjectPreviewCaptureResult = {
	preview_id: string;
	session_id: string;
	path: string;
	viewport: ProjectPreviewCaptureViewport;
	width: number;
	height: number;
	pixel_width?: number;
	pixel_height?: number;
	device_scale_factor?: number;
	pixel_ratio?: number;
	full_page: boolean;
	captured_at: number;
	mime: "image/png";
	size_bytes: number;
	image_base64: string;
};

export const MAX_PROJECT_PREVIEW_FULL_PAGE_HEIGHT = 16_000;
export const MAX_PROJECT_PREVIEW_CAPTURE_BYTES = 10 * 1024 * 1024;
export const PROJECT_PREVIEW_CAPTURE_DEVICE_SCALE_FACTOR = 2;
export const MAX_PROJECT_PREVIEW_CAPTURE_PIXELS = 12_000_000;
export const MAX_PROJECT_PREVIEW_CAPTURE_PIXEL_DIMENSION = 16_384;
export const MIN_PROJECT_PREVIEW_CAPTURE_SCALE = 0.1;
export const MAX_PROJECT_PREVIEW_CAPTURE_ATTEMPTS = 4;
export const PROJECT_PREVIEW_CAPTURE_TIMEOUT_MS = 20_000;
export const MIN_PROJECT_PREVIEW_VIEWPORT_WIDTH = 240;
export const MAX_PROJECT_PREVIEW_VIEWPORT_WIDTH = 3_840;
export const MIN_PROJECT_PREVIEW_VIEWPORT_HEIGHT = 240;
export const MAX_PROJECT_PREVIEW_VIEWPORT_HEIGHT = 2_160;
export const MAX_PROJECT_PREVIEW_SCROLL_OFFSET = 100_000;

export type ProjectPreviewPngDimensions = {
	width: number;
	height: number;
};

export function projectPreviewCaptureScale(
	width: number,
	height: number,
	deviceScaleFactor = PROJECT_PREVIEW_CAPTURE_DEVICE_SCALE_FACTOR,
): number {
	if (
		!Number.isFinite(width) ||
		!Number.isFinite(height) ||
		width <= 0 ||
		height <= 0
	) {
		return 1;
	}
	const scaledWidth = width * deviceScaleFactor;
	const scaledHeight = height * deviceScaleFactor;
	return Math.min(
		1,
		Math.sqrt(
			MAX_PROJECT_PREVIEW_CAPTURE_PIXELS / (scaledWidth * scaledHeight),
		),
		MAX_PROJECT_PREVIEW_CAPTURE_PIXEL_DIMENSION / scaledWidth,
		MAX_PROJECT_PREVIEW_CAPTURE_PIXEL_DIMENSION / scaledHeight,
	);
}

export function nextProjectPreviewCaptureScale(
	currentScale: number,
	sizeBytes: number,
): number {
	const byteScale =
		Math.sqrt(MAX_PROJECT_PREVIEW_CAPTURE_BYTES / sizeBytes) * 0.9;
	const reducedScale = currentScale * Math.min(0.8, byteScale);
	return currentScale > MIN_PROJECT_PREVIEW_CAPTURE_SCALE
		? Math.max(MIN_PROJECT_PREVIEW_CAPTURE_SCALE, reducedScale)
		: reducedScale;
}

export function readProjectPreviewPngDimensions(
	png: Buffer,
): ProjectPreviewPngDimensions {
	if (
		png.byteLength < 24 ||
		png[0] !== 0x89 ||
		png.subarray(1, 4).toString("ascii") !== "PNG" ||
		png.subarray(12, 16).toString("ascii") !== "IHDR"
	) {
		throw new Error("Project Preview browser returned an invalid PNG.");
	}
	const width = png.readUInt32BE(16);
	const height = png.readUInt32BE(20);
	if (width <= 0 || height <= 0) {
		throw new Error("Project Preview browser returned an invalid PNG size.");
	}
	return { width, height };
}

export function normalizeProjectPreviewCapturePath(path: string): string {
	const trimmed = path.trim();
	if (
		!trimmed.startsWith("/") ||
		trimmed.startsWith("//") ||
		trimmed.includes("\\")
	) {
		throw new Error("Capture path must start with a single slash.");
	}
	const url = new URL(trimmed, "http://127.0.0.1");
	if (url.origin !== "http://127.0.0.1") {
		throw new Error("Capture path must remain on the Project Preview.");
	}
	return `${url.pathname}${url.search}${url.hash}`;
}

export function isAllowedProjectPreviewBrowserUrl(
	value: string,
	port: number,
): boolean {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		return false;
	}
	if (url.protocol === "data:" || url.protocol === "blob:") return true;
	if (!["http:", "https:", "ws:", "wss:"].includes(url.protocol)) {
		return false;
	}
	const loopback =
		url.hostname === "127.0.0.1" ||
		url.hostname === "localhost" ||
		url.hostname === "[::1]";
	const effectivePort =
		url.port ||
		(url.protocol === "https:" || url.protocol === "wss:" ? "443" : "80");
	return loopback && effectivePort === String(port);
}
