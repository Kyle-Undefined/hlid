import { createHash } from "node:crypto";
import { readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { HlidConfig } from "../config";
import {
	assembleCockpitData,
	type collectCockpitData,
} from "../lib/cockpitData";
import {
	type FolderGroup,
	type MemoryFile,
	type Project,
	type Skill,
	scanFolderGroups,
	scanMemory,
	scanProjects,
	scanSkills,
} from "../lib/vault";
import { managedSkillsDirectory } from "./libraryStore";

export type VaultFolderKey =
	| "inbox"
	| "projects"
	| "areas"
	| "resources"
	| "archive"
	| "raw"
	| "wiki_folder"
	| "skills"
	| "memory"
	| "outputs";

const PARA_ORDER: VaultFolderKey[] = [
	"inbox",
	"projects",
	"areas",
	"resources",
	"archive",
	"skills",
	"memory",
	"outputs",
];
const WIKI_ORDER: VaultFolderKey[] = [
	"raw",
	"wiki_folder",
	"outputs",
	"skills",
	"memory",
];
const FIELD_LABELS: Record<VaultFolderKey, string> = {
	inbox: "INBOX",
	projects: "PROJECTS",
	areas: "AREAS",
	resources: "RESOURCES",
	archive: "ARCHIVE",
	raw: "RAW",
	wiki_folder: "WIKI",
	skills: "SKILLS",
	memory: "MEMORY",
	outputs: "OUTPUTS",
};

export const VAULT_FOLDER_KEYS = Object.keys(FIELD_LABELS) as VaultFolderKey[];
export const CLAUDE_SKILLS_DIR = resolve(homedir(), ".claude", "skills");

export type VaultRouteSnapshot = {
	tabConfig: { id: VaultFolderKey; label: string }[];
	projects: Project[];
	wikiPages: Project[];
	resources: FolderGroup[];
	archive: Project[];
	skills: Skill[];
	sectionOrder: string[];
	memory: MemoryFile[];
	inbox: MemoryFile[];
	raw: MemoryFile[];
	areas: FolderGroup[];
	outputs: MemoryFile[];
	vocab: HlidConfig["status_vocabulary"];
};

export type VaultSnapshotData = {
	vault: VaultRouteSnapshot;
	cockpit: ReturnType<typeof collectCockpitData>;
};

function portableVaultPath(...parts: Array<string | undefined>): string {
	return parts
		.filter((part): part is string => Boolean(part))
		.flatMap((part) => part.split(/[\\/]+/))
		.filter(Boolean)
		.join("/");
}

function withNodeVaultPaths(
	nodes: Project["children"],
	prefix: string,
): Project["children"] {
	return nodes?.map((node) => ({
		...node,
		vaultRelativePath: portableVaultPath(prefix, node.path),
		children: withNodeVaultPaths(node.children, prefix),
	}));
}

function withProjectVaultPaths(
	projects: Project[],
	folder: string | undefined,
): Project[] {
	if (!folder) return projects;
	return projects.map((project) => ({
		...project,
		vaultRelativePath: portableVaultPath(folder, project.file),
		children: withNodeVaultPaths(project.children, folder),
	}));
}

function withMemoryVaultPaths(
	files: MemoryFile[],
	folder: string | undefined,
): MemoryFile[] {
	if (!folder) return files;
	return files.map((file) => ({
		...file,
		vaultRelativePath: portableVaultPath(folder, file.path),
	}));
}

function withGroupVaultPaths(
	groups: FolderGroup[],
	folder: string | undefined,
): FolderGroup[] {
	if (!folder) return groups;
	return groups.map((group) => ({
		...group,
		children:
			withNodeVaultPaths(
				group.children,
				portableVaultPath(folder, group.name),
			) ?? [],
	}));
}

function configuredVaultTabs(vault: HlidConfig["vault"]) {
	const order = vault.style === "wiki" ? WIKI_ORDER : PARA_ORDER;
	return order
		.filter((key) => Boolean(vault[key]))
		.map((key) => ({ id: key, label: FIELD_LABELS[key] }));
}

function scanConfiguredFolder<T>(
	vault: HlidConfig["vault"],
	key: VaultFolderKey,
	scan: (root: string, folder: string) => T,
	fallback: T,
): T {
	const folder = vault[key];
	return vault.path && typeof folder === "string"
		? scan(vault.path, folder)
		: fallback;
}

function inboxMarkdownCount(config: HlidConfig): number {
	const { vault } = config;
	if (!(vault.path && vault.inbox)) return 0;
	try {
		return readdirSync(join(vault.path, vault.inbox)).filter((file) =>
			file.endsWith(".md"),
		).length;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
			console.warn("Failed to read inbox directory:", error);
		}
		return 0;
	}
}

export function buildSnapshotData(config: HlidConfig): VaultSnapshotData {
	const { vault, status_vocabulary: vocab } = config;
	const scanProjectFolder = (root: string, folder: string) =>
		scanProjects(root, folder, vocab);
	const projects = withProjectVaultPaths(
		scanConfiguredFolder(vault, "projects", scanProjectFolder, []),
		vault.projects,
	);
	const wikiPages = withProjectVaultPaths(
		scanConfiguredFolder(vault, "wiki_folder", scanProjectFolder, []),
		vault.wiki_folder,
	);
	const { skills, sectionOrder } = scanConfiguredFolder(
		vault,
		"skills",
		(root, folder) => scanSkills(root, folder, config.ui.hide_skills_index),
		{ skills: [], sectionOrder: [] },
	);
	const memory = withMemoryVaultPaths(
		scanConfiguredFolder(vault, "memory", scanMemory, []),
		vault.memory,
	);
	const inbox = withMemoryVaultPaths(
		scanConfiguredFolder(vault, "inbox", scanMemory, []),
		vault.inbox,
	);
	const raw = withMemoryVaultPaths(
		scanConfiguredFolder(vault, "raw", scanMemory, []),
		vault.raw,
	);
	const areas = withGroupVaultPaths(
		scanConfiguredFolder(vault, "areas", scanFolderGroups, []),
		vault.areas,
	);
	const resources = withGroupVaultPaths(
		scanConfiguredFolder(vault, "resources", scanFolderGroups, []),
		vault.resources,
	);
	const archive = withProjectVaultPaths(
		scanConfiguredFolder(vault, "archive", scanProjectFolder, []),
		vault.archive,
	);
	const outputs = withMemoryVaultPaths(
		scanConfiguredFolder(vault, "outputs", scanMemory, []),
		vault.outputs,
	);
	const { skills: claudeSkills } = scanSkills(CLAUDE_SKILLS_DIR, ".", false);
	const { skills: managedSkills } = scanSkills(
		managedSkillsDirectory(),
		".",
		false,
	);

	return {
		vault: {
			tabConfig: configuredVaultTabs(vault),
			projects,
			wikiPages,
			resources,
			archive,
			skills,
			sectionOrder,
			memory,
			inbox,
			raw,
			areas,
			outputs,
			vocab,
		},
		cockpit: assembleCockpitData({
			inboxCount: inboxMarkdownCount(config),
			projects,
			vaultSkills: skills,
			sectionOrder,
			claudeSkills,
			managedSkills,
		}),
	};
}

export function emptySnapshotData(config: HlidConfig): VaultSnapshotData {
	return {
		vault: {
			tabConfig: configuredVaultTabs(config.vault),
			projects: [],
			wikiPages: [],
			resources: [],
			archive: [],
			skills: [],
			sectionOrder: [],
			memory: [],
			inbox: [],
			raw: [],
			areas: [],
			outputs: [],
			vocab: config.status_vocabulary,
		},
		cockpit: assembleCockpitData({
			inboxCount: 0,
			projects: [],
			vaultSkills: [],
			sectionOrder: [],
			claudeSkills: [],
		}),
	};
}

/**
 * Compute a compact snapshot fingerprint. In production this runs inside the
 * Vault worker so the main event loop never serializes a full snapshot merely
 * to discover that a refresh did not change anything.
 */
export function snapshotContentKey(
	configKey: string,
	data: VaultSnapshotData,
): string {
	return createHash("sha256")
		.update(JSON.stringify({ config: configKey, data }))
		.digest("hex");
}
