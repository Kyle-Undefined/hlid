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
import { MessageList } from "./MessageList";
import { useMessageListView } from "./useMessageListView";

vi.mock("#/hooks/projectPreviewStore", () => ({
	useProjectPreview: () => null,
}));
vi.mock("./ChatMessageRow", () => ({
	ChatMessageRow: ({
		message,
		queueState,
		toolEventStartIndex,
		olderToolEventCount,
		onLoadOlderToolEvents,
		groupedProjectPreviewEventIds,
		historicalProjectPreviewGroups,
	}: {
		message: ChatMessage;
		queueState?: { kind: string };
		toolEventStartIndex?: number;
		olderToolEventCount?: number;
		onLoadOlderToolEvents?: () => void;
		groupedProjectPreviewEventIds?: ReadonlySet<string>;
		historicalProjectPreviewGroups?: ReadonlyMap<string, unknown[]>;
	}) => (
		<div
			data-testid={`message-${message.id}`}
			data-queue-state={queueState?.kind}
			data-tool-event-start={toolEventStartIndex}
			data-preview-grouped={String(groupedProjectPreviewEventIds?.size ?? 0)}
			data-preview-history={String(historicalProjectPreviewGroups?.size ?? 0)}
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
	it("collects Preview calls from multiple turns into one session card", () => {
		renderList({
			messages: [
				previewAssistantMsg("start", "start_project_preview"),
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
		const previewResult = (
			id: string,
			state: "ready" | "stopped",
			label: string,
		) =>
			JSON.stringify({
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
