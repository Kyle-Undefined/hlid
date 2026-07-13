// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
import { isRavenPath, scrollChatToBottom } from "./scrollContainers";

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
