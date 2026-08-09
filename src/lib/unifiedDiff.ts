function prefixedLines(value: string, prefix: "+" | "-"): string[] {
	return value.length === 0
		? []
		: value.split("\n").map((line) => `${prefix}${line}`);
}

/** Build one small unified-diff-shaped replacement for provider and UI metadata. */
export function replacementUnifiedDiff(
	path: string,
	oldValue: string,
	newValue: string,
	label?: string,
): string {
	return [
		`--- ${path}`,
		`+++ ${path}`,
		...(label ? [`@@ ${label} @@`] : []),
		...prefixedLines(oldValue, "-"),
		...prefixedLines(newValue, "+"),
	].join("\n");
}
