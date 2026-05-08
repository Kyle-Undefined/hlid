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
		expect(capturedPrompt()).toContain("  - TodoWrite\n");
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

	it("handles empty tool list", async () => {
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
		expect(capturedPrompt()).toContain("Tools used:\n");
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
		expect(capturedPrompt()).toContain("  - Ghost\n");
	});
});

// ── excerpt truncation ────────────────────────────────────────────────────────

describe("generateTurnRecap — excerpt truncation", () => {
	it("truncates user message to 300 chars", async () => {
		stubQueryEmpty();
		const longMsg = "a".repeat(400);
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
		expect(p).toContain(`User request: ${"a".repeat(300)}`);
		expect(p).not.toContain("a".repeat(301));
	});

	it("truncates assistant text to 1200 chars", async () => {
		stubQueryEmpty();
		const longText = "b".repeat(1400);
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
		expect(p).toContain(`Assistant response excerpt: ${"b".repeat(1200)}`);
		expect(p).not.toContain("b".repeat(1201));
	});

	it("collapses newlines to spaces in user message", async () => {
		stubQueryEmpty();
		await generateTurnRecap(
			null,
			0,
			"line1\n\nline2",
			[],
			"",
			vi.fn(),
			"/vault",
			undefined,
		);
		expect(capturedPrompt()).toContain("User request: line1 line2");
	});

	it("collapses newlines to spaces in assistant text", async () => {
		stubQueryEmpty();
		await generateTurnRecap(
			null,
			0,
			"req",
			[],
			"first\nsecond\n\nthird",
			vi.fn(),
			"/vault",
			undefined,
		);
		expect(capturedPrompt()).toContain(
			"Assistant response excerpt: first second third",
		);
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
