import { describe, expect, it } from "vitest";
import {
	isAllowedProjectPreviewBrowserOrigin,
	isAllowedWebBrowserRequest,
	MAX_PROJECT_PREVIEW_CAPTURE_BYTES,
	MAX_PROJECT_PREVIEW_CAPTURE_PIXEL_DIMENSION,
	MAX_PROJECT_PREVIEW_CAPTURE_PIXELS,
	nextProjectPreviewCaptureScale,
	normalizeProjectPreviewCapturePath,
	normalizeWebBrowserUrl,
	PROJECT_PREVIEW_CAPTURE_DEVICE_SCALE_FACTOR,
	projectPreviewCaptureScale,
	readProjectPreviewPngDimensions,
} from "./projectPreviewCapture";

describe("Project Preview capture boundaries", () => {
	it("normalizes only Preview-local paths", () => {
		expect(normalizeProjectPreviewCapturePath("/settings?tab=ui")).toBe(
			"/settings?tab=ui",
		);
		expect(() => normalizeProjectPreviewCapturePath("//evil.test")).toThrow(
			"single slash",
		);
		expect(() =>
			normalizeProjectPreviewCapturePath("https://evil.test"),
		).toThrow("single slash");
		expect(() => normalizeProjectPreviewCapturePath("/..\\secret")).toThrow(
			"single slash",
		);
	});

	it("allows only the exact loopback Preview port and local data", () => {
		const origin = "http://127.0.0.1:5173";
		expect(
			isAllowedProjectPreviewBrowserOrigin("http://127.0.0.1:5173/app", origin),
		).toBe(true);
		expect(
			isAllowedProjectPreviewBrowserOrigin("data:text/plain,ok", origin),
		).toBe(true);
		expect(
			isAllowedProjectPreviewBrowserOrigin("http://127.0.0.1:5174/app", origin),
		).toBe(false);
		expect(
			isAllowedProjectPreviewBrowserOrigin("https://example.com/app", origin),
		).toBe(false);
		expect(
			isAllowedProjectPreviewBrowserOrigin("file:///tmp/secret", origin),
		).toBe(false);
	});

	it("pins agent-browser traffic to the exact private relay origin", () => {
		const origin = "http://hlid-a1b2.localhost:6173";
		expect(
			isAllowedProjectPreviewBrowserOrigin(
				"http://hlid-a1b2.localhost:6173/settings",
				origin,
			),
		).toBe(true);
		expect(
			isAllowedProjectPreviewBrowserOrigin(
				"http://hlid-a1b2.localhost:6174/settings",
				origin,
			),
		).toBe(false);
		expect(
			isAllowedProjectPreviewBrowserOrigin(
				"http://hlid-other.localhost:6173/settings",
				origin,
			),
		).toBe(false);
	});

	it("allows public Browser URLs while keeping private access on one approved origin", () => {
		expect(normalizeWebBrowserUrl("https://example.com/docs")).toBe(
			"https://example.com/docs",
		);
		expect(() => normalizeWebBrowserUrl("ftp://example.com/file")).toThrow(
			/HTTP or HTTPS/,
		);
		expect(() =>
			normalizeWebBrowserUrl("https://user:pass@example.com/"),
		).toThrow(/credentials/);
		expect(
			isAllowedWebBrowserRequest("https://cdn.example.net/app.js", null),
		).toBe(true);
		expect(isAllowedWebBrowserRequest("http://127.0.0.1:8080/app", null)).toBe(
			false,
		);
		expect(
			isAllowedWebBrowserRequest(
				"http://127.0.0.1:8080/app",
				"http://127.0.0.1:8080",
			),
		).toBe(true);
		expect(
			isAllowedWebBrowserRequest(
				"http://127.0.0.1:8081/app",
				"http://127.0.0.1:8080",
			),
		).toBe(false);
		expect(isAllowedWebBrowserRequest("file:///tmp/secret", null)).toBe(false);
		expect(isAllowedWebBrowserRequest("data:text/plain,ok", null)).toBe(true);
	});

	it("keeps named viewport captures at 2x and bounds tall full-page output", () => {
		expect(projectPreviewCaptureScale(1440, 1000)).toBe(1);

		const scale = projectPreviewCaptureScale(1440, 16_000);
		const pixelWidth =
			1440 * PROJECT_PREVIEW_CAPTURE_DEVICE_SCALE_FACTOR * scale;
		const pixelHeight =
			16_000 * PROJECT_PREVIEW_CAPTURE_DEVICE_SCALE_FACTOR * scale;
		expect(scale).toBeLessThan(1);
		expect(pixelWidth * pixelHeight).toBeCloseTo(
			MAX_PROJECT_PREVIEW_CAPTURE_PIXELS,
		);
		expect(Math.max(pixelWidth, pixelHeight)).toBeLessThanOrEqual(
			MAX_PROJECT_PREVIEW_CAPTURE_PIXEL_DIMENSION,
		);
	});

	it("reduces an oversized PNG capture instead of raising the byte cap", () => {
		const next = nextProjectPreviewCaptureScale(
			1,
			MAX_PROJECT_PREVIEW_CAPTURE_BYTES * 4,
		);
		expect(next).toBeCloseTo(0.45);

		const alreadyBounded = nextProjectPreviewCaptureScale(
			0.05,
			MAX_PROJECT_PREVIEW_CAPTURE_BYTES * 4,
		);
		expect(alreadyBounded).toBeCloseTo(0.0225);
		expect(alreadyBounded).toBeLessThan(0.05);
	});

	it("reads exact bitmap dimensions from the PNG header", () => {
		const png = Buffer.alloc(24);
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png);
		png.write("IHDR", 12, "ascii");
		png.writeUInt32BE(2880, 16);
		png.writeUInt32BE(2000, 20);

		expect(readProjectPreviewPngDimensions(png)).toEqual({
			width: 2880,
			height: 2000,
		});
		expect(() =>
			readProjectPreviewPngDimensions(Buffer.from("not png")),
		).toThrow("invalid PNG");
	});
});
