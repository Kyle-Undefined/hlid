export const MAX_VAULT_REFERENCES = 32;

export type VaultReferenceItem = {
	relativePath: string;
	name: string;
	directory: string;
};

export type VaultReferenceSearchResult = {
	rootLabel: string;
	items: VaultReferenceItem[];
	total: number;
	truncated: boolean;
};

export type VaultReferenceQuery = {
	query: string;
	start: number;
	promptWithoutQuery: string;
};

/** Find the active @ fragment at the end of a composer prompt. */
export function vaultReferenceQuery(
	prompt: string,
): VaultReferenceQuery | null {
	const match = /(?:^|\s)@([^\n]*)$/.exec(prompt);
	if (!match) return null;
	const start = (match.index ?? 0) + match[0].lastIndexOf("@");
	return {
		query: match[1] ?? "",
		start,
		promptWithoutQuery: prompt.slice(0, start),
	};
}

/** Stable transcript representation for turns that include linked vault files. */
export function formatVaultReferencedMessage(
	text: string,
	references: readonly string[],
): string {
	if (references.length === 0) return text;
	const block = `Vault references:\n${references.map((path) => `- ${path}`).join("\n")}`;
	return text ? `${text}\n\n${block}` : block;
}
