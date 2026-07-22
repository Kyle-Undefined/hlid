// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
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
	it("places the mobile reveal control directly before the tool rows it reveals", () => {
		const onLoadOlderToolEvents = vi.fn();
		render(
			<AssistantMsg
				toolEventStartIndex={1}
				olderToolEventCount={1}
				onLoadOlderToolEvents={onLoadOlderToolEvents}
				message={makeMsg({
					toolEvents: [
						{
							type: "tool_event",
							id: "old-read",
							name: "Read old",
							input: {},
						},
						{
							type: "tool_event",
							id: "visible-read",
							name: "Read visible",
							input: {},
						},
					],
				})}
			/>,
		);

		const reveal = screen.getByRole("button", {
			name: "Show 1 earlier tool call",
		});
		const visibleTool = screen.getByRole("button", { name: /read visible/i });
		expect(
			reveal.compareDocumentPosition(visibleTool) &
				Node.DOCUMENT_POSITION_FOLLOWING,
		).toBeTruthy();
		expect(reveal.className).toContain("w-full");
		expect(reveal.className).toContain("sm:w-auto");
		fireEvent.click(reveal);
		expect(onLoadOlderToolEvents).toHaveBeenCalledOnce();
	});

	it("hides completed tool calls before the window but keeps active subagents visible", () => {
		render(
			<AssistantMsg
				toolEventStartIndex={2}
				message={makeMsg({
					toolEvents: [
						{
							type: "tool_event",
							id: "old-read",
							name: "Read old",
							input: {},
						},
						{
							type: "tool_event",
							id: "active-child",
							name: "spawn_agent",
							input: {},
							subagent: {
								provider: "codex",
								agentId: "child-1",
								name: "Active child",
								status: "running",
								startedAtMs: 1,
							},
						},
						{
							type: "tool_event",
							id: "new-read",
							name: "Read new",
							input: {},
						},
					],
				})}
			/>,
		);

		expect(screen.queryByRole("button", { name: /read old/i })).toBeNull();
		expect(screen.getByRole("button", { name: /read new/i })).toBeTruthy();
		expect(
			screen.getByRole("button", { name: /active child running/i }),
		).toBeTruthy();
	});

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
		const read = screen.getByRole("button", { name: /^Read path:/ });
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
		it("keeps completed actions after the response at every viewport", () => {
			render(<AssistantMsg message={makeMsg()} />);
			const btn = screen.getByRole("button", { name: /copy/i });
			const actions = btn.parentElement;
			expect(actions?.className).toContain("basis-full");
			expect(actions?.className).not.toContain("sm:basis-auto");
			expect(actions?.parentElement?.className).toContain("flex-wrap");
			expect(actions?.parentElement?.className).not.toContain("sm:flex-nowrap");
		});

		it("copy button has [@media(hover:none)]:opacity-100 class so it shows on touch devices", () => {
			render(<AssistantMsg message={makeMsg()} />);
			const btn = screen.getByRole("button", { name: /copy/i });
			expect(btn.className).toContain("[@media(hover:none)]:opacity-100");
		});

		it("offers read aloud beside copy for completed responses", () => {
			render(<AssistantMsg message={makeMsg()} />);
			const button = screen.getByRole("button", { name: "Read aloud" });
			expect(button.className).toContain("[@media(hover:none)]:opacity-100");
		});

		it("copy button not rendered when streaming", () => {
			render(
				<AssistantMsg message={makeMsg({ streaming: true, text: "hi" })} />,
			);
			expect(screen.queryByRole("button", { name: /copy/i })).toBeNull();
			expect(screen.queryByRole("button", { name: /read aloud/i })).toBeNull();
		});

		it("copy button not rendered when no text", () => {
			render(<AssistantMsg message={makeMsg({ text: "" })} />);
			expect(screen.queryByRole("button", { name: /copy/i })).toBeNull();
		});
	});

	describe("branch from here", () => {
		it("is not rendered when canBranch is false", () => {
			render(
				<AssistantMsg
					message={makeMsg({ dbId: 42 })}
					canBranch={false}
					onBranch={vi.fn()}
				/>,
			);
			expect(
				screen.queryByRole("button", { name: /branch from here/i }),
			).toBeNull();
		});

		it("is not rendered when the message has no dbId yet (still arriving live)", () => {
			render(<AssistantMsg message={makeMsg()} canBranch onBranch={vi.fn()} />);
			expect(
				screen.queryByRole("button", { name: /branch from here/i }),
			).toBeNull();
		});

		it("calls onBranch with the message's dbId when clicked", () => {
			const onBranch = vi.fn();
			render(
				<AssistantMsg
					message={makeMsg({ dbId: 42 })}
					canBranch
					onBranch={onBranch}
				/>,
			);
			fireEvent.click(
				screen.getByRole("button", { name: /branch from here/i }),
			);
			expect(onBranch).toHaveBeenCalledWith(42);
		});

		it("disables the button while this row's branch is in flight", () => {
			render(
				<AssistantMsg
					message={makeMsg({ dbId: 42 })}
					canBranch
					branching
					onBranch={vi.fn()}
				/>,
			);
			const btn = screen.getByRole("button", {
				name: /branch from here/i,
			}) as HTMLButtonElement;
			expect(btn.disabled).toBe(true);
		});
	});
});
