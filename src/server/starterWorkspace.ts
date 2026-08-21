import { mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { pathStartsWith } from "#/lib/paths";

const MARKER = ".hlid-starter.json";
const MARKER_CONTENT = `${JSON.stringify({ format: 1, kind: "hlid-starter-workspace" })}\n`;

const DIRECTORIES = [
	"00 Inbox",
	"10 Projects",
	"20 Areas",
	"30 Resources",
	"40 Archive",
	"_munin",
	"_munin/skills",
	"_munin/memory",
] as const;

const FILES = [
	[
		"Welcome to Hlid.md",
		"# Welcome to Hlid\n\nThis is your starter workspace. Keep your notes where they make sense to you; Hlid only uses the folders you choose during setup.\n",
	],
] as const;

export const STARTER_WORKSPACE_NAME = "Hlid Starter";

export type StarterWorkspaceResult = {
	path: string;
	created: boolean;
	recovered: boolean;
};

function isInside(parent: string, child: string): boolean {
	return child !== parent && pathStartsWith(parent, child);
}

async function verifyStarterRoot(
	parent: string,
	target: string,
): Promise<string> {
	const resolved = await realpath(target);
	if (!isInside(parent, resolved)) {
		throw new Error("Starter workspace escaped the selected folder.");
	}
	const details = await stat(resolved);
	if (!details.isDirectory()) {
		throw new Error("A file already uses the starter workspace name.");
	}
	return resolved;
}

async function hasStarterMarker(root: string): Promise<boolean> {
	try {
		const marker = await realpath(join(root, MARKER));
		if (!pathStartsWith(root, marker)) return false;
		const content = await readFile(marker, "utf8");
		return content === MARKER_CONTENT;
	} catch {
		return false;
	}
}

async function createDirectory(root: string, relative: string) {
	const target = join(root, relative);
	try {
		await mkdir(target);
	} catch (error) {
		if (
			!(error instanceof Error) ||
			!("code" in error) ||
			error.code !== "EEXIST"
		) {
			throw error;
		}
	}
	const canonical = await realpath(target);
	if (!pathStartsWith(root, canonical)) {
		throw new Error("Starter workspace contains an unsafe linked folder.");
	}
	const details = await stat(canonical);
	if (!details.isDirectory()) {
		throw new Error(`Starter workspace entry ${relative} is not a folder.`);
	}
}

/**
 * Creates the small, predictable vault used by the first-start guided path.
 * A prior, marked partial attempt can be resumed; all content writes are exclusive.
 */
export async function bootstrapStarterWorkspace(
	parentPath: string,
): Promise<StarterWorkspaceResult> {
	const parent = await realpath(resolve(parentPath));
	const parentDetails = await stat(parent);
	if (!parentDetails.isDirectory()) {
		throw new Error("Choose a folder for the starter workspace.");
	}
	const target = resolve(parent, STARTER_WORKSPACE_NAME);
	if (
		basename(target) !== STARTER_WORKSPACE_NAME ||
		!isInside(parent, target)
	) {
		throw new Error("Starter workspace must stay inside the selected folder.");
	}

	let created = false;
	try {
		await mkdir(target);
		created = true;
	} catch (error) {
		if (
			!(error instanceof Error) ||
			!("code" in error) ||
			error.code !== "EEXIST"
		) {
			throw error;
		}
	}

	const root = await verifyStarterRoot(parent, target);
	const marked = await hasStarterMarker(root);
	if (!created && !marked) {
		throw new Error(
			"A folder named Hlid Starter already exists. It was not changed.",
		);
	}
	if (created) {
		// The marker is written before any template content so a stopped request can
		// be safely retried without treating an unrelated folder as ours.
		await writeFile(join(root, MARKER), MARKER_CONTENT, { flag: "wx" });
	}

	for (const directory of DIRECTORIES) await createDirectory(root, directory);
	for (const [relative, content] of FILES) {
		try {
			await writeFile(join(root, relative), content, { flag: "wx" });
		} catch (error) {
			if (
				error instanceof Error &&
				"code" in error &&
				error.code === "EEXIST"
			) {
				const existing = await readFile(join(root, relative), "utf8").catch(
					() => null,
				);
				if (existing === content) continue;
				throw new Error(
					`Starter workspace file ${relative} already exists; it was not changed.`,
				);
			}
			throw error;
		}
	}

	return { path: root, created, recovered: !created };
}
