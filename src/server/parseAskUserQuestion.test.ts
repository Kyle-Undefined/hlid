import { describe, expect, it } from "vitest";
import { parseAskUserQuestion } from "./parseAskUserQuestion";

// ── SDK format (current) ───────────────────────────────────────────────────────

describe("parseAskUserQuestion — SDK format", () => {
	it("extracts question text from questions[0].question", () => {
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
		expect(result.questions[0].question).toBe("Which library?");
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
		expect(result.questions[0].options).toEqual(["A", "B", "C"]);
	});

	it("returns all questions when multiple are present", () => {
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
		expect(result.questions).toHaveLength(2);
		expect(result.questions[0].question).toBe("First?");
		expect(result.questions[0].options).toEqual(["Yes", "No"]);
		expect(result.questions[1].question).toBe("Second?");
		expect(result.questions[1].options).toEqual(["Alpha", "Beta"]);
	});

	it("preserves multiSelect flag per question", () => {
		const result = parseAskUserQuestion({
			questions: [
				{
					question: "Single?",
					header: "S",
					options: [{ label: "A" }, { label: "B" }],
					multiSelect: false,
				},
				{
					question: "Multi?",
					header: "M",
					options: [{ label: "X" }, { label: "Y" }, { label: "Z" }],
					multiSelect: true,
				},
			],
		});
		expect(result.questions[0].multiSelect).toBe(false);
		expect(result.questions[1].multiSelect).toBe(true);
	});

	it("defaults multiSelect to false when missing", () => {
		const result = parseAskUserQuestion({
			questions: [
				{
					question: "Q",
					header: "H",
					options: [{ label: "A" }, { label: "B" }],
				},
			],
		});
		expect(result.questions[0].multiSelect).toBe(false);
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
		expect(result.questions[0].options).toEqual(["Valid"]);
	});

	it("drops questions that have no usable options", () => {
		const result = parseAskUserQuestion({
			questions: [
				{
					question: "Empty?",
					header: "E",
					options: [],
					multiSelect: false,
				},
				{
					question: "Has options?",
					header: "H",
					options: [{ label: "Yes" }],
					multiSelect: false,
				},
			],
		});
		expect(result.questions).toHaveLength(1);
		expect(result.questions[0].question).toBe("Has options?");
	});
});

// ── Legacy / plain-string format ───────────────────────────────────────────────

describe("parseAskUserQuestion — plain-string fallback", () => {
	it("falls back to top-level question string", () => {
		const result = parseAskUserQuestion({
			question: "Plain question?",
			options: ["Opt A", "Opt B"],
		});
		expect(result.questions).toHaveLength(1);
		expect(result.questions[0].question).toBe("Plain question?");
	});

	it("falls back to top-level string options array", () => {
		const result = parseAskUserQuestion({
			question: "Q?",
			options: ["X", "Y"],
		});
		expect(result.questions[0].options).toEqual(["X", "Y"]);
	});

	it("plain-string fallback is never multiSelect", () => {
		const result = parseAskUserQuestion({
			question: "Q?",
			options: ["X", "Y"],
		});
		expect(result.questions[0].multiSelect).toBe(false);
	});
});

// ── Title fallback ─────────────────────────────────────────────────────────────

describe("parseAskUserQuestion — title fallback", () => {
	it("falls back to title when no question field anywhere", () => {
		const result = parseAskUserQuestion({}, "Tool title");
		expect(result.questions[0].question).toBe("Tool title");
	});

	it("falls back to default string when no question and no title", () => {
		const result = parseAskUserQuestion({});
		expect(result.questions[0].question).toBe("Question from Claude");
	});

	it("returns a single question with empty options when nothing present", () => {
		const result = parseAskUserQuestion({});
		expect(result.questions).toHaveLength(1);
		expect(result.questions[0].options).toEqual([]);
	});
});
