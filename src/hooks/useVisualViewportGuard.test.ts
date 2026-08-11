// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useVisualViewportGuard } from "./useVisualViewportGuard";

class VisualViewportStub extends EventTarget {
	height = 720;
	scale = 1;
}

let visualViewport: VisualViewportStub;
let animationFrames: Array<{ callback: FrameRequestCallback; id: number }>;
let nextAnimationFrameId: number;
let windowScrollY: number;

function flushAnimationFrames(): void {
	while (animationFrames.length > 0) {
		const frames = animationFrames;
		animationFrames = [];
		for (const { callback } of frames) callback(performance.now());
	}
}

beforeEach(() => {
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
	visualViewport = new VisualViewportStub();
	animationFrames = [];
	nextAnimationFrameId = 1;
	windowScrollY = 0;
	Object.defineProperty(window, "visualViewport", {
		configurable: true,
		value: visualViewport,
	});
	Object.defineProperty(window, "scrollY", {
		configurable: true,
		get: () => windowScrollY,
	});
	vi.spyOn(window, "scrollTo").mockImplementation(
		(optionsOrX?: ScrollToOptions | number, y?: number) => {
			windowScrollY =
				typeof optionsOrX === "number" ? (y ?? 0) : (optionsOrX?.top ?? 0);
		},
	);
	vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
		const id = nextAnimationFrameId++;
		animationFrames.push({ callback, id });
		return id;
	});
	vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id) => {
		animationFrames = animationFrames.filter((frame) => frame.id !== id);
	});
});

afterEach(() => {
	document.documentElement.style.removeProperty("--app-height");
	document.documentElement.scrollTop = 0;
	document.body.scrollTop = 0;
	vi.restoreAllMocks();
	vi.useRealTimers();
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
		act(flushAnimationFrames);

		act(() => {
			visualViewport.height = 640;
			visualViewport.dispatchEvent(new Event("resize"));
		});

		expect(
			document.documentElement.style.getPropertyValue("--app-height"),
		).toBe("640px");
	});

	it("clamps delayed shell scrolling after a same-path Forge query transition", () => {
		const shell = document.createElement("div");
		const wrapper = document.createElement("div");
		const shellRef = { current: shell };
		const wrapperRef = { current: wrapper };
		const { rerender } = renderHook(
			({ routeKey }) =>
				useVisualViewportGuard(routeKey, [shellRef, wrapperRef]),
			{
				initialProps: {
					routeKey: "/forge?category=integrations",
				},
			},
		);
		act(flushAnimationFrames);

		rerender({
			routeKey: "/forge?category=integrations&section=opencode-acp&view=acp",
		});
		act(flushAnimationFrames);
		act(() => vi.advanceTimersByTime(200));

		// ACP destination focus runs after the route's immediate/rAF clamps and can
		// scroll overflow-hidden ancestors, shifting the whole app shell upward.
		windowScrollY = 132;
		document.documentElement.scrollTop = 132;
		document.body.scrollTop = 132;
		shell.scrollTop = 132;
		shell.scrollLeft = 6;
		wrapper.scrollTop = 132;
		wrapper.scrollLeft = 6;
		act(() => vi.advanceTimersByTime(49));
		expect(window.scrollY).toBe(132);
		expect(shell.scrollTop).toBe(132);
		expect(wrapper.scrollTop).toBe(132);

		act(() => vi.advanceTimersByTime(1));
		expect(window.scrollY).toBe(0);
		expect(document.documentElement.scrollTop).toBe(0);
		expect(document.body.scrollTop).toBe(0);
		expect(shell.scrollTop).toBe(0);
		expect(shell.scrollLeft).toBe(0);
		expect(wrapper.scrollTop).toBe(0);
		expect(wrapper.scrollLeft).toBe(0);
	});

	it("keeps the shell matched to the viewport when the keyboard opens", () => {
		renderHook(() => useVisualViewportGuard("/forge"));
		act(flushAnimationFrames);

		act(() => {
			visualViewport.height = 410;
			visualViewport.dispatchEvent(new Event("resize"));
		});

		expect(
			document.documentElement.style.getPropertyValue("--app-height"),
		).toBe("410px");
	});

	it("does not resize the shell while the user is pinch-zoomed", () => {
		renderHook(() => useVisualViewportGuard("/forge"));
		act(flushAnimationFrames);

		act(() => {
			visualViewport.scale = 1.5;
			visualViewport.height = 480;
			visualViewport.dispatchEvent(new Event("resize"));
		});

		expect(
			document.documentElement.style.getPropertyValue("--app-height"),
		).toBe("720px");
	});
});
