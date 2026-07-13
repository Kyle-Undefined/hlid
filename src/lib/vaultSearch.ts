/**
 * Client-safe vault search helpers. No Node.js imports.
 */

/** Case-insensitive substring match across any of the given fields. */
export function matchesQuery(
	query: string,
	...fields: Array<string | string[] | undefined | null>
): boolean {
	const q = query.trim().toLowerCase();
	if (!q) return true;
	return fields.some((field) => {
		if (!field) return false;
		if (Array.isArray(field))
			return field.some((s) => s.toLowerCase().includes(q));
		return field.toLowerCase().includes(q);
	});
}
