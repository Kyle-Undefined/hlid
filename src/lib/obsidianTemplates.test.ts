import { describe, expect, it } from "vitest";
import { parseObsidianTemplateNames } from "./obsidianTemplates";

describe("parseObsidianTemplateNames", () => {
	it("normalizes template output without reordering it", () => {
		expect(
			parseObsidianTemplateNames(
				" Daily Note\r\nProjects/New Project\nDaily Note\n\n",
			),
		).toEqual(["Daily Note", "Projects/New Project"]);
	});
});
