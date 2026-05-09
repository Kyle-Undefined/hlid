/**
 * generateTurnRecap — tests the pure inline logic via inspecting the
 * prompt passed to `query` and verifying emit / DB calls.
 * Mocks: @anthropic-ai/claude-agent-sdk (query), ../db (setMessageRecap).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// ── mocks (declared before import) ───────────────────────────────────────────

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
	query: vi.fn(),
}));

vi.mock("../db", () => ({
	setMessageRecap: vi.fn().mockResolvedValue(undefined),
}));

import { query } from "@anthropic-ai/claude-agent-sdk";
import * as db from "../db";
import { generateTurnRecap } from "./recap";

const mockQuery = vi.mocked(query);
const mockSetRecap = vi.mocked(db.setMessageRecap);

// ── helpers ───────────────────────────────────────────────────────────────────

/** Make query return a single assistant text block then a success result. */
function stubQueryReturns(text: string) {
	mockQuery.mockReturnValue(
		(async function* () {
			yield {
				type: "assistant" as const,
				message: { content: [{ type: "text" as const, text }] },
			};
			yield {
				type: "result" as const,
				subtype: "success" as const,
				result: "",
			};
		})() as unknown as ReturnType<typeof query>,
	);
}

/** Make query return only a result with no assistant block (uses msg.result fallback). */
function stubQueryResult(result: string) {
	mockQuery.mockReturnValue(
		(async function* () {
			yield { type: "result" as const, subtype: "success" as const, result };
		})() as unknown as ReturnType<typeof query>,
	);
}

/** Make query return an empty stream (no summary). */
function stubQueryEmpty() {
	mockQuery.mockReturnValue(
		(async function* () {
			yield {
				type: "result" as const,
				subtype: "success" as const,
				result: "",
			};
		})() as unknown as ReturnType<typeof query>,
	);
}

function capturedPrompt(): string {
	return (mockQuery.mock.calls[0][0] as { prompt: string }).prompt;
}

beforeEach(() => {
	vi.clearAllMocks();
});

// ── tool summary line building ────────────────────────────────────────────────

describe("generateTurnRecap — tool summary", () => {
	it("uses path field when present", async () => {
		stubQueryEmpty();
		await generateTurnRecap(
			null,
			0,
			"req",
			[{ name: "Read", input: { path: "/foo/bar.ts" } }],
			"",
			vi.fn(),
			"/vault",
			undefined,
		);
		expect(capturedPrompt()).toContain("  - Read(/foo/bar.ts)");
	});

	it("uses command field when path absent", async () => {
		stubQueryEmpty();
		await generateTurnRecap(
			null,
			0,
			"req",
			[{ name: "Bash", input: { command: "ls -la" } }],
			"",
			vi.fn(),
			"/vault",
			undefined,
		);
		expect(capturedPrompt()).toContain("  - Bash(ls -la)");
	});

	it("truncates command to 80 chars", async () => {
		stubQueryEmpty();
		const longCmd = "x".repeat(100);
		await generateTurnRecap(
			null,
			0,
			"req",
			[{ name: "Bash", input: { command: longCmd } }],
			"",
			vi.fn(),
			"/vault",
			undefined,
		);
		expect(capturedPrompt()).toContain(`  - Bash(${"x".repeat(80)})`);
	});

	it("uses file_path field when path and command absent", async () => {
		stubQueryEmpty();
		await generateTurnRecap(
			null,
			0,
			"req",
			[{ name: "Edit", input: { file_path: "/src/index.ts" } }],
			"",
			vi.fn(),
			"/vault",
			undefined,
		);
		expect(capturedPrompt()).toContain("  - Edit(/src/index.ts)");
	});

	it("falls back to just tool name when no recognized field", async () => {
		stubQueryEmpty();
		await generateTurnRecap(
			null,
			0,
			"req",
			[{ name: "TodoWrite", input: { todos: [] } }],
			"",
			vi.fn(),
			"/vault",
			undefined,
		);
		const p = capturedPrompt();
		expect(p).toContain("  - TodoWrite");
		expect(p).not.toContain("  - TodoWrite(");
	});

	it("path takes precedence over command and file_path", async () => {
		stubQueryEmpty();
		await generateTurnRecap(
			null,
			0,
			"req",
			[
				{
					name: "Tool",
					input: { path: "/path-wins", command: "cmd", file_path: "/fp" },
				},
			],
			"",
			vi.fn(),
			"/vault",
			undefined,
		);
		expect(capturedPrompt()).toContain("  - Tool(/path-wins)");
	});

	it("handles multiple tools", async () => {
		stubQueryEmpty();
		await generateTurnRecap(
			null,
			0,
			"req",
			[
				{ name: "Read", input: { path: "/a.ts" } },
				{ name: "Bash", input: { command: "npm test" } },
			],
			"",
			vi.fn(),
			"/vault",
			undefined,
		);
		const p = capturedPrompt();
		expect(p).toContain("  - Read(/a.ts)");
		expect(p).toContain("  - Bash(npm test)");
	});

	it("omits tools section when tool list is empty", async () => {
		stubQueryEmpty();
		await generateTurnRecap(
			null,
			0,
			"req",
			[],
			"",
			vi.fn(),
			"/vault",
			undefined,
		);
		expect(capturedPrompt()).not.toContain("Tools used:");
	});

	it("handles null input gracefully", async () => {
		stubQueryEmpty();
		await generateTurnRecap(
			null,
			0,
			"req",
			[{ name: "Ghost", input: null }],
			"",
			vi.fn(),
			"/vault",
			undefined,
		);
		const p = capturedPrompt();
		expect(p).toContain("  - Ghost");
		expect(p).not.toContain("  - Ghost(");
	});
});

// ── excerpt truncation ────────────────────────────────────────────────────────

describe("generateTurnRecap — excerpt truncation", () => {
	it("truncates user message to 600 chars", async () => {
		stubQueryEmpty();
		const longMsg = "a".repeat(700);
		await generateTurnRecap(
			null,
			0,
			longMsg,
			[],
			"",
			vi.fn(),
			"/vault",
			undefined,
		);
		const p = capturedPrompt();
		expect(p).toContain("a".repeat(600));
		expect(p).not.toContain("a".repeat(601));
	});

	it("truncates assistant text to 2400 chars", async () => {
		stubQueryEmpty();
		const longText = "b".repeat(2600);
		await generateTurnRecap(
			null,
			0,
			"req",
			[],
			longText,
			vi.fn(),
			"/vault",
			undefined,
		);
		const p = capturedPrompt();
		expect(p).toContain("b".repeat(2400));
		expect(p).not.toContain("b".repeat(2401));
	});

	it("preserves single newlines in user message", async () => {
		stubQueryEmpty();
		await generateTurnRecap(
			null,
			0,
			"line1\nline2",
			[],
			"",
			vi.fn(),
			"/vault",
			undefined,
		);
		expect(capturedPrompt()).toContain("line1\nline2");
	});

	it("preserves single newlines in assistant text", async () => {
		stubQueryEmpty();
		await generateTurnRecap(
			null,
			0,
			"req",
			[],
			"first\nsecond\nthird",
			vi.fn(),
			"/vault",
			undefined,
		);
		expect(capturedPrompt()).toContain("first\nsecond\nthird");
	});

	it("normalizes 3+ blank lines to double newline in user message", async () => {
		stubQueryEmpty();
		await generateTurnRecap(
			null,
			0,
			"a\n\n\n\nb",
			[],
			"",
			vi.fn(),
			"/vault",
			undefined,
		);
		const p = capturedPrompt();
		expect(p).toContain("a\n\nb");
		expect(p).not.toContain("a\n\n\n");
	});

	it("normalizes 3+ blank lines to double newline in assistant text", async () => {
		stubQueryEmpty();
		await generateTurnRecap(
			null,
			0,
			"req",
			[],
			"x\n\n\n\ny",
			vi.fn(),
			"/vault",
			undefined,
		);
		const p = capturedPrompt();
		expect(p).toContain("x\n\ny");
		expect(p).not.toContain("x\n\n\n");
	});
});

// ── emit behavior ─────────────────────────────────────────────────────────────

describe("generateTurnRecap — emit", () => {
	it("emits tool_use_summary when SDK returns text", async () => {
		stubQueryReturns("Reads config and writes output.");
		const emit = vi.fn();
		await generateTurnRecap(null, 0, "req", [], "", emit, "/vault", undefined);
		expect(emit).toHaveBeenCalledWith({
			type: "tool_use_summary",
			summary: "Reads config and writes output.",
		});
	});

	it("does not emit when summary is empty", async () => {
		stubQueryEmpty();
		const emit = vi.fn();
		await generateTurnRecap(null, 0, "req", [], "", emit, "/vault", undefined);
		expect(emit).not.toHaveBeenCalled();
	});

	it("does not emit when summary is only whitespace", async () => {
		stubQueryReturns("   \n  ");
		const emit = vi.fn();
		await generateTurnRecap(null, 0, "req", [], "", emit, "/vault", undefined);
		expect(emit).not.toHaveBeenCalled();
	});

	it("trims whitespace from summary before emit", async () => {
		stubQueryReturns("  Summary text.  ");
		const emit = vi.fn();
		await generateTurnRecap(null, 0, "req", [], "", emit, "/vault", undefined);
		expect(emit).toHaveBeenCalledWith({
			type: "tool_use_summary",
			summary: "Summary text.",
		});
	});

	it("uses result field as fallback when no assistant block", async () => {
		stubQueryResult("Fallback summary.");
		const emit = vi.fn();
		await generateTurnRecap(null, 0, "req", [], "", emit, "/vault", undefined);
		expect(emit).toHaveBeenCalledWith({
			type: "tool_use_summary",
			summary: "Fallback summary.",
		});
	});
});

// ── DB persistence ────────────────────────────────────────────────────────────

describe("generateTurnRecap — DB persist", () => {
	it("persists recap when sessionId set and assistantSeq >= 0", async () => {
		stubQueryReturns("Summary.");
		await generateTurnRecap(
			"sess-1",
			3,
			"req",
			[],
			"",
			vi.fn(),
			"/vault",
			undefined,
		);
		expect(mockSetRecap).toHaveBeenCalledWith("sess-1", 3, "Summary.");
	});

	it("does not persist when sessionId is null", async () => {
		stubQueryReturns("Summary.");
		await generateTurnRecap(
			null,
			3,
			"req",
			[],
			"",
			vi.fn(),
			"/vault",
			undefined,
		);
		expect(mockSetRecap).not.toHaveBeenCalled();
	});

	it("does not persist when assistantSeq is -1", async () => {
		stubQueryReturns("Summary.");
		await generateTurnRecap(
			"sess-1",
			-1,
			"req",
			[],
			"",
			vi.fn(),
			"/vault",
			undefined,
		);
		expect(mockSetRecap).not.toHaveBeenCalled();
	});

	it("does not persist when summary is empty", async () => {
		stubQueryEmpty();
		await generateTurnRecap(
			"sess-1",
			0,
			"req",
			[],
			"",
			vi.fn(),
			"/vault",
			undefined,
		);
		expect(mockSetRecap).not.toHaveBeenCalled();
	});

	it("persists at assistantSeq=0", async () => {
		stubQueryReturns("Zero seq summary.");
		await generateTurnRecap(
			"sess-1",
			0,
			"req",
			[],
			"",
			vi.fn(),
			"/vault",
			undefined,
		);
		expect(mockSetRecap).toHaveBeenCalledWith("sess-1", 0, "Zero seq summary.");
	});
});

// ── prompt structure ──────────────────────────────────────────────────────────

describe("generateTurnRecap — prompt structure", () => {
	it("uses User: label for user message", async () => {
		stubQueryEmpty();
		await generateTurnRecap(
			null,
			0,
			"do a thing",
			[],
			"",
			vi.fn(),
			"/vault",
			undefined,
		);
		expect(capturedPrompt()).toContain("User: do a thing");
	});

	it("uses Assistant: label for assistant text", async () => {
		stubQueryEmpty();
		await generateTurnRecap(
			null,
			0,
			"req",
			[],
			"I did the thing.",
			vi.fn(),
			"/vault",
			undefined,
		);
		expect(capturedPrompt()).toContain("Assistant: I did the thing.");
	});

	it("prompt instruction uses past tense", async () => {
		stubQueryEmpty();
		await generateTurnRecap(
			null,
			0,
			"req",
			[],
			"",
			vi.fn(),
			"/vault",
			undefined,
		);
		expect(capturedPrompt()).toMatch(/past tense/);
	});
});

// ── SDK summary context ───────────────────────────────────────────────────────

describe("generateTurnRecap — SDK summary context", () => {
	it("includes SDK summary in prompt when provided", async () => {
		stubQueryEmpty();
		await generateTurnRecap(
			null,
			0,
			"req",
			[],
			"",
			vi.fn(),
			"/vault",
			undefined,
			"Ran the test suite and fixed 3 failures.",
		);
		expect(capturedPrompt()).toContain(
			"Ran the test suite and fixed 3 failures.",
		);
	});

	it("omits SDK summary section when null", async () => {
		stubQueryEmpty();
		await generateTurnRecap(
			null,
			0,
			"req",
			[],
			"",
			vi.fn(),
			"/vault",
			undefined,
			null,
		);
		expect(capturedPrompt()).not.toContain("Claude's recap:");
	});

	it("omits SDK summary section when not provided", async () => {
		stubQueryEmpty();
		await generateTurnRecap(
			null,
			0,
			"req",
			[],
			"",
			vi.fn(),
			"/vault",
			undefined,
		);
		expect(capturedPrompt()).not.toContain("Claude's recap:");
	});
});
