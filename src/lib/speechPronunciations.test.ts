import { describe, expect, it } from "vitest";
import {
	applySpeechPronunciations,
	createSpeechPronunciationReplacer,
	MAX_SPEECH_PRONUNCIATIONS,
	normalizeSpeechPronunciations,
	type SpeechPronunciation,
} from "./speechPronunciations";

describe("normalizeSpeechPronunciations", () => {
	it("trims and normalizes valid entries while rejecting malformed values", () => {
		expect(
			normalizeSpeechPronunciations([
				{ written: "  Cafe\u0301 ", spoken: "  cafeh  " },
				{ written: "", spoken: "blank" },
				{ written: "Hlid", spoken: " " },
				{ written: 7, spoken: "seven" },
				null,
				"not an entry",
				{ written: "x".repeat(81), spoken: "long" },
			]),
		).toEqual([{ written: "Café", spoken: "cafeh" }]);
	});

	it("keeps the first case-equivalent written term", () => {
		expect(
			normalizeSpeechPronunciations([
				{ written: "Hlid", spoken: "first" },
				{ written: "HLID", spoken: "second" },
				{ written: "Raven", spoken: "ray-ven" },
			]),
		).toEqual([
			{ written: "Hlid", spoken: "first" },
			{ written: "Raven", spoken: "ray-ven" },
		]);
	});

	it("caps the normalized list at the supported entry count", () => {
		const values = Array.from(
			{ length: MAX_SPEECH_PRONUNCIATIONS + 5 },
			(_, index) => ({ written: `word ${index}`, spoken: `sound ${index}` }),
		);

		expect(normalizeSpeechPronunciations(values)).toHaveLength(
			MAX_SPEECH_PRONUNCIATIONS,
		);
	});

	it("returns an empty list for a non-array value", () => {
		expect(normalizeSpeechPronunciations({ written: "Hlid" })).toEqual([]);
	});
});

describe("applySpeechPronunciations", () => {
	it("can compile a replacer once and reuse it across speech segments", () => {
		const replacePronunciations = createSpeechPronunciationReplacer([
			{ written: "Hlid", spoken: "hleed" },
		]);

		expect(replacePronunciations("Hlid is ready.")).toBe("hleed is ready.");
		expect(replacePronunciations("Ask Hlid again.")).toBe("Ask hleed again.");
	});

	it("replaces whole terms case-insensitively beside punctuation", () => {
		expect(
			applySpeechPronunciations(`Hlið, (HLIÐ)! "hlið".`, [
				{ written: "Hlið", spoken: "hleeth" },
			]),
		).toBe(`hleeth, (hleeth)! "hleeth".`);
	});

	it("matches uppercase acronym-like terms with exact case", () => {
		expect(
			applySpeechPronunciations("US us Us uS, HLIÐ hlið, A a.", [
				{ written: "US", spoken: "you ess" },
				{ written: "HLIÐ", spoken: "hleeth" },
				{ written: "A", spoken: "ay" },
			]),
		).toBe("you ess us Us uS, hleeth hlið, ay ay.");
	});

	it("falls back to shorter exact-case terms when a longer acronym differs", () => {
		expect(
			applySpeechPronunciations("US gov", [
				{ written: "US GOV", spoken: "federal government" },
				{ written: "US", spoken: "you ess" },
				{ written: "Gov", spoken: "government" },
			]),
		).toBe("you ess government");
	});

	it("does not replace text inside longer words or identifiers", () => {
		expect(
			applySpeechPronunciations("Hlid Hlidish unHlid hlid_config", [
				{ written: "Hlid", spoken: "hleed" },
			]),
		).toBe("hleed Hlidish unHlid hlid_config");
	});

	it("prefers the longest matching phrase at the same position", () => {
		const pronunciations: SpeechPronunciation[] = [
			{ written: "Open", spoken: "open" },
			{ written: "Open Code", spoken: "open-code" },
		];

		expect(
			applySpeechPronunciations("Open Code and Open.", pronunciations),
		).toBe("open-code and open.");
	});

	it("normalizes composed and decomposed Unicode before matching", () => {
		expect(
			applySpeechPronunciations("Try Cafe\u0301 today.", [
				{ written: "Café", spoken: "cafeh" },
			]),
		).toBe("Try cafeh today.");
	});

	it("treats regular-expression punctuation as literal text", () => {
		expect(
			applySpeechPronunciations("C++, C+, and C. Use a+b, not aaab.", [
				{ written: "C++", spoken: "C plus plus" },
				{ written: "a+b", spoken: "a plus b" },
			]),
		).toBe("C plus plus, C+, and C. Use a plus b, not aaab.");
	});

	it("does not recursively apply replacement text", () => {
		expect(
			applySpeechPronunciations("Hlid uses Raven.", [
				{ written: "Hlid", spoken: "Open Code" },
				{ written: "Open Code", spoken: "second replacement" },
			]),
		).toBe("Open Code uses Raven.");
	});

	it("keeps the first case-equivalent duplicate", () => {
		expect(
			applySpeechPronunciations("HLID", [
				{ written: "Hlid", spoken: "first" },
				{ written: "hlid", spoken: "second" },
			]),
		).toBe("first");
	});

	it("uses replacement strings literally", () => {
		expect(
			applySpeechPronunciations("Hlid", [
				{ written: "Hlid", spoken: "$& dollars" },
			]),
		).toBe("$& dollars");
	});

	it("ignores blank and incomplete entries", () => {
		const pronunciations = [
			{ written: "", spoken: "empty" },
			{ written: "Hlid", spoken: " " },
			{ written: "  ", spoken: "blank" },
		];
		const decomposed = "Cafe\u0301 and Hlid";

		expect(applySpeechPronunciations(decomposed, pronunciations)).toBe(
			decomposed,
		);
	});

	it("trims entry edges without changing unmatched text spacing", () => {
		expect(
			applySpeechPronunciations("  Hlid   is ready.  ", [
				{ written: "  Hlid  ", spoken: "  hleed  " },
			]),
		).toBe("  hleed   is ready.  ");
	});
});
