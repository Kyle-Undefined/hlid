// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useVisualViewportGuard } from "./useVisualViewportGuard";

class VisualViewportStub extends EventTarget {
	height = 720;
	scale = 1;
}

let visualViewport: VisualViewportStub;

beforeEach(() => {
	visualViewport = new VisualViewportStub();
	Object.defineProperty(window, "visualViewport", {
		configurable: true,
		value: visualViewport,
	});
	vi.spyOn(window, "requestAnimationFrame").mockImplementation(() => 1);
	vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});
});

afterEach(() => {
	document.documentElement.style.removeProperty("--app-height");
	vi.restoreAllMocks();
});

describe("useVisualViewportGuard", () => {
	it("pins the shell to the visible viewport immediately on startup", () => {
		const { unmount } = renderHook(() => useVisualViewportGuard("/"));

		expect(
			document.documentElement.style.getPropertyValue("--app-height"),
		).toBe("720px");

		unmount();
		expect(
			document.documentElement.style.getPropertyValue("--app-height"),
		).toBe("");
	});

	it("tracks viewport changes without requiring an input focus", () => {
		renderHook(() => useVisualViewportGuard("/"));

		act(() => {
			visualViewport.height = 640;
			visualViewport.dispatchEvent(new Event("resize"));
		});

		expect(
			document.documentElement.style.getPropertyValue("--app-height"),
		).toBe("640px");
	});
});
