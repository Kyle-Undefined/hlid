/**
 * generateTurnRecap — tests the pure inline logic via inspecting the
 * prompt passed to the AgentProvider and verifying emit / DB calls.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../db", () => ({
	setMessageRecap: vi.fn().mockResolvedValue(undefined),
}));

import * as db from "../db";
import type {
	AgentEvent,
	AgentProvider,
	AgentQueryParams,
	AgentSession,
} from "./agentProvider";
import { generateTurnRecap } from "./recap";

const mockSetRecap = vi.mocked(db.setMessageRecap);

// ── helpers ───────────────────────────────────────────────────────────────────

let capturedParams: AgentQueryParams | undefined;
let capturedSendArg: string | undefined;

/** Build a mock AgentProvider that captures params and returns the given text. */
function makeProvider(responseText: string): AgentProvider {
	return {
		providerId: "claude",
		query(params: AgentQueryParams): AgentSession {
			capturedParams = params;
			const gen = (async function* (): AsyncGenerator<AgentEvent> {
				if (responseText) {
					yield { type: "text_delta", text: responseText };
				}
				yield {
					type: "done",
					cost: 0,
					turns: 1,
					durationMs: 0,
					usage: { inputTokens: 10, outputTokens: 5 },
				};
			})();
			return {
				[Symbol.asyncIterator]: () => gen[Symbol.asyncIterator](),
				cancel: vi.fn(),
				send: vi.fn(async (msg: string) => {
					capturedSendArg = msg;
				}),
			};
		},
	};
}

function stubReturns(text: string): AgentProvider {
	return makeProvider(text);
}

function stubEmpty(): AgentProvider {
	return makeProvider("");
}

function capturedPrompt(): string {
	if (capturedSendArg === undefined)
		throw new Error("No send was made — recap did not push prompt");
	return capturedSendArg;
}

beforeEach(() => {
	vi.clearAllMocks();
	capturedParams = undefined;
	capturedSendArg = undefined;
});

// ── tool summary line building ────────────────────────────────────────────────

describe("generateTurnRecap — tool summary", () => {
	it("uses path field when present", async () => {
		await generateTurnRecap(
			null,
			0,
			"req",
			[{ name: "Read", input: { path: "/foo/bar.ts" } }],
			"",
			vi.fn(),
			"/vault",
			undefined,
			null,
			stubEmpty(),
		);
		expect(capturedPrompt()).toContain("  - Read(/foo/bar.ts)");
	});

	it("uses command field when path absent", async () => {
		await generateTurnRecap(
			null,
			0,
			"req",
			[{ name: "Bash", input: { command: "ls -la" } }],
			"",
			vi.fn(),
			"/vault",
			undefined,
			null,
			stubEmpty(),
		);
		expect(capturedPrompt()).toContain("  - Bash(ls -la)");
	});

	it("truncates command to 80 chars", async () => {
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
			null,
			stubEmpty(),
		);
		expect(capturedPrompt()).toContain(`  - Bash(${"x".repeat(80)})`);
	});

	it("uses file_path field when path and command absent", async () => {
		await generateTurnRecap(
			null,
			0,
			"req",
			[{ name: "Edit", input: { file_path: "/src/index.ts" } }],
			"",
			vi.fn(),
			"/vault",
			undefined,
			null,
			stubEmpty(),
		);
		expect(capturedPrompt()).toContain("  - Edit(/src/index.ts)");
	});

	it("falls back to just tool name when no recognized field", async () => {
		await generateTurnRecap(
			null,
			0,
			"req",
			[{ name: "TodoWrite", input: { todos: [] } }],
			"",
			vi.fn(),
			"/vault",
			undefined,
			null,
			stubEmpty(),
		);
		const p = capturedPrompt();
		expect(p).toContain("  - TodoWrite");
		expect(p).not.toContain("  - TodoWrite(");
	});

	it("path takes precedence over command and file_path", async () => {
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
			null,
			stubEmpty(),
		);
		expect(capturedPrompt()).toContain("  - Tool(/path-wins)");
	});

	it("handles multiple tools", async () => {
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
			null,
			stubEmpty(),
		);
		const p = capturedPrompt();
		expect(p).toContain("  - Read(/a.ts)");
		expect(p).toContain("  - Bash(npm test)");
	});

	it("omits tools section when tool list is empty", async () => {
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
			stubEmpty(),
		);
		expect(capturedPrompt()).not.toContain("Tools used:");
	});

	it("handles null input gracefully", async () => {
		await generateTurnRecap(
			null,
			0,
			"req",
			[{ name: "Ghost", input: null }],
			"",
			vi.fn(),
			"/vault",
			undefined,
			null,
			stubEmpty(),
		);
		const p = capturedPrompt();
		expect(p).toContain("  - Ghost");
		expect(p).not.toContain("  - Ghost(");
	});
});

// ── excerpt truncation ────────────────────────────────────────────────────────

describe("generateTurnRecap — excerpt truncation", () => {
	it("truncates user message to 600 chars", async () => {
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
			null,
			stubEmpty(),
		);
		const p = capturedPrompt();
		expect(p).toContain("a".repeat(600));
		expect(p).not.toContain("a".repeat(601));
	});

	it("truncates assistant text to 2400 chars", async () => {
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
			null,
			stubEmpty(),
		);
		const p = capturedPrompt();
		expect(p).toContain("b".repeat(2400));
		expect(p).not.toContain("b".repeat(2401));
	});

	it("preserves single newlines in user message", async () => {
		await generateTurnRecap(
			null,
			0,
			"line1\nline2",
			[],
			"",
			vi.fn(),
			"/vault",
			undefined,
			null,
			stubEmpty(),
		);
		expect(capturedPrompt()).toContain("line1\nline2");
	});

	it("preserves single newlines in assistant text", async () => {
		await generateTurnRecap(
			null,
			0,
			"req",
			[],
			"first\nsecond\nthird",
			vi.fn(),
			"/vault",
			undefined,
			null,
			stubEmpty(),
		);
		expect(capturedPrompt()).toContain("first\nsecond\nthird");
	});

	it("normalizes 3+ blank lines to double newline in user message", async () => {
		await generateTurnRecap(
			null,
			0,
			"a\n\n\n\nb",
			[],
			"",
			vi.fn(),
			"/vault",
			undefined,
			null,
			stubEmpty(),
		);
		const p = capturedPrompt();
		expect(p).toContain("a\n\nb");
		expect(p).not.toContain("a\n\n\n");
	});

	it("normalizes 3+ blank lines to double newline in assistant text", async () => {
		await generateTurnRecap(
			null,
			0,
			"req",
			[],
			"x\n\n\n\ny",
			vi.fn(),
			"/vault",
			undefined,
			null,
			stubEmpty(),
		);
		const p = capturedPrompt();
		expect(p).toContain("x\n\ny");
		expect(p).not.toContain("x\n\n\n");
	});
});

// ── emit behavior ─────────────────────────────────────────────────────────────

describe("generateTurnRecap — emit", () => {
	it("emits tool_use_summary when provider returns text", async () => {
		const emit = vi.fn();
		await generateTurnRecap(
			null,
			0,
			"req",
			[],
			"",
			emit,
			"/vault",
			undefined,
			null,
			stubReturns("Reads config and writes output."),
		);
		expect(emit).toHaveBeenCalledWith({
			type: "tool_use_summary",
			summary: "Reads config and writes output.",
		});
	});

	it("does not emit when summary is empty", async () => {
		const emit = vi.fn();
		await generateTurnRecap(
			null,
			0,
			"req",
			[],
			"",
			emit,
			"/vault",
			undefined,
			null,
			stubEmpty(),
		);
		expect(emit).not.toHaveBeenCalled();
	});

	it("does not emit when summary is only whitespace", async () => {
		const emit = vi.fn();
		await generateTurnRecap(
			null,
			0,
			"req",
			[],
			"",
			emit,
			"/vault",
			undefined,
			null,
			stubReturns("   \n  "),
		);
		expect(emit).not.toHaveBeenCalled();
	});

	it("trims whitespace from summary before emit", async () => {
		const emit = vi.fn();
		await generateTurnRecap(
			null,
			0,
			"req",
			[],
			"",
			emit,
			"/vault",
			undefined,
			null,
			stubReturns("  Summary text.  "),
		);
		expect(emit).toHaveBeenCalledWith({
			type: "tool_use_summary",
			summary: "Summary text.",
		});
	});
});

// ── DB persistence ────────────────────────────────────────────────────────────

describe("generateTurnRecap — DB persist", () => {
	it("persists recap when sessionId set and assistantSeq >= 0", async () => {
		await generateTurnRecap(
			"sess-1",
			3,
			"req",
			[],
			"",
			vi.fn(),
			"/vault",
			undefined,
			null,
			stubReturns("Summary."),
		);
		expect(mockSetRecap).toHaveBeenCalledWith("sess-1", 3, "Summary.");
	});

	it("does not persist when sessionId is null", async () => {
		await generateTurnRecap(
			null,
			3,
			"req",
			[],
			"",
			vi.fn(),
			"/vault",
			undefined,
			null,
			stubReturns("Summary."),
		);
		expect(mockSetRecap).not.toHaveBeenCalled();
	});

	it("does not persist when assistantSeq is -1", async () => {
		await generateTurnRecap(
			"sess-1",
			-1,
			"req",
			[],
			"",
			vi.fn(),
			"/vault",
			undefined,
			null,
			stubReturns("Summary."),
		);
		expect(mockSetRecap).not.toHaveBeenCalled();
	});

	it("does not persist when summary is empty", async () => {
		await generateTurnRecap(
			"sess-1",
			0,
			"req",
			[],
			"",
			vi.fn(),
			"/vault",
			undefined,
			null,
			stubEmpty(),
		);
		expect(mockSetRecap).not.toHaveBeenCalled();
	});

	it("persists at assistantSeq=0", async () => {
		await generateTurnRecap(
			"sess-1",
			0,
			"req",
			[],
			"",
			vi.fn(),
			"/vault",
			undefined,
			null,
			stubReturns("Zero seq summary."),
		);
		expect(mockSetRecap).toHaveBeenCalledWith("sess-1", 0, "Zero seq summary.");
	});
});

// ── prompt structure ──────────────────────────────────────────────────────────

describe("generateTurnRecap — prompt structure", () => {
	it("uses User: label for user message", async () => {
		await generateTurnRecap(
			null,
			0,
			"do a thing",
			[],
			"",
			vi.fn(),
			"/vault",
			undefined,
			null,
			stubEmpty(),
		);
		expect(capturedPrompt()).toContain("User: do a thing");
	});

	it("uses Assistant: label for assistant text", async () => {
		await generateTurnRecap(
			null,
			0,
			"req",
			[],
			"I did the thing.",
			vi.fn(),
			"/vault",
			undefined,
			null,
			stubEmpty(),
		);
		expect(capturedPrompt()).toContain("Assistant: I did the thing.");
	});

	it("prompt instruction uses past tense", async () => {
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
			stubEmpty(),
		);
		expect(capturedPrompt()).toMatch(/past tense/);
	});
});

// ── SDK summary context ───────────────────────────────────────────────────────

describe("generateTurnRecap — SDK summary context", () => {
	it("includes SDK summary in prompt when provided", async () => {
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
			stubEmpty(),
		);
		expect(capturedPrompt()).toContain(
			"Ran the test suite and fixed 3 failures.",
		);
	});

	it("omits SDK summary section when null", async () => {
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
			stubEmpty(),
		);
		expect(capturedPrompt()).not.toContain("Claude's recap:");
	});

	it("omits SDK summary section when not provided", async () => {
		await generateTurnRecap(
			null,
			0,
			"req",
			[],
			"",
			vi.fn(),
			"/vault",
			undefined,
			undefined,
			stubEmpty(),
		);
		expect(capturedPrompt()).not.toContain("Claude's recap:");
	});
});

// ── recap model ───────────────────────────────────────────────────────────────

describe("generateTurnRecap — recap model", () => {
	it("uses claude-haiku-4-5 by default when no recapModel provided", async () => {
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
			stubEmpty(),
		);
		expect(capturedParams?.model).toBe("claude-haiku-4-5");
	});

	it("uses recapModel when explicitly provided", async () => {
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
			stubEmpty(),
			"claude-sonnet-4-6",
		);
		expect(capturedParams?.model).toBe("claude-sonnet-4-6");
	});

	it("passes recapModel to provider query regardless of provider type", async () => {
		const customProvider: AgentProvider = {
			providerId: "codex",
			query(params: AgentQueryParams): AgentSession {
				capturedParams = params;
				const gen = (async function* (): AsyncGenerator<AgentEvent> {
					yield {
						type: "done",
						cost: 0,
						turns: 1,
						durationMs: 0,
						usage: { inputTokens: 1, outputTokens: 1 },
					};
				})();
				return {
					[Symbol.asyncIterator]: () => gen[Symbol.asyncIterator](),
					cancel: vi.fn(),
					send: vi.fn().mockResolvedValue(undefined),
				};
			},
		};
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
			customProvider,
			"gpt-4o-mini",
		);
		expect(capturedParams?.model).toBe("gpt-4o-mini");
	});
});

// ── returns early when no provider ───────────────────────────────────────────

describe("generateTurnRecap — no provider", () => {
	it("returns immediately without error when provider is undefined", async () => {
		const emit = vi.fn();
		await generateTurnRecap(
			"sess-1",
			0,
			"req",
			[],
			"text",
			emit,
			"/vault",
			undefined,
		);
		expect(emit).not.toHaveBeenCalled();
		expect(mockSetRecap).not.toHaveBeenCalled();
	});
});
