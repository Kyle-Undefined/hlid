// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { THRESHOLD, usePullToRefresh } from "./usePullToRefresh";

function touch(type: string, y?: number): Event {
	const event = new Event(type, { bubbles: true, cancelable: true });
	Object.defineProperty(event, "touches", {
		value: y === undefined ? [] : [{ clientY: y }],
	});
	return event;
}

function makeScrollable(element: HTMLElement, scrollTop: number): void {
	element.style.overflowY = "auto";
	Object.defineProperties(element, {
		scrollHeight: { value: 400 },
		clientHeight: { value: 100 },
	});
	element.scrollTop = scrollTop;
}

function nestedScrollFixture() {
	const container = document.createElement("div");
	const forgeScroller = document.createElement("main");
	const historyScroller = document.createElement("div");
	const historyEntry = document.createElement("li");
	container.append(forgeScroller);
	forgeScroller.append(historyScroller);
	historyScroller.append(historyEntry);
	document.body.append(container);
	return { container, forgeScroller, historyScroller, historyEntry };
}

beforeEach(() => vi.useFakeTimers());

afterEach(() => {
	vi.useRealTimers();
	document.body.replaceChildren();
});

describe("usePullToRefresh", () => {
	it("clears a scheduled reload when the owner unmounts", () => {
		const container = document.createElement("div");
		document.body.append(container);
		const ref = { current: container };
		const { result, unmount } = renderHook(() => usePullToRefresh(ref));

		act(() => {
			container.dispatchEvent(touch("touchstart", 0));
			container.dispatchEvent(touch("touchmove", 300));
			container.dispatchEvent(touch("touchend"));
		});

		expect(result.current.pullY).toBeGreaterThanOrEqual(THRESHOLD);
		expect(result.current.isRefreshing).toBe(true);
		expect(vi.getTimerCount()).toBe(1);
		unmount();
		expect(vi.getTimerCount()).toBe(0);
	});

	it("resets a pull released below the refresh threshold", () => {
		const container = document.createElement("div");
		document.body.append(container);
		const ref = { current: container };
		const { result } = renderHook(() => usePullToRefresh(ref));

		act(() => {
			container.dispatchEvent(touch("touchstart", 0));
			container.dispatchEvent(touch("touchmove", 40));
		});
		expect(result.current.pullY).toBeGreaterThan(0);
		act(() => container.dispatchEvent(touch("touchcancel")));
		expect(result.current.pullY).toBe(0);
		expect(result.current.isRefreshing).toBe(false);
	});

	it("does not pull when a parent scroller has content above the viewport", () => {
		const { container, forgeScroller, historyScroller, historyEntry } =
			nestedScrollFixture();
		makeScrollable(forgeScroller, 48);
		makeScrollable(historyScroller, 0);

		const ref = { current: container };
		const { result } = renderHook(() => usePullToRefresh(ref));

		act(() => {
			historyEntry.dispatchEvent(touch("touchstart", 0));
			historyEntry.dispatchEvent(touch("touchmove", 120));
		});

		expect(result.current.pullY).toBe(0);
		expect(result.current.isRefreshing).toBe(false);

		forgeScroller.scrollTop = 0;
		act(() => {
			historyEntry.dispatchEvent(touch("touchstart", 0));
			historyEntry.dispatchEvent(touch("touchmove", 120));
		});

		expect(result.current.pullY).toBeGreaterThan(0);
	});

	it("does not start pulling after a nested scroller reaches the top mid-gesture", () => {
		const { container, forgeScroller, historyScroller, historyEntry } =
			nestedScrollFixture();
		makeScrollable(forgeScroller, 0);
		makeScrollable(historyScroller, 32);

		const ref = { current: container };
		const { result } = renderHook(() => usePullToRefresh(ref));

		act(() => {
			historyEntry.dispatchEvent(touch("touchstart", 0));
			historyEntry.dispatchEvent(touch("touchmove", 40));
		});
		expect(result.current.pullY).toBe(0);

		historyScroller.scrollTop = 0;
		act(() => {
			historyEntry.dispatchEvent(touch("touchmove", 300));
			historyEntry.dispatchEvent(touch("touchend"));
		});

		expect(result.current.pullY).toBe(0);
		expect(result.current.isRefreshing).toBe(false);
		expect(vi.getTimerCount()).toBe(0);
	});
});
