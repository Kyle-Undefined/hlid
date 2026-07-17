import { describe, expect, it } from "vitest";
import {
	includesSearchText,
	normalizeSearchText,
	startsWithSearchText,
} from "./search";

describe("search text normalization", () => {
	it("folds accents and equivalent decomposed characters", () => {
		expect(normalizeSearchText("Grímr")).toBe("grimr");
		expect(includesSearchText("Cafe\u0301 notes", "café")).toBe(true);
		expect(startsWithSearchText("Éxplain", "ex")).toBe(true);
	});

	it("folds common Latin characters that NFKD does not decompose", () => {
		expect(includesSearchText("Smørrebrød", "smorrebrod")).toBe(true);
		expect(includesSearchText("Straße", "strasse")).toBe(true);
		expect(includesSearchText("Ægir and Þór", "aegir")).toBe(true);
	});
});
