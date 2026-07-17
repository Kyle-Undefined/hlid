/**
 * Client-safe vault search helpers. No Node.js imports.
 */

import { normalizeSearchText } from "./search";

/** Case- and accent-insensitive substring match across any given field. */
export function matchesQuery(
	query: string,
	...fields: Array<string | string[] | undefined | null>
): boolean {
	const q = normalizeSearchText(query.trim());
	if (!q) return true;
	return fields.some((field) => {
		if (!field) return false;
		if (Array.isArray(field))
			return field.some((s) => normalizeSearchText(s).includes(q));
		return normalizeSearchText(field).includes(q);
	});
}
