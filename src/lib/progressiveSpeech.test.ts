import { describe, expect, it } from "vitest";
import {
	createProgressiveSpeechSegmenter,
	MAX_PROGRESSIVE_SPEECH_SEGMENT_CHARS,
} from "./progressiveSpeech";

describe("createProgressiveSpeechSegmenter", () => {
	it("buffers split words and emits complete sentences once", () => {
		const speech = createProgressiveSpeechSegmenter("turn-1");
		expect(speech.pushChunk({ text: "I'll ins", offset: 0 }).enqueue).toEqual(
			[],
		);
		const update = speech.pushChunk({ text: "pect that. ", offset: 8 });
		expect(update.enqueue.map((segment) => segment.text)).toEqual([
			"I'll inspect that.",
		]);
		expect(update.enqueue[0]).toMatchObject({
			sourceStart: 0,
			sourceEnd: 18,
			boundary: "sentence",
		});

		// A reconnect can replay the exact same offset-aware delta.
		expect(speech.pushChunk({ text: "pect that. ", offset: 8 })).toEqual({
			enqueue: [],
			invalidate: [],
		});
	});

	it("uses a blank line as a stable paragraph boundary", () => {
		const speech = createProgressiveSpeechSegmenter();
		const update = speech.pushChunk({ text: "Working on it\n\nNext" });
		expect(update.enqueue.map((segment) => segment.text)).toEqual([
			"Working on it.",
		]);
		expect(update.enqueue[0]?.boundary).toBe("paragraph");
		expect(speech.flush("done").enqueue.map((segment) => segment.text)).toEqual(
			["Next."],
		);
	});

	it.each([
		[
			"unordered items",
			"- First item\n- Second item",
			[
				{ text: "First item.", sourceStart: 0, sourceEnd: 13 },
				{ text: "Second item.", sourceStart: 13, sourceEnd: 26 },
			],
		],
		[
			"period-numbered items",
			"1. First item\n2. Second item",
			[
				{ text: "First item.", sourceStart: 0, sourceEnd: 14 },
				{ text: "Second item.", sourceStart: 14, sourceEnd: 28 },
			],
		],
		[
			"parenthesis-numbered items",
			"1) First item\n2) Second item",
			[
				{ text: "First item.", sourceStart: 0, sourceEnd: 14 },
				{ text: "Second item.", sourceStart: 14, sourceEnd: 28 },
			],
		],
		[
			"nested items",
			"- Parent\n  - Child\n- Sibling",
			[
				{ text: "Parent.", sourceStart: 0, sourceEnd: 9 },
				{ text: "Child.", sourceStart: 9, sourceEnd: 19 },
				{ text: "Sibling.", sourceStart: 19, sourceEnd: 28 },
			],
		],
		[
			"task-list items",
			"- [ ] Pending\n- [x] Done",
			[
				{ text: "Pending.", sourceStart: 0, sourceEnd: 14 },
				{ text: "Done.", sourceStart: 14, sourceEnd: 24 },
			],
		],
	] as const)("emits %s as source-aligned speech segments", (_name, source, expected) => {
		const speech = createProgressiveSpeechSegmenter("turn-list");
		const stable = speech.pushChunk({ text: source }).enqueue;
		const tail = speech.flush("done").enqueue;

		expect(
			[...stable, ...tail].map(({ text, sourceStart, sourceEnd }) => ({
				text,
				sourceStart,
				sourceEnd,
			})),
		).toEqual(expected);
	});

	it("keeps a soft-wrapped list continuation in its parent item", () => {
		const source = "- First line\n  continuation\n- Next item";
		const speech = createProgressiveSpeechSegmenter("turn-wrapped-list");
		const stable = speech.pushChunk({ text: source }).enqueue;
		const tail = speech.flush("done").enqueue;
		const segments = [...stable, ...tail];

		expect(segments).toHaveLength(2);
		expect(segments[0]).toMatchObject({ sourceStart: 0, sourceEnd: 28 });
		expect(segments[0]?.text).toContain("First line");
		expect(segments[0]?.text).toContain("continuation");
		expect(segments[1]).toMatchObject({
			text: "Next item.",
			sourceStart: 28,
			sourceEnd: source.length,
		});
	});

	it("keeps later sentences separate from the next list item", () => {
		const source = "- First sentence. More detail\n- Second item";
		const speech = createProgressiveSpeechSegmenter("turn-list-detail");
		const stable = speech.pushChunk({ text: source }).enqueue;
		const tail = speech.flush("done").enqueue;

		expect([...stable, ...tail].map((segment) => segment.text)).toEqual([
			"First sentence.",
			"More detail.",
			"Second item.",
		]);
	});

	it("buffers a partial ordered-list marker until its item arrives", () => {
		const speech = createProgressiveSpeechSegmenter("turn-partial-list");
		expect(speech.pushChunk({ text: "1." }).enqueue).toEqual([]);
		expect(
			speech
				.pushChunk({
					text: " First item\n2. Second item",
					offset: 2,
				})
				.enqueue.map((segment) => segment.text),
		).toEqual(["First item."]);
		expect(speech.flush("done").enqueue.map((segment) => segment.text)).toEqual(
			["Second item."],
		);
	});

	it("handles a long non-list blockquote prefix without pathological scanning", () => {
		const source = `${">".repeat(30)} not a list.`;
		const speech = createProgressiveSpeechSegmenter("turn-blockquote-prefix");
		expect(
			speech.pushChunk({ text: source }).enqueue.map(({ text }) => text),
		).toEqual(["not a list."]);
	}, 500);

	it("invalidates only a revised queued list item", () => {
		const speech = createProgressiveSpeechSegmenter("turn-list-replace");
		const original = speech.pushChunk({
			text: "- First item\n- Old item.",
		}).enqueue;

		const replacement = speech.pushChunk({
			text: "- First item\n- New item.",
			replace: true,
		});

		expect(replacement.invalidate).toEqual([original[1]?.id]);
		expect(replacement.invalidate).not.toContain(original[0]?.id);
		expect(replacement.enqueue.map((segment) => segment.text)).toEqual([
			"New item.",
		]);
	});

	it.each([
		["ordinary prose", "First line\nSecond line.", "First line. Second line."],
		["a heading", "## Result\nReady.", "Result. Ready."],
		[
			"a table",
			"| Name | State |\n| --- | --- |\n| Raven | ready |",
			"Name, State. Raven, ready.",
		],
	] as const)("does not split %s at a single newline", (_name, source, expected) => {
		const speech = createProgressiveSpeechSegmenter("turn-non-list");
		const stable = speech.pushChunk({ text: source }).enqueue;
		const tail = speech.flush("done").enqueue;

		expect([...stable, ...tail]).toMatchObject([
			{
				text: expected,
				sourceStart: 0,
				sourceEnd: source.length,
			},
		]);
	});

	it("force flushes settled prose at tool and message boundaries", () => {
		const speech = createProgressiveSpeechSegmenter();
		expect(speech.pushChunk({ text: "I'll inspect that" }).enqueue).toEqual([]);
		expect(speech.flush("tool").enqueue).toMatchObject([
			{ text: "I'll inspect that.", boundary: "tool" },
		]);
		speech.pushChunk({ text: "The first check is complete" });
		expect(speech.flush("message").enqueue).toMatchObject([
			{ text: "The first check is complete.", boundary: "message" },
		]);
		expect(speech.flush("done")).toEqual({ enqueue: [], invalidate: [] });
	});

	it("applies configured pronunciations without changing source ranges", () => {
		const source = "Hlið uses OpenCode. HLIÐ is ready.";
		const speech = createProgressiveSpeechSegmenter("turn-pronunciation", [
			{ written: "Hlið", spoken: "hleeth" },
			{ written: "OpenCode", spoken: "open code" },
		]);

		expect(speech.pushChunk({ text: source }).enqueue).toMatchObject([
			{
				text: "hleeth uses open code.",
				sourceStart: 0,
				sourceEnd: "Hlið uses OpenCode.".length,
			},
			{
				text: "hleeth is ready.",
				sourceStart: "Hlið uses OpenCode.".length,
				sourceEnd: source.length,
			},
		]);
	});

	it("bounds expanded pronunciations before neural synthesis", () => {
		const spoken = "A C P application control protocol";
		const source = Array.from({ length: 30 }, () => "ACP").join(" ");
		const speech = createProgressiveSpeechSegmenter("turn-expanded", [
			{ written: "ACP", spoken },
		]);
		speech.pushChunk({ text: source });
		const segments = speech.flush("done").enqueue;

		expect(segments.length).toBeGreaterThan(1);
		expect(
			segments.every(
				(segment) =>
					segment.text.length <= MAX_PROGRESSIVE_SPEECH_SEGMENT_CHARS,
			),
		).toBe(true);
		expect(
			segments.reduce(
				(count, segment) => count + segment.text.split(spoken).length - 1,
				0,
			),
		).toBe(30);
		expect(segments.every((segment) => !segment.text.includes("ACP"))).toBe(
			true,
		);
		expect(segments[0]?.sourceStart).toBe(0);
		expect(segments.at(-1)?.sourceEnd).toBe(source.length);
	});

	it("subdivides long prose into bounded source-aligned segments", () => {
		const speech = createProgressiveSpeechSegmenter("turn-long");
		const source = Array.from(
			{ length: 120 },
			(_, index) => `word${index}`,
		).join(" ");
		speech.pushChunk({ text: source });
		const segments = speech.flush("done").enqueue;

		expect(segments.length).toBeGreaterThan(1);
		expect(
			segments.every(
				(segment) =>
					segment.text.length <= MAX_PROGRESSIVE_SPEECH_SEGMENT_CHARS,
			),
		).toBe(true);
		expect(segments[0]?.sourceStart).toBe(0);
		expect(segments.at(-1)?.sourceEnd).toBe(source.length);
		for (let index = 1; index < segments.length; index += 1) {
			expect(segments[index]?.sourceStart).toBe(segments[index - 1]?.sourceEnd);
		}
	});

	it("hard-splits an unbroken token below the synthesis endpoint cap", () => {
		const speech = createProgressiveSpeechSegmenter("turn-hash");
		const source = "a".repeat(700);
		speech.pushChunk({ text: source });
		const segments = speech.flush("tool").enqueue;

		expect(segments.length).toBeGreaterThan(2);
		expect(
			Math.max(...segments.map((segment) => segment.text.length)),
		).toBeLessThanOrEqual(MAX_PROGRESSIVE_SPEECH_SEGMENT_CHARS);
		expect(
			segments.map((segment) => segment.sourceEnd - segment.sourceStart),
		).toEqual(
			expect.arrayContaining([MAX_PROGRESSIVE_SPEECH_SEGMENT_CHARS - 1]),
		);
		expect(segments.at(-1)?.sourceEnd).toBe(source.length);
	});

	it("never narrates fenced or indented code and cleans Markdown", () => {
		const speech = createProgressiveSpeechSegmenter();
		const first = speech.pushChunk({
			text: "Here is the result.\n\n```ts\nconst hidden = 'do not read.';",
		});
		expect(first.enqueue.map((segment) => segment.text)).toEqual([
			"Here is the result.",
		]);
		expect(speech.flush("tool").enqueue).toEqual([]);

		const second = speech.pushChunk({
			text: "\n```\n\nRead [the docs](https://example.com/docs).\n\n    hiddenCall();\n",
		});
		expect(second.enqueue.map((segment) => segment.text)).toEqual([
			"Read the docs.",
		]);
		expect(
			second.enqueue.map((segment) => segment.text).join(" "),
		).not.toContain("hidden");
	});

	it("does not narrate standalone indented code that resembles a list", () => {
		const speech = createProgressiveSpeechSegmenter("turn-indented-code-list");
		const source = "Intro.\n\n    - hidden item\n\nDone.";
		expect(
			speech.pushChunk({ text: source }).enqueue.map(({ text }) => text),
		).toEqual(["Intro.", "Done."]);
	});

	it("does not narrate indented list-shaped code inside a list", () => {
		const speech = createProgressiveSpeechSegmenter("turn-nested-list-code");
		const source = [
			"- Parent",
			"",
			"      - secret code",
			"",
			"- Sibling",
		].join("\n");
		const stable = speech.pushChunk({ text: source }).enqueue;
		const tail = speech.flush("done").enqueue;
		expect([...stable, ...tail].map(({ text }) => text)).toEqual([
			"Parent.",
			"Sibling.",
		]);
	});

	it("cleans the exact Codex shell timestamp and Windows folder tail", () => {
		const source = [
			"Live shell check:",
			"",
			"- Time: `2026-08-15T11:31:48-04:00`",
			"- Working folder: `C:\\Users\\kyleu\\Documents\\Obsidian\\Fornbok`",
		].join("\n");
		const speech = createProgressiveSpeechSegmenter("turn-shell-check");
		const stable = speech.pushChunk({ text: source }).enqueue;
		const tail = speech.flush("done").enqueue;

		expect([...stable, ...tail]).toMatchObject([
			{
				text: "Live shell check:",
				sourceStart: 0,
				sourceEnd: "Live shell check:\n\n".length,
			},
			{
				text: "Working folder: Fornbok.",
				sourceStart: "Live shell check:\n\n".length,
				sourceEnd: source.length,
			},
		]);
	});

	it("removes bracketed and bare ISO log prefixes while keeping their prose", () => {
		for (const source of [
			"[2026-08-15T15:42:07.123Z] Running focused tests.",
			"2026-08-15T11:31:48-04:00 Running focused tests.",
		]) {
			const speech = createProgressiveSpeechSegmenter("turn-log-prefix");
			const segment = speech.pushChunk({ text: source }).enqueue[0];
			expect(segment).toMatchObject({
				text: "Running focused tests.",
				sourceStart: 0,
				sourceEnd: source.length,
			});
		}
	});

	it("omits test timing telemetry but preserves failures and ordinary numbers", () => {
		const source = [
			"2 tests failed. Retry at 3:30 PM.",
			"Start at  15:39:41",
			"Duration  1.25s (transform 200ms, setup 10ms, collect 500ms, tests 50ms)",
			"The deadline is 2026-08-20 and port 3000 remains.",
		].join("\n");
		const speech = createProgressiveSpeechSegmenter("turn-test-output");
		const stable = speech.pushChunk({ text: source }).enqueue;
		const tail = speech.flush("done").enqueue;

		expect([...stable, ...tail].map((segment) => segment.text)).toEqual([
			"2 tests failed.",
			"Retry at 3:30 PM.",
			"The deadline is 2026-08-20 and port 3000 remains.",
		]);
	});

	it("keeps relative paths and ordinary ISO timestamps in prose", () => {
		const source =
			"Review src/lib/progressiveSpeech.ts at 3:30 PM. The cutoff is 2026-08-15T11:31:48-04:00.";
		const speech = createProgressiveSpeechSegmenter("turn-relative-path");
		const stable = speech.pushChunk({ text: source }).enqueue;
		const tail = speech.flush("done").enqueue;

		expect([...stable, ...tail].map((segment) => segment.text)).toEqual([
			"Review src/lib/progressiveSpeech.ts at 3:30 PM.",
			"The cutoff is 2026-08-15T11:31:48-04:00.",
		]);
	});

	it("does not split on punctuation inside inline code, links, or abbreviations", () => {
		const speech = createProgressiveSpeechSegmenter();
		const update = speech.pushChunk({
			text: "Dr. Rao checked `item.value`. See [the docs](https://example.com/v1.2). Done.",
		});
		expect(update.enqueue.map((segment) => segment.text)).toEqual([
			"Dr. Rao checked item.value.",
			"See the docs.",
			"Done.",
		]);
	});

	it("keeps sentence punctuation outside a bare URL", () => {
		const speech = createProgressiveSpeechSegmenter();
		const update = speech.pushChunk({
			text: "See https://example.com/v1.2. Continue afterward.",
		});
		expect(update.enqueue.map((segment) => segment.text)).toEqual([
			"See.",
			"Continue afterward.",
		]);
	});

	it("applies Hlid offsets as UTF-16 code units", () => {
		const speech = createProgressiveSpeechSegmenter();
		expect(speech.pushChunk({ text: "🙂 Hel", offset: 0 }).enqueue).toEqual([]);
		const update = speech.pushChunk({ text: "lo.", offset: 6 });
		expect(update.enqueue).toMatchObject([
			{ text: "🙂 Hello.", sourceStart: 0, sourceEnd: 9 },
		]);
		expect(speech.pushChunk({ text: "lo.", offset: 6 })).toEqual({
			enqueue: [],
			invalidate: [],
		});
	});

	it("keeps Markdown masks aligned after astral characters", () => {
		const speech = createProgressiveSpeechSegmenter();
		const update = speech.pushChunk({
			text: "😀 Ready.\n\n```ts\nhiddenCall();\n```\n\nContinue afterward.",
		});
		expect(update.enqueue.map((segment) => segment.text)).toEqual([
			"😀 Ready.",
			"Continue afterward.",
		]);
	});

	it("preserves unchanged queued speech and invalidates only a revised tail", () => {
		const speech = createProgressiveSpeechSegmenter("turn-replace");
		const original = speech.pushChunk({
			text: "First sentence. Second sentence.",
		}).enqueue;
		expect(original).toHaveLength(2);

		const replacement = speech.pushChunk({
			text: "First sentence. Revised sentence.",
			replace: true,
		});
		expect(replacement.invalidate).toEqual([original[1]?.id]);
		expect(replacement.invalidate).not.toContain(original[0]?.id);
		expect(replacement.enqueue.map((segment) => segment.text)).toEqual([
			"Revised sentence.",
		]);
	});

	it("keeps masked metadata source-aligned when a later sentence is revised", () => {
		const firstSource =
			"[2026-08-15T11:31:48-04:00] Working folder: `C:\\Users\\kyleu\\Documents\\Obsidian\\Fornbok`.";
		const speech = createProgressiveSpeechSegmenter("turn-masked-replace");
		const originalText = `${firstSource} Old result.`;
		const original = speech.pushChunk({ text: originalText }).enqueue;

		expect(original).toMatchObject([
			{
				text: "Working folder: Fornbok.",
				sourceStart: 0,
				sourceEnd: firstSource.length,
			},
			{
				text: "Old result.",
				sourceStart: firstSource.length,
				sourceEnd: originalText.length,
			},
		]);

		const replacementText = `${firstSource} New result.`;
		const replacement = speech.pushChunk({
			text: replacementText,
			replace: true,
		});
		expect(replacement.invalidate).toEqual([original[1]?.id]);
		expect(replacement.invalidate).not.toContain(original[0]?.id);
		expect(replacement.enqueue).toMatchObject([
			{
				text: "New result.",
				sourceStart: firstSource.length,
				sourceEnd: replacementText.length,
			},
		]);
	});

	it("does not invalidate audio that has already started", () => {
		const speech = createProgressiveSpeechSegmenter("turn-playing");
		const original = speech.pushChunk({
			text: "First sentence. Second sentence.",
		}).enqueue;
		const first = original[0];
		expect(first).toBeDefined();
		if (!first) return;
		speech.markStarted(first.id);

		const replacement = speech.pushChunk({
			text: "First sentence. Revised sentence.",
			replace: true,
		});
		expect(replacement.invalidate).toEqual([original[1]?.id]);
		expect(replacement.invalidate).not.toContain(first.id);
		expect(replacement.enqueue.map((segment) => segment.text)).toEqual([
			"Revised sentence.",
		]);
	});

	it("does not contradict speech when a replacement revises played text", () => {
		const speech = createProgressiveSpeechSegmenter("turn-retraction");
		const original = speech.pushChunk({ text: "The old answer." }).enqueue[0];
		expect(original).toBeDefined();
		if (!original) return;
		speech.markStarted(original.id);

		expect(
			speech.pushChunk({
				text: "A new answer. Fresh detail.",
				replace: true,
			}),
		).toEqual({ enqueue: [], invalidate: [] });
		expect(
			speech
				.pushChunk({ text: " More later.", offset: 27 })
				.enqueue.map((segment) => segment.text),
		).toEqual(["More later."]);
	});

	it("reset invalidates queued speech and isolates the next assistant scope", () => {
		const speech = createProgressiveSpeechSegmenter("turn-a");
		const queued = speech.pushChunk({ text: "Queued response." }).enqueue[0];
		expect(queued).toBeDefined();
		if (!queued) return;
		expect(speech.reset("turn-b")).toEqual({
			enqueue: [],
			invalidate: [queued.id],
		});
		const next = speech.pushChunk({ text: "Queued response." }).enqueue[0];
		expect(next?.id).not.toBe(queued.id);
	});
});
