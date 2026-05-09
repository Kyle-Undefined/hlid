// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as privacyStore from "#/hooks/privacyStore";
import { AssistantMsg } from "./AssistantMsg";
import type { AssistantMessage } from "./chatReducer";

afterEach(cleanup);

function makeMsg(overrides?: Partial<AssistantMessage>): AssistantMessage {
	return {
		id: "msg-1",
		role: "assistant",
		text: "hello world",
		toolEvents: [],
		streaming: false,
		cost: null,
		...overrides,
	};
}

beforeEach(() => {
	privacyStore.__resetForTesting();
	Object.defineProperty(navigator, "clipboard", {
		value: { writeText: vi.fn().mockResolvedValue(undefined) },
		configurable: true,
	});
});

describe("AssistantMsg", () => {
	describe("CopyButton mobile visibility", () => {
		it("copy button has [@media(hover:none)]:opacity-100 class so it shows on touch devices", () => {
			render(<AssistantMsg message={makeMsg()} />);
			const btn = screen.getByRole("button", { name: /copy/i });
			expect(btn.className).toContain("[@media(hover:none)]:opacity-100");
		});

		it("copy button not rendered when streaming", () => {
			render(
				<AssistantMsg message={makeMsg({ streaming: true, text: "hi" })} />,
			);
			expect(screen.queryByRole("button", { name: /copy/i })).toBeNull();
		});

		it("copy button not rendered when no text", () => {
			render(<AssistantMsg message={makeMsg({ text: "" })} />);
			expect(screen.queryByRole("button", { name: /copy/i })).toBeNull();
		});
	});
});
