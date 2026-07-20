export const MAX_VAULT_REFERENCES = 32;
export const MAX_RELIC_REFERENCES = 16;

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

export type RelicReferenceItem = {
	id: string;
	path: string;
	filename: string;
	mime: string;
	kind: string;
	createdAt: number;
	category: string;
};

export type ComposerReferenceItem =
	| ({ source: "vault" } & VaultReferenceItem)
	| ({ source: "relic" } & RelicReferenceItem);

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
	relicReferences: readonly string[] = [],
): string {
	const blocks: string[] = [];
	if (references.length > 0) {
		blocks.push(
			`Vault references:\n${references.map((path) => `- ${path}`).join("\n")}`,
		);
	}
	if (relicReferences.length > 0) {
		blocks.push(
			`Relic references:\n${relicReferences.map((name) => `- ${name}`).join("\n")}`,
		);
	}
	if (blocks.length === 0) return text;
	const block = blocks.join("\n\n");
	return text ? `${text}\n\n${block}` : block;
}
