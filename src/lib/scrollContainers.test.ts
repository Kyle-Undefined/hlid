// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
import {
	isRavenPath,
	ROUTE_SCROLL_RESTORATION_IDS,
	resetScrollAncestors,
	resetShellScroll,
	resetWindowScroll,
	SCROLL_TO_TOP_SELECTORS,
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

	it("gives each route scroller a distinct restoration identity", () => {
		const ids = Object.values(ROUTE_SCROLL_RESTORATION_IDS);
		expect(new Set(ids).size).toBe(ids.length);
	});

	it("declares both app and nested route reset targets", () => {
		expect(SCROLL_TO_TOP_SELECTORS).toEqual([
			'[data-scroll-to-top="app"]',
			'[data-scroll-to-top="route"]',
		]);
	});
});

describe("resetScrollAncestors", () => {
	it("clamps ancestors without moving the transcript itself", () => {
		const shell = document.createElement("div");
		const page = document.createElement("main");
		const transcript = document.createElement("div");
		shell.append(page);
		page.append(transcript);
		shell.scrollTop = 120;
		page.scrollTop = 80;
		page.scrollLeft = 10;
		transcript.scrollTop = 600;

		resetScrollAncestors(transcript, shell);

		expect(shell.scrollTop).toBe(0);
		expect(page.scrollTop).toBe(0);
		expect(page.scrollLeft).toBe(0);
		expect(transcript.scrollTop).toBe(600);
	});
});

describe("resetShellScroll", () => {
	it("clamps stray scroll on persistent shell containers", () => {
		const shell = document.createElement("div");
		const wrapper = document.createElement("div");
		shell.scrollTop = 140;
		wrapper.scrollTop = 90;
		wrapper.scrollLeft = 12;

		resetShellScroll([shell, null, wrapper]);

		expect(shell.scrollTop).toBe(0);
		expect(wrapper.scrollTop).toBe(0);
		expect(wrapper.scrollLeft).toBe(0);
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
