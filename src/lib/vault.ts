import {
	lstatSync,
	readdirSync,
	readFileSync,
	realpathSync,
	writeFileSync,
} from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import matter from "gray-matter";
import {
	classifyStatus,
	type ProjectStatus,
	type StatusVocabulary,
} from "#/lib/classify";
import { pathStartsWith } from "./paths";

export type { ProjectStatus, StatusVocabulary };
export { classifyStatus };

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
				const { content } = matter(raw);
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

	const projects: Project[] = [];

	for (const entry of entries) {
		const full = join(dir, entry);
		try {
			const stat = lstatSync(full);
			if (stat.isSymbolicLink()) continue;

			if (stat.isDirectory()) {
				let innerEntries: string[];
				try {
					innerEntries = readdirSync(full);
				} catch {
					continue;
				}
				const mdFiles = innerEntries.filter((f) => f.endsWith(".md"));
				const mainFile =
					mdFiles.find((f) => f.toLowerCase() === "index.md") ??
					mdFiles.find((f) => f.replace(/\.md$/, "") === entry) ??
					mdFiles[0] ??
					null;

				if (!mainFile) continue;

				const mainFullPath = join(full, mainFile);
				const mainRelPath = join(entry, mainFile);

				let title = entry;
				let rawStatus = "";
				let tags: string[] = [];
				let created: string | undefined;
				let modified: string | undefined;
				let content: string | undefined;

				try {
					const raw = readFileSync(mainFullPath, "utf-8");
					const parsed = matter(raw);
					rawStatus = String(parsed.data.status ?? "");
					title = (parsed.data.title as string | undefined) ?? entry;
					tags = Array.isArray(parsed.data.tags)
						? (parsed.data.tags as string[])
						: [];
					created = parsed.data.created as string | undefined;
					modified = parsed.data.modified as string | undefined;
					content = parsed.content || undefined;
				} catch {
					// use defaults
				}

				const allChildren = buildNodes(full, dir);
				const children = allChildren.filter((n) => n.path !== mainRelPath);

				projects.push({
					file: mainRelPath,
					title,
					status: classifyStatus(rawStatus, vocab),
					rawStatus,
					tags,
					created,
					modified,
					isFolder: true,
					content,
					children: children.length > 0 ? children : undefined,
				});
			} else if (entry.endsWith(".md")) {
				try {
					const raw = readFileSync(full, "utf-8");
					const { data, content } = matter(raw);
					const rawStatus = String(data.status ?? "");
					projects.push({
						file: entry,
						title:
							(data.title as string | undefined) ?? entry.replace(/\.md$/, ""),
						status: classifyStatus(rawStatus, vocab),
						rawStatus,
						tags: Array.isArray(data.tags) ? (data.tags as string[]) : [],
						created: data.created as string | undefined,
						modified: data.modified as string | undefined,
						isFolder: false,
						content: content || undefined,
					});
				} catch {
					projects.push({
						file: entry,
						title: entry.replace(/\.md$/, ""),
						status: "unknown" as const,
						rawStatus: "",
						tags: [],
						isFolder: false,
					});
				}
			}
		} catch {
			// skip unreadable entries
		}
	}

	return projects;
}

export type Skill = {
	file: string;
	name: string;
	description: string;
	content: string;
	filePath: string;
	section?: string;
};

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
		const full = join(dir, entry);
		try {
			const stat = lstatSync(full);
			if (stat.isSymbolicLink()) continue;
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
			const { data, content } = matter(raw);
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
				const { content } = matter(raw);
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
		const full = join(dir, entry);
		try {
			const stat = lstatSync(full);
			if (stat.isSymbolicLink()) continue;

			if (stat.isDirectory()) {
				groups.push({ name: entry, children: buildNodes(full, full) });
			} else if (entry.endsWith(".md")) {
				const raw = readFileSync(full, "utf-8");
				const { content } = matter(raw);
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

export function setProjectStatus(
	vaultPath: string,
	projectsFolder: string,
	file: string,
	newStatus: string,
): void {
	const baseDir = resolve(vaultPath, projectsFolder);
	const target = resolve(baseDir, file);
	assertContained(baseDir, target);
	const raw = readFileSync(target, "utf-8");
	const parsed = matter(raw);
	parsed.data.status = newStatus;
	const updated = matter.stringify(parsed.content, parsed.data);
	writeFileSync(target, updated, "utf-8");
}
