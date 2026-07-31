// @vitest-environment jsdom
/**
 * MessageList — focused on the "orphan queue" rendering path added to fix
 * disappearing queued messages after SPA nav.
 *
 * Live queued msgs live in two places: wsStore._chatQueue (module state,
 * survives nav) and the reducer transcript (lost on remount). On remount
 * the reducer reloads from DB — which has no row for a not-yet-running
 * queued turn — so the message would vanish until processed. MessageList
 * now re-surfaces queue items not in the transcript.
 */
import {
	act,
	cleanup,
	fireEvent,
	render,
	renderHook,
	screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as privacyStore from "#/hooks/privacyStore";
import type { QueuedChatMessage } from "#/hooks/wsChatQueueStore";
import type { AssistantMessage, ChatMessage, UserMessage } from "./chatReducer";
import { reducer } from "./chatReducer";
import { MessageList } from "./MessageList";
import { useMessageListView } from "./useMessageListView";

const projectPreviewState = vi.hoisted(() => ({
	live: null as
		| import("#/lib/serverFns/projectPreviews").ProjectPreviewSnapshot
		| null,
}));

vi.mock("#/hooks/projectPreviewStore", () => ({
	useProjectPreview: () => projectPreviewState.live,
}));
vi.mock("./ChatMessageRow", () => ({
	ChatMessageRow: ({
		message,
		acceptedSteers,
		queueState,
		toolEventStartIndex,
		olderToolEventCount,
		onLoadOlderToolEvents,
		groupedProjectPreviewEventIds,
		historicalProjectPreviewGroups,
		requesterSubagents,
		pendingPermissionsByWorkflow,
		embeddedPermissionIds,
	}: {
		message: ChatMessage;
		acceptedSteers?: readonly UserMessage[];
		queueState?: { kind: string };
		toolEventStartIndex?: number;
		olderToolEventCount?: number;
		onLoadOlderToolEvents?: () => void;
		groupedProjectPreviewEventIds?: ReadonlySet<string>;
		historicalProjectPreviewGroups?: ReadonlyMap<string, unknown[]>;
		requesterSubagents?: ReadonlyMap<string, unknown>;
		pendingPermissionsByWorkflow?: ReadonlyMap<string, unknown[]>;
		embeddedPermissionIds?: ReadonlySet<string>;
	}) => (
		<div
			data-testid={`message-${message.id}`}
			data-queue-state={queueState?.kind}
			data-accepted-steers={acceptedSteers?.map((steer) => steer.id).join(",")}
			data-steer-boundaries={acceptedSteers
				?.map((steer) => steer.steerToolEventIndex)
				.join(",")}
			data-tool-event-start={toolEventStartIndex}
			data-preview-grouped={String(groupedProjectPreviewEventIds?.size ?? 0)}
			data-preview-history={String(historicalProjectPreviewGroups?.size ?? 0)}
			data-requester-count={String(requesterSubagents?.size ?? 0)}
			data-workflow-approval-count={String(
				Array.from(pendingPermissionsByWorkflow?.values() ?? []).reduce(
					(total, approvals) => total + approvals.length,
					0,
				),
			)}
			data-embedded-permission={String(
				embeddedPermissionIds?.has(message.id) ?? false,
			)}
		>
			{"text" in message ? message.text : message.id}
			{Boolean(olderToolEventCount && onLoadOlderToolEvents) && (
				<button type="button" onClick={onLoadOlderToolEvents}>
					Show {olderToolEventCount} earlier tool{" "}
					{olderToolEventCount === 1 ? "call" : "calls"}
				</button>
			)}
		</div>
	),
}));
vi.mock("./HlidDelegationActivityPanel", () => ({
	HlidDelegationActivityPanel: ({ sessionId }: { sessionId: string }) => (
		<div data-testid="hlid-children" data-session-id={sessionId} />
	),
}));
vi.mock("./ProjectPreviewToolBlock", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("./ProjectPreviewToolBlock")>();
	return {
		...actual,
		ProjectPreviewActivityCard: ({ events }: { events: unknown[] }) => (
			<div data-testid="preview-activity" data-count={events.length} />
		),
	};
});

afterEach(cleanup);

beforeEach(() => {
	projectPreviewState.live = null;
	privacyStore.__resetForTesting();
	Object.defineProperty(navigator, "clipboard", {
		value: { writeText: vi.fn().mockResolvedValue(undefined) },
		configurable: true,
	});
});

function userMsg(id: string, text: string): UserMessage {
	return { id, role: "user", text, attachments: [] };
}

function assistantMsg(id: string, toolCount: number): AssistantMessage {
	return {
		id,
		role: "assistant",
		text: id,
		streaming: false,
		cost: null,
		toolEvents: Array.from({ length: toolCount }, (_, index) => ({
			type: "tool_event" as const,
			id: `${id}-tool-${index}`,
			name: "Read",
			input: {},
		})),
	};
}

function previewAssistantMsg(
	id: string,
	toolName: "start_project_preview" | "capture_project_preview",
): AssistantMessage {
	return {
		...assistantMsg(id, 0),
		toolEvents: [
			{
				type: "tool_event",
				id: `${id}-preview`,
				name: `mcp__hlid__${toolName}`,
				input: {},
			},
		],
	};
}

function previewResult(id: string, state: "ready" | "stopped", label: string) {
	return JSON.stringify({
		id,
		session_id: "s1",
		label,
		command: "bun run dev",
		cwd: "/work",
		port: 4173,
		path: "/",
		url: "http://127.0.0.1:4173/",
		relay_url: `/api/project-previews/${id}/relay/`,
		state,
		present: true,
		started_at: "2026-07-24T10:00:00.000Z",
		expires_at: "2026-07-24T14:00:00.000Z",
		logs: [],
	});
}

function queued(
	id: string,
	text: string,
	session_id = "s1",
): QueuedChatMessage {
	return { id, text, session_id, _sent: true };
}

function bottomRef() {
	return { current: null } as React.MutableRefObject<HTMLDivElement | null>;
}

type RenderListArgs = {
	messages?: ChatMessage[];
	chatQueue?: QueuedChatMessage[];
	sessionId?: string;
	sessionState?: "idle" | "running" | "error";
	runningTurnId?: string | null;
	hasOlderHistory?: boolean;
	isLoadingOlderHistory?: boolean;
	onLoadOlderHistory?: () => Promise<number>;
};

function listElement(args: RenderListArgs) {
	return (
		<MessageList
			messages={args.messages ?? []}
			chatQueue={args.chatQueue ?? []}
			sessionId={args.sessionId ?? "s1"}
			sessionState={args.sessionState ?? "running"}
			runningTurnId={args.runningTurnId ?? null}
			hasOlderHistory={args.hasOlderHistory}
			isLoadingOlderHistory={args.isLoadingOlderHistory}
			onLoadOlderHistory={args.onLoadOlderHistory}
			handleDecide={vi.fn()}
			handleSubmitAnswers={vi.fn()}
			handlePlanDecide={vi.fn()}
			handleCancelQueued={vi.fn()}
			handlePromoteQueued={vi.fn()}
			handleSteerQueued={vi.fn()}
			canSteerQueued={true}
			bottomRef={bottomRef()}
		/>
	);
}

function renderList(args: RenderListArgs) {
	return render(listElement(args));
}

describe("MessageList — orphan queue rendering", () => {
	it("renders a queued msg from chatQueue when it is not in the transcript (post-nav remount case)", () => {
		// Reducer is empty (DB load returned nothing for the not-yet-running turn);
		// chatQueue still has the queued item.
		renderList({
			messages: [],
			chatQueue: [queued("q1", "do this thing")],
			sessionState: "idle",
		});
		expect(screen.getByText("do this thing")).toBeTruthy();
		// Labeled Q1 (queued, index 0).
		expect(screen.getByText("Q1")).toBeTruthy();
	});

	it("does not double-render a queued msg already in the transcript (live case, id matches)", () => {
		// Live case: synthetic user_message dispatched ADD_USER with id === queue.id.
		renderList({
			messages: [userMsg("q1", "hello")],
			chatQueue: [queued("q1", "hello")],
			sessionState: "running",
			runningTurnId: "q1",
		});
		// Exactly one occurrence of the text.
		expect(screen.getAllByText("hello")).toHaveLength(1);
	});

	it("skips the running turn even when ids do not match (post-nav remount during running)", () => {
		// DB-loaded user row has a fresh uid; chatQueue still carries the queue id.
		// Without the runningTurnId guard this would render twice.
		renderList({
			messages: [userMsg("db-uid-xyz", "running prompt")],
			chatQueue: [queued("turn-id-1", "running prompt")],
			sessionState: "running",
			runningTurnId: "turn-id-1",
		});
		expect(screen.getAllByText("running prompt")).toHaveLength(1);
	});

	it("renders orphan queued msgs after transcript messages", () => {
		renderList({
			messages: [userMsg("first", "old turn")],
			chatQueue: [queued("q1", "pending turn")],
			sessionState: "idle",
		});
		// Both visible.
		const old = screen.getByText("old turn");
		const pending = screen.getByText("pending turn");
		// Pending should appear later in document order than the transcript msg.
		expect(
			old.compareDocumentPosition(pending) & Node.DOCUMENT_POSITION_FOLLOWING,
		).toBeTruthy();
	});

	it("filters chatQueue items belonging to other sessions", () => {
		renderList({
			messages: [],
			chatQueue: [
				queued("q1", "this session", "s1"),
				queued("q2", "other session", "s2"),
			],
			sessionId: "s1",
		});
		expect(screen.getByText("this session")).toBeTruthy();
		expect(screen.queryByText("other session")).toBeNull();
	});

	it("renders multiple orphans with sequential Q1, Q2 labels", () => {
		renderList({
			messages: [],
			chatQueue: [queued("q1", "first queued"), queued("q2", "second queued")],
			sessionState: "idle",
		});
		expect(screen.getByText("first queued")).toBeTruthy();
		expect(screen.getByText("second queued")).toBeTruthy();
		expect(screen.getByText("Q1")).toBeTruthy();
		expect(screen.getByText("Q2")).toBeTruthy();
	});

	it("hides steering for a queued payload the server marked unsafe", () => {
		renderList({
			messages: [],
			chatQueue: [{ ...queued("q1", "attached context"), steerable: false }],
			sessionState: "running",
			runningTurnId: "running",
		});
		expect(
			screen.queryByRole("button", { name: /steer current run/i }),
		).toBeNull();
		expect(
			screen.getByRole("button", { name: /send queued message/i }),
		).toBeTruthy();
	});

	it("renders nothing extra when chatQueue is empty", () => {
		renderList({
			messages: [userMsg("u1", "only msg")],
			chatQueue: [],
		});
		expect(screen.getAllByText("only msg")).toHaveLength(1);
		expect(screen.queryByText(/^Q\d/)).toBeNull();
	});

	it("marks a promoted follow-up as pending instead of leaving queued actions active", () => {
		renderList({
			messages: [userMsg("q1", "run this next")],
			chatQueue: [{ ...queued("q1", "run this next"), _promoting: true }],
			runningTurnId: "old-turn",
		});
		expect(screen.getByText("run this next").dataset.queueState).toBe(
			"promoting",
		);
	});
});

describe("MessageList — workflow approval placement", () => {
	it("attributes a pending child approval to its owning workflow", () => {
		const workflow = assistantMsg("assistant-1", 0);
		workflow.toolEvents = [
			{
				type: "tool_event",
				id: "workflow-event",
				name: "Workflow",
				input: {},
				subagent: {
					provider: "claude",
					agentId: "workflow-1",
					kind: "workflow",
					name: "Repository audit",
					status: "running",
					startedAtMs: 1,
				},
			},
			{
				type: "tool_event",
				id: "child-event",
				name: "Task",
				input: {},
				subagent: {
					provider: "claude",
					agentId: "child-1",
					parentActivityId: "workflow-1",
					name: "Reader",
					status: "running",
					startedAtMs: 1,
				},
			},
		];
		renderList({
			messages: [
				workflow,
				{
					id: "approval-1",
					role: "permission",
					toolName: "Bash",
					title: "Claude requests Shell command",
					requester: {
						providerId: "claude",
						agentId: "child-1",
					},
					decision: "pending",
				},
			],
		});

		expect(
			screen.getByTestId("message-assistant-1").dataset.workflowApprovalCount,
		).toBe("1");
		expect(
			screen.getByTestId("message-approval-1").dataset.embeddedPermission,
		).toBe("true");
		expect(
			screen.getByTestId("message-approval-1").dataset.requesterCount,
		).toBe("2");
	});
});

describe("MessageList — bounded history rendering", () => {
	it("renders the latest 100 messages and reveals older history", () => {
		const messages = Array.from({ length: 101 }, (_, index) =>
			userMsg(`u${index}`, `message ${index}`),
		);
		renderList({ messages });

		expect(screen.queryByText("message 0")).toBeNull();
		expect(screen.getByText("message 1")).toBeTruthy();
		expect(screen.getByText("message 100")).toBeTruthy();

		fireEvent.click(screen.getByRole("button", { name: "Load 1 older" }));
		expect(screen.getByText("message 0")).toBeTruthy();
		expect(screen.queryByRole("button", { name: /load .* older/i })).toBeNull();
	});

	it("expands a cursor render window by the returned page size and caps later live growth", async () => {
		const latest = Array.from({ length: 100 }, (_, index) =>
			userMsg(`u${index + 50}`, `message ${index + 50}`),
		);
		let resolvePage!: (count: number) => void;
		const onLoadOlderHistory = vi.fn(
			() =>
				new Promise<number>((resolve) => {
					resolvePage = resolve;
				}),
		);
		const view = renderList({
			messages: latest,
			hasOlderHistory: true,
			onLoadOlderHistory,
		});

		fireEvent.click(screen.getByRole("button", { name: "Load 100 older" }));
		expect(onLoadOlderHistory).toHaveBeenCalledOnce();

		// The reducer prepends the fetched page before the async scroll-preserving
		// callback resolves. Its rows must already be inside the reserved window.
		const withFetchedPage = Array.from({ length: 150 }, (_, index) =>
			userMsg(`u${index}`, `message ${index}`),
		);
		view.rerender(
			listElement({
				messages: withFetchedPage,
				hasOlderHistory: false,
				isLoadingOlderHistory: true,
				onLoadOlderHistory,
			}),
		);
		expect(screen.getByText("message 0")).toBeTruthy();

		await act(async () => resolvePage(50));

		// The final cap is 100 + the 50 rows actually returned. A new live row
		// displaces the oldest rendered row instead of growing the DOM to 151.
		const withLiveGrowth = [...withFetchedPage, userMsg("u150", "message 150")];
		view.rerender(
			listElement({
				messages: withLiveGrowth,
				hasOlderHistory: false,
				onLoadOlderHistory,
			}),
		);
		expect(screen.queryByText("message 0")).toBeNull();
		expect(screen.getByText("message 1")).toBeTruthy();
		expect(screen.getByText("message 150")).toBeTruthy();
	});

	it("keeps cursor-loaded transcripts bounded before another server page is requested", () => {
		const messages = Array.from({ length: 101 }, (_, index) =>
			userMsg(`u${index}`, `message ${index}`),
		);
		const onLoadOlderHistory = vi.fn().mockResolvedValue(100);
		renderList({ messages, hasOlderHistory: true, onLoadOlderHistory });

		expect(screen.queryByText("message 0")).toBeNull();
		expect(screen.getByText("message 1")).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: "Load 1 older" }));
		expect(screen.getByText("message 0")).toBeTruthy();
		expect(onLoadOlderHistory).not.toHaveBeenCalled();
	});

	it("disables the older-page control while its cursor request is in flight", () => {
		renderList({
			messages: [userMsg("u1", "message")],
			hasOlderHistory: true,
			isLoadingOlderHistory: true,
			onLoadOlderHistory: vi.fn().mockResolvedValue(0),
		});

		expect(
			(
				screen.getByRole("button", {
					name: "Loading older",
				}) as HTMLButtonElement
			).disabled,
		).toBe(true);
	});
});

describe("MessageList — bounded tool rendering", () => {
	it("keeps durable Hlid children at the session bottom after Preview activity", () => {
		const start = previewAssistantMsg("start", "start_project_preview");
		start.toolEvents[0] = {
			...start.toolEvents[0],
			result: previewResult("active-preview", "ready", "Active"),
		};
		projectPreviewState.live = JSON.parse(start.toolEvents[0].result ?? "null");
		const { container } = renderList({
			messages: [start],
		});

		const message = screen.getByTestId("message-start");
		const preview = screen.getByTestId("preview-activity");
		const children = screen.getByTestId("hlid-children");
		expect(
			message.compareDocumentPosition(preview) &
				Node.DOCUMENT_POSITION_FOLLOWING,
		).toBeTruthy();
		expect(
			preview.compareDocumentPosition(children) &
				Node.DOCUMENT_POSITION_FOLLOWING,
		).toBeTruthy();
		expect(children.dataset.sessionId).toBe("s1");
		expect(children.nextElementSibling).toBe(container.lastElementChild);
	});

	it("collects Preview calls from multiple turns into one session card", () => {
		const start = previewAssistantMsg("start", "start_project_preview");
		start.toolEvents[0] = {
			...start.toolEvents[0],
			result: previewResult("active-preview", "ready", "Active"),
		};
		projectPreviewState.live = JSON.parse(start.toolEvents[0].result ?? "null");
		renderList({
			messages: [
				start,
				previewAssistantMsg("capture", "capture_project_preview"),
			],
		});

		expect(screen.getAllByTestId("preview-activity")).toHaveLength(1);
		expect(screen.getByTestId("preview-activity").dataset.count).toBe("2");
		expect(screen.getByTestId("message-start").dataset.previewGrouped).toBe(
			"2",
		);
		expect(screen.getByTestId("message-capture").dataset.previewGrouped).toBe(
			"2",
		);
	});

	it("returns a stopped Preview card to transcript order when a new one starts", () => {
		const old = previewAssistantMsg("old", "start_project_preview");
		old.toolEvents[0] = {
			...old.toolEvents[0],
			result: previewResult("old-preview", "ready", "Old"),
		};
		const stopped = previewAssistantMsg("stopped", "capture_project_preview");
		stopped.toolEvents[0] = {
			...stopped.toolEvents[0],
			name: "mcp__hlid__stop_project_preview",
			result: previewResult("old-preview", "stopped", "Old"),
		};
		const current = previewAssistantMsg("current", "start_project_preview");
		current.toolEvents[0] = {
			...current.toolEvents[0],
			result: previewResult("new-preview", "ready", "New"),
		};
		projectPreviewState.live = JSON.parse(
			current.toolEvents[0].result ?? "null",
		);

		renderList({ messages: [old, stopped, current] });

		expect(screen.getByTestId("preview-activity").dataset.count).toBe("1");
		expect(screen.getByTestId("message-old").dataset.previewHistory).toBe("1");
		expect(screen.getByTestId("message-stopped").dataset.previewGrouped).toBe(
			"2",
		);
		expect(screen.getByTestId("message-current").dataset.previewGrouped).toBe(
			"2",
		);
	});

	it("does not pin an interrupted Preview card when the session resumes", () => {
		const interrupted = previewAssistantMsg(
			"interrupted",
			"start_project_preview",
		);
		const resumed = {
			...assistantMsg("resumed", 0),
			streaming: true,
		};

		renderList({
			messages: [interrupted, resumed],
			sessionState: "running",
		});

		expect(screen.queryByTestId("preview-activity")).toBeNull();
		expect(
			screen.getByTestId("message-interrupted").dataset.previewHistory,
		).toBe("1");
	});

	it("allocates the latest 200 tool calls across assistant messages", () => {
		renderList({
			messages: [
				userMsg("first", "first submission"),
				assistantMsg("older", 150),
				assistantMsg("newer", 150),
			],
		});

		expect(screen.getByTestId("message-older").dataset.toolEventStart).toBe(
			"100",
		);
		expect(screen.getByTestId("message-newer").dataset.toolEventStart).toBe(
			"0",
		);
		const reveal = screen.getByRole("button", {
			name: "Show 100 earlier tool calls",
		});
		expect(reveal.closest("[data-testid]")).toBe(
			screen.getByTestId("message-older"),
		);
		expect(
			screen.getByText("first submission").compareDocumentPosition(reveal) &
				Node.DOCUMENT_POSITION_FOLLOWING,
		).toBeTruthy();
		fireEvent.click(reveal);
		expect(screen.getByTestId("message-older").dataset.toolEventStart).toBe(
			"0",
		);
		expect(
			screen.queryByRole("button", { name: /earlier tool calls/i }),
		).toBeNull();
	});

	it("folds a steer into a response without losing its 200-tool boundary", () => {
		const original = userMsg("original", "first submission");
		const response = {
			...assistantMsg("response", 250),
			turnId: "original",
		};
		const steer = userMsg("steer", "change direction");
		const messages = reducer([original, response, steer], {
			type: "STEER_USER",
			turnId: "steer",
			targetTurnId: "original",
			assistantId: "response",
		});
		const view = renderList({ messages });

		const responseRow = screen.getByTestId("message-response");
		expect(screen.queryByTestId("message-steer")).toBeNull();
		expect(responseRow.dataset.acceptedSteers).toBe("steer");
		expect(responseRow.dataset.steerBoundaries).toBe("250");
		expect(responseRow.dataset.toolEventStart).toBe("50");

		const updatedResponse = {
			...response,
			toolEvents: [
				...response.toolEvents,
				...assistantMsg("later", 10).toolEvents,
			],
		};
		view.rerender(
			listElement({
				messages: messages.map((message) =>
					message.id === "response" ? updatedResponse : message,
				),
			}),
		);

		const updatedRow = screen.getByTestId("message-response");
		expect(screen.queryByTestId("message-steer")).toBeNull();
		expect(updatedRow.dataset.acceptedSteers).toBe("steer");
		expect(updatedRow.dataset.steerBoundaries).toBe("250");
		expect(updatedRow.dataset.toolEventStart).toBe("60");
	});

	it("associates a steer before applying the 100-row render window", () => {
		const response = {
			...assistantMsg("response", 0),
			turnId: "original",
			transcriptSeq: 2,
		};
		const steer: UserMessage = {
			...userMsg("steer", "change direction"),
			steerTargetSeq: 2,
			steerToolEventIndex: 0,
			transcriptSeq: 3,
		};
		const newer = Array.from({ length: 99 }, (_, index) =>
			userMsg(`newer-${index}`, `newer ${index}`),
		);

		renderList({
			messages: [
				userMsg("original", "first submission"),
				steer,
				response,
				...newer,
			],
		});

		expect(screen.queryByTestId("message-original")).toBeNull();
		expect(screen.queryByTestId("message-steer")).toBeNull();
		expect(screen.getByTestId("message-response").dataset.acceptedSteers).toBe(
			"steer",
		);
	});

	it("orders multiple accepted steers by persisted steering sequence", () => {
		const response = {
			...assistantMsg("response", 1),
			turnId: "original",
			transcriptSeq: 2,
		};
		const laterSteer: UserMessage = {
			...userMsg("steer-later", "second direction"),
			steerTargetSeq: 2,
			steerToolEventIndex: 1,
			transcriptSeq: 4,
		};
		const earlierSteer: UserMessage = {
			...userMsg("steer-earlier", "first direction"),
			steerTargetSeq: 2,
			steerToolEventIndex: 1,
			transcriptSeq: 3,
		};

		renderList({
			messages: [
				userMsg("original", "first submission"),
				laterSteer,
				earlierSteer,
				response,
			],
		});

		expect(screen.getByTestId("message-response").dataset.acceptedSteers).toBe(
			"steer-earlier,steer-later",
		);
	});

	it("folds a late steer into its exact old response instead of the active one", () => {
		const oldResponse = {
			...assistantMsg("old-response", 1),
			turnId: "old-turn",
			transcriptSeq: 10,
		};
		const activeResponse = {
			...assistantMsg("active-response", 1),
			turnId: "active-turn",
			transcriptSeq: 20,
			streaming: true,
		};
		const messages = reducer(
			[
				userMsg("old-turn", "old prompt"),
				oldResponse,
				userMsg("active-turn", "active prompt"),
				activeResponse,
				userMsg("late-steer", "change the old response"),
			],
			{
				type: "STEER_USER",
				turnId: "late-steer",
				targetTurnId: "old-turn",
				targetAssistantSeq: 10,
				steerSeq: 30,
				steerToolEventIndex: 1,
				assistantId: "active-response",
			},
		);

		renderList({ messages });

		expect(screen.queryByTestId("message-late-steer")).toBeNull();
		expect(
			screen.getByTestId("message-old-response").dataset.acceptedSteers,
		).toBe("late-steer");
		expect(
			screen.getByTestId("message-active-response").dataset.acceptedSteers,
		).toBeUndefined();
	});

	it("falls back to the exact live turn when its persisted sequence is not mounted", () => {
		const liveResponse = {
			...assistantMsg("live-response", 0),
			turnId: "original-turn",
			streaming: true,
		};
		const steer: UserMessage = {
			...userMsg("steer", "change direction"),
			steerTargetSeq: 999,
			steerTargetTurnId: "original-turn",
			steerToolEventIndex: 0,
		};

		renderList({ messages: [liveResponse, steer] });

		expect(screen.queryByTestId("message-steer")).toBeNull();
		expect(
			screen.getByTestId("message-live-response").dataset.acceptedSteers,
		).toBe("steer");
	});

	it("does not render an accepted steer as a user row while its target page is hidden", () => {
		const steer: UserMessage = {
			...userMsg("steer", "change direction"),
			steerTargetSeq: 999,
			steerToolEventIndex: 0,
		};

		const view = renderList({ messages: [steer] });

		expect(screen.queryByTestId("message-steer")).toBeNull();

		const target = {
			...assistantMsg("older-target", 0),
			transcriptSeq: 999,
		};
		view.rerender(listElement({ messages: [target, steer] }));

		expect(screen.queryByTestId("message-steer")).toBeNull();
		expect(
			screen.getByTestId("message-older-target").dataset.acceptedSteers,
		).toBe("steer");
	});

	it("keeps the permission lookup stable across unrelated streaming updates", () => {
		const permission = {
			id: "tool-1",
			role: "permission" as const,
			toolName: "Read",
			title: "",
			decision: "approved" as const,
		};
		const assistant = assistantMsg("assistant", 1);
		const { result, rerender } = renderHook(
			({ messages }: { messages: ChatMessage[] }) =>
				useMessageListView({
					messages,
					chatQueue: [],
					sessionId: "s1",
					sessionState: "running",
					runningTurnId: null,
				}),
			{ initialProps: { messages: [permission, assistant] } },
		);
		const firstLookup = result.current.permissionLabels;

		rerender({
			messages: [
				permission,
				{ ...assistant, text: "assistant streaming update", streaming: true },
			],
		});

		expect(result.current.permissionLabels).toBe(firstLookup);
	});
});
