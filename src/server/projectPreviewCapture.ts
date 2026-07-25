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
	full_page: boolean;
	captured_at: number;
	mime: "image/png";
	size_bytes: number;
	image_base64: string;
};

export const MAX_PROJECT_PREVIEW_FULL_PAGE_HEIGHT = 16_000;
export const MAX_PROJECT_PREVIEW_CAPTURE_BYTES = 10 * 1024 * 1024;
export const PROJECT_PREVIEW_CAPTURE_TIMEOUT_MS = 20_000;
export const MIN_PROJECT_PREVIEW_VIEWPORT_WIDTH = 240;
export const MAX_PROJECT_PREVIEW_VIEWPORT_WIDTH = 3_840;
export const MIN_PROJECT_PREVIEW_VIEWPORT_HEIGHT = 240;
export const MAX_PROJECT_PREVIEW_VIEWPORT_HEIGHT = 2_160;
export const MAX_PROJECT_PREVIEW_SCROLL_OFFSET = 100_000;

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
