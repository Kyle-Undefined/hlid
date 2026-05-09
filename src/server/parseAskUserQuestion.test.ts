import { describe, expect, it } from "vitest";
import { parseAskUserQuestion } from "./parseAskUserQuestion";

// ── SDK format (current) ───────────────────────────────────────────────────────

describe("parseAskUserQuestion — SDK format", () => {
	it("extracts question from questions[0].question", () => {
		const result = parseAskUserQuestion({
			questions: [
				{
					question: "Which library?",
					header: "Library",
					options: [
						{ label: "React", description: "Popular UI lib" },
						{ label: "Vue", description: "Progressive framework" },
					],
					multiSelect: false,
				},
			],
		});
		expect(result.question).toBe("Which library?");
	});

	it("extracts option labels from questions[0].options", () => {
		const result = parseAskUserQuestion({
			questions: [
				{
					question: "Pick one",
					header: "Pick",
					options: [
						{ label: "A", description: "First" },
						{ label: "B", description: "Second" },
						{ label: "C", description: "Third" },
					],
					multiSelect: false,
				},
			],
		});
		expect(result.options).toEqual(["A", "B", "C"]);
	});

	it("uses first question when multiple questions present", () => {
		const result = parseAskUserQuestion({
			questions: [
				{
					question: "First?",
					header: "Q1",
					options: [{ label: "Yes" }, { label: "No" }],
					multiSelect: false,
				},
				{
					question: "Second?",
					header: "Q2",
					options: [{ label: "Alpha" }, { label: "Beta" }],
					multiSelect: false,
				},
			],
		});
		expect(result.question).toBe("First?");
		expect(result.options).toEqual(["Yes", "No"]);
	});

	it("skips options without a string label", () => {
		const result = parseAskUserQuestion({
			questions: [
				{
					question: "Q",
					header: "H",
					options: [
						{ label: "Valid" },
						{ label: 42 }, // non-string label
						{}, // missing label
					],
					multiSelect: false,
				},
			],
		});
		expect(result.options).toEqual(["Valid"]);
	});
});

// ── Legacy / plain-string format ───────────────────────────────────────────────

describe("parseAskUserQuestion — plain-string fallback", () => {
	it("falls back to top-level question string", () => {
		const result = parseAskUserQuestion({
			question: "Plain question?",
			options: ["Opt A", "Opt B"],
		});
		expect(result.question).toBe("Plain question?");
	});

	it("falls back to top-level string options array", () => {
		const result = parseAskUserQuestion({
			question: "Q?",
			options: ["X", "Y"],
		});
		expect(result.options).toEqual(["X", "Y"]);
	});
});

// ── Title fallback ─────────────────────────────────────────────────────────────

describe("parseAskUserQuestion — title fallback", () => {
	it("falls back to title when no question field anywhere", () => {
		const result = parseAskUserQuestion({}, "Tool title");
		expect(result.question).toBe("Tool title");
	});

	it("falls back to default string when no question and no title", () => {
		const result = parseAskUserQuestion({});
		expect(result.question).toBe("Question from Claude");
	});

	it("returns empty options when none present", () => {
		const result = parseAskUserQuestion({});
		expect(result.options).toEqual([]);
	});
});
