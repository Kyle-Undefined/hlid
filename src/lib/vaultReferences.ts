export const MAX_VAULT_REFERENCES = 32;
export const MAX_RELIC_REFERENCES = 16;
export const MAX_WORKSPACE_REFERENCES = 8;
export const MAX_COMPOSER_REFERENCES = 32;

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

export type VaultReferencePreview = VaultReferenceItem & {
	content: string;
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

export type WorkspaceReferenceEnvironment = "host" | "windows" | "wsl";

export type WorkspaceReferenceItem = {
	relativePath: string;
	name: string;
	directory: string;
};

export type WorkspaceReferenceSearchResult = {
	rootLabel: string;
	environment: WorkspaceReferenceEnvironment;
	environmentLabel: string;
	items: WorkspaceReferenceItem[];
	total: number;
	truncated: boolean;
};

export type WorkspaceReferenceRequest = {
	relativePath: string;
	sha256: string;
};

export type WorkspaceReferenceSelection = WorkspaceReferenceItem &
	WorkspaceReferenceRequest & {
		sizeBytes: number;
		environment: WorkspaceReferenceEnvironment;
		environmentLabel: string;
		previewKind: "text" | "image";
		mime: string;
	};

export type WorkspaceReferencePreview =
	| (WorkspaceReferenceSelection & {
			previewKind: "text";
			content: string;
			truncated: boolean;
	  })
	| (WorkspaceReferenceSelection & {
			previewKind: "image";
			dataUrl: string;
			truncated: false;
	  });

export type ComposerReferenceItem =
	| ({ source: "vault" } & VaultReferenceItem)
	| ({ source: "relic" } & RelicReferenceItem)
	| ({ source: "workspace" } & WorkspaceReferenceItem);

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
	workspaceReferences: readonly {
		relativePath: string;
		sha256: string;
		environmentLabel?: string;
	}[] = [],
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
	if (workspaceReferences.length > 0) {
		blocks.push(
			`Workspace references:\n${workspaceReferences
				.map(
					(reference) =>
						`- ${reference.relativePath} (${reference.environmentLabel ? `${reference.environmentLabel}, ` : ""}sha256:${reference.sha256})`,
				)
				.join("\n")}`,
		);
	}
	if (blocks.length === 0) return text;
	const block = blocks.join("\n\n");
	return text ? `${text}\n\n${block}` : block;
}
