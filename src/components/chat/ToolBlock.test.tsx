// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as privacyStore from "#/hooks/privacyStore";
import type { ToolEventMessage } from "#/server/protocol";
import {
	looksLikeMarkdown,
	stripReadLineNumbers,
	ToolBlock,
} from "./ToolBlock";

afterEach(cleanup);
beforeEach(() => {
	privacyStore.__resetForTesting();
});

function makeEvent(overrides?: Partial<ToolEventMessage>): ToolEventMessage {
	return {
		type: "tool_event",
		id: "te1",
		name: "Bash",
		input: { command: "ls /tmp" },
		...overrides,
	};
}

describe("ToolBlock — collapsed", () => {
	it("renders tool name and input pills", () => {
		render(<ToolBlock event={makeEvent()} />);
		expect(screen.getByText("Bash")).not.toBeNull();
		expect(screen.getByText(/command:/)).not.toBeNull();
	});

	it("shows result preview line when result is present", () => {
		render(<ToolBlock event={makeEvent({ result: "file1\nfile2\nfile3" })} />);
		expect(screen.getByText("file1")).not.toBeNull();
		expect(screen.queryByText("file2")).toBeNull();
	});

	it("does not show result preview when no result", () => {
		render(<ToolBlock event={makeEvent()} />);
		expect(screen.queryByText("(empty)")).toBeNull();
	});

	it("renders error indicator on isError", () => {
		render(
			<ToolBlock
				event={makeEvent({ result: "permission denied", isError: true })}
			/>,
		);
		expect(screen.getByLabelText(/error/i)).not.toBeNull();
		expect(screen.getByText("permission denied")).not.toBeNull();
	});
});

describe("ToolBlock — expanded", () => {
	it("expand reveals full result text", () => {
		render(<ToolBlock event={makeEvent({ result: "line1\nline2\nline3" })} />);
		fireEvent.click(screen.getByRole("button", { expanded: false }));
		const pre = document.querySelector("pre");
		expect(pre?.textContent).toBe("line1\nline2\nline3");
	});

	it("expand renders Result heading on success", () => {
		render(<ToolBlock event={makeEvent({ result: "ok" })} />);
		fireEvent.click(screen.getByRole("button", { expanded: false }));
		expect(screen.getByText(/^Result$/i)).not.toBeNull();
	});

	it("expand renders Error heading on isError", () => {
		render(<ToolBlock event={makeEvent({ result: "boom", isError: true })} />);
		fireEvent.click(screen.getByRole("button", { expanded: false }));
		expect(screen.getByText(/^Error$/i)).not.toBeNull();
	});
});

describe("looksLikeMarkdown", () => {
	it("detects ATX headings", () => {
		expect(looksLikeMarkdown("# Title\nbody")).toBe(true);
		expect(looksLikeMarkdown("## Sub")).toBe(true);
	});
	it("detects fenced code blocks", () => {
		expect(looksLikeMarkdown("foo\n```js\nx\n```")).toBe(true);
	});
	it("detects bullet lists", () => {
		expect(looksLikeMarkdown("- one\n- two")).toBe(true);
		expect(looksLikeMarkdown("1. first\n2. second")).toBe(true);
	});
	it("detects markdown tables", () => {
		expect(looksLikeMarkdown("| a | b |\n| - | - |\n| 1 | 2 |")).toBe(true);
	});
	it("detects link with brackets", () => {
		expect(looksLikeMarkdown("see [docs](https://x.y)")).toBe(true);
	});
	it("detects multiple bold spans", () => {
		expect(looksLikeMarkdown("**a** and **b**")).toBe(true);
	});
	it("rejects single bold span (too weak)", () => {
		expect(looksLikeMarkdown("**only**")).toBe(false);
	});
	it("rejects plain bash output", () => {
		expect(looksLikeMarkdown("file1\nfile2\nfile3")).toBe(false);
	});
	it("rejects JSON", () => {
		expect(looksLikeMarkdown('{"a": 1, "b": [2, 3]}')).toBe(false);
	});
	it("rejects empty", () => {
		expect(looksLikeMarkdown("")).toBe(false);
	});
});

describe("stripReadLineNumbers", () => {
	it("strips '   N\\t' prefix from Read tool output", () => {
		const input = "     1\t# Title\n     2\t\n     3\tBody.";
		expect(stripReadLineNumbers(input)).toBe("# Title\n\nBody.");
	});

	it("handles tabs without leading whitespace", () => {
		expect(stripReadLineNumbers("1\tfoo\n2\tbar")).toBe("foo\nbar");
	});

	it("leaves plain text unchanged when no prefix", () => {
		const input = "no line numbers here\njust text";
		expect(stripReadLineNumbers(input)).toBe(input);
	});

	it("does not mangle output when only one line happens to match", () => {
		const input = "1\tfoo\nnormal line\nanother normal";
		expect(stripReadLineNumbers(input)).toBe(input);
	});

	it("handles empty string", () => {
		expect(stripReadLineNumbers("")).toBe("");
	});
});

describe("ToolBlock — Read tool markdown rendering", () => {
	it("strips line numbers and renders markdown for Read of a markdown file", () => {
		const readme =
			"     1\t# Hlið\n     2\t\n     3\t*Short for Hliðskjálf.*\n     4\t\n     5\t- one\n     6\t- two";
		render(<ToolBlock event={makeEvent({ name: "Read", result: readme })} />);
		fireEvent.click(screen.getByRole("button", { expanded: false }));
		// Heading rendered, line numbers gone
		expect(screen.getByText("Hlið").tagName).toBe("H1");
		expect(screen.queryByText(/^\s*1\s*$/)).toBeNull();
	});
});

describe("ToolBlock — markdown result rendering", () => {
	it("renders <pre> for plain text result", () => {
		render(<ToolBlock event={makeEvent({ result: "line1\nline2" })} />);
		fireEvent.click(screen.getByRole("button", { expanded: false }));
		expect(document.querySelector("pre")).not.toBeNull();
	});

	it("renders MarkdownBody for markdown-shaped result", () => {
		render(
			<ToolBlock
				event={makeEvent({ result: "# Heading\n\n- item 1\n- item 2" })}
			/>,
		);
		fireEvent.click(screen.getByRole("button", { expanded: false }));
		expect(screen.getByText("Heading").tagName).toBe("H1");
		// pre should NOT be used for the markdown-rendered result
		const pres = document.querySelectorAll("pre");
		expect(pres.length).toBe(0);
	});

	it("error result always uses <pre> regardless of markdown", () => {
		render(
			<ToolBlock event={makeEvent({ result: "# heading", isError: true })} />,
		);
		fireEvent.click(screen.getByRole("button", { expanded: false }));
		expect(document.querySelector("pre")).not.toBeNull();
	});
});

describe("ToolBlock — permissionLabel", () => {
	it("shows label when provided", () => {
		render(<ToolBlock event={makeEvent()} permissionLabel="APPROVED" />);
		expect(screen.getByText("APPROVED")).not.toBeNull();
	});
});
