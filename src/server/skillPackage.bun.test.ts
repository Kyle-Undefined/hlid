// Bun lane: skill frontmatter is parsed by Bun.YAML.
import { describe, expect, it } from "vitest";
import { skillDocumentMetadata } from "./skillPackage";

describe("skillDocumentMetadata", () => {
	it("trims a declared name and preserves an explicitly empty description", () => {
		expect(
			skillDocumentMetadata(
				'---\nname: "  Review code  "\ndescription: ""\n---\n# Fallback description\n',
				"review",
			),
		).toEqual({
			name: "Review code",
			description: "",
		});
	});

	it("falls back to the package name and first content heading", () => {
		expect(
			skillDocumentMetadata(
				"---\nname: 42\ndescription: false\n---\n\n## Review changes\nMore detail.\n",
				"review",
			),
		).toEqual({
			name: "review",
			description: "Review changes",
		});
	});

	it("uses the package name when a declared name trims to empty", () => {
		expect(
			skillDocumentMetadata('---\nname: "   "\n---\nInstructions.\n', "review"),
		).toEqual({
			name: "review",
			description: "Instructions.",
		});
	});
});
