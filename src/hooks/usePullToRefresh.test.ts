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
});
