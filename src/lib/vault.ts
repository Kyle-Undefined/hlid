import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import matter from "gray-matter";
import {
	classifyStatus,
	type ProjectStatus,
	type StatusVocabulary,
} from "#/lib/classify";

export type { ProjectStatus, StatusVocabulary };
export { classifyStatus };

export type Project = {
	file: string;
	title: string;
	status: ProjectStatus;
	rawStatus: string;
	tags: string[];
	created?: string;
	modified?: string;
};

function walkProjects(dir: string): string[] {
	let results: string[] = [];
	let entries: string[];
	try {
		entries = readdirSync(dir);
	} catch {
		return [];
	}
	for (const entry of entries) {
		const full = join(dir, entry);
		try {
			if (statSync(full).isDirectory()) {
				results = results.concat(walkProjects(full));
			} else if (entry.endsWith(".md")) {
				results.push(full);
			}
		} catch {
			// skip unreadable
		}
	}
	return results;
}

export function scanProjects(
	vaultPath: string,
	projectsFolder: string,
	vocab: StatusVocabulary,
): Project[] {
	const dir = join(vaultPath, projectsFolder);
	const files = walkProjects(dir);

	return files.map((fullPath) => {
		const file = relative(dir, fullPath);
		try {
			const raw = readFileSync(fullPath, "utf-8");
			const { data } = matter(raw);
			const rawStatus = String(data.status ?? "");
			const titleFromFrontmatter = data.title as string | undefined;
			const titleFromFilename = fullPath.split(sep).pop()?.replace(/\.md$/, "");
			return {
				file,
				title: titleFromFrontmatter ?? titleFromFilename ?? "",
				status: classifyStatus(rawStatus, vocab),
				rawStatus,
				tags: Array.isArray(data.tags) ? (data.tags as string[]) : [],
				created: data.created as string | undefined,
				modified: data.modified as string | undefined,
			};
		} catch {
			return {
				file,
				title: file.replace(/\.md$/, ""),
				status: "unknown" as const,
				rawStatus: "",
				tags: [],
			};
		}
	});
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
	const dir = join(vaultPath, skillsFolder);
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
			const stat = statSync(full);
			if (stat.isDirectory()) {
				// skill folder — find the .md file directly inside (one level only)
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
			const stat = statSync(full);
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
	const dir = join(vaultPath, memoryFolder);
	return walkMd(dir, dir);
}

export function setProjectStatus(
	vaultPath: string,
	projectsFolder: string,
	file: string,
	newStatus: string,
): void {
	const baseDir = resolve(vaultPath, projectsFolder);
	const target = resolve(baseDir, file);
	if (!target.startsWith(baseDir + sep)) {
		throw new Error("Access denied");
	}
	const raw = readFileSync(target, "utf-8");
	const parsed = matter(raw);
	parsed.data.status = newStatus;
	const updated = matter.stringify(parsed.content, parsed.data);
	writeFileSync(target, updated, "utf-8");
}
