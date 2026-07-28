import { describe, expect, it } from "vitest";
import {
	chunkNeuralReadAloudText,
	chunkReadAloudText,
	DEFAULT_READ_ALOUD_PREFERENCES,
	estimateReadAloudResumeIndex,
	normalizeReadAloudPreferences,
	readableTextFromMarkdown,
} from "./readAloud";

describe("readableTextFromMarkdown", () => {
	it("keeps prose and labels while dropping code, URLs, and Markdown punctuation", () => {
		const markdown = `# Result

Read the [documentation](https://example.com/docs) and **keep this**.

- First item
- Second item with \`inline code\`

\`\`\`ts
const secret = "do not narrate code";
\`\`\`

![Architecture diagram](https://example.com/image.png)`;

		expect(readableTextFromMarkdown(markdown)).toBe(
			"Result. Read the documentation and keep this. First item. Second item with inline code. Architecture diagram.",
		);
	});

	it("turns tables into short spoken rows without narrating separators", () => {
		expect(
			readableTextFromMarkdown(
				"| Name | State |\n| --- | --- |\n| Raven | ready |",
			),
		).toBe("Name, State. Raven, ready.");
	});
});

describe("chunkReadAloudText", () => {
	it("keeps utterances bounded while preserving every word", () => {
		const text =
			"One short sentence. Another sentence with several words. A final sentence for the test.";
		const chunks = chunkReadAloudText(text, 38);
		expect(chunks.every((chunk) => chunk.length <= 38)).toBe(true);
		expect(chunks.join(" ")).toBe(text);
	});

	it("returns no utterances for blank text", () => {
		expect(chunkReadAloudText("   ")).toEqual([]);
	});
});

describe("chunkNeuralReadAloudText", () => {
	it("uses a short first chunk and preserves the complete text", () => {
		const text =
			"Hlid reads a deliberately short opening before preparing the rest of this reply.";
		const chunks = chunkNeuralReadAloudText(text);
		expect(chunks[0]?.length).toBeLessThanOrEqual(20);
		expect(chunks.join(" ")).toBe(text);
		expect(chunks.slice(1).every((chunk) => chunk.length <= 220)).toBe(true);
	});

	it("keeps an unbroken token inside the runtime limit", () => {
		const chunks = chunkNeuralReadAloudText("x".repeat(900));
		expect(chunks.every((chunk) => chunk.length <= 220)).toBe(true);
	});
});

describe("estimateReadAloudResumeIndex", () => {
	it("uses elapsed speech to resume at a conservative prior word", () => {
		const text = "One two three four five six seven eight.";
		const index = estimateReadAloudResumeIndex(text, 0, 2_200, 1);
		expect(text.slice(index)).toBe("four five six seven eight.");
	});

	it("advances relative to a previous resume point", () => {
		const text = "One two three four five six seven eight.";
		const start = text.indexOf("four");
		const index = estimateReadAloudResumeIndex(text, start, 1_100, 1);
		expect(text.slice(index)).toBe("five six seven eight.");
	});

	it("does not guess before enough speech has played", () => {
		expect(estimateReadAloudResumeIndex("One two three.", 0, 500, 1)).toBe(0);
	});
});

describe("normalizeReadAloudPreferences", () => {
	it("accepts an in-range rate and device voice", () => {
		expect(
			normalizeReadAloudPreferences({
				provider: "microsoft",
				voiceURI: "local:voice",
				microsoftVoiceId: "windows:mark",
				rate: 1.25,
			}),
		).toEqual({
			provider: "microsoft",
			voiceURI: "local:voice",
			microsoftVoiceId: "windows:mark",
			neuralVoiceId: "expr-voice-2-f",
			rate: 1.25,
		});
	});

	it("migrates existing browser-only preferences", () => {
		expect(
			normalizeReadAloudPreferences({ voiceURI: "local:voice", rate: 1.5 }),
		).toEqual({
			provider: "device",
			voiceURI: "local:voice",
			microsoftVoiceId: "",
			neuralVoiceId: "expr-voice-2-f",
			rate: 1.5,
		});
	});

	it("falls back for invalid stored preferences", () => {
		expect(normalizeReadAloudPreferences({ voiceURI: 7, rate: 12 })).toEqual(
			DEFAULT_READ_ALOUD_PREFERENCES,
		);
	});

	it("accepts the local neural provider and voice", () => {
		expect(
			normalizeReadAloudPreferences({
				provider: "neural",
				neuralVoiceId: "expr-voice-5-f",
			}),
		).toMatchObject({
			provider: "neural",
			neuralVoiceId: "expr-voice-5-f",
		});
	});
});
