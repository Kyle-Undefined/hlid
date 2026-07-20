export function parseObsidianTemplateNames(output: string): string[] {
	const seen = new Set<string>();
	const templates: string[] = [];
	for (const line of output.split(/\r?\n/)) {
		const name = line.trim();
		if (!name || seen.has(name)) continue;
		seen.add(name);
		templates.push(name);
	}
	return templates;
}
