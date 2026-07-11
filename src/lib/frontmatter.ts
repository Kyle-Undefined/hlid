import { load } from "js-yaml";

export type Frontmatter = {
	data: Record<string, unknown>;
	content: string;
};

/** Parse an optional YAML frontmatter block without evaluating custom types. */
export function parseFrontmatter(source: string): Frontmatter {
	const opening = source.match(/^\uFEFF?---[\t ]*\r?\n/);
	if (!opening) return { data: {}, content: source };

	const bodyStart = opening[0].length;
	const closing = /^(?:---|\.\.\.)[\t ]*(?:\r?\n|$)/m;
	const closingMatch = closing.exec(source.slice(bodyStart));
	if (!closingMatch) return { data: {}, content: source };

	const headerEnd = bodyStart + closingMatch.index;
	const contentStart = headerEnd + closingMatch[0].length;
	const parsed = load(source.slice(bodyStart, headerEnd), { json: true });
	const data =
		parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: {};

	return { data, content: source.slice(contentStart) };
}
