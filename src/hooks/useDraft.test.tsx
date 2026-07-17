// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useDraft } from "./useDraft";

beforeEach(() => {
	localStorage.clear();
	vi.useFakeTimers();
});

afterEach(() => {
	cleanup();
	vi.useRealTimers();
});

describe("useDraft", () => {
	it("restores a saved Watch draft", () => {
		localStorage.setItem("hlid:draft:watch", "unfinished thought");
		const { result } = renderHook(() =>
			useDraft({ existingSessionId: "watch", seededPrompt: undefined }),
		);
		expect(result.current.input).toBe("unfinished thought");
	});

	it("flushes the latest value when navigation beats the debounce", () => {
		const { result, unmount } = renderHook(() =>
			useDraft({ existingSessionId: "watch", seededPrompt: undefined }),
		);
		act(() => result.current.setInput("keep this"));
		unmount();
		expect(localStorage.getItem("hlid:draft:watch")).toBe("keep this");
	});

	it("does not resurrect a cleared draft during immediate navigation", () => {
		localStorage.setItem("hlid:draft:watch", "already sent");
		const { result, unmount } = renderHook(() =>
			useDraft({ existingSessionId: "watch", seededPrompt: undefined }),
		);
		act(() => result.current.setInput(""));
		unmount();
		expect(localStorage.getItem("hlid:draft:watch")).toBeNull();
	});
});
