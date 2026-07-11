// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as privacyStore from "#/hooks/privacyStore";
import type { UserMessage } from "./chatReducer";
import { UserMsg } from "./UserMsg";

afterEach(cleanup);

function makeMsg(overrides?: Partial<UserMessage>): UserMessage {
	return {
		id: "msg-1",
		role: "user",
		text: "hello world",
		attachments: [],
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

describe("UserMsg", () => {
	it("keeps the normal ME label while a promoted queued message is running", () => {
		render(<UserMsg message={makeMsg()} queueState={{ kind: "running" }} />);
		expect(screen.getByText("ME")).toBeTruthy();
		expect(screen.queryByText("RUN")).toBeNull();
	});

	describe("CopyButton mobile visibility", () => {
		it("copy button has [@media(hover:none)]:opacity-100 class so it shows on touch devices", () => {
			render(<UserMsg message={makeMsg()} />);
			const btn = screen.getByRole("button", { name: /copy/i });
			expect(btn.className).toContain("[@media(hover:none)]:opacity-100");
		});

		it("copy button not rendered when no text", () => {
			render(<UserMsg message={makeMsg({ text: "" })} />);
			expect(screen.queryByRole("button", { name: /copy/i })).toBeNull();
		});
	});
});
