import { lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import {
	classifyStatus,
	type ProjectStatus,
	type StatusVocabulary,
} from "#/lib/classify";
import { parseFrontmatter } from "./frontmatter";
import { pathStartsWith } from "./paths";
import type { Skill } from "./skills";

export type { Skill } from "./skills";

export type ProjectNode = {
	name: string;
	path: string;
	isFolder: boolean;
	content?: string;
	children?: ProjectNode[];
};

export type Project = {
	file: string;
	title: string;
	status: ProjectStatus;
	rawStatus: string;
	tags: string[];
	created?: string;
	modified?: string;
	isFolder: boolean;
	content?: string;
	children?: ProjectNode[];
};

function buildNodes(dir: string, baseDir: string): ProjectNode[] {
	const nodes: ProjectNode[] = [];
	let entries: string[];
	try {
		entries = readdirSync(dir).sort();
	} catch {
		return [];
	}
	for (const entry of entries) {
		const full = join(dir, entry);
		const path = relative(baseDir, full);
		try {
			const stat = lstatSync(full);
			if (stat.isSymbolicLink()) continue;
			if (stat.isDirectory()) {
				nodes.push({
					name: entry,
					path,
					isFolder: true,
					children: buildNodes(full, baseDir),
				});
			} else if (entry.endsWith(".md")) {
				const raw = readFileSync(full, "utf-8");
				const { content } = parseFrontmatter(raw);
				nodes.push({
					name: entry.replace(/\.md$/, ""),
					path,
					isFolder: false,
					content,
				});
			} else {
				nodes.push({ name: entry, path, isFolder: false });
			}
		} catch {
			// skip unreadable
		}
	}
	return nodes;
}

function assertContained(base: string, joined: string): void {
	let real: string;
	try {
		real = realpathSync(joined);
	} catch {
		// Path doesn't exist yet, check the join result directly
		real = resolve(joined);
	}
	if (!pathStartsWith(base, real)) {
		throw new Error("Access denied: path escapes vault");
	}
}

function readDirectoryEntry(dir: string, entry: string) {
	const full = join(dir, entry);
	try {
		const stat = lstatSync(full);
		return stat.isSymbolicLink() ? null : { full, stat };
	} catch {
		return null;
	}
}

function projectFromMarkdown(options: {
	fullPath: string;
	file: string;
	fallbackTitle: string;
	vocab: StatusVocabulary;
	isFolder: boolean;
	children?: ProjectNode[];
}): Project {
	const { fullPath, file, fallbackTitle, vocab, isFolder, children } = options;
	try {
		const raw = readFileSync(fullPath, "utf-8");
		const { data, content } = parseFrontmatter(raw);
		const rawStatus = String(data.status ?? "");
		return {
			file,
			title: (data.title as string | undefined) ?? fallbackTitle,
			status: classifyStatus(rawStatus, vocab),
			rawStatus,
			tags: Array.isArray(data.tags) ? (data.tags as string[]) : [],
			created: data.created as string | undefined,
			modified: data.modified as string | undefined,
			isFolder,
			content: content || undefined,
			children,
		};
	} catch {
		return {
			file,
			title: fallbackTitle,
			status: "unknown",
			rawStatus: "",
			tags: [],
			isFolder,
			children,
		};
	}
}

function findFolderMainFile(
	directory: string,
	folderName: string,
): string | null {
	let files: string[];
	try {
		files = readdirSync(directory).filter((file) => file.endsWith(".md"));
	} catch {
		return null;
	}
	return (
		files.find((file) => file.toLowerCase() === "index.md") ??
		files.find((file) => file.replace(/\.md$/, "") === folderName) ??
		files[0] ??
		null
	);
}

function scanProjectFolder(
	fullPath: string,
	folderName: string,
	projectsDirectory: string,
	vocab: StatusVocabulary,
): Project | undefined {
	const mainFile = findFolderMainFile(fullPath, folderName);
	if (!mainFile) return undefined;
	const relativeMainPath = join(folderName, mainFile);
	const children = buildNodes(fullPath, projectsDirectory).filter(
		(node) => node.path !== relativeMainPath,
	);
	return projectFromMarkdown({
		fullPath: join(fullPath, mainFile),
		file: relativeMainPath,
		fallbackTitle: folderName,
		vocab,
		isFolder: true,
		children: children.length > 0 ? children : undefined,
	});
}

function scanProjectEntry(
	projectsDirectory: string,
	entry: string,
	vocab: StatusVocabulary,
): Project | undefined {
	const fullPath = join(projectsDirectory, entry);
	try {
		const stat = lstatSync(fullPath);
		if (stat.isSymbolicLink()) return undefined;
		if (stat.isDirectory()) {
			return scanProjectFolder(fullPath, entry, projectsDirectory, vocab);
		}
		if (!entry.endsWith(".md")) return undefined;
		return projectFromMarkdown({
			fullPath,
			file: entry,
			fallbackTitle: entry.replace(/\.md$/, ""),
			vocab,
			isFolder: false,
		});
	} catch {
		return undefined;
	}
}

export function scanProjects(
	vaultPath: string,
	projectsFolder: string,
	vocab: StatusVocabulary,
): Project[] {
	const base = resolve(vaultPath);
	const dir = resolve(base, projectsFolder);
	assertContained(base, dir);
	let entries: string[];
	try {
		entries = readdirSync(dir);
	} catch {
		return [];
	}

	return entries.flatMap((entry) => {
		const project = scanProjectEntry(dir, entry, vocab);
		return project ? [project] : [];
	});
}

function parseSectionMap(indexPath: string): {
	sectionMap: Map<string, string>;
	sectionOrder: string[];
} {
	const sectionMap = new Map<string, string>();
	const sectionOrder: string[] = [];
	let raw: string;
	try {
		raw = readFileSync(indexPath, "utf-8");
	} catch {
		return { sectionMap, sectionOrder };
	}
	let currentSection = "";
	for (const line of raw.split("\n")) {
		const heading = line.match(/^##\s+(.+)/);
		if (heading) {
			currentSection = heading[1].trim();
			if (!sectionOrder.includes(currentSection))
				sectionOrder.push(currentSection);
			continue;
		}
		if (currentSection) {
			// match backtick-quoted name in first pipe-table column: | `name` | ...
			const cell = line.match(/^\|?\s*`([^`]+)`/);
			if (cell) sectionMap.set(cell[1].trim(), currentSection);
		}
	}
	return { sectionMap, sectionOrder };
}

export function scanSkills(
	vaultPath: string,
	skillsFolder: string,
	hideIndex = true,
): { skills: Skill[]; sectionOrder: string[] } {
	const base = resolve(vaultPath);
	const dir = resolve(base, skillsFolder);
	assertContained(base, dir);
	let entries: string[];
	try {
		entries = readdirSync(dir);
	} catch {
		return { skills: [], sectionOrder: [] };
	}

	const skillFiles: { file: string; fullPath: string }[] = [];
	let indexPath: string | null = null;

	for (const entry of entries) {
		const item = readDirectoryEntry(dir, entry);
		if (!item) continue;
		const { full, stat } = item;
		try {
			if (stat.isDirectory()) {
				// skill folder, find the .md file directly inside (one level only)
				const inner = readdirSync(full).filter((f) => f.endsWith(".md"));
				// prefer file matching folder name, else first .md
				const match =
					inner.find((f) => f.replace(/\.md$/, "") === entry) ?? inner[0];
				if (match)
					skillFiles.push({
						file: join(entry, match),
						fullPath: join(full, match),
					});
			} else if (entry.endsWith(".md")) {
				if (entry.toLowerCase() === "index.md") {
					indexPath = full;
					if (hideIndex) continue;
				}
				skillFiles.push({ file: entry, fullPath: full });
			}
		} catch {
			// skip
		}
	}

	const { sectionMap, sectionOrder } = indexPath
		? parseSectionMap(indexPath)
		: { sectionMap: new Map<string, string>(), sectionOrder: [] };

	const skills = skillFiles.map(({ file, fullPath }) => {
		try {
			const raw = readFileSync(fullPath, "utf-8");
			const { data, content } = parseFrontmatter(raw);
			const name =
				(data.name as string | undefined) ??
				file.split(sep)[0].replace(/\.md$/, "");
			const firstLine =
				content
					.trim()
					.split("\n")
					.find((l) => l.trim()) ?? "";
			const description =
				(data.description as string | undefined) ??
				firstLine.replace(/^#+\s*/, "");
			const section = sectionMap.get(name);
			return {
				file,
				name,
				description,
				content,
				filePath: fullPath,
				section,
			};
		} catch {
			return {
				file,
				name: file.split(sep)[0].replace(/\.md$/, ""),
				description: "",
				content: "",
				filePath: fullPath,
			};
		}
	});

	skills.sort((a, b) => a.name.localeCompare(b.name));

	return { skills, sectionOrder };
}

export type MemoryFile = {
	path: string;
	name: string;
	content: string;
};

function walkMd(dir: string, root: string): MemoryFile[] {
	let results: MemoryFile[] = [];
	let entries: string[];
	try {
		entries = readdirSync(dir);
	} catch {
		return [];
	}
	for (const entry of entries) {
		const full = join(dir, entry);
		try {
			const stat = lstatSync(full);
			if (stat.isSymbolicLink()) continue;
			if (stat.isDirectory()) {
				results = results.concat(walkMd(full, root));
			} else if (entry.endsWith(".md")) {
				const rel = relative(root, full);
				const raw = readFileSync(full, "utf-8");
				const { content } = parseFrontmatter(raw);
				results.push({ path: rel, name: entry.replace(/\.md$/, ""), content });
			}
		} catch {
			// skip unreadable entries
		}
	}
	return results;
}

export function scanMemory(
	vaultPath: string,
	memoryFolder: string,
): MemoryFile[] {
	const base = resolve(vaultPath);
	const dir = resolve(base, memoryFolder);
	assertContained(base, dir);
	return walkMd(dir, dir);
}

export type FolderGroup = {
	name: string;
	children: ProjectNode[];
};

// Top-level subfolders become groups (always shown, even if empty). Loose .md
// files at the root land in a group keyed by "". Children preserve folder
// hierarchy via ProjectNode trees so nested folders render as expandable.
export function scanFolderGroups(
	vaultPath: string,
	folder: string,
): FolderGroup[] {
	const base = resolve(vaultPath);
	const dir = resolve(base, folder);
	assertContained(base, dir);

	let entries: string[];
	try {
		entries = readdirSync(dir).sort();
	} catch {
		return [];
	}

	const groups: FolderGroup[] = [];
	const looseFiles: ProjectNode[] = [];

	for (const entry of entries) {
		const item = readDirectoryEntry(dir, entry);
		if (!item) continue;
		const { full, stat } = item;
		try {
			if (stat.isDirectory()) {
				groups.push({ name: entry, children: buildNodes(full, full) });
			} else if (entry.endsWith(".md")) {
				const raw = readFileSync(full, "utf-8");
				const { content } = parseFrontmatter(raw);
				looseFiles.push({
					name: entry.replace(/\.md$/, ""),
					path: entry,
					isFolder: false,
					content,
				});
			}
		} catch {
			// skip unreadable
		}
	}

	if (looseFiles.length > 0) groups.unshift({ name: "", children: looseFiles });
	return groups;
}
