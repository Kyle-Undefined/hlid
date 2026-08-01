// @vitest-environment jsdom
import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
	within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as privacyStore from "#/hooks/privacyStore";
import type { ToolEventMessage } from "#/server/protocol";
import {
	HlidVisualizationToolBlock,
	isHlidVisualizationToolEvent,
	parseHlidVisualizationResult,
	VISUALIZATION_OFFSCREEN_GRACE_MS,
} from "./HlidVisualizationToolBlock";

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
	cleanup();
});
beforeEach(() => privacyStore.__resetForTesting());

const RESULT = JSON.stringify({
	type: "hlid_visualization",
	attachment_id: "0591f46e-b4b3-4bfb-9aa2-14f65d625209",
	filename: "latency-explorer.html",
	title: "Latency explorer",
});

function event(overrides: Partial<ToolEventMessage> = {}): ToolEventMessage {
	return {
		type: "tool_event",
		id: "visualization-tool-1",
		name: "mcp__hlid__create_visualization",
		input: {},
		result: RESULT,
		...overrides,
	};
}

describe("parseHlidVisualizationResult", () => {
	it("accepts the compact Hlid visualization result", () => {
		expect(parseHlidVisualizationResult(RESULT)).toEqual({
			type: "hlid_visualization",
			attachment_id: "0591f46e-b4b3-4bfb-9aa2-14f65d625209",
			filename: "latency-explorer.html",
			title: "Latency explorer",
		});
		expect(isHlidVisualizationToolEvent(event())).toBe(true);
		expect(
			isHlidVisualizationToolEvent(event({ name: "create_visualization" })),
		).toBe(true);
	});

	it.each([
		"not json",
		JSON.stringify({ type: "something_else" }),
		JSON.stringify({
			type: "hlid_visualization",
			attachment_id: "../../secret",
			filename: "latency-explorer.html",
			title: "Latency explorer",
		}),
		JSON.stringify({
			type: "hlid_visualization",
			attachment_id: "attachment-1",
			filename: "../latency-explorer.html",
			title: "Latency explorer",
		}),
		JSON.stringify({
			type: "hlid_visualization",
			attachment_id: "attachment-1",
			filename: "latency-explorer.html",
			title: " ",
		}),
	] as const)("rejects an invalid or unsafe result: %s", (result) => {
		expect(parseHlidVisualizationResult(result)).toBeNull();
	});

	it("recognizes an errored bridge result for bounded failure rendering", () => {
		expect(isHlidVisualizationToolEvent(event({ isError: true }))).toBe(true);
	});

	it("does not trust a visualization-shaped result from another tool", () => {
		expect(
			isHlidVisualizationToolEvent(event({ name: "mcp__other__render" })),
		).toBe(false);
	});
});

describe("HlidVisualizationToolBlock", () => {
	it("renders the retained attachment in a script-only sandbox", () => {
		render(
			<HlidVisualizationToolBlock
				event={event()}
				sessionId="session-1"
				expanded
			/>,
		);

		const frame = screen.getByTitle("Latency explorer");
		expect(frame.tagName).toBe("IFRAME");
		expect(frame.getAttribute("src")).toBe(
			"/api/attachments/0591f46e-b4b3-4bfb-9aa2-14f65d625209/raw?visualization_session_id=session-1",
		);
		expect(frame.getAttribute("sandbox")).toBe("allow-scripts");
		expect(frame.getAttribute("referrerpolicy")).toBe("no-referrer");
		expect(frame.getAttribute("scrolling")).toBe("yes");
		expect(frame.style.touchAction).toBe("pan-x pan-y pinch-zoom");
		expect(frame.className).toContain("h-full");
		expect(frame.className).toContain("w-full");
		expect(frame.style.transform).toBe("");
		expect(frame.className).toContain("[-webkit-overflow-scrolling:touch]");
		expect(screen.getByTestId("visualization-viewport").className).toContain(
			"h-[min(70svh,40rem)]",
		);
		expect(screen.queryByText(RESULT)).toBeNull();
	});

	it("sends bounded zoom into the visualization document", () => {
		render(
			<HlidVisualizationToolBlock
				event={event()}
				sessionId="session-1"
				expanded
			/>,
		);
		const frame = screen.getByTitle("Latency explorer");
		const postMessage = vi.fn();
		Object.defineProperty(frame, "contentWindow", {
			value: { postMessage },
			configurable: true,
		});

		fireEvent.click(
			screen.getByRole("button", { name: "Zoom visualization out" }),
		);
		expect(screen.getByText("90%")).not.toBeNull();
		expect(postMessage).toHaveBeenLastCalledWith(
			{
				type: "hlid:visualization-zoom",
				version: 1,
				zoom: 0.9,
			},
			"*",
		);
		expect(frame.style.transform).toBe("");

		fireEvent.load(frame);
		expect(postMessage).toHaveBeenLastCalledWith(
			{
				type: "hlid:visualization-zoom",
				version: 1,
				zoom: 0.9,
			},
			"*",
		);

		fireEvent.click(
			screen.getByRole("button", { name: "Reset visualization zoom" }),
		);
		expect(screen.getByText("100%")).not.toBeNull();
		expect(postMessage).toHaveBeenLastCalledWith(
			{
				type: "hlid:visualization-zoom",
				version: 1,
				zoom: 1,
			},
			"*",
		);
	});

	it("maximizes with one iframe and restores it inline", () => {
		render(
			<HlidVisualizationToolBlock
				event={event()}
				sessionId="session-1"
				expanded
			/>,
		);
		const inlineFrame = screen.getByTitle("Latency explorer");

		fireEvent.click(
			screen.getByRole("button", { name: "Maximize visualization" }),
		);
		const dialog = screen.getByRole("dialog", {
			name: "Visualization viewer: Latency explorer",
		});
		expect(dialog.getAttribute("aria-modal")).toBe("true");
		expect(screen.getAllByTitle("Latency explorer")).toHaveLength(1);
		expect(screen.getByTitle("Latency explorer")).toBe(inlineFrame);
		expect(
			within(dialog).getByRole("button", {
				name: "Zoom visualization out",
			}),
		).not.toBeNull();

		fireEvent.click(
			within(dialog).getByRole("button", {
				name: "Restore inline visualization",
			}),
		);
		expect(screen.queryByRole("dialog")).toBeNull();
		expect(screen.getAllByTitle("Latency explorer")).toHaveLength(1);
		expect(screen.getByTitle("Latency explorer")).toBe(inlineFrame);
		expect(
			screen.getByRole("button", { name: "Maximize visualization" }),
		).not.toBeNull();
	});

	it("keeps the iframe unmounted while collapsed", () => {
		const onToggle = vi.fn();
		render(
			<HlidVisualizationToolBlock
				event={event()}
				sessionId="session-1"
				onToggle={onToggle}
			/>,
		);

		expect(screen.queryByTitle("Latency explorer")).toBeNull();
		const toggle = screen.getByRole("button", {
			name: "Expand visualization: Latency explorer",
		});
		expect(toggle.getAttribute("aria-expanded")).toBe("false");
		fireEvent.click(toggle);
		expect(onToggle).toHaveBeenCalledOnce();
	});

	it("collapses after remaining fully offscreen for the grace period", () => {
		vi.useFakeTimers();
		let intersectionCallback: IntersectionObserverCallback | undefined;
		vi.stubGlobal(
			"IntersectionObserver",
			class {
				constructor(callback: IntersectionObserverCallback) {
					intersectionCallback = callback;
				}
				observe() {}
				disconnect() {}
			},
		);
		const onInactive = vi.fn();
		render(
			<HlidVisualizationToolBlock
				event={event()}
				sessionId="session-1"
				expanded
				onInactive={onInactive}
			/>,
		);

		act(() => {
			intersectionCallback?.(
				[{ isIntersecting: false } as IntersectionObserverEntry],
				{} as IntersectionObserver,
			);
			vi.advanceTimersByTime(VISUALIZATION_OFFSCREEN_GRACE_MS - 1);
		});
		expect(onInactive).not.toHaveBeenCalled();

		act(() => {
			intersectionCallback?.(
				[{ isIntersecting: true } as IntersectionObserverEntry],
				{} as IntersectionObserver,
			);
			vi.advanceTimersByTime(VISUALIZATION_OFFSCREEN_GRACE_MS);
		});
		expect(onInactive).not.toHaveBeenCalled();

		act(() => {
			intersectionCallback?.(
				[{ isIntersecting: false } as IntersectionObserverEntry],
				{} as IntersectionObserver,
			);
			vi.advanceTimersByTime(VISUALIZATION_OFFSCREEN_GRACE_MS);
		});
		expect(onInactive).toHaveBeenCalledOnce();
	});

	it("uses the same grace period while the document remains hidden", () => {
		vi.useFakeTimers();
		vi.stubGlobal(
			"IntersectionObserver",
			class {
				observe() {}
				disconnect() {}
			},
		);
		vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
		const onInactive = vi.fn();
		render(
			<HlidVisualizationToolBlock
				event={event()}
				sessionId="session-1"
				expanded
				onInactive={onInactive}
			/>,
		);

		act(() => {
			document.dispatchEvent(new Event("visibilitychange"));
			vi.advanceTimersByTime(VISUALIZATION_OFFSCREEN_GRACE_MS);
		});
		expect(onInactive).toHaveBeenCalledOnce();
	});

	it("shows the permission receipt without exposing the dynamic result", () => {
		render(
			<HlidVisualizationToolBlock
				event={event()}
				permissionLabel="APPROVED"
				sessionId="session-1"
			/>,
		);

		expect(screen.getByText("APPROVED")).not.toBeNull();
		expect(screen.queryByText(RESULT)).toBeNull();
	});

	it("shows bounded states instead of raw malformed bridge output", () => {
		const { rerender } = render(
			<HlidVisualizationToolBlock
				event={event({ result: undefined })}
				sessionId="session-1"
			/>,
		);
		expect(screen.getByText("Creating visualization…")).not.toBeNull();

		rerender(
			<HlidVisualizationToolBlock
				event={event({ result: "bad json" })}
				sessionId="session-1"
			/>,
		);
		expect(screen.getByText("Visualization unavailable")).not.toBeNull();
		expect(screen.queryByText("bad json")).toBeNull();
	});

	it("shows the worker's bounded recovery status while creation is pending", () => {
		render(
			<HlidVisualizationToolBlock
				event={event({
					result: undefined,
					subagent: {
						provider: "codex",
						agentId: "visualize-worker-1",
						label: "Windows Visualize",
						status: "running",
						currentStep:
							"Windows sandbox launch failed; Visualize is retrying…",
						startedAtMs: 1,
					},
				})}
				sessionId="session-1"
			/>,
		);

		expect(
			screen.getByText("Windows sandbox launch failed; Visualize is retrying…"),
		).not.toBeNull();
	});

	it("hides failed bridge details behind a bounded state", () => {
		render(
			<HlidVisualizationToolBlock
				event={event({ result: "internal protocol details", isError: true })}
				sessionId="session-1"
			/>,
		);

		expect(screen.getByText("Visualization failed")).not.toBeNull();
		expect(screen.queryByText("internal protocol details")).toBeNull();
	});
});
