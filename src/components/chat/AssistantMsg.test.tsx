// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as privacyStore from "#/hooks/privacyStore";
import { AssistantMsg, normalizeMd } from "./AssistantMsg";
import type { AssistantMessage, UserMessage } from "./chatReducer";

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

function acceptedSteer(overrides?: Partial<UserMessage>): UserMessage {
	return {
		id: "steer-1",
		role: "user",
		text: "Change direction",
		steerTargetSeq: 1,
		steerToolEventIndex: 1,
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
	it("keeps the accepted steer at its tool boundary as later tools resume below it", () => {
		const before = {
			type: "tool_event" as const,
			id: "tool-before",
			name: "Read",
			input: { path: "/before" },
		};
		const later = {
			type: "tool_event" as const,
			id: "tool-later",
			name: "Read",
			input: { path: "/later" },
		};
		const { container, rerender } = render(
			<AssistantMsg
				message={makeMsg({ toolEvents: [before], streaming: true })}
				acceptedSteers={[acceptedSteer()]}
			/>,
		);

		const firstTool = screen.getByRole("button", {
			name: /^Read path: \/before/,
		});
		const receipt = container.querySelector("[data-steer-receipt]");
		const agentText = screen.getByText("hello world");
		expect(receipt).not.toBeNull();
		expect(
			firstTool.compareDocumentPosition(receipt as Element) &
				Node.DOCUMENT_POSITION_FOLLOWING,
		).toBeTruthy();
		expect(
			(receipt as Element).compareDocumentPosition(agentText) &
				Node.DOCUMENT_POSITION_FOLLOWING,
		).toBeTruthy();

		rerender(
			<AssistantMsg
				message={makeMsg({
					toolEvents: [before, later],
					streaming: true,
				})}
				acceptedSteers={[acceptedSteer()]}
			/>,
		);

		const resumedReceipt = container.querySelector("[data-steer-receipt]");
		const laterTool = screen.getByRole("button", {
			name: /^Read path: \/later/,
		});
		expect(
			(resumedReceipt as Element).compareDocumentPosition(laterTool) &
				Node.DOCUMENT_POSITION_FOLLOWING,
		).toBeTruthy();
		expect(
			laterTool.compareDocumentPosition(screen.getByText("hello world")) &
				Node.DOCUMENT_POSITION_FOLLOWING,
		).toBeTruthy();
	});

	it("renders an accepted steer even when the provider response is empty", () => {
		const { container } = render(
			<AssistantMsg
				message={makeMsg({ text: "", toolEvents: [] })}
				acceptedSteers={[acceptedSteer({ steerToolEventIndex: 0 })]}
			/>,
		);

		expect(container.querySelector("[data-steer-receipt]")).not.toBeNull();
		expect(screen.getByText("Change direction")).toBeTruthy();
	});

	it("does not offer expansion when the accepted steer fits in two lines", () => {
		const { container } = render(
			<AssistantMsg
				message={makeMsg()}
				acceptedSteers={[acceptedSteer({ text: "Mobile steer" })]}
			/>,
		);

		expect(screen.queryByTitle("Expand accepted steer")).toBeNull();
		expect(
			container.querySelector("[data-steer-receipt] [aria-expanded]"),
		).toBeNull();
		expect(
			container.querySelector("[data-steer-focus]")?.textContent,
		).toContain("Mobile steer");
	});

	it("offers expansion when the collapsed accepted steer overflows", () => {
		const scrollHeight = vi
			.spyOn(Element.prototype, "scrollHeight", "get")
			.mockImplementation(function (this: Element) {
				return this.hasAttribute("data-steer-text") ? 48 : 0;
			});
		const clientHeight = vi
			.spyOn(Element.prototype, "clientHeight", "get")
			.mockImplementation(function (this: Element) {
				return this.hasAttribute("data-steer-text") ? 32 : 0;
			});
		try {
			const { container } = render(
				<AssistantMsg
					message={makeMsg()}
					acceptedSteers={[
						acceptedSteer({
							text: "A longer steering instruction that wraps beyond the compact two-line receipt.",
						}),
					]}
				/>,
			);

			const expand = screen.getByTitle("Expand accepted steer");
			expect(expand.getAttribute("aria-expanded")).toBe("false");
			expect(container.querySelector("[data-steer-text]")?.className).toContain(
				"line-clamp-2",
			);
			fireEvent.click(expand);
			expect(screen.getByTitle("Collapse accepted steer")).toBeTruthy();
			expect(
				container.querySelector("[data-steer-text]")?.className,
			).not.toContain("line-clamp-2");
		} finally {
			scrollHeight.mockRestore();
			clientHeight.mockRestore();
		}
	});

	it("interleaves multiple steers at their distinct acceptance boundaries", () => {
		const toolEvents = Array.from({ length: 4 }, (_, index) => ({
			type: "tool_event" as const,
			id: `tool-${index}`,
			name: `Read ${index}`,
			input: {},
		}));
		const { container } = render(
			<AssistantMsg
				message={makeMsg({ toolEvents, streaming: true })}
				acceptedSteers={[
					acceptedSteer({
						id: "steer-first",
						text: "First direction",
						steerToolEventIndex: 1,
					}),
					acceptedSteer({
						id: "steer-second",
						text: "Second direction",
						steerToolEventIndex: 3,
					}),
				]}
			/>,
		);

		const tool0 = screen.getByRole("button", { name: /read 0/i });
		const tool1 = screen.getByRole("button", { name: /read 1/i });
		const tool2 = screen.getByRole("button", { name: /read 2/i });
		const tool3 = screen.getByRole("button", { name: /read 3/i });
		const firstReceipt = container.querySelector(
			"[data-steer-receipt='steer-first']",
		);
		const secondReceipt = container.querySelector(
			"[data-steer-receipt='steer-second']",
		);
		const prose = screen.getByText("hello world");
		expect(firstReceipt).not.toBeNull();
		expect(secondReceipt).not.toBeNull();
		const appearsBefore = (left: Node, right: Node) =>
			Boolean(
				left.compareDocumentPosition(right) & Node.DOCUMENT_POSITION_FOLLOWING,
			);
		expect(appearsBefore(tool0, firstReceipt as Element)).toBe(true);
		expect(appearsBefore(firstReceipt as Element, tool1)).toBe(true);
		expect(appearsBefore(tool1, tool2)).toBe(true);
		expect(appearsBefore(tool2, secondReceipt as Element)).toBe(true);
		expect(appearsBefore(secondReceipt as Element, tool3)).toBe(true);
		expect(appearsBefore(tool3, prose)).toBe(true);

		const tailIndicator = screen.getByTitle(
			"2 accepted steers in this response",
		);
		fireEvent.click(tailIndicator);
		expect(document.activeElement).toBe(
			(secondReceipt as Element).querySelector("[data-steer-focus]"),
		);
	});

	it("keeps a hidden acceptance boundary visible beside the tool reveal control", () => {
		const toolEvents = Array.from({ length: 205 }, (_, index) => ({
			type: "tool_event" as const,
			id: `tool-${index}`,
			name: `Read ${index}`,
			input: {},
		}));
		const { container } = render(
			<AssistantMsg
				message={makeMsg({ toolEvents })}
				acceptedSteers={[acceptedSteer({ steerToolEventIndex: 10 })]}
				toolEventStartIndex={200}
				olderToolEventCount={200}
				onLoadOlderToolEvents={vi.fn()}
			/>,
		);

		const reveal = screen.getByRole("button", {
			name: "Show 200 earlier tool calls",
		});
		const receipt = container.querySelector("[data-steer-receipt]");
		const firstVisibleTool = screen.getByRole("button", {
			name: /read 200/i,
		});
		expect(receipt).not.toBeNull();
		expect(
			reveal.compareDocumentPosition(receipt as Element) &
				Node.DOCUMENT_POSITION_FOLLOWING,
		).toBeTruthy();
		expect(
			(receipt as Element).compareDocumentPosition(firstVisibleTool) &
				Node.DOCUMENT_POSITION_FOLLOWING,
		).toBeTruthy();
	});

	it("preserves the exact boundary as the tool window advances and reveals", () => {
		const toolEvents = Array.from({ length: 25 }, (_, index) => ({
			type: "tool_event" as const,
			id: `window-tool-${index}`,
			name: `Read ${index}`,
			input: {},
		}));
		const steer = acceptedSteer({ steerToolEventIndex: 25 });
		const { container, rerender } = render(
			<AssistantMsg
				message={makeMsg({ toolEvents, streaming: true })}
				acceptedSteers={[steer]}
				toolEventStartIndex={5}
			/>,
		);
		const receipt = () =>
			container.querySelector("[data-steer-receipt='steer-1']");
		expect(
			screen
				.getByRole("button", { name: /read 24/i })
				.compareDocumentPosition(receipt() as Element) &
				Node.DOCUMENT_POSITION_FOLLOWING,
		).toBeTruthy();

		const updatedTools = [
			...toolEvents,
			...Array.from({ length: 3 }, (_, offset) => ({
				type: "tool_event" as const,
				id: `window-tool-${25 + offset}`,
				name: `Read ${25 + offset}`,
				input: {},
			})),
		];
		rerender(
			<AssistantMsg
				message={makeMsg({ toolEvents: updatedTools, streaming: true })}
				acceptedSteers={[steer]}
				toolEventStartIndex={8}
			/>,
		);
		expect(
			(receipt() as Element).compareDocumentPosition(
				screen.getByRole("button", { name: /read 25/i }),
			) & Node.DOCUMENT_POSITION_FOLLOWING,
		).toBeTruthy();

		rerender(
			<AssistantMsg
				message={makeMsg({ toolEvents: updatedTools, streaming: true })}
				acceptedSteers={[steer]}
				toolEventStartIndex={0}
			/>,
		);
		expect(
			screen
				.getByRole("button", { name: /read 24/i })
				.compareDocumentPosition(receipt() as Element) &
				Node.DOCUMENT_POSITION_FOLLOWING,
		).toBeTruthy();
		expect(
			(receipt() as Element).compareDocumentPosition(
				screen.getByRole("button", { name: /read 25/i }),
			) & Node.DOCUMENT_POSITION_FOLLOWING,
		).toBeTruthy();
	});

	it("keeps a compact steering indicator at the tail of a long response", () => {
		const scrollIntoView = vi.fn();
		Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
			configurable: true,
			value: scrollIntoView,
		});
		const { container } = render(
			<AssistantMsg
				message={makeMsg({
					text: "Long response ".repeat(500),
					streaming: true,
				})}
				acceptedSteers={[acceptedSteer({ steerToolEventIndex: 0 })]}
			/>,
		);

		const tailIndicator = screen.getByTitle(
			"1 accepted steer in this response",
		);
		expect(tailIndicator.textContent).toContain("Steered");
		expect(tailIndicator.className).toContain("min-h-6");
		expect(tailIndicator.className).toContain("min-w-6");
		expect(tailIndicator.className).toContain("focus-visible:ring-1");
		const receipt = container.querySelector<HTMLElement>("[data-steer-focus]");
		expect(receipt).not.toBeNull();
		expect(screen.queryByTitle("Expand accepted steer")).toBeNull();
		const prose = container.querySelector("p");
		expect(prose).not.toBeNull();
		expect(
			(prose as Element).compareDocumentPosition(tailIndicator) &
				Node.DOCUMENT_POSITION_FOLLOWING,
		).toBeTruthy();
		fireEvent.click(tailIndicator);
		expect(scrollIntoView).toHaveBeenCalledWith({
			behavior: "smooth",
			block: "center",
		});
		expect(document.activeElement).toBe(receipt);
		expect(receipt?.querySelector(".line-clamp-2")).not.toBeNull();
		Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
	});

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

	it("nests workflow children under their provider-neutral parent activity", () => {
		render(
			<AssistantMsg
				sessionId="session-1"
				message={makeMsg({
					toolEvents: [
						{
							type: "tool_event",
							id: "workflow-tool",
							name: "Workflow",
							input: {},
							subagent: {
								provider: "claude",
								agentId: "workflow-task",
								taskId: "workflow-task",
								kind: "workflow",
								name: "Repository audit",
								status: "running",
								startedAtMs: 1,
							},
						},
						{
							type: "tool_event",
							id: "workflow-child",
							name: "Subagent",
							input: {},
							subagent: {
								provider: "claude",
								agentId: "child-task",
								kind: "agent",
								parentActivityId: "workflow-task",
								name: "Reader",
								status: "running",
								startedAtMs: 1,
							},
						},
					],
				})}
			/>,
		);

		expect(
			screen.queryByRole("button", { name: /reader running/i }),
		).toBeNull();
		fireEvent.click(
			screen.getByRole("button", { name: /repository audit running/i }),
		);
		expect(
			screen.getAllByRole("button", { name: /reader running/i }),
		).toHaveLength(1);
	});

	it("keeps a workflow child below a steer accepted after its parent", () => {
		const { container } = render(
			<AssistantMsg
				sessionId="session-1"
				acceptedSteers={[acceptedSteer({ steerToolEventIndex: 1 })]}
				message={makeMsg({
					toolEvents: [
						{
							type: "tool_event",
							id: "workflow-tool",
							name: "Workflow",
							input: {},
							subagent: {
								provider: "claude",
								agentId: "workflow-task",
								taskId: "workflow-task",
								kind: "workflow",
								name: "Repository audit",
								status: "completed",
								startedAtMs: 1,
								endedAtMs: 2,
							},
						},
						{
							type: "tool_event",
							id: "workflow-child",
							name: "Subagent",
							input: {},
							subagent: {
								provider: "claude",
								agentId: "child-task",
								kind: "agent",
								parentActivityId: "workflow-task",
								name: "Reader",
								status: "completed",
								startedAtMs: 1,
								endedAtMs: 2,
							},
						},
					],
				})}
			/>,
		);

		const parent = screen.getByRole("button", {
			name: /repository audit completed/i,
		});
		const receipt = container.querySelector("[data-steer-receipt]");
		const child = screen.getByRole("button", { name: /reader completed/i });
		expect(receipt).not.toBeNull();
		expect(
			parent.compareDocumentPosition(receipt as Element) &
				Node.DOCUMENT_POSITION_FOLLOWING,
		).toBeTruthy();
		expect(
			(receipt as Element).compareDocumentPosition(child) &
				Node.DOCUMENT_POSITION_FOLLOWING,
		).toBeTruthy();
	});

	describe("completed message actions", () => {
		it("keeps completed actions after the response at every viewport", () => {
			render(<AssistantMsg message={makeMsg()} />);
			const btn = screen.getByRole("button", { name: /copy/i });
			const actions = btn.parentElement;
			expect(actions?.className).toContain("basis-full");
			expect(actions?.className).not.toContain("sm:basis-auto");
			expect(actions?.parentElement?.className).toContain("flex-wrap");
			expect(actions?.parentElement?.className).not.toContain("sm:flex-nowrap");
		});

		it("always shows completed response controls", () => {
			render(<AssistantMsg message={makeMsg()} />);
			expect(screen.getByRole("button", { name: /copy/i })).toBeTruthy();
			expect(screen.getByRole("button", { name: "Read aloud" })).toBeTruthy();
			expect(
				screen.queryByRole("button", { name: "Message actions" }),
			).toBeNull();
		});

		it("offers read aloud beside copy for completed responses", () => {
			render(<AssistantMsg message={makeMsg()} />);
			expect(screen.getByRole("button", { name: "Read aloud" })).toBeTruthy();
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
