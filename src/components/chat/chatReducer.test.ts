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

	it("does not mutate previous state", () => {
		const initial = empty();
		reducer(initial, { type: "ADD_USER", id: "x", text: "x" });
		expect(initial).toHaveLength(0);
	});
});

// ── ADD_ASSISTANT ─────────────────────────────────────────────────────────────

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
});

// ── ADD_TOOL_RESULT ───────────────────────────────────────────────────────────

describe("ADD_TOOL_RESULT", () => {
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
			},
		});
		expect(state).toHaveLength(1);
		expect(state[0]).toMatchObject({
			id: "p1",
			role: "permission",
			toolName: "Bash",
			decision: "pending",
		});
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
