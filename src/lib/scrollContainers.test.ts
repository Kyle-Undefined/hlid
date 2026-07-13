// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
import {
	isRavenPath,
	keyboardInset,
	resetWindowScroll,
	scrollChatToBottom,
} from "./scrollContainers";

describe("route scroll containers", () => {
	it("recognizes Raven with or without a trailing slash", () => {
		expect(isRavenPath("/raven")).toBe(true);
		expect(isRavenPath("/raven/")).toBe(true);
		expect(isRavenPath("/ledger")).toBe(false);
	});

	it("scrolls the Raven transcript directly without scrollIntoView", () => {
		const element = document.createElement("div");
		Object.defineProperty(element, "scrollHeight", { value: 1_200 });
		element.scrollTo = vi.fn();

		scrollChatToBottom(element);

		expect(element.scrollTo).toHaveBeenCalledWith({
			top: 1_200,
			behavior: "smooth",
		});
	});
});

describe("keyboardInset", () => {
	it("reports the keyboard height when the visual viewport shrinks a lot", () => {
		expect(keyboardInset(500, 800)).toBe(300);
	});

	it("ignores small viewport differences like URL-bar collapse", () => {
		expect(keyboardInset(760, 800)).toBe(0);
	});

	it("returns 0 without a visual viewport", () => {
		expect(keyboardInset(undefined, 800)).toBe(0);
	});
});

describe("resetWindowScroll", () => {
	function fakeWindow(scrollY: number, docTop: number, bodyTop: number) {
		return {
			scrollY,
			scrollTo: vi.fn(),
			document: {
				documentElement: { scrollTop: docTop },
				body: { scrollTop: bodyTop },
			},
		} as unknown as Window;
	}

	it("clamps stray window scroll back to the top", () => {
		const win = fakeWindow(120, 120, 0);
		resetWindowScroll(win);
		expect(win.scrollTo).toHaveBeenCalledWith(0, 0);
		expect(win.document.documentElement.scrollTop).toBe(0);
		expect(win.document.body.scrollTop).toBe(0);
	});

	it("does nothing when already at the top", () => {
		const win = fakeWindow(0, 0, 0);
		resetWindowScroll(win);
		expect(win.scrollTo).not.toHaveBeenCalled();
	});
});
