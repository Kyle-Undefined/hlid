import type { HlidConfig } from "#/config";

/** Normalized fields for building a vault config section. */
export type VaultFields = {
	name: string;
	path: string;
	style: HlidConfig["vault"]["style"];
	inbox?: string;
	projects?: string;
	areas?: string;
	resources?: string;
	archive?: string;
	/** Raw folder path (wiki-style vaults). */
	raw?: string;
	wikiFolder?: string;
	outputs?: string;
	skills?: string;
	memory?: string;
};

/**
 * Builds the `vault` section of HlidConfig from normalized form fields.
 * Handles para/wiki style branching so callers don't repeat the conditional masking.
 */
export function buildVaultSection(f: VaultFields): HlidConfig["vault"] {
	const isPara = f.style === "para";
	const isWiki = f.style === "wiki";
	return {
		name: f.name,
		path: f.path,
		style: f.style,
		inbox: isPara ? f.inbox || undefined : undefined,
		projects: isPara ? f.projects || undefined : undefined,
		areas: isPara ? f.areas || undefined : undefined,
		resources: isPara ? f.resources || undefined : undefined,
		archive: isPara ? f.archive || undefined : undefined,
		raw: isWiki ? f.raw || undefined : undefined,
		wiki_folder: isWiki ? f.wikiFolder || undefined : undefined,
		outputs: isWiki ? f.outputs || undefined : undefined,
		skills: f.skills || undefined,
		memory: f.memory || undefined,
		delete_vault_attachments: false,
	};
}
