import { mkdir } from "node:fs/promises";
import { basename, relative, resolve } from "node:path";
import { LIBRARY_DIR, pathStartsWith } from "../lib/paths";

const SAFE_SEGMENT = /[^a-zA-Z0-9._-]+/g;

export function safeLibrarySegment(value: string, fallback = "item"): string {
	const cleaned = basename(value)
		.slice(0, 200)
		.replace(SAFE_SEGMENT, "_")
		.replace(/^\.+/, "_");
	return cleaned || fallback;
}

function withinLibrary(path: string): string {
	const absolute = resolve(path);
	if (!pathStartsWith(LIBRARY_DIR, absolute)) {
		throw new Error("library path escapes Hlid-owned storage");
	}
	return absolute;
}

export function artifactDirectory(id: string): string {
	return withinLibrary(resolve(artifactsDirectory(), safeLibrarySegment(id)));
}

export function artifactsDirectory(): string {
	return withinLibrary(resolve(LIBRARY_DIR, "artifacts"));
}

export function artifactPath(id: string, filename: string): string {
	return withinLibrary(
		resolve(artifactDirectory(id), safeLibrarySegment(filename, "file")),
	);
}

export function planStagingDirectory(): string {
	return withinLibrary(resolve(LIBRARY_DIR, "staging", "plans"));
}

export function planStagingPath(sessionId: string): string {
	return withinLibrary(
		resolve(
			planStagingDirectory(),
			`plan-${safeLibrarySegment(sessionId, "session")}.html`,
		),
	);
}

export function managedSkillsDirectory(): string {
	return withinLibrary(resolve(LIBRARY_DIR, "skills"));
}

export function storageKey(path: string): string {
	const absolute = withinLibrary(path);
	return relative(LIBRARY_DIR, absolute).replace(/\\/g, "/");
}

export async function prepareLibrary(): Promise<void> {
	await Promise.all([
		mkdir(artifactsDirectory(), { recursive: true, mode: 0o700 }),
		mkdir(planStagingDirectory(), { recursive: true, mode: 0o700 }),
		mkdir(managedSkillsDirectory(), { recursive: true, mode: 0o700 }),
	]);
}
