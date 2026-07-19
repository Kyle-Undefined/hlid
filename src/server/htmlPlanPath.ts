/** Match a reported provider path to the required HTML plan output path. */
export function isHtmlPlanPath(
	path: string,
	expected: string | undefined,
): boolean {
	if (!expected) return false;
	const normalize = (value: string) => {
		const slashed = value.replace(/\\/g, "/");
		return /^[A-Za-z]:\//.test(slashed) ? slashed.toLowerCase() : slashed;
	};
	return normalize(path) === normalize(expected);
}
