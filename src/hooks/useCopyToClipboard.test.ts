// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useCopyToClipboard } from "./useCopyToClipboard";

// ── Clipboard stub ────────────────────────────────────────────────────────────

const writeText = vi.fn();

beforeEach(() => {
	writeText.mockReset().mockResolvedValue(undefined);
	Object.defineProperty(navigator, "clipboard", {
		value: { writeText },
		writable: true,
		configurable: true,
	});
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
});

// ── tests ─────────────────────────────────────────────────────────────────────

describe("useCopyToClipboard", () => {
	it("copied is false initially", () => {
		const { result } = renderHook(() => useCopyToClipboard());
		expect(result.current.copied).toBe(false);
	});

	it("calls navigator.clipboard.writeText with provided text", async () => {
		const { result } = renderHook(() => useCopyToClipboard());
		await act(async () => {
			result.current.copy("hello world");
		});
		expect(writeText).toHaveBeenCalledWith("hello world");
	});

	it("sets copied to true after copy()", async () => {
		const { result } = renderHook(() => useCopyToClipboard());
		await act(async () => {
			result.current.copy("test");
		});
		expect(result.current.copied).toBe(true);
	});

	it("resets copied to false after 2000ms", async () => {
		const { result } = renderHook(() => useCopyToClipboard());
		await act(async () => {
			result.current.copy("test");
		});
		expect(result.current.copied).toBe(true);

		act(() => {
			vi.advanceTimersByTime(2000);
		});
		expect(result.current.copied).toBe(false);
	});

	it("remains true before 2000ms elapses", async () => {
		const { result } = renderHook(() => useCopyToClipboard());
		await act(async () => {
			result.current.copy("test");
		});
		act(() => {
			vi.advanceTimersByTime(1999);
		});
		expect(result.current.copied).toBe(true);
	});

	it("does not throw and copied stays false when clipboard rejects", async () => {
		writeText.mockRejectedValueOnce(new Error("Permission denied"));
		const { result } = renderHook(() => useCopyToClipboard());
		await act(async () => {
			result.current.copy("test");
		});
		expect(result.current.copied).toBe(false);
	});

	it("resets timer on repeated calls", async () => {
		const { result } = renderHook(() => useCopyToClipboard());

		await act(async () => {
			result.current.copy("first");
		});
		act(() => {
			vi.advanceTimersByTime(1500);
		});

		// Second copy restarts the 2s window
		await act(async () => {
			result.current.copy("second");
		});
		act(() => {
			vi.advanceTimersByTime(1500);
		});
		// Still true — timer was reset
		expect(result.current.copied).toBe(true);

		act(() => {
			vi.advanceTimersByTime(500);
		});
		expect(result.current.copied).toBe(false);
	});
});
