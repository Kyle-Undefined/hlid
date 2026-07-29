import { parseFrontmatter } from "../lib/frontmatter";

export const MAX_SKILL_PACKAGE_FILES = 2_000;
export const MAX_SKILL_PACKAGE_BYTES = 50 * 1024 * 1024;
export const MAX_SKILL_DOCUMENT_BYTES = 1024 * 1024;

export function skillDocumentMetadata(
	source: string,
	fallbackName: string,
): { name: string; description: string } {
	const parsed = parseFrontmatter(source);
	const frontmatterName =
		typeof parsed.data.name === "string" ? parsed.data.name.trim() : "";
	const firstLine =
		parsed.content
			.trim()
			.split("\n")
			.find((line) => line.trim()) ?? "";
	return {
		name: frontmatterName || fallbackName,
		description:
			typeof parsed.data.description === "string"
				? parsed.data.description
				: firstLine.replace(/^#+\s*/, ""),
	};
}
