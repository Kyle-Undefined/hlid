import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import matter from "gray-matter";

export type ProjectStatus = "active" | "planning" | "done" | "unknown";

export type Project = {
	file: string;
	title: string;
	status: ProjectStatus;
	rawStatus: string;
	tags: string[];
	created?: string;
	modified?: string;
};

export type StatusVocabulary = {
	active: string[];
	planning: string[];
	done: string[];
};

export function classifyStatus(
	raw: string | undefined,
	vocab: StatusVocabulary,
): ProjectStatus {
	if (!raw) return "unknown";
	const lower = raw.toLowerCase();
	if (vocab.active.some((v) => v.toLowerCase() === lower)) return "active";
	if (vocab.planning.some((v) => v.toLowerCase() === lower)) return "planning";
	if (vocab.done.some((v) => v.toLowerCase() === lower)) return "done";
	return "unknown";
}

export function scanProjects(
	vaultPath: string,
	projectsFolder: string,
	vocab: StatusVocabulary,
): Project[] {
	const dir = join(vaultPath, projectsFolder);
	let files: string[];
	try {
		files = readdirSync(dir).filter((f) => f.endsWith(".md"));
	} catch {
		return [];
	}

	return files.map((file) => {
		try {
			const raw = readFileSync(join(dir, file), "utf-8");
			const { data } = matter(raw);
			const rawStatus = String(data.status ?? "");
			const titleFromFrontmatter = data.title as string | undefined;
			const titleFromFilename = file.replace(/\.md$/, "");
			return {
				file,
				title: titleFromFrontmatter ?? titleFromFilename,
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
};

export function scanSkills(vaultPath: string, skillsFolder: string): Skill[] {
	const dir = join(vaultPath, skillsFolder);
	let files: string[];
	try {
		files = readdirSync(dir).filter((f) => f.endsWith(".md"));
	} catch {
		return [];
	}

	return files.map((file) => {
		try {
			const raw = readFileSync(join(dir, file), "utf-8");
			const { data, content } = matter(raw);
			const name =
				(data.name as string | undefined) ?? file.replace(/\.md$/, "");
			const firstLine =
				content
					.trim()
					.split("\n")
					.find((l) => l.trim()) ?? "";
			const description =
				(data.description as string | undefined) ??
				firstLine.replace(/^#+\s*/, "");
			return { file, name, description, content: raw };
		} catch {
			return {
				file,
				name: file.replace(/\.md$/, ""),
				description: "",
				content: "",
			};
		}
	});
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
				const content = readFileSync(full, "utf-8");
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
