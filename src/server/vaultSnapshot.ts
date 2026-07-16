import { type FSWatcher, readdirSync, watch } from "node:fs";
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
import { loadConfig } from "./config";
import {
	bumpDataRevision,
	getDataRevisions,
	subscribeDataRevisions,
} from "./dataRevision";

type VaultFolderKey =
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

export type VaultSnapshot = {
	revision: number;
	refreshedAt: number;
	vault: VaultRouteSnapshot;
	cockpit: ReturnType<typeof collectCockpitData>;
};

const SNAPSHOT_TTL_MS = 5_000;
const WATCH_DEBOUNCE_MS = 200;
const CLAUDE_SKILLS_DIR = resolve(homedir(), ".claude", "skills");

type SnapshotRecord = VaultSnapshot & {
	configKey: string;
	contentKey: string;
};

let current: SnapshotRecord | null = null;
let inflight: Promise<SnapshotRecord> | null = null;
let dirty = false;
let invalidationGeneration = 0;
let refreshTimer: ReturnType<typeof setTimeout> | null = null;
let pendingConfig: HlidConfig | null = null;
let watchSignature = "";
let watchers: FSWatcher[] = [];

function configKey(config: HlidConfig): string {
	return JSON.stringify({
		vault: config.vault,
		statusVocabulary: config.status_vocabulary,
		hideSkillsIndex: config.ui.hide_skills_index,
	});
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

function buildSnapshotData(config: HlidConfig): {
	vault: VaultRouteSnapshot;
	cockpit: ReturnType<typeof collectCockpitData>;
} {
	const { vault, status_vocabulary: vocab } = config;
	const scanProjectFolder = (root: string, folder: string) =>
		scanProjects(root, folder, vocab);
	const projects = scanConfiguredFolder(
		vault,
		"projects",
		scanProjectFolder,
		[],
	);
	const wikiPages = scanConfiguredFolder(
		vault,
		"wiki_folder",
		scanProjectFolder,
		[],
	);
	const { skills, sectionOrder } = scanConfiguredFolder(
		vault,
		"skills",
		(root, folder) => scanSkills(root, folder, config.ui.hide_skills_index),
		{ skills: [], sectionOrder: [] },
	);
	const memory = scanConfiguredFolder(vault, "memory", scanMemory, []);
	const inbox = scanConfiguredFolder(vault, "inbox", scanMemory, []);
	const raw = scanConfiguredFolder(vault, "raw", scanMemory, []);
	const areas = scanConfiguredFolder(vault, "areas", scanFolderGroups, []);
	const resources = scanConfiguredFolder(
		vault,
		"resources",
		scanFolderGroups,
		[],
	);
	const archive = scanConfiguredFolder(vault, "archive", scanProjectFolder, []);
	const outputs = scanConfiguredFolder(vault, "outputs", scanMemory, []);
	const { skills: claudeSkills } = scanSkills(CLAUDE_SKILLS_DIR, ".", false);

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
		}),
	};
}

function configuredWatchPaths(config: HlidConfig): string[] {
	const paths = new Set<string>([CLAUDE_SKILLS_DIR]);
	if (config.vault.path) {
		paths.add(resolve(config.vault.path));
		for (const key of Object.keys(FIELD_LABELS) as VaultFolderKey[]) {
			const folder = config.vault[key];
			if (typeof folder === "string") {
				paths.add(resolve(config.vault.path, folder));
			}
		}
	}
	return [...paths].sort();
}

function closeWatchers(): void {
	for (const watcher of watchers) watcher.close();
	watchers = [];
}

function installWatchers(config: HlidConfig): void {
	const paths = configuredWatchPaths(config);
	const signature = paths.join("\0");
	if (signature === watchSignature) return;
	closeWatchers();
	watchSignature = signature;

	for (const path of paths) {
		try {
			const watcher = watch(path, { recursive: true, persistent: false }, () =>
				invalidateVaultSnapshot("filesystem"),
			);
			watcher.on("error", () => watcher.close());
			watchers.push(watcher);
		} catch {
			try {
				const watcher = watch(path, { persistent: false }, () =>
					invalidateVaultSnapshot("filesystem"),
				);
				watcher.on("error", () => watcher.close());
				watchers.push(watcher);
			} catch {
				// Missing folders and platforms without usable watchers are covered by
				// the short safety TTL checked by every server snapshot read.
			}
		}
	}
}

function emitChange(record: SnapshotRecord): void {
	void record;
	bumpDataRevision("vault");
}

function scheduleRefresh(config?: HlidConfig): void {
	if (config) pendingConfig = config;
	if (!current || refreshTimer) return;
	refreshTimer = setTimeout(() => {
		refreshTimer = null;
		const nextConfig = pendingConfig ?? loadConfig();
		pendingConfig = null;
		void refreshSnapshot(nextConfig).finally(() => {
			if (dirty) scheduleRefresh();
		});
	}, WATCH_DEBOUNCE_MS);
}

async function refreshSnapshot(config: HlidConfig): Promise<SnapshotRecord> {
	if (inflight) return inflight;
	const startedGeneration = invalidationGeneration;
	const nextConfigKey = configKey(config);
	const promise = Promise.resolve()
		.then(() => buildSnapshotData(config))
		.then((data) => {
			const contentKey = JSON.stringify({ config: nextConfigKey, data });
			const changed = current?.contentKey !== contentKey;
			const record: SnapshotRecord = {
				...data,
				revision: changed
					? (current?.revision ?? 0) + 1
					: (current?.revision ?? 1),
				refreshedAt: Date.now(),
				configKey: nextConfigKey,
				contentKey,
			};
			current = record;
			dirty = invalidationGeneration !== startedGeneration;
			installWatchers(config);
			if (changed) emitChange(record);
			return record;
		})
		.finally(() => {
			inflight = null;
		});
	inflight = promise;
	return promise;
}

/**
 * Return the server's last-good Vault/Cockpit view immediately. A missing
 * snapshot is built once; stale or invalidated snapshots refresh in one
 * background flight and notify subscribers only when their contents change.
 */
export async function getVaultSnapshot(options: { refresh?: boolean } = {}) {
	const config = loadConfig();
	const nextConfigKey = configKey(config);
	if (!current) return refreshSnapshot(config);

	if (options.refresh) {
		dirty = true;
		invalidationGeneration++;
		return refreshSnapshot(config);
	}

	if (
		current.configKey !== nextConfigKey ||
		Date.now() - current.refreshedAt >= SNAPSHOT_TTL_MS
	) {
		dirty = true;
		invalidationGeneration++;
		scheduleRefresh(config);
	}
	return current;
}

/** Mark the shared snapshot stale and coalesce a background rebuild. */
export function invalidateVaultSnapshot(
	_reason = "explicit",
	config?: HlidConfig,
): void {
	dirty = true;
	invalidationGeneration++;
	scheduleRefresh(config);
}

/** Prime the shared snapshot during server boot without delaying startup. */
export function warmVaultSnapshot(): void {
	void getVaultSnapshot().catch((error) =>
		console.warn("[vaultSnapshot] warm-up failed:", error),
	);
}

let observedConfigRevision = getDataRevisions().config;
subscribeDataRevisions((revisions) => {
	if (revisions.config === observedConfigRevision) return;
	observedConfigRevision = revisions.config;
	invalidateVaultSnapshot("config");
});
