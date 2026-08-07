import { describe, expect, it } from "vitest";
import type { ChatMessage } from "./chatReducer";
import { reducer } from "./chatReducer";

// ── helpers ───────────────────────────────────────────────────────────────────

function empty(): ChatMessage[] {
	return [];
}

function withUser(id = "u1", text = "hello"): ChatMessage[] {
	return reducer(empty(), { type: "ADD_USER", id, text });
}

function withAssistant(id = "a1"): ChatMessage[] {
	return reducer(empty(), { type: "ADD_ASSISTANT", id });
}

// ── ADD_USER ──────────────────────────────────────────────────────────────────

describe("ADD_USER", () => {
	it("appends a user message", () => {
		const state = reducer(empty(), {
			type: "ADD_USER",
			id: "u1",
			text: "hi there",
		});
		expect(state).toHaveLength(1);
		expect(state[0]).toMatchObject({
			id: "u1",
			role: "user",
			text: "hi there",
		});
	});

	it("preserves attachments", () => {
		const state = reducer(empty(), {
			type: "ADD_USER",
			id: "u1",
			text: "attach",
			attachments: [
				{
					id: "att1",
					path: "/tmp/f.png",
					filename: "f.png",
					mime: "image/png",
					kind: "ephemeral",
				},
			],
		});
		expect((state[0] as { attachments?: unknown[] }).attachments).toHaveLength(
			1,
		);
	});

	it("ignores a repeated user message with the same turn id", () => {
		const initial = withUser("u1", "queued prompt");
		const state = reducer(initial, {
			type: "ADD_USER",
			id: "u1",
			text: "queued prompt",
		});
		expect(state).toBe(initial);
		expect(state).toHaveLength(1);
	});

	it("restores a late running prompt before its correlated assistant", () => {
		const assistant = {
			...withAssistant("assistant")[0],
			turnId: "queued-turn",
		} as ChatMessage;
		const state = reducer([assistant], {
			type: "ADD_USER",
			id: "queued-turn",
			text: "queued prompt",
		});

		expect(state.map((message) => message.id)).toEqual([
			"queued-turn",
			"assistant",
		]);
	});

	it("does not mutate previous state", () => {
		const initial = empty();
		reducer(initial, { type: "ADD_USER", id: "x", text: "x" });
		expect(initial).toHaveLength(0);
	});
});

describe("MARK_USER_CONTEXT_RECEIPT", () => {
	it("makes a completed live turn inspectable without a history reload", () => {
		const initial = withUser("turn-1", "inspect me");
		const state = reducer(initial, {
			type: "MARK_USER_CONTEXT_RECEIPT",
			id: "turn-1",
		});
		expect(state[0]).toMatchObject({
			id: "turn-1",
			role: "user",
			hasContextReceipt: true,
		});
		expect(initial[0]).not.toHaveProperty("hasContextReceipt");
	});
});

// ── ADD_ASSISTANT ─────────────────────────────────────────────────────────────

describe("Raven Live transcript", () => {
	it("appends provisional deltas into one ordinary user bubble", () => {
		let state = reducer(empty(), {
			type: "UPSERT_REALTIME_TRANSCRIPT",
			id: "utterance-user-1",
			role: "user",
			text: "Hello ",
			done: false,
			realtimeSessionId: "realtime-1",
			transcriptSeq: 4,
			forkSupported: false,
		});
		state = reducer(state, {
			type: "UPSERT_REALTIME_TRANSCRIPT",
			id: "utterance-user-1",
			role: "user",
			text: "Raven",
			done: false,
			realtimeSessionId: "realtime-1",
			transcriptSeq: 4,
			forkSupported: false,
		});

		expect(state).toHaveLength(1);
		expect(state[0]).toMatchObject({
			id: "utterance-user-1",
			role: "user",
			text: "Hello Raven",
			streaming: true,
			source: "codex_realtime",
			utteranceId: "utterance-user-1",
			realtimeSessionId: "realtime-1",
			transcriptSeq: 4,
			forkSupported: false,
		});
	});

	it("replaces provisional text with the authoritative final assistant row", () => {
		let state = reducer(empty(), {
			type: "UPSERT_REALTIME_TRANSCRIPT",
			id: "utterance-assistant-1",
			role: "assistant",
			text: "Hi K",
			done: false,
			realtimeSessionId: "realtime-1",
			transcriptSeq: 5,
		});
		state = reducer(state, {
			type: "UPSERT_REALTIME_TRANSCRIPT",
			id: "utterance-assistant-1",
			role: "assistant",
			text: "Hi, Kyle.",
			done: true,
			realtimeSessionId: "realtime-1",
			transcriptSeq: 5,
			dbId: 42,
			forkSupported: false,
		});

		expect(state).toHaveLength(1);
		expect(state[0]).toMatchObject({
			id: "utterance-assistant-1",
			role: "assistant",
			text: "Hi, Kyle.",
			streaming: false,
			dbId: 42,
			transcriptSeq: 5,
			forkSupported: false,
			cost: null,
			toolEvents: [],
		});
	});

	it("removes only the matching provisional bubble for an empty final", () => {
		const settled = reducer(empty(), {
			type: "UPSERT_REALTIME_TRANSCRIPT",
			id: "settled",
			role: "assistant",
			text: "Keep me",
			done: true,
		});
		const provisional = reducer(settled, {
			type: "UPSERT_REALTIME_TRANSCRIPT",
			id: "private-utterance",
			role: "user",
			text: "private partial",
			done: false,
		});
		const state = reducer(provisional, {
			type: "UPSERT_REALTIME_TRANSCRIPT",
			id: "private-utterance",
			role: "user",
			text: "   ",
			done: true,
		});

		expect(state.map((message) => message.id)).toEqual(["settled"]);
	});

	it("settles an empty Live assistant bubble when it owns tool activity", () => {
		let state = reducer(empty(), {
			type: "UPSERT_REALTIME_TRANSCRIPT",
			id: "utterance-assistant-tools",
			role: "assistant",
			text: "",
			done: false,
			realtimeSessionId: "realtime-1",
			transcriptSeq: 5,
		});
		state = reducer(state, {
			type: "ADD_TOOL_EVENT",
			id: "utterance-assistant-tools",
			event: {
				type: "tool_event",
				id: "tool-1",
				name: "hlid_help",
				input: { topic: "voice_audio" },
			},
		});
		state = reducer(state, {
			type: "UPSERT_REALTIME_TRANSCRIPT",
			id: "utterance-assistant-tools",
			role: "assistant",
			text: "",
			done: true,
			realtimeSessionId: "realtime-1",
			transcriptSeq: 5,
			dbId: 44,
			forkSupported: false,
		});

		expect(state).toHaveLength(1);
		expect(state[0]).toMatchObject({
			id: "utterance-assistant-tools",
			role: "assistant",
			text: "",
			streaming: false,
			dbId: 44,
			toolEvents: [expect.objectContaining({ id: "tool-1" })],
		});
	});

	it("does not duplicate repeated finals or regress for a delayed partial", () => {
		const final = reducer(empty(), {
			type: "UPSERT_REALTIME_TRANSCRIPT",
			id: "utterance-user-1",
			role: "user",
			text: "Final words",
			done: true,
			dbId: 9,
		});
		const repeated = reducer(final, {
			type: "UPSERT_REALTIME_TRANSCRIPT",
			id: "utterance-user-1",
			role: "user",
			text: "Final words",
			done: true,
			dbId: 9,
		});
		const delayed = reducer(repeated, {
			type: "UPSERT_REALTIME_TRANSCRIPT",
			id: "utterance-user-1",
			role: "user",
			text: " stale",
			done: false,
		});

		expect(repeated).toBe(final);
		expect(delayed).toBe(final);
		expect(delayed[0]).toMatchObject({ text: "Final words", streaming: false });
	});

	it("drops only provisional bubbles for the closed realtime session", () => {
		const first = reducer(empty(), {
			type: "UPSERT_REALTIME_TRANSCRIPT",
			id: "partial-1",
			role: "user",
			text: "First",
			done: false,
			realtimeSessionId: "realtime-1",
		});
		const second = reducer(first, {
			type: "UPSERT_REALTIME_TRANSCRIPT",
			id: "partial-2",
			role: "assistant",
			text: "Second",
			done: false,
			realtimeSessionId: "realtime-2",
		});
		const state = reducer(second, {
			type: "DISCARD_REALTIME_PARTIALS",
			realtimeSessionId: "realtime-1",
		});

		expect(state.map((message) => message.id)).toEqual(["partial-2"]);
	});

	it("lets durable history settle the matching provisional bubble", () => {
		const provisional = reducer(empty(), {
			type: "UPSERT_REALTIME_TRANSCRIPT",
			id: "utterance-user-1",
			role: "user",
			text: "Provisional",
			done: false,
		});
		const hydrated = reducer(provisional, {
			type: "HYDRATE_HISTORY",
			items: [
				{
					kind: "message",
					id: "utterance-user-1",
					role: "user",
					text: "Persisted final",
					dbId: 27,
					seq: 8,
					source: "codex_realtime",
					utteranceId: "utterance-user-1",
					forkSupported: false,
				},
			],
		});

		expect(hydrated).toHaveLength(1);
		expect(hydrated[0]).toMatchObject({
			text: "Persisted final",
			streaming: false,
			dbId: 27,
			transcriptSeq: 8,
		});
	});

	it("keeps newer Live tool state when delayed history hydrates the bubble", () => {
		let state = reducer(empty(), {
			type: "UPSERT_REALTIME_TRANSCRIPT",
			id: "utterance-assistant-tools",
			role: "assistant",
			text: "",
			done: false,
		});
		state = reducer(state, {
			type: "ADD_TOOL_EVENT",
			id: "utterance-assistant-tools",
			event: {
				type: "tool_event",
				id: "live-tool-1",
				name: "hlid_help",
				input: { topic: "voice_audio" },
			},
		});
		state = reducer(state, {
			type: "ADD_TOOL_RESULT",
			toolUseId: "live-tool-1",
			content: "new result",
		});

		const hydrated = reducer(state, {
			type: "HYDRATE_HISTORY",
			items: [
				{
					kind: "message",
					id: "utterance-assistant-tools",
					role: "assistant",
					text: "Finished",
					source: "codex_realtime",
					utteranceId: "utterance-assistant-tools",
					toolEvents: [
						{
							type: "tool_event",
							id: "live-tool-1",
							name: "hlid_help",
							input: { topic: "voice_audio" },
							result: "stale result",
						},
					],
				},
			],
		});

		expect(hydrated[0]).toMatchObject({
			text: "Finished",
			streaming: false,
			toolEvents: [expect.objectContaining({ result: "new result" })],
		});
	});
});

describe("ADD_ASSISTANT", () => {
	it("appends an assistant message in streaming state", () => {
		const state = reducer(empty(), { type: "ADD_ASSISTANT", id: "a1" });
		expect(state).toHaveLength(1);
		expect(state[0]).toMatchObject({
			id: "a1",
			role: "assistant",
			text: "",
			streaming: true,
			cost: null,
			toolEvents: [],
		});
	});

	it("retains the user turn that opened a live response", () => {
		const state = reducer(withUser("u1", "start"), {
			type: "ADD_ASSISTANT",
			id: "a1",
			afterUserId: "u1",
		});
		expect(state[1]).toMatchObject({
			id: "a1",
			role: "assistant",
			turnId: "u1",
		});
	});
});

describe("STEER_USER", () => {
	it("moves an accepted steer immediately before the active response", () => {
		const state: ChatMessage[] = [
			...withUser("original", "first prompt"),
			...withAssistant("assistant"),
			...withUser("steer", "updated direction"),
		];
		const steered = reducer(state, {
			type: "STEER_USER",
			turnId: "steer",
			assistantId: "assistant",
		});
		expect(steered.map((message) => message.id)).toEqual([
			"original",
			"steer",
			"assistant",
		]);
	});

	it("preserves the order of multiple accepted steers", () => {
		const state: ChatMessage[] = [
			...withUser("original", "first prompt"),
			...withUser("steer-1", "first update"),
			...withAssistant("assistant"),
			...withUser("steer-2", "second update"),
		];
		const steered = reducer(state, {
			type: "STEER_USER",
			turnId: "steer-2",
			assistantId: "assistant",
		});
		expect(steered.map((message) => message.id)).toEqual([
			"original",
			"steer-1",
			"steer-2",
			"assistant",
		]);
	});

	it("restores persisted steer order when acknowledgements arrive in reverse", () => {
		let state = reducer(empty(), {
			type: "ADD_USER",
			id: "original",
			text: "first prompt",
		});
		state = reducer(state, {
			type: "ADD_ASSISTANT",
			id: "assistant",
			afterUserId: "original",
		});
		state = reducer(state, {
			type: "ADD_USER",
			id: "steer-1",
			text: "first update",
		});
		state = reducer(state, {
			type: "ADD_USER",
			id: "steer-2",
			text: "second update",
		});

		state = reducer(state, {
			type: "STEER_USER",
			turnId: "steer-2",
			targetTurnId: "original",
			steerSeq: 4,
			assistantId: "assistant",
		});
		state = reducer(state, {
			type: "STEER_USER",
			turnId: "steer-1",
			targetTurnId: "original",
			steerSeq: 3,
			assistantId: "assistant",
		});

		expect(state.map((message) => message.id)).toEqual([
			"original",
			"steer-1",
			"steer-2",
			"assistant",
		]);
		expect(
			state
				.filter((message) => message.role === "user")
				.map((message) => message.transcriptSeq),
		).toEqual([undefined, 3, 4]);
	});

	it("returns the same state when an accepted steer is already fully correlated", () => {
		const state: ChatMessage[] = [
			...withUser("original", "first prompt"),
			{
				id: "steer",
				role: "user",
				text: "updated direction",
				steerTargetTurnId: "original",
				steerToolEventIndex: 0,
			},
			{
				...withAssistant("assistant")[0],
				turnId: "original",
			} as ChatMessage,
		];
		expect(
			reducer(state, {
				type: "STEER_USER",
				turnId: "steer",
				targetTurnId: "original",
				assistantId: "assistant",
			}),
		).toBe(state);
	});

	it("pins the raw tool boundary when the steer is accepted", () => {
		const assistant = {
			...withAssistant("assistant")[0],
			turnId: "original",
			toolEvents: [
				{
					type: "tool_event" as const,
					id: "tool-before",
					name: "Read",
					input: {},
				},
			],
		} as ChatMessage;
		let state: ChatMessage[] = [
			...withUser("original", "first prompt"),
			assistant,
			...withUser("steer", "updated direction"),
		];
		state = reducer(state, {
			type: "STEER_USER",
			turnId: "steer",
			targetTurnId: "original",
			steerToolEventIndex: 1,
			assistantId: "assistant",
		});

		expect(state.find((message) => message.id === "steer")).toMatchObject({
			steerTargetTurnId: "original",
			steerToolEventIndex: 1,
		});

		state = reducer(state, {
			type: "ADD_TOOL_EVENT",
			id: "assistant",
			event: {
				type: "tool_event",
				id: "tool-after",
				name: "Read",
				input: {},
			},
		});
		expect(state.find((message) => message.id === "steer")).toMatchObject({
			steerToolEventIndex: 1,
		});
	});

	it("targets the exact completed turn instead of a newer active response", () => {
		const oldAssistant = {
			...withAssistant("old-assistant")[0],
			turnId: "original",
		} as ChatMessage;
		const newAssistant = {
			...withAssistant("new-assistant")[0],
			turnId: "new-turn",
		} as ChatMessage;
		const state: ChatMessage[] = [
			...withUser("original", "first prompt"),
			oldAssistant,
			...withUser("new-turn", "next prompt"),
			newAssistant,
			...withUser("steer", "updated direction"),
		];

		const steered = reducer(state, {
			type: "STEER_USER",
			turnId: "steer",
			targetTurnId: "original",
			assistantId: "new-assistant",
		});

		expect(steered.map((message) => message.id)).toEqual([
			"original",
			"steer",
			"old-assistant",
			"new-turn",
			"new-assistant",
		]);
	});

	it("does not attach an exact steer target to a known different turn", () => {
		const assistant = {
			...withAssistant("new-assistant")[0],
			turnId: "new-turn",
		} as ChatMessage;
		const state: ChatMessage[] = [
			...withUser("new-turn", "next prompt"),
			assistant,
			...withUser("steer", "updated direction"),
		];

		expect(
			reducer(state, {
				type: "STEER_USER",
				turnId: "steer",
				targetTurnId: "old-turn",
				assistantId: "new-assistant",
			}),
		).toBe(state);
	});

	it("targets a persisted assistant sequence when turn correlation is absent", () => {
		const oldAssistant = {
			...withAssistant("old-assistant")[0],
			transcriptSeq: 10,
		} as ChatMessage;
		const newAssistant = {
			...withAssistant("new-assistant")[0],
			transcriptSeq: 20,
		} as ChatMessage;
		const state: ChatMessage[] = [
			...withUser("original", "first prompt"),
			oldAssistant,
			...withUser("new-turn", "next prompt"),
			newAssistant,
			...withUser("steer", "updated direction"),
		];

		const steered = reducer(state, {
			type: "STEER_USER",
			turnId: "steer",
			targetAssistantSeq: 10,
			steerSeq: 30,
			assistantId: "new-assistant",
		});

		expect(steered.map((message) => message.id)).toEqual([
			"original",
			"steer",
			"old-assistant",
			"new-turn",
			"new-assistant",
		]);
		expect(steered[1]).toMatchObject({
			steerTargetSeq: 10,
			transcriptSeq: 30,
		});
	});

	it("does not fall back when an exact assistant sequence is absent", () => {
		const assistant = {
			...withAssistant("assistant")[0],
			transcriptSeq: 20,
		} as ChatMessage;
		const state: ChatMessage[] = [
			...withUser("turn", "prompt"),
			assistant,
			...withUser("steer", "updated direction"),
		];

		expect(
			reducer(state, {
				type: "STEER_USER",
				turnId: "steer",
				targetAssistantSeq: 10,
				steerSeq: 30,
				assistantId: "assistant",
			}),
		).toBe(state);
	});
});

describe("SET_ASSISTANT_TURN", () => {
	it("correlates a restored assistant row with the active user turn", () => {
		const state = reducer(withAssistant("a1"), {
			type: "SET_ASSISTANT_TURN",
			id: "a1",
			turnId: "u1",
		});
		expect(state[0]).toMatchObject({ id: "a1", turnId: "u1" });
	});
});

describe("RESUME_ASSISTANT", () => {
	it("restores streaming state on a persisted in-flight assistant", () => {
		const history = reducer(empty(), {
			type: "LOAD_HISTORY",
			items: [
				{
					kind: "message",
					id: "a1",
					role: "assistant",
					text: "partial response",
				},
			],
		});
		const state = reducer(history, { type: "RESUME_ASSISTANT", id: "a1" });
		const message = state[0];
		expect(message).toMatchObject({
			id: "a1",
			role: "assistant",
			text: "partial response",
			streaming: true,
		});
	});
});

// ── APPEND_CHUNK ──────────────────────────────────────────────────────────────

describe("APPEND_CHUNK", () => {
	it("appends text to the correct assistant message", () => {
		const state = reducer(withAssistant("a1"), {
			type: "APPEND_CHUNK",
			id: "a1",
			text: " world",
		});
		// biome-ignore lint/style/noNonNullAssertion: test knows message exists
		const msg = state.find((m) => m.id === "a1")!;
		expect(msg.role).toBe("assistant");
		if (msg.role === "assistant") expect(msg.text).toBe(" world");
	});

	it("does not affect other messages", () => {
		const initial = [...withAssistant("a1"), ...withAssistant("a2")];
		const state = reducer(initial, {
			type: "APPEND_CHUNK",
			id: "a1",
			text: "x",
		});
		// biome-ignore lint/style/noNonNullAssertion: test knows message exists
		const a2 = state.find((m) => m.id === "a2")!;
		if (a2.role === "assistant") expect(a2.text).toBe("");
	});

	it("accumulates multiple chunks", () => {
		let state = withAssistant("a1");
		state = reducer(state, { type: "APPEND_CHUNK", id: "a1", text: "foo" });
		state = reducer(state, { type: "APPEND_CHUNK", id: "a1", text: "bar" });
		const msg = state[0];
		if (msg.role === "assistant") expect(msg.text).toBe("foobar");
	});

	it("applies offset chunks idempotently across repeated replay", () => {
		let state = withAssistant("a1");
		for (const action of [
			{ type: "APPEND_CHUNK" as const, id: "a1", text: "Hello", offset: 0 },
			{ type: "APPEND_CHUNK" as const, id: "a1", text: " world", offset: 5 },
			{ type: "APPEND_CHUNK" as const, id: "a1", text: "Hello", offset: 0 },
			{ type: "APPEND_CHUNK" as const, id: "a1", text: " world", offset: 5 },
		]) {
			state = reducer(state, action);
		}
		const msg = state[0];
		if (msg.role === "assistant") expect(msg.text).toBe("Hello world");
	});

	it("appends only the unpersisted suffix of an overlapping chunk", () => {
		let state = withAssistant("a1");
		state = reducer(state, {
			type: "APPEND_CHUNK",
			id: "a1",
			text: "Hello wor",
		});
		state = reducer(state, {
			type: "APPEND_CHUNK",
			id: "a1",
			text: "world",
			offset: 6,
		});
		const msg = state[0];
		if (msg.role === "assistant") expect(msg.text).toBe("Hello world");
	});

	it("ignores id mismatch", () => {
		const state = reducer(withAssistant("a1"), {
			type: "APPEND_CHUNK",
			id: "wrong",
			text: "x",
		});
		const a1 = state[0];
		if (a1.role === "assistant") expect(a1.text).toBe("");
	});
});

describe("REPLACE_TEXT", () => {
	it("replaces arbitrary streamed text exactly and is idempotent", () => {
		let state = reducer(withAssistant("a1"), {
			type: "APPEND_CHUNK",
			id: "a1",
			text: "The start. Broken end.",
		});
		state = reducer(state, {
			type: "REPLACE_TEXT",
			id: "a1",
			text: "The start. Restored middle and end.",
		});
		state = reducer(state, {
			type: "REPLACE_TEXT",
			id: "a1",
			text: "The start. Restored middle and end.",
		});
		const msg = state[0];
		if (msg.role === "assistant") {
			expect(msg.text).toBe("The start. Restored middle and end.");
		}
	});
});

// ── ADD_TOOL_EVENT ────────────────────────────────────────────────────────────

describe("ADD_TOOL_EVENT", () => {
	it("adds tool event to the correct assistant message", () => {
		const state = reducer(withAssistant("a1"), {
			type: "ADD_TOOL_EVENT",
			id: "a1",
			event: {
				type: "tool_event",
				id: "te1",
				name: "Bash",
				input: { command: "ls" },
			},
		});
		const msg = state[0];
		if (msg.role === "assistant") {
			expect(msg.toolEvents).toHaveLength(1);
			expect(msg.toolEvents[0].name).toBe("Bash");
		}
	});

	it("does not duplicate a replayed tool event", () => {
		const event = {
			type: "tool_event" as const,
			id: "te1",
			name: "Bash",
			input: { command: "ls" },
		};
		let state = reducer(withAssistant("a1"), {
			type: "ADD_TOOL_EVENT",
			id: "a1",
			event,
		});
		state = reducer(state, {
			type: "ADD_TOOL_EVENT",
			id: "a1",
			event,
		});
		const msg = state[0];
		if (msg.role === "assistant") expect(msg.toolEvents).toHaveLength(1);
	});
});

describe("historical tool-event pages", () => {
	const tool = (id: string) => ({
		type: "tool_event" as const,
		id,
		name: "Read",
		input: {},
	});

	function pagedHistory(ids: string[], nextBeforeId: number | null) {
		return reducer(empty(), {
			type: "LOAD_HISTORY",
			items: [
				{
					kind: "message" as const,
					id: "a1",
					role: "assistant",
					text: "done",
					seq: 2,
					toolEvents: ids.map(tool),
					toolEventPage: {
						total: 4,
						errorCount: 1,
						hasEarlier: nextBeforeId !== null,
						nextBeforeId,
					},
				},
			],
		});
	}

	it("prepends unique rows only for the current cursor", () => {
		const initial = pagedHistory(["t3", "t4"], 30);
		const stale = reducer(initial, {
			type: "PREPEND_TOOL_EVENT_PAGE",
			id: "a1",
			expectedBeforeId: 29,
			events: [tool("t2")],
			page: {
				total: 4,
				errorCount: 1,
				hasEarlier: true,
				nextBeforeId: 20,
			},
		});
		expect(stale).toBe(initial);

		const next = reducer(initial, {
			type: "PREPEND_TOOL_EVENT_PAGE",
			id: "a1",
			expectedBeforeId: 30,
			events: [tool("t1"), tool("t2"), tool("t3")],
			page: {
				total: 4,
				errorCount: 1,
				hasEarlier: false,
				nextBeforeId: null,
			},
		});
		const message = next[0];
		expect(
			message.role === "assistant" ? message.toolEvents.map((e) => e.id) : [],
		).toEqual(["t1", "t2", "t3", "t4"]);
		expect(message).toMatchObject({
			toolEventPage: { hasEarlier: false, nextBeforeId: null },
		});
	});

	it("keeps an already revealed prefix across a reconnect snapshot", () => {
		const revealed = pagedHistory(["t1", "t2", "t3", "t4"], null);
		const refreshed = reducer(revealed, {
			type: "LOAD_HISTORY",
			preserveToolEventPages: true,
			items: [
				{
					kind: "message",
					id: "a1",
					role: "assistant",
					text: "fresh",
					seq: 2,
					toolEvents: [tool("t3"), { ...tool("t4"), result: "fresh" }],
					toolEventPage: {
						total: 4,
						errorCount: 1,
						hasEarlier: true,
						nextBeforeId: 30,
					},
				},
			],
		});
		const message = refreshed[0];
		expect(
			message.role === "assistant" ? message.toolEvents.map((e) => e.id) : [],
		).toEqual(["t1", "t2", "t3", "t4"]);
		expect(message).toMatchObject({
			text: "fresh",
			toolEvents: expect.arrayContaining([
				expect.objectContaining({ id: "t4", result: "fresh" }),
			]),
			toolEventPage: { hasEarlier: false, nextBeforeId: null },
		});
	});

	it("keeps a partially revealed prefix and its next cursor on reconnect", () => {
		const revealed = reducer(empty(), {
			type: "LOAD_HISTORY",
			items: [
				{
					kind: "message",
					id: "a1",
					role: "assistant",
					text: "done",
					seq: 2,
					toolEvents: Array.from({ length: 40 }, (_, index) =>
						tool(`t${index + 6}`),
					),
					toolEventPage: {
						total: 45,
						errorCount: 2,
						hasEarlier: true,
						nextBeforeId: 6,
					},
				},
			],
		});
		const refreshed = reducer(revealed, {
			type: "LOAD_HISTORY",
			preserveToolEventPages: true,
			items: [
				{
					kind: "message",
					id: "a1",
					role: "assistant",
					text: "fresh",
					seq: 2,
					toolEvents: Array.from({ length: 20 }, (_, index) =>
						tool(`t${index + 26}`),
					),
					toolEventPage: {
						total: 45,
						errorCount: 2,
						hasEarlier: true,
						nextBeforeId: 26,
					},
				},
			],
		});
		const message = refreshed[0];
		expect(
			message.role === "assistant" ? message.toolEvents.map((e) => e.id) : [],
		).toEqual(Array.from({ length: 40 }, (_, index) => `t${index + 6}`));
		expect(message).toMatchObject({
			text: "fresh",
			toolEventPage: {
				total: 45,
				hasEarlier: true,
				nextBeforeId: 6,
			},
		});
	});
});

// ── ADD_TOOL_RESULT ───────────────────────────────────────────────────────────

describe("ADD_TOOL_RESULT", () => {
	it("patches normalized task activity in place", () => {
		let state = reducer(withAssistant("a1"), {
			type: "ADD_TOOL_EVENT",
			id: "a1",
			event: {
				type: "tool_event",
				id: "plan-1",
				name: "update_plan",
				input: {},
				taskActivity: {
					kind: "tasks",
					source: "codex-plan",
					operation: "snapshot",
					items: [{ subject: "Test", status: "in_progress" }],
				},
			},
		});
		state = reducer(state, {
			type: "UPDATE_TOOL_ACTIVITY",
			toolUseId: "plan-1",
			taskActivity: {
				kind: "tasks",
				source: "codex-plan",
				operation: "snapshot",
				items: [{ subject: "Test", status: "completed" }],
			},
		});
		const message = state[0];
		if (message.role === "assistant") {
			expect(message.toolEvents[0].taskActivity?.items[0].status).toBe(
				"completed",
			);
		}
	});

	it("attaches result to matching tool event on assistant message", () => {
		let state = reducer(withAssistant("a1"), {
			type: "ADD_TOOL_EVENT",
			id: "a1",
			event: {
				type: "tool_event",
				id: "te1",
				name: "Bash",
				input: { command: "ls" },
			},
		});
		state = reducer(state, {
			type: "ADD_TOOL_RESULT",
			toolUseId: "te1",
			content: "file1\nfile2",
		});
		const msg = state[0];
		if (msg.role === "assistant") {
			expect(msg.toolEvents[0].result).toBe("file1\nfile2");
			expect(msg.toolEvents[0].isError).toBeUndefined();
		}
	});

	it("flags isError when set", () => {
		let state = reducer(withAssistant("a1"), {
			type: "ADD_TOOL_EVENT",
			id: "a1",
			event: { type: "tool_event", id: "te1", name: "Bash", input: {} },
		});
		state = reducer(state, {
			type: "ADD_TOOL_RESULT",
			toolUseId: "te1",
			content: "denied",
			isError: true,
		});
		const msg = state[0];
		if (msg.role === "assistant") {
			expect(msg.toolEvents[0].isError).toBe(true);
		}
	});

	it("replaces lazy history metadata when the live full result arrives", () => {
		let state = reducer(withAssistant("a1"), {
			type: "ADD_TOOL_EVENT",
			id: "a1",
			event: {
				type: "tool_event",
				id: "te1",
				name: "Read",
				input: {},
				result: "preview",
				resultTruncated: true,
				resultLength: 10_000,
				detailSessionId: "session-1",
			},
		});
		state = reducer(state, {
			type: "ADD_TOOL_RESULT",
			toolUseId: "te1",
			content: "complete live result",
		});
		const msg = state[0];
		if (msg.role === "assistant") {
			expect(msg.toolEvents[0]).toMatchObject({
				result: "complete live result",
			});
			expect(msg.toolEvents[0].resultTruncated).toBeUndefined();
			expect(msg.toolEvents[0].detailSessionId).toBeUndefined();
		}
	});

	it("retains lazy metadata when the live result is already compacted", () => {
		let state = reducer(withAssistant("a1"), {
			type: "ADD_TOOL_EVENT",
			id: "a1",
			event: { type: "tool_event", id: "te1", name: "Read", input: {} },
		});
		state = reducer(state, {
			type: "ADD_TOOL_RESULT",
			toolUseId: "te1",
			content: "preview",
			resultTruncated: true,
			resultLength: 50_000,
			detailSessionId: "session-1",
		});
		const msg = state[0];
		if (msg.role === "assistant") {
			expect(msg.toolEvents[0]).toMatchObject({
				result: "preview",
				resultTruncated: true,
				resultLength: 50_000,
				detailSessionId: "session-1",
			});
		}
	});

	it("locates tool event across multiple assistant messages", () => {
		let state = [...withAssistant("a1"), ...withAssistant("a2")];
		state = reducer(state, {
			type: "ADD_TOOL_EVENT",
			id: "a2",
			event: { type: "tool_event", id: "te9", name: "Read", input: {} },
		});
		state = reducer(state, {
			type: "ADD_TOOL_RESULT",
			toolUseId: "te9",
			content: "content",
		});
		const a2 = state[1];
		if (a2.role === "assistant") {
			expect(a2.toolEvents[0].result).toBe("content");
		}
	});

	it("no-op when toolUseId not found", () => {
		const before = withAssistant("a1");
		const after = reducer(before, {
			type: "ADD_TOOL_RESULT",
			toolUseId: "ghost",
			content: "x",
		});
		expect(after).toEqual(before);
	});

	it("does not affect other tool events on same message", () => {
		let state = withAssistant("a1");
		state = reducer(state, {
			type: "ADD_TOOL_EVENT",
			id: "a1",
			event: { type: "tool_event", id: "te1", name: "Read", input: {} },
		});
		state = reducer(state, {
			type: "ADD_TOOL_EVENT",
			id: "a1",
			event: { type: "tool_event", id: "te2", name: "Bash", input: {} },
		});
		state = reducer(state, {
			type: "ADD_TOOL_RESULT",
			toolUseId: "te1",
			content: "r1",
		});
		const msg = state[0];
		if (msg.role === "assistant") {
			expect(msg.toolEvents[0].result).toBe("r1");
			expect(msg.toolEvents[1].result).toBeUndefined();
		}
	});
});

describe("UPDATE_TOOL_EVENT", () => {
	it("replaces the subagent snapshot on the matching tool event", () => {
		let state = reducer(withAssistant("a1"), {
			type: "ADD_TOOL_EVENT",
			id: "a1",
			event: {
				type: "tool_event",
				id: "spawn-1",
				name: "spawn_agent",
				input: {},
			},
		});
		state = reducer(state, {
			type: "UPDATE_TOOL_EVENT",
			toolUseId: "spawn-1",
			subagent: {
				provider: "codex",
				agentId: "child-1",
				status: "running",
				startedAtMs: 1000,
				currentStep: "Inspecting files",
			},
		});
		const message = state[0];
		if (message.role === "assistant") {
			expect(message.toolEvents[0].subagent).toMatchObject({
				agentId: "child-1",
				status: "running",
				currentStep: "Inspecting files",
			});
		}
	});
});

describe("SETTLE_ACTIVE_SUBAGENTS", () => {
	it("interrupts stale live cards while preserving completed children", () => {
		let state = reducer(withAssistant("a1"), {
			type: "ADD_TOOL_EVENT",
			id: "a1",
			event: {
				type: "tool_event",
				id: "computer-use",
				name: "windows_computer_use",
				input: {},
				subagent: {
					provider: "codex",
					agentId: "desktop-1",
					status: "running",
					startedAtMs: 1000,
				},
			},
		});
		state = reducer(state, {
			type: "ADD_TOOL_EVENT",
			id: "a1",
			event: {
				type: "tool_event",
				id: "finished",
				name: "spawn_agent",
				input: {},
				subagent: {
					provider: "codex",
					agentId: "child-2",
					status: "completed",
					startedAtMs: 1000,
					endedAtMs: 1500,
				},
			},
		});

		state = reducer(state, {
			type: "SETTLE_ACTIVE_SUBAGENTS",
			endedAtMs: 2000,
		});

		const message = state[0];
		if (message.role !== "assistant") throw new Error("wrong role");
		expect(message.toolEvents[0].subagent).toMatchObject({
			status: "interrupted",
			currentStep: "Parent turn is no longer running",
			endedAtMs: 2000,
		});
		expect(message.toolEvents[1].subagent?.status).toBe("completed");
	});
});

// ── ADD_PLAN_PROPOSAL ─────────────────────────────────────────────────────────

describe("ADD_PLAN_PROPOSAL", () => {
	it("appends a plan_proposal message in pending state", () => {
		const state = reducer(empty(), {
			type: "ADD_PLAN_PROPOSAL",
			id: "pp1",
			plan: "## Steps\n1. do x",
		});
		expect(state).toHaveLength(1);
		const msg = state[0];
		if (msg.role !== "plan_proposal") throw new Error("wrong role");
		expect(msg.id).toBe("pp1");
		expect(msg.plan).toBe("## Steps\n1. do x");
		expect(msg.decision).toBe("pending");
	});

	it("carries htmlRelicId when the agent produced an HTML plan", () => {
		const state = reducer(empty(), {
			type: "ADD_PLAN_PROPOSAL",
			id: "pp1",
			plan: "## Steps\n1. do x",
			htmlRelicId: "att-1",
		});
		const msg = state[0];
		if (msg.role !== "plan_proposal") throw new Error("wrong role");
		expect(msg.htmlRelicId).toBe("att-1");
	});

	it("omits htmlRelicId when not provided", () => {
		const state = reducer(empty(), {
			type: "ADD_PLAN_PROPOSAL",
			id: "pp1",
			plan: "do x",
		});
		const msg = state[0];
		if (msg.role !== "plan_proposal") throw new Error("wrong role");
		expect(msg.htmlRelicId).toBeUndefined();
	});

	it("merges a replayed live HTML proposal into its pending history card", () => {
		const history = reducer(empty(), {
			type: "LOAD_HISTORY",
			items: [
				{
					kind: "plan_proposal",
					id: "pp1",
					plan: "Saved plan",
					decision: "pending",
					html_attachment_id: null,
				},
			],
		});
		const state = reducer(history, {
			type: "ADD_PLAN_PROPOSAL",
			id: "pp1",
			plan: "Live plan",
			htmlRelicId: "att-live",
		});

		expect(state).toHaveLength(1);
		expect(state[0]).toMatchObject({
			role: "plan_proposal",
			plan: "Live plan",
			decision: "pending",
			htmlRelicId: "att-live",
		});
	});
});

describe("LOAD_HISTORY — HTML plan", () => {
	it("hydrates a saved plan's HTML attachment id", () => {
		const state = reducer(empty(), {
			type: "LOAD_HISTORY",
			items: [
				{
					kind: "plan_proposal",
					id: "pp-history",
					plan: "Saved plan",
					decision: "approved",
					html_attachment_id: "att-history",
				},
			],
		});
		expect(state[0]).toMatchObject({
			role: "plan_proposal",
			htmlRelicId: "att-history",
		});
	});
});

// ── RESOLVE_PLAN_PROPOSAL ─────────────────────────────────────────────────────

describe("RESOLVE_PLAN_PROPOSAL", () => {
	function withPlan(id = "pp1"): ChatMessage[] {
		return reducer(empty(), {
			type: "ADD_PLAN_PROPOSAL",
			id,
			plan: "do stuff",
		});
	}

	it("sets decision on matching plan", () => {
		const state = reducer(withPlan(), {
			type: "RESOLVE_PLAN_PROPOSAL",
			id: "pp1",
			decision: "approved",
		});
		const msg = state[0];
		if (msg.role !== "plan_proposal") throw new Error("wrong role");
		expect(msg.decision).toBe("approved");
	});

	it("supports edited and cancelled decisions", () => {
		let state = withPlan();
		state = reducer(state, {
			type: "RESOLVE_PLAN_PROPOSAL",
			id: "pp1",
			decision: "edited",
		});
		const m1 = state[0];
		if (m1.role === "plan_proposal") expect(m1.decision).toBe("edited");
		state = reducer(state, {
			type: "RESOLVE_PLAN_PROPOSAL",
			id: "pp1",
			decision: "cancelled",
		});
		const m2 = state[0];
		if (m2.role === "plan_proposal") expect(m2.decision).toBe("cancelled");
	});

	it("ignores unknown id", () => {
		const before = withPlan();
		const after = reducer(before, {
			type: "RESOLVE_PLAN_PROPOSAL",
			id: "ghost",
			decision: "approved",
		});
		expect(after).toEqual(before);
	});
});

// ── DONE ──────────────────────────────────────────────────────────────────────

describe("DONE", () => {
	it("marks streaming false and sets cost", () => {
		const state = reducer(withAssistant("a1"), {
			type: "DONE",
			id: "a1",
			cost: 0.0042,
		});
		const msg = state[0];
		if (msg.role === "assistant") {
			expect(msg.streaming).toBe(false);
			expect(msg.cost).toBe(0.0042);
		}
	});

	it("handles null cost", () => {
		const state = reducer(withAssistant("a1"), {
			type: "DONE",
			id: "a1",
			cost: null,
		});
		const msg = state[0];
		if (msg.role === "assistant") expect(msg.cost).toBeNull();
	});

	it("sets dbId when the server reports one, so a live message can be branched from without a reload", () => {
		const state = reducer(withAssistant("a1"), {
			type: "DONE",
			id: "a1",
			cost: 0,
			dbId: 42,
		});
		const msg = state[0];
		if (msg.role === "assistant") expect(msg.dbId).toBe(42);
	});

	it("leaves dbId unset when the server doesn't report one", () => {
		const state = reducer(withAssistant("a1"), {
			type: "DONE",
			id: "a1",
			cost: 0,
		});
		const msg = state[0];
		if (msg.role === "assistant") expect(msg.dbId).toBeUndefined();
	});
});

// ── SET_RECAP ─────────────────────────────────────────────────────────────────

describe("SET_RECAP", () => {
	it("sets recap on assistant message", () => {
		const state = reducer(withAssistant("a1"), {
			type: "SET_RECAP",
			id: "a1",
			recap: "Did X, Y, Z",
		});
		const msg = state[0];
		if (msg.role === "assistant") expect(msg.recap).toBe("Did X, Y, Z");
	});
});

// ── ADD_PERMISSION ────────────────────────────────────────────────────────────

describe("ADD_PERMISSION", () => {
	it("appends a permission message with pending decision", () => {
		const state = reducer(empty(), {
			type: "ADD_PERMISSION",
			msg: {
				type: "permission_request",
				id: "p1",
				toolName: "Bash",
				title: "Run ls",
				displayName: "Bash",
				description: "list files",
				input: { command: "ls" },
				requester: {
					providerId: "claude",
					agentId: "child-1",
					agentType: "reader",
				},
				policy: { source: "umbod", reason: "default approval" },
			},
		});
		expect(state).toHaveLength(1);
		expect(state[0]).toMatchObject({
			id: "p1",
			role: "permission",
			toolName: "Bash",
			requester: {
				providerId: "claude",
				agentId: "child-1",
				agentType: "reader",
			},
			policy: { source: "umbod", reason: "default approval" },
			decision: "pending",
		});
	});

	it("does not duplicate a replayed permission request", () => {
		const msg = {
			type: "permission_request" as const,
			id: "p1",
			toolName: "Bash",
			title: "Run command",
		};
		let state = reducer(empty(), { type: "ADD_PERMISSION", msg });
		state = reducer(state, { type: "ADD_PERMISSION", msg });
		expect(state).toHaveLength(1);
	});
});

// ── RESOLVE_PERMISSION ────────────────────────────────────────────────────────

describe("RESOLVE_PERMISSION", () => {
	it("updates decision on matching permission message", () => {
		let state = reducer(empty(), {
			type: "ADD_PERMISSION",
			msg: {
				type: "permission_request",
				id: "p1",
				toolName: "Bash",
				title: "T",
			},
		});
		state = reducer(state, {
			type: "RESOLVE_PERMISSION",
			id: "p1",
			decision: "approved",
		});
		const msg = state[0];
		if (msg.role === "permission") expect(msg.decision).toBe("approved");
	});

	it("does not affect other messages", () => {
		let state = [
			...reducer(empty(), {
				type: "ADD_PERMISSION",
				msg: {
					type: "permission_request",
					id: "p1",
					toolName: "T",
					title: "T",
				},
			}),
			...reducer(empty(), {
				type: "ADD_PERMISSION",
				msg: {
					type: "permission_request",
					id: "p2",
					toolName: "T",
					title: "T",
				},
			}),
		];
		state = reducer(state, {
			type: "RESOLVE_PERMISSION",
			id: "p1",
			decision: "denied",
		});
		// biome-ignore lint/style/noNonNullAssertion: test knows message exists
		const p2 = state.find((m) => m.id === "p2")!;
		if (p2.role === "permission") expect(p2.decision).toBe("pending");
	});
});

// ── RESOLVE_OR_ADD_PERMISSION ─────────────────────────────────────────────────

describe("RESOLVE_OR_ADD_PERMISSION", () => {
	it("resolves existing permission", () => {
		let state = reducer(empty(), {
			type: "ADD_PERMISSION",
			msg: {
				type: "permission_request",
				id: "p1",
				toolName: "Bash",
				title: "T",
			},
		});
		state = reducer(state, {
			type: "RESOLVE_OR_ADD_PERMISSION",
			id: "p1",
			toolName: "Bash",
			decision: "approved_session",
		});
		expect(state).toHaveLength(1);
		const msg = state[0];
		if (msg.role === "permission")
			expect(msg.decision).toBe("approved_session");
	});

	it("adds new permission when id not found", () => {
		const state = reducer(empty(), {
			type: "RESOLVE_OR_ADD_PERMISSION",
			id: "p99",
			toolName: "Read",
			decision: "approved",
		});
		expect(state).toHaveLength(1);
		expect(state[0]).toMatchObject({
			id: "p99",
			role: "permission",
			toolName: "Read",
			decision: "approved",
		});
	});
});

// ── LOAD_HISTORY ──────────────────────────────────────────────────────────────

describe("LOAD_HISTORY", () => {
	it("loads user and assistant messages", () => {
		const state = reducer(empty(), {
			type: "LOAD_HISTORY",
			items: [
				{ kind: "message", id: "u1", role: "user", text: "hello" },
				{
					kind: "message",
					id: "a1",
					role: "assistant",
					text: "world",
					toolEvents: [],
				},
			],
		});
		expect(state).toHaveLength(2);
		expect(state[0]).toMatchObject({ role: "user", text: "hello" });
		expect(state[1]).toMatchObject({
			role: "assistant",
			text: "world",
			streaming: false,
		});
	});

	it("restores exact, estimated, zero, and unknown assistant costs", () => {
		const state = reducer(empty(), {
			type: "LOAD_HISTORY",
			items: [
				{
					kind: "message",
					id: "actual",
					role: "assistant",
					text: "actual",
					cost: 0.1234,
					costEstimated: false,
				},
				{
					kind: "message",
					id: "estimated",
					role: "assistant",
					text: "estimated",
					cost: 0.2345,
					costEstimated: true,
				},
				{
					kind: "message",
					id: "zero",
					role: "assistant",
					text: "zero",
					cost: 0,
					costEstimated: false,
				},
				{
					kind: "message",
					id: "unknown",
					role: "assistant",
					text: "unknown",
					cost: null,
					costEstimated: false,
				},
			],
		});

		expect(state).toMatchObject([
			{ role: "assistant", cost: 0.1234 },
			{ role: "assistant", cost: 0.2345, costEstimated: true },
			{ role: "assistant", cost: 0 },
			{ role: "assistant", cost: null },
		]);
		expect(state[0]).not.toHaveProperty("costEstimated");
		expect(state[2]).not.toHaveProperty("costEstimated");
		expect(state[3]).not.toHaveProperty("costEstimated");
	});

	it("prepends an older cursor page without replacing live rows or duplicating overlap", () => {
		const current = reducer(empty(), {
			type: "LOAD_HISTORY",
			items: [{ kind: "message", id: "u2", role: "user", text: "current" }],
		});
		const state = reducer(current, {
			type: "PREPEND_HISTORY",
			items: [
				{ kind: "message", id: "u1", role: "user", text: "older" },
				{ kind: "message", id: "u2", role: "user", text: "overlap" },
			],
		});

		expect(state.map((message) => message.id)).toEqual(["u1", "u2"]);
		expect(state[1]).toMatchObject({ text: "current" });
	});

	it("hydrates optional history cards without rolling back live message state", () => {
		const base = reducer(empty(), {
			type: "LOAD_HISTORY",
			items: [
				{ kind: "message", id: "u1", role: "user", text: "hello" },
				{ kind: "message", id: "a1", role: "assistant", text: "partial" },
			],
		});
		const live = reducer(base, {
			type: "APPEND_CHUNK",
			id: "a1",
			text: " response",
		});
		const state = reducer(live, {
			type: "HYDRATE_HISTORY",
			items: [
				{ kind: "message", id: "u1", role: "user", text: "hello" },
				{
					kind: "ask_user_question",
					id: "q1",
					questions: [],
					answers: null,
				},
				{ kind: "message", id: "a1", role: "assistant", text: "partial" },
			],
		});

		expect(state.map((message) => `${message.role}:${message.id}`)).toEqual([
			"user:u1",
			"ask_user_question:q1",
			"assistant:a1",
		]);
		expect(state[2]).toMatchObject({ text: "partial response" });
	});

	it("keeps a live accepted steer in place during delayed history hydration", () => {
		const base = reducer(empty(), {
			type: "LOAD_HISTORY",
			items: [
				{ kind: "message", id: "u1", role: "user", text: "start" },
				{ kind: "message", id: "a1", role: "assistant", text: "working" },
			],
		});
		const queued = reducer(base, {
			type: "ADD_USER",
			id: "steer-1",
			text: "change direction",
		});
		const steered = reducer(queued, {
			type: "STEER_USER",
			turnId: "steer-1",
			assistantId: "a1",
		});
		const state = reducer(steered, {
			type: "HYDRATE_HISTORY",
			items: [
				{ kind: "message", id: "u1", role: "user", text: "start" },
				{
					kind: "ask_user_question",
					id: "q1",
					questions: [],
					answers: null,
				},
				{ kind: "message", id: "a1", role: "assistant", text: "working" },
			],
		});

		expect(state.map((message) => message.id)).toEqual([
			"u1",
			"q1",
			"steer-1",
			"a1",
		]);
	});

	it("restores a persisted steer before the assistant response it joined", () => {
		let state = reducer(empty(), {
			type: "LOAD_HISTORY",
			items: [
				{
					kind: "message",
					id: "u1",
					role: "user",
					text: "start",
					seq: 0,
				},
				{
					kind: "message",
					id: "a1",
					role: "assistant",
					text: "response",
					seq: 1,
					toolEvents: [
						{
							type: "tool_event",
							id: "restored-tool-1",
							name: "Read",
							input: {},
						},
						{
							type: "tool_event",
							id: "restored-tool-2",
							name: "Read",
							input: {},
						},
					],
				},
				{
					kind: "message",
					id: "steer-1",
					role: "user",
					text: "change direction",
					seq: 2,
					steerTargetSeq: 1,
				},
			],
		});

		expect(state.map((message) => message.id)).toEqual(["u1", "steer-1", "a1"]);
		expect(state[1]).toMatchObject({
			role: "user",
			steerTargetSeq: 1,
			steerToolEventIndex: 2,
		});
		expect(state[2]).toMatchObject({
			role: "assistant",
			turnId: "u1",
			transcriptSeq: 1,
		});

		state = reducer(state, {
			type: "ADD_TOOL_EVENT",
			id: "a1",
			event: {
				type: "tool_event",
				id: "later-tool",
				name: "Read",
				input: {},
			},
		});
		expect(state[1]).toMatchObject({ steerToolEventIndex: 2 });
	});

	it("deduplicates repeated persisted cards within one older page", () => {
		const state = reducer(empty(), {
			type: "PREPEND_HISTORY",
			items: [
				{ kind: "message", id: "u1", role: "user", text: "older" },
				{ kind: "message", id: "u1", role: "user", text: "duplicate" },
			],
		});

		expect(state).toHaveLength(1);
		expect(state[0]).toMatchObject({ id: "u1", text: "older" });
	});

	it("loads assistant recap from history", () => {
		const state = reducer(empty(), {
			type: "LOAD_HISTORY",
			items: [
				{
					kind: "message",
					id: "a1",
					role: "assistant",
					text: "response",
					recap: "summary",
				},
			],
		});
		const msg = state[0];
		if (msg.role === "assistant") expect(msg.recap).toBe("summary");
	});

	it("treats null recap as undefined", () => {
		const state = reducer(empty(), {
			type: "LOAD_HISTORY",
			items: [
				{
					kind: "message",
					id: "a1",
					role: "assistant",
					text: "r",
					recap: null,
				},
			],
		});
		const msg = state[0];
		if (msg.role === "assistant") expect(msg.recap).toBeUndefined();
	});

	it("loads permission items", () => {
		const state = reducer(empty(), {
			type: "LOAD_HISTORY",
			items: [
				{
					kind: "permission",
					tool_id: "p1",
					tool_name: "Bash",
					display_name: "Bash",
					decision: "approved",
				},
			],
		});
		expect(state[0]).toMatchObject({
			id: "p1",
			role: "permission",
			toolName: "Bash",
		});
	});

	it("preserves real permission decisions loaded from history", () => {
		const state = reducer(empty(), {
			type: "LOAD_HISTORY",
			items: [
				{
					kind: "permission",
					tool_id: "p1",
					tool_name: "Bash",
					display_name: null,
					decision: "approved",
				},
				{
					kind: "permission",
					tool_id: "p2",
					tool_name: "Read",
					display_name: null,
					decision: "denied",
				},
				{
					kind: "permission",
					tool_id: "p3",
					tool_name: "Edit",
					display_name: null,
					decision: "approved_always",
				},
				{
					kind: "permission",
					tool_id: "p4",
					tool_name: "Write",
					display_name: null,
					decision: "approved_session",
				},
			],
		});
		const decisions = state
			.filter((m) => m.role === "permission")
			.map((m) => (m as { decision: string }).decision);
		expect(decisions).toEqual([
			"approved",
			"denied",
			"approved_always",
			"approved_session",
		]);
	});

	it("falls back to pending for unrecognized decision strings", () => {
		const state = reducer(empty(), {
			type: "LOAD_HISTORY",
			items: [
				{
					kind: "permission",
					tool_id: "p1",
					tool_name: "Bash",
					display_name: null,
					decision: "allow_once",
				},
				{
					kind: "permission",
					tool_id: "p2",
					tool_name: "Read",
					display_name: null,
					decision: "unknown_value",
				},
			],
		});
		for (const msg of state) {
			if (msg.role === "permission") {
				expect(msg.decision).toBe("pending");
			}
		}
	});

	it("rehydrates tool event result + isError", () => {
		const state = reducer(empty(), {
			type: "LOAD_HISTORY",
			items: [
				{
					kind: "message",
					id: "a1",
					role: "assistant",
					text: "ok",
					toolEvents: [
						{
							type: "tool_event",
							id: "te1",
							name: "Bash",
							input: { command: "ls" },
							result: "file1",
							isError: false,
						},
					],
				},
			],
		});
		const msg = state[0];
		if (msg.role === "assistant") {
			expect(msg.toolEvents[0].result).toBe("file1");
			expect(msg.toolEvents[0].isError).toBe(false);
		}
	});

	it("rehydrates plan_proposal items", () => {
		const state = reducer(empty(), {
			type: "LOAD_HISTORY",
			items: [
				{
					kind: "plan_proposal",
					id: "pp1",
					plan: "the plan",
					decision: "approved",
				},
			],
		});
		expect(state).toHaveLength(1);
		const msg = state[0];
		if (msg.role !== "plan_proposal") throw new Error("wrong role");
		expect(msg.plan).toBe("the plan");
		expect(msg.decision).toBe("approved");
	});

	it("rehydrates pending ask_user_question items (answers=null)", () => {
		const state = reducer(empty(), {
			type: "LOAD_HISTORY",
			items: [
				{
					kind: "ask_user_question",
					id: "aq-1",
					questions: [
						{ question: "Pick?", options: ["A", "B"], multiSelect: false },
					],
					provenance: {
						provider_id: "claude",
						kind: "mcp_elicitation",
						source_name: "github",
						turn_id: "turn-1",
					},
					answers: null,
				},
			],
		});
		expect(state).toHaveLength(1);
		const msg = state[0];
		if (msg.role !== "ask_user_question") throw new Error("wrong role");
		expect(msg.answers).toBeNull();
		expect(msg.notes).toBeUndefined();
		expect(msg.questions[0].question).toBe("Pick?");
		expect(msg.provenance).toMatchObject({
			provider_id: "claude",
			source_name: "github",
			turn_id: "turn-1",
		});
	});

	it("rehydrates resolved ask_user_question items with answers + notes", () => {
		const state = reducer(empty(), {
			type: "LOAD_HISTORY",
			items: [
				{
					kind: "ask_user_question",
					id: "aq-1",
					questions: [
						{ question: "Pick?", options: ["A", "B"], multiSelect: false },
					],
					answers: { "Pick?": ["A"] },
					notes: { "Pick?": "because A" },
				},
			],
		});
		const msg = state[0];
		if (msg.role !== "ask_user_question") throw new Error("wrong role");
		expect(msg.answers).toEqual({ "Pick?": ["A"] });
		expect(msg.notes).toEqual({ "Pick?": "because A" });
	});

	it("omits notes field when not provided on the loaded item", () => {
		const state = reducer(empty(), {
			type: "LOAD_HISTORY",
			items: [
				{
					kind: "ask_user_question",
					id: "aq-1",
					questions: [
						{ question: "Pick?", options: ["A", "B"], multiSelect: false },
					],
					answers: { "Pick?": ["B"] },
				},
			],
		});
		const msg = state[0];
		if (msg.role !== "ask_user_question") throw new Error("wrong role");
		expect(msg.notes).toBeUndefined();
	});

	it("normalizes unknown role to assistant", () => {
		const state = reducer(empty(), {
			type: "LOAD_HISTORY",
			items: [{ kind: "message", id: "x1", role: "unknown_role", text: "hi" }],
		});
		expect(state[0].role).toBe("assistant");
	});
});

// ── CLEAR ─────────────────────────────────────────────────────────────────────

describe("CLEAR", () => {
	it("returns empty array regardless of state size", () => {
		let state = withUser();
		state = [...state, ...withAssistant()];
		state = reducer(state, { type: "CLEAR" });
		expect(state).toEqual([]);
	});
});

// ── Edge cases ────────────────────────────────────────────────────────────────

describe("DONE — edge cases", () => {
	it("ignores id mismatch — state unchanged", () => {
		const before = withAssistant("a1");
		const after = reducer(before, { type: "DONE", id: "wrong", cost: 0.5 });
		const msg = after[0];
		if (msg.role === "assistant") {
			expect(msg.streaming).toBe(true);
			expect(msg.cost).toBeNull();
		}
	});

	it("handles cost=0 (falsy but valid)", () => {
		const state = reducer(withAssistant("a1"), {
			type: "DONE",
			id: "a1",
			cost: 0,
		});
		const msg = state[0];
		if (msg.role === "assistant") expect(msg.cost).toBe(0);
	});
});

describe("ADD_TOOL_EVENT — edge cases", () => {
	it("ignores id mismatch — tool events unchanged", () => {
		const before = withAssistant("a1");
		const after = reducer(before, {
			type: "ADD_TOOL_EVENT",
			id: "wrong",
			event: { type: "tool_event", id: "te1", name: "Bash", input: {} },
		});
		const msg = after[0];
		if (msg.role === "assistant") expect(msg.toolEvents).toHaveLength(0);
	});

	it("ignores when id matches but role is not assistant", () => {
		// user message has same id — must not crash or mutate
		const before = withUser("u1");
		const after = reducer(before, {
			type: "ADD_TOOL_EVENT",
			id: "u1",
			event: { type: "tool_event", id: "te1", name: "Bash", input: {} },
		});
		expect(after[0].role).toBe("user");
	});
});

describe("SET_RECAP — edge cases", () => {
	it("is no-op when id not found", () => {
		const before = withAssistant("a1");
		const after = reducer(before, {
			type: "SET_RECAP",
			id: "missing",
			recap: "x",
		});
		const msg = after[0];
		if (msg.role === "assistant") expect(msg.recap).toBeUndefined();
	});
});

describe("RESOLVE_PERMISSION — edge cases", () => {
	it("is no-op when id not found", () => {
		const before = reducer(empty(), {
			type: "ADD_PERMISSION",
			msg: {
				type: "permission_request",
				id: "p1",
				toolName: "Bash",
				title: "T",
			},
		});
		const after = reducer(before, {
			type: "RESOLVE_PERMISSION",
			id: "nonexistent",
			decision: "approved",
		});
		const msg = after[0];
		if (msg.role === "permission") expect(msg.decision).toBe("pending");
	});
});

describe("APPEND_CHUNK — edge cases", () => {
	it("ignores when id matches non-assistant message", () => {
		const before = withUser("u1", "original");
		const after = reducer(before, {
			type: "APPEND_CHUNK",
			id: "u1",
			text: "extra",
		});
		const msg = after[0];
		if (msg.role === "user") expect(msg.text).toBe("original");
	});
});

// ── ADD_ASK_USER_QUESTION ─────────────────────────────────────────────────────

describe("ADD_ASK_USER_QUESTION", () => {
	it("appends an ask_user_question message with answers=null and notes undefined", () => {
		const state = reducer(empty(), {
			type: "ADD_ASK_USER_QUESTION",
			id: "aq-1",
			questions: [
				{ question: "Pick?", options: ["A", "B"], multiSelect: false },
			],
		});
		expect(state).toHaveLength(1);
		const msg = state[0];
		if (msg.role !== "ask_user_question") throw new Error("wrong role");
		expect(msg.answers).toBeNull();
		expect(msg.notes).toBeUndefined();
		expect(msg.questions).toHaveLength(1);
		expect(msg.questions[0].question).toBe("Pick?");
	});

	it("dedups when an ask_user_question with the same id is already in state", () => {
		// Mirrors the live flow: LOAD_HISTORY hydrates the card from DB, then
		// the WS server re-emits the same pending question on reconnect. Without
		// the dedup guard the prompt would appear twice.
		const before = reducer(empty(), {
			type: "LOAD_HISTORY",
			items: [
				{
					kind: "ask_user_question",
					id: "aq-1",
					questions: [
						{ question: "Pick?", options: ["A", "B"], multiSelect: false },
					],
					answers: null,
				},
			],
		});
		const after = reducer(before, {
			type: "ADD_ASK_USER_QUESTION",
			id: "aq-1",
			questions: [
				{ question: "Pick?", options: ["A", "B"], multiSelect: false },
			],
		});
		expect(after).toHaveLength(1);
		// Same reference returned when no work happens — avoids unnecessary re-renders.
		expect(after).toBe(before);
	});

	it("still appends when the existing id belongs to a different role", () => {
		const before = reducer(empty(), {
			type: "ADD_USER",
			id: "aq-1",
			text: "user message reusing the id",
		});
		const after = reducer(before, {
			type: "ADD_ASK_USER_QUESTION",
			id: "aq-1",
			questions: [
				{ question: "Pick?", options: ["A", "B"], multiSelect: false },
			],
		});
		// Role check ensures dedup is scoped to ask_user_question only.
		expect(after).toHaveLength(2);
	});
});

// ── RESOLVE_ASK_USER_QUESTION ─────────────────────────────────────────────────

describe("RESOLVE_ASK_USER_QUESTION", () => {
	function withAsk(id = "aq-1"): ChatMessage[] {
		return reducer(empty(), {
			type: "ADD_ASK_USER_QUESTION",
			id,
			questions: [
				{ question: "Pick?", options: ["A", "B"], multiSelect: false },
			],
		});
	}

	it("sets answers on the matching ask_user_question message", () => {
		const before = withAsk("aq-1");
		const after = reducer(before, {
			type: "RESOLVE_ASK_USER_QUESTION",
			id: "aq-1",
			answers: { "Pick?": ["A"] },
		});
		const msg = after[0];
		if (msg.role !== "ask_user_question") throw new Error("wrong role");
		expect(msg.answers).toEqual({ "Pick?": ["A"] });
	});

	it("stores notes when provided", () => {
		const before = withAsk("aq-1");
		const after = reducer(before, {
			type: "RESOLVE_ASK_USER_QUESTION",
			id: "aq-1",
			answers: { "Pick?": ["A"] },
			notes: { "Pick?": "more context here" },
		});
		const msg = after[0];
		if (msg.role !== "ask_user_question") throw new Error("wrong role");
		expect(msg.notes).toEqual({ "Pick?": "more context here" });
	});

	it("leaves notes undefined when not provided", () => {
		const before = withAsk("aq-1");
		const after = reducer(before, {
			type: "RESOLVE_ASK_USER_QUESTION",
			id: "aq-1",
			answers: { "Pick?": ["A"] },
		});
		const msg = after[0];
		if (msg.role !== "ask_user_question") throw new Error("wrong role");
		expect(msg.notes).toBeUndefined();
	});

	it("ignores ids that do not match any message", () => {
		const before = withAsk("aq-1");
		const after = reducer(before, {
			type: "RESOLVE_ASK_USER_QUESTION",
			id: "ghost",
			answers: { "Pick?": ["A"] },
		});
		const msg = after[0];
		if (msg.role !== "ask_user_question") throw new Error("wrong role");
		expect(msg.answers).toBeNull();
	});
});

// ── ADD_LOCAL_COMMAND_OUTPUT ──────────────────────────────────────────────────

describe("ADD_LOCAL_COMMAND_OUTPUT", () => {
	it("appends a local_command_output message", () => {
		const state = reducer(empty(), {
			type: "ADD_LOCAL_COMMAND_OUTPUT",
			id: "lco-1",
			content: "/help output here",
		});
		expect(state).toHaveLength(1);
		const msg = state[0];
		expect(msg.role).toBe("local_command_output");
		if (msg.role === "local_command_output") {
			expect(msg.id).toBe("lco-1");
			expect(msg.content).toBe("/help output here");
		}
	});

	it("appends after existing messages without touching them", () => {
		const initial = withUser("u1", "hello");
		const state = reducer(initial, {
			type: "ADD_LOCAL_COMMAND_OUTPUT",
			id: "lco-2",
			content: "command result",
		});
		expect(state).toHaveLength(2);
		expect(state[0].role).toBe("user");
		expect(state[1].role).toBe("local_command_output");
	});

	it("does not mutate previous state", () => {
		const initial = empty();
		reducer(initial, {
			type: "ADD_LOCAL_COMMAND_OUTPUT",
			id: "lco-3",
			content: "x",
		});
		expect(initial).toHaveLength(0);
	});
});

describe("default — unknown action", () => {
	it("returns state unchanged for unknown action type", () => {
		const before = withUser();
		// biome-ignore lint/suspicious/noExplicitAny: testing runtime guard
		const after = reducer(before, { type: "UNKNOWN_ACTION" } as any);
		expect(after).toBe(before);
	});
});
