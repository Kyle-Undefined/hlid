/**
 * Normalize user-visible text for forgiving search without changing display text.
 * NFKD handles accented characters such as í, while the explicit replacements
 * cover common Latin letters that Unicode does not decompose (for example ø).
 */
const SEARCH_FOLD_REPLACEMENTS: Record<string, string> = {
	æ: "ae",
	ð: "d",
	đ: "d",
	ħ: "h",
	ı: "i",
	ł: "l",
	ŋ: "n",
	ø: "o",
	œ: "oe",
	ß: "ss",
	ŧ: "t",
	þ: "th",
};

export function normalizeSearchText(value: string): string {
	return value
		.normalize("NFKD")
		.replace(/\p{M}/gu, "")
		.toLocaleLowerCase()
		.replace(
			/[\u00e6ðđħıłŋøœßŧþ]/gu,
			(character) => SEARCH_FOLD_REPLACEMENTS[character] ?? character,
		);
}

export function includesSearchText(value: string, query: string): boolean {
	return normalizeSearchText(value).includes(normalizeSearchText(query));
}

export function startsWithSearchText(value: string, query: string): boolean {
	return normalizeSearchText(value).startsWith(normalizeSearchText(query));
}
