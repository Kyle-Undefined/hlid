import { describe, expect, it } from "vitest";
import {
	isAllowedProjectPreviewBrowserUrl,
	normalizeProjectPreviewCapturePath,
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
		expect(
			isAllowedProjectPreviewBrowserUrl("http://127.0.0.1:5173/app", 5173),
		).toBe(true);
		expect(
			isAllowedProjectPreviewBrowserUrl("ws://localhost:5173/hmr", 5173),
		).toBe(true);
		expect(isAllowedProjectPreviewBrowserUrl("data:text/plain,ok", 5173)).toBe(
			true,
		);
		expect(
			isAllowedProjectPreviewBrowserUrl("http://127.0.0.1:5174/app", 5173),
		).toBe(false);
		expect(
			isAllowedProjectPreviewBrowserUrl("https://example.com/app", 5173),
		).toBe(false);
		expect(isAllowedProjectPreviewBrowserUrl("file:///tmp/secret", 5173)).toBe(
			false,
		);
	});
});
