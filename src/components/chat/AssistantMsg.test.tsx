// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as privacyStore from "#/hooks/privacyStore";
import { AssistantMsg, normalizeMd } from "./AssistantMsg";
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

describe("normalizeMd", () => {
	it("inserts space after closer when preceded by punctuation and followed by word char", () => {
		expect(normalizeMd("**foo:**Yes")).toBe("**foo:** Yes");
	});

	it("handles real-world agent output with parens and colon", () => {
		expect(normalizeMd("**hlid (your app):**Yes. Bin")).toBe(
			"**hlid (your app):** Yes. Bin",
		);
	});

	it("handles other trailing punctuation (! . ))", () => {
		expect(normalizeMd("**foo!**Yes")).toBe("**foo!** Yes");
		expect(normalizeMd("**foo.**Yes")).toBe("**foo.** Yes");
		expect(normalizeMd("**foo)**Yes")).toBe("**foo)** Yes");
	});

	it("does not modify already-correct intra-word strong", () => {
		expect(normalizeMd("**foo**Yes")).toBe("**foo**Yes");
	});

	it("does not modify strong followed by space", () => {
		expect(normalizeMd("**foo:** Yes")).toBe("**foo:** Yes");
	});

	it("leaves plain text unchanged", () => {
		expect(normalizeMd("regular text with no markdown")).toBe(
			"regular text with no markdown",
		);
	});

	it("normalizes multiple occurrences on the same line", () => {
		expect(normalizeMd("**a:**b **c:**d")).toBe("**a:** b **c:** d");
	});

	it("does not touch closer when followed by punctuation or whitespace", () => {
		expect(normalizeMd("**foo:**, more")).toBe("**foo:**, more");
		expect(normalizeMd("**foo:**\nbar")).toBe("**foo:**\nbar");
	});

	// Regression: previously a greedy '** text **' rule collapsed two valid
	// adjacent strong blocks into one mangled span by pairing the closer of the
	// first with the opener of the second.
	it("preserves multiple adjacent strong blocks separated by sentences", () => {
		const src =
			"**Visual review:** border alignment trick, correct. **No DRY violations:** ok. **Summary:** done";
		expect(normalizeMd(src)).toBe(src);
	});

	it("preserves structured agent output with code spans between strongs", () => {
		const src =
			"**Fix nit:** All 9 `normalizeMd` tests pass. **Summary:** done";
		expect(normalizeMd(src)).toBe(src);
	});

	it("preserves a strong block followed by an unpaired ** marker", () => {
		expect(normalizeMd("**Summary:** done **")).toBe("**Summary:** done **");
	});
});

describe("AssistantMsg", () => {
	it("keeps active subagent cards below later parent tool calls and text", () => {
		const { rerender } = render(
			<AssistantMsg
				message={makeMsg({
					toolEvents: [
						{
							type: "tool_event",
							id: "subagent-1",
							name: "spawn_agent",
							input: {},
							subagent: {
								provider: "codex",
								agentId: "child-1",
								name: "Explorer",
								status: "running",
								startedAtMs: 1,
							},
						},
						{
							type: "tool_event",
							id: "tool-1",
							name: "Read",
							input: { path: "src/app.ts" },
						},
					],
				})}
			/>,
		);
		const read = screen.getByRole("button", { name: /read/i });
		const active = screen.getByRole("button", { name: /explorer running/i });
		expect(
			read.compareDocumentPosition(active) & Node.DOCUMENT_POSITION_FOLLOWING,
		).toBeTruthy();

		// Terminal cards return to their original transcript position.
		rerender(
			<AssistantMsg
				message={makeMsg({
					toolEvents: [
						{
							type: "tool_event",
							id: "subagent-1",
							name: "spawn_agent",
							input: {},
							subagent: {
								provider: "codex",
								agentId: "child-1",
								name: "Explorer",
								status: "completed",
								startedAtMs: 1,
								endedAtMs: 2,
							},
						},
						{
							type: "tool_event",
							id: "tool-1",
							name: "Read",
							input: { path: "src/app.ts" },
						},
					],
				})}
			/>,
		);
		const completed = screen.getByRole("button", {
			name: /explorer completed/i,
		});
		expect(
			completed.compareDocumentPosition(read) &
				Node.DOCUMENT_POSITION_FOLLOWING,
		).toBeTruthy();
	});

	describe("CopyButton mobile visibility", () => {
		it("keeps completed actions on a separate mobile row so text width stays stable", () => {
			render(<AssistantMsg message={makeMsg()} />);
			const btn = screen.getByRole("button", { name: /copy/i });
			const actions = btn.parentElement;
			expect(actions?.className).toContain("basis-full");
			expect(actions?.className).toContain("sm:basis-auto");
			expect(actions?.parentElement?.className).toContain("flex-wrap");
			expect(actions?.parentElement?.className).toContain("sm:flex-nowrap");
		});

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
