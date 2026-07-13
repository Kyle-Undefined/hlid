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
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as privacyStore from "#/hooks/privacyStore";
import type { QueuedChatMessage } from "#/hooks/wsStore";
import type { ChatMessage, UserMessage } from "./chatReducer";
import { MessageList } from "./MessageList";

vi.mock("./ChatMessageRow", () => ({
	ChatMessageRow: ({ message }: { message: ChatMessage }) => (
		<div>{"text" in message ? message.text : message.id}</div>
	),
}));

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

function renderList(args: {
	messages?: ChatMessage[];
	chatQueue?: QueuedChatMessage[];
	sessionId?: string;
	sessionState?: "idle" | "running" | "error";
	runningTurnId?: string | null;
}) {
	return render(
		<MessageList
			messages={args.messages ?? []}
			chatQueue={args.chatQueue ?? []}
			sessionId={args.sessionId ?? "s1"}
			sessionState={args.sessionState ?? "running"}
			runningTurnId={args.runningTurnId ?? null}
			handleDecide={vi.fn()}
			handleSubmitAnswers={vi.fn()}
			handlePlanDecide={vi.fn()}
			handleCancelQueued={vi.fn()}
			handlePromoteQueued={vi.fn()}
			bottomRef={bottomRef()}
		/>,
	);
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
});

describe("MessageList — bounded history rendering", () => {
	it("renders the latest 200 messages and reveals older history", () => {
		const messages = Array.from({ length: 201 }, (_, index) =>
			userMsg(`u${index}`, `message ${index}`),
		);
		renderList({ messages });

		expect(screen.queryByText("message 0")).toBeNull();
		expect(screen.getByText("message 1")).toBeTruthy();
		expect(screen.getByText("message 200")).toBeTruthy();

		fireEvent.click(screen.getByRole("button", { name: "Load 1 older" }));
		expect(screen.getByText("message 0")).toBeTruthy();
		expect(screen.queryByRole("button", { name: /load .* older/i })).toBeNull();
	});
});
