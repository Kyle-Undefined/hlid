// @vitest-environment jsdom
import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as privacyStore from "#/hooks/privacyStore";
import type { TaskActivity } from "#/server/agentProvider";
import type { ToolEventMessage } from "#/server/protocol";
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

function taskEvent(
	id: string,
	name: string,
	taskActivity: TaskActivity,
): ToolEventMessage {
	return {
		type: "tool_event",
		id,
		name,
		input: {},
		result: "done",
		taskActivity,
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
	it("renders generated media after the response without an Activity tray", () => {
		const { container } = render(
			<AssistantMsg
				message={makeMsg({
					text: "Your image is ready.",
					toolEvents: [
						{
							type: "tool_event",
							id: "image-1",
							name: "ImageGeneration",
							input: { status: "inProgress" },
							result: JSON.stringify({
								type: "hlid_generated_media",
								version: 1,
								status: "ready",
								provider: "codex",
								provider_item_id: "image-1",
								attachment_id: "attachment-1",
								filename: "image-1.png",
								mime: "image/png",
								size_bytes: 4_096,
								width: 1_024,
								height: 768,
							}),
						},
					],
				})}
				providerId="codex"
			/>,
		);

		expect(screen.queryByText("Activity")).toBeNull();
		expect(screen.getByText("Generated image")).not.toBeNull();
		const response = screen.getByText("Your image is ready.");
		const media = container.querySelector(
			"[data-generated-media='attachment-1']",
		);
		expect(media).not.toBeNull();
		expect(
			response.compareDocumentPosition(media as Element) &
				Node.DOCUMENT_POSITION_FOLLOWING,
		).toBeTruthy();
	});

	it("renders grouped live Preview calls as compact inspectable activity rows", () => {
		const onSelectTool = vi.fn();
		const toolEvents: ToolEventMessage[] = [
			{
				type: "tool_event",
				id: "preview-control",
				name: "mcp__hlid__control_project_preview",
				input: { action: "click" },
				result: "ok",
			},
			{
				type: "tool_event",
				id: "preview-capture",
				name: "mcp__hlid__capture_project_preview",
				input: { viewport: "desktop" },
				result: "ok",
			},
		];
		render(
			<AssistantMsg
				message={makeMsg({ toolEvents })}
				providerId="codex"
				activityOpen
				onSelectTool={onSelectTool}
				groupedProjectPreviewEventIds={
					new Set(toolEvents.map((event) => event.id))
				}
				historicalProjectPreviewGroups={new Map()}
			/>,
		);

		expect(
			screen.getByRole("button", {
				name: "Activity, 2 tool calls, expanded",
			}),
		).not.toBeNull();
		const control = screen.getByRole("button", {
			name: /control_project_preview action: click, Complete/i,
		});
		expect(
			screen.getByRole("button", {
				name: /capture_project_preview viewport: desktop, Complete/i,
			}),
		).not.toBeNull();
		fireEvent.click(control);
		expect(onSelectTool).toHaveBeenCalledWith(toolEvents[0], control);
	});

	it("groups Claude task-store operations into one evolving task card", () => {
		const base = {
			kind: "tasks" as const,
			source: "claude-task-store" as const,
		};
		const message = makeMsg({
			toolEvents: [
				taskEvent("create", "TaskCreate", {
					...base,
					operation: "create",
					items: [
						{ id: "1", subject: "Test task integration", status: "pending" },
					],
				}),
				taskEvent("list", "TaskList", {
					...base,
					operation: "list",
					items: [
						{ id: "1", subject: "Test task integration", status: "pending" },
					],
				}),
				taskEvent("update", "TaskUpdate", {
					...base,
					operation: "update",
					items: [{ id: "1", subject: "Task 1", status: "completed" }],
				}),
				taskEvent("get", "TaskGet", {
					...base,
					operation: "get",
					items: [
						{ id: "1", subject: "Test task integration", status: "completed" },
					],
				}),
			],
		});
		render(
			<AssistantMsg message={message} providerId="claude" sessionId="s" />,
		);

		const group = screen.getByRole("button", {
			name: "Tasks task activity details",
			expanded: false,
		});
		expect(screen.getAllByText("Tasks")).toHaveLength(1);
		expect(screen.getByText("1/1 done")).not.toBeNull();
		fireEvent.click(group);
		expect(screen.getByText("Test task integration")).not.toBeNull();
		expect(screen.queryByText("Task 1")).toBeNull();
		expect(screen.getByText("Tool details")).not.toBeNull();
	});

	it("settles a completed task-list call without presenting unfinished rows as live", () => {
		const base = {
			kind: "tasks" as const,
			source: "claude-task-store" as const,
		};
		const { container } = render(
			<AssistantMsg
				message={makeMsg({
					toolEvents: [
						taskEvent("create-live", "TaskCreate", {
							...base,
							operation: "create",
							items: [{ id: "4", subject: "Owner claim", status: "pending" }],
						}),
						taskEvent("list-live", "TaskList", {
							...base,
							operation: "list",
							items: [
								{ id: "4", subject: "Owner claim", status: "in_progress" },
							],
						}),
					],
				})}
				providerId="claude"
				sessionId="s"
			/>,
		);

		expect(screen.getByLabelText("Tasks checked")).not.toBeNull();
		expect(screen.queryByText("ACTIVE")).toBeNull();
		fireEvent.click(
			screen.getByRole("button", { name: "Tasks task activity details" }),
		);
		expect(screen.getByText("Owner claim")).not.toBeNull();
		expect(container.querySelector(".animate-spin")).toBeNull();
	});

	it("ends an unresolved task card when its response has already settled", () => {
		const { container } = render(
			<AssistantMsg
				message={makeMsg({
					streaming: false,
					toolEvents: [
						{
							type: "tool_event",
							id: "unresolved-task",
							name: "TaskUpdate",
							input: {},
							taskActivity: {
								kind: "tasks",
								source: "claude-task-store",
								operation: "update",
								items: [
									{
										id: "5",
										subject: "Interrupted work",
										status: "in_progress",
									},
								],
							},
						},
					],
				})}
				providerId="claude"
				sessionId="s"
			/>,
		);

		expect(screen.getByLabelText("Tasks ended")).not.toBeNull();
		expect(screen.queryByLabelText("Tasks updating")).toBeNull();
		expect(container.querySelector(".animate-spin")).toBeNull();
	});

	it("pins active task activity below response text and returns it to transcript position when settled", () => {
		const taskActivity = {
			kind: "tasks" as const,
			source: "claude-task-store" as const,
			operation: "create" as const,
			items: [
				{ id: "9", subject: "First-class task", status: "pending" as const },
			],
		};
		const toolEvents = [
			taskEvent("single-task", "TaskCreate", taskActivity),
			{
				type: "tool_event" as const,
				id: "later-read",
				name: "Read",
				input: { path: "src/app.ts" },
			},
		];
		const { rerender } = render(
			<AssistantMsg
				message={makeMsg({ toolEvents, streaming: true })}
				providerId="claude"
				sessionId="s"
			/>,
		);

		const taskCard = screen.getByRole("button", {
			name: "Tasks task activity details",
		});
		const response = screen.getByText("hello world");
		expect(
			response.compareDocumentPosition(taskCard) &
				Node.DOCUMENT_POSITION_FOLLOWING,
		).toBeTruthy();

		rerender(
			<AssistantMsg
				message={makeMsg({ toolEvents, streaming: false })}
				providerId="claude"
				sessionId="s"
			/>,
		);
		const settledTaskCard = screen.getByRole("button", {
			name: "Tasks task activity details",
		});
		const laterRead = screen.getByRole("button", { name: /^Read path:/ });
		expect(
			settledTaskCard.compareDocumentPosition(laterRead) &
				Node.DOCUMENT_POSITION_FOLLOWING,
		).toBeTruthy();
		expect(screen.getByLabelText("Tasks created")).not.toBeNull();
	});

	it("keeps terminal task rows pinned until the streaming response ends", () => {
		const taskActivity: TaskActivity = {
			kind: "tasks",
			source: "claude-task-store",
			operation: "list",
			items: [
				{
					id: "11",
					subject: "Finished before response end",
					status: "completed",
				},
			],
		};
		const toolEvents: ToolEventMessage[] = [
			taskEvent("terminal-list", "TaskList", taskActivity),
			taskEvent("later-get", "TaskGet", {
				...taskActivity,
				operation: "get",
			}),
			{
				type: "tool_event",
				id: "later-read",
				name: "Read",
				input: { path: "src/app.ts" },
			},
		];
		const { rerender } = render(
			<AssistantMsg
				message={makeMsg({ toolEvents, streaming: true })}
				providerId="claude"
				sessionId="s"
			/>,
		);

		const taskCard = screen.getByRole("button", {
			name: "Tasks task activity details",
		});
		const response = screen.getByText("hello world");
		expect(screen.getAllByText("Tasks")).toHaveLength(1);
		expect(
			response.compareDocumentPosition(taskCard) &
				Node.DOCUMENT_POSITION_FOLLOWING,
		).toBeTruthy();

		rerender(
			<AssistantMsg
				message={makeMsg({ toolEvents, streaming: false })}
				providerId="claude"
				sessionId="s"
			/>,
		);
		const settledTaskCard = screen.getByRole("button", {
			name: "Tasks task activity details",
		});
		const laterRead = screen.getByRole("button", { name: /^Read path:/ });
		expect(
			settledTaskCard.compareDocumentPosition(laterRead) &
				Node.DOCUMENT_POSITION_FOLLOWING,
		).toBeTruthy();
	});

	it("keeps an active task card visible beside the bounded activity tray", () => {
		const taskActivity = {
			kind: "tasks" as const,
			source: "claude-task-store" as const,
			operation: "create" as const,
			items: [
				{ id: "10", subject: "Windowed task", status: "pending" as const },
			],
		};
		render(
			<AssistantMsg
				message={makeMsg({
					streaming: true,
					toolEvents: [
						taskEvent("hidden-task", "TaskCreate", taskActivity),
						{
							type: "tool_event",
							id: "visible-read",
							name: "Read visible",
							input: {},
						},
					],
				})}
				providerId="claude"
				sessionId="s"
			/>,
		);

		expect(
			screen.getByRole("button", { name: "Tasks task activity details" }),
		).not.toBeNull();
		expect(
			screen.getByRole("button", { name: /read visible/i }),
		).not.toBeNull();
	});

	it("renders Codex visualizations below the agent response while normal tools stay above it", () => {
		const read = {
			type: "tool_event" as const,
			id: "tool-read",
			name: "Read",
			input: { path: "/before" },
		};
		const visualization = {
			type: "tool_event" as const,
			id: "tool-visualization",
			name: "create_visualization",
			input: { request: "Show the response path" },
			result: JSON.stringify({
				type: "hlid_visualization",
				attachment_id: "visualization-1",
				filename: "response-path.html",
				title: "Response path",
			}),
		};
		const message = makeMsg({ toolEvents: [read, visualization] });
		const { rerender } = render(
			<AssistantMsg
				message={message}
				providerId="codex"
				sessionId="session-1"
			/>,
		);
		expect(screen.queryByTitle("Response path")).toBeNull();
		expect(
			screen.getByRole("button", {
				name: "Expand visualization: Response path",
			}),
		).not.toBeNull();

		rerender(
			<AssistantMsg
				message={message}
				providerId="codex"
				sessionId="session-1"
				expandedVisualizationEventId="tool-visualization"
			/>,
		);

		const readTool = screen.getByRole("button", {
			name: /^Read path: \/before/,
		});
		const response = screen.getByText("hello world");
		const frame = screen.getByTitle("Response path");
		expect(
			readTool.compareDocumentPosition(response) &
				Node.DOCUMENT_POSITION_FOLLOWING,
		).toBeTruthy();
		expect(
			response.compareDocumentPosition(frame) &
				Node.DOCUMENT_POSITION_FOLLOWING,
		).toBeTruthy();
	});

	it("renders an active Codex visualization worker only once", () => {
		const visualization: ToolEventMessage = {
			type: "tool_event",
			id: "tool-visualization",
			name: "mcp__hlid__create_visualization",
			input: { request: "Show the response path" },
			subagent: {
				provider: "codex",
				agentId: "visualization-worker-1",
				kind: "workflow",
				status: "running",
				currentStep: "Building visualization",
				startedAtMs: 1,
			},
		};

		render(
			<AssistantMsg
				message={makeMsg({
					streaming: true,
					toolEvents: [visualization],
				})}
				providerId="codex"
				sessionId="session-1"
			/>,
		);

		expect(screen.getAllByText("Building visualization")).toHaveLength(1);
	});

	it("keeps the accepted steer below the Activity tray as later tools arrive", () => {
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
			laterTool.compareDocumentPosition(resumedReceipt as Element) &
				Node.DOCUMENT_POSITION_FOLLOWING,
		).toBeTruthy();
		expect(
			(resumedReceipt as Element).compareDocumentPosition(
				screen.getByText("hello world"),
			) & Node.DOCUMENT_POSITION_FOLLOWING,
		).toBeTruthy();
	});

	it("keeps accepted steers mounted when the Activity tray is collapsed", () => {
		const { container } = render(
			<AssistantMsg
				message={makeMsg({
					toolEvents: [
						{
							type: "tool_event",
							id: "tool-hidden",
							name: "Read",
							input: { path: "/hidden" },
						},
					],
				})}
				acceptedSteers={[acceptedSteer()]}
				activityOpen={false}
			/>,
		);

		expect(
			screen.getByRole("button", {
				name: "Activity, 1 tool call · 1 steer, collapsed",
			}),
		).not.toBeNull();
		expect(
			screen.queryByRole("button", { name: /^Read path: \/hidden/ }),
		).toBeNull();
		expect(
			container.querySelector("[data-steer-stack='msg-1']"),
		).not.toBeNull();
		expect(
			container.querySelector("[data-steer-receipt='steer-1']"),
		).not.toBeNull();
		expect(screen.getByText("Change direction")).not.toBeNull();
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

	it("keeps observing the connected text after adding the expand control", () => {
		const callbacks: ResizeObserverCallback[] = [];
		const observed: Element[] = [];
		class ResizeObserverMock {
			constructor(callback: ResizeObserverCallback) {
				callbacks.push(callback);
			}
			observe(target: Element) {
				observed.push(target);
			}
			disconnect() {}
			unobserve() {}
		}
		vi.stubGlobal("ResizeObserver", ResizeObserverMock);
		const scrollHeight = vi
			.spyOn(Element.prototype, "scrollHeight", "get")
			.mockImplementation(function (this: Element) {
				if (!this.hasAttribute("data-steer-text")) return 0;
				return this.isConnected ? 48 : 0;
			});
		const clientHeight = vi
			.spyOn(Element.prototype, "clientHeight", "get")
			.mockImplementation(function (this: Element) {
				return this.hasAttribute("data-steer-text") && this.isConnected
					? 32
					: 0;
			});
		try {
			const { container } = render(
				<AssistantMsg
					message={makeMsg()}
					acceptedSteers={[
						acceptedSteer({
							text: "A mobile steering instruction that is longer than the two-line compact receipt.",
						}),
					]}
				/>,
			);

			expect(screen.getByTitle("Expand accepted steer")).toBeTruthy();
			expect(observed.at(-1)).toBe(
				container.querySelector("[data-steer-text]"),
			);

			act(() => callbacks.at(-1)?.([], {} as ResizeObserver));
			expect(screen.getByTitle("Expand accepted steer")).toBeTruthy();
		} finally {
			scrollHeight.mockRestore();
			clientHeight.mockRestore();
			vi.unstubAllGlobals();
		}
	});

	it("stacks multiple steers below all visible tool calls in persisted order", () => {
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
		expect(appearsBefore(tool0, tool1)).toBe(true);
		expect(appearsBefore(tool1, tool2)).toBe(true);
		expect(appearsBefore(tool2, tool3)).toBe(true);
		expect(appearsBefore(tool3, firstReceipt as Element)).toBe(true);
		expect(
			appearsBefore(firstReceipt as Element, secondReceipt as Element),
		).toBe(true);
		expect(appearsBefore(secondReceipt as Element, prose)).toBe(true);

		const tailIndicator = screen.getByTitle(
			"2 accepted steers in this response",
		);
		fireEvent.click(tailIndicator);
		expect(document.activeElement).toBe(
			(secondReceipt as Element).querySelector("[data-steer-focus]"),
		);
	});

	it("keeps accepted steers mounted without replacing the bounded tool window", () => {
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
				activityOpen
				onSelectTool={vi.fn()}
			/>,
		);

		expect(container.querySelector("[data-steer-receipt]")).not.toBeNull();
		expect(screen.getByRole("button", { name: /read 185/i })).not.toBeNull();
		expect(screen.getByRole("button", { name: /read 204/i })).not.toBeNull();
		expect(screen.queryByRole("button", { name: /read 0/i })).toBeNull();
	});

	it("keeps the steer stack below the tool window as calls arrive and earlier calls load", async () => {
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
			/>,
		);
		expect(
			screen
				.getByRole("button", { name: /read 27/i })
				.compareDocumentPosition(receipt() as Element) &
				Node.DOCUMENT_POSITION_FOLLOWING,
		).toBeTruthy();

		fireEvent.click(screen.getByRole("button", { name: "Load 8 earlier" }));
		await waitFor(() =>
			expect(screen.getByRole("button", { name: /read 0/i })).not.toBeNull(),
		);
		expect(
			screen
				.getByRole("button", { name: /read 27/i })
				.compareDocumentPosition(receipt() as Element) &
				Node.DOCUMENT_POSITION_FOLLOWING,
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

	it("places the bounded load-earlier control directly before the rows it reveals", async () => {
		render(
			<AssistantMsg
				message={makeMsg({
					toolEvents: [
						{
							type: "tool_event",
							id: "old-read",
							name: "Read old",
							input: {},
						},
						...Array.from({ length: 20 }, (_, index) => ({
							type: "tool_event" as const,
							id: `middle-${index}`,
							name: `Read middle ${index}`,
							input: {},
						})),
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

		const reveal = screen.getByRole("button", { name: "Load 2 earlier" });
		const visibleTool = screen.getByRole("button", { name: /read visible/i });
		expect(
			reveal.compareDocumentPosition(visibleTool) &
				Node.DOCUMENT_POSITION_FOLLOWING,
		).toBeTruthy();
		expect(reveal.className).toContain("w-full");
		fireEvent.click(reveal);
		await waitFor(() =>
			expect(screen.getByRole("button", { name: /read old/i })).not.toBeNull(),
		);
	});

	it("hides completed tool calls before the window but keeps active subagents visible", () => {
		render(
			<AssistantMsg
				message={makeMsg({
					toolEvents: [
						{
							type: "tool_event",
							id: "old-read",
							name: "Read old",
							input: {},
						},
						...Array.from({ length: 19 }, (_, index) => ({
							type: "tool_event" as const,
							id: `filler-${index}`,
							name: `Read filler ${index}`,
							input: {},
						})),
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

	it("keeps a cross-boundary workflow child visible above the steer stack", () => {
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
			parent.compareDocumentPosition(child) & Node.DOCUMENT_POSITION_FOLLOWING,
		).toBeTruthy();
		expect(
			child.compareDocumentPosition(receipt as Element) &
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

		it.each([
			{
				label: "provider-reported",
				message: makeMsg({ cost: 0.1234, costEstimated: false }),
				display: "$0.1234",
			},
			{
				label: "estimated",
				message: makeMsg({ cost: 0.1234, costEstimated: true }),
				display: "~$0.1234",
			},
			{
				label: "provider-reported zero",
				message: makeMsg({ cost: 0, costEstimated: false }),
				display: "$0.0000",
			},
		])("shows $label cost beside the completed actions", ({
			message,
			display,
		}) => {
			render(<AssistantMsg message={message} />);
			const actions = screen.getByRole("button", {
				name: /copy/i,
			}).parentElement;
			const cost = screen.getByText(display);

			expect(actions?.contains(cost)).toBe(true);
		});

		it("does not invent a cost beside completed actions when pricing is unknown", () => {
			render(<AssistantMsg message={makeMsg({ cost: null })} />);
			const actions = screen.getByRole("button", {
				name: /copy/i,
			}).parentElement;

			expect(actions?.textContent).not.toContain("$");
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
