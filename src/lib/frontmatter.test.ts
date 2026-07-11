import { describe, expect, it } from "vitest";
import { parseFrontmatter } from "./frontmatter";

describe("parseFrontmatter", () => {
	it("returns source without a frontmatter block unchanged", () => {
		expect(parseFrontmatter("# Note\nbody")).toEqual({
			data: {},
			content: "# Note\nbody",
		});
	});

	it("parses YAML mappings, arrays, and block strings", () => {
		expect(
			parseFrontmatter(
				"---\ntitle: Project\ntags: [one, two]\ndescription: |\n  line one\n  line two\n---\nBody",
			),
		).toEqual({
			data: {
				title: "Project",
				tags: ["one", "two"],
				description: "line one\nline two\n",
			},
			content: "Body",
		});
	});

	it("accepts BOM, CRLF, and the YAML document-end delimiter", () => {
		expect(
			parseFrontmatter("\uFEFF---\r\nstatus: active\r\n...\r\nBody"),
		).toEqual({
			data: { status: "active" },
			content: "Body",
		});
	});

	it("treats non-mapping YAML as empty metadata", () => {
		expect(parseFrontmatter("---\n- one\n- two\n---\nBody")).toEqual({
			data: {},
			content: "Body",
		});
	});
});
