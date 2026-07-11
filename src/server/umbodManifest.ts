import { access, mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { APP_DIR, expandTilde } from "#/lib/paths";

export async function defaultUmbodManifest(): Promise<string> {
	const { createDefaultManifestSource } = await import("@umbod/core");
	return createDefaultManifestSource({
		name: "hlid",
		version: "1.0.0",
		timeout: 300,
		defaultUnknown: "approve",
		approvalMethod: "cli",
	});
}

export function resolveUmbodManifestPath(path: string): string {
	return resolve(APP_DIR, expandTilde(path));
}

export async function validateUmbodManifest(path: string): Promise<void> {
	const { loadManifest } = await import("@umbod/core");
	await loadManifest(resolveUmbodManifestPath(path));
}

export async function ensureUmbodManifest(path: string): Promise<void> {
	const resolved = resolveUmbodManifestPath(path);
	try {
		await access(resolved);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		await mkdir(dirname(resolved), { recursive: true });
		try {
			await writeFile(resolved, await defaultUmbodManifest(), {
				encoding: "utf8",
				mode: 0o600,
				flag: "wx",
			});
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		}
	}
	await validateUmbodManifest(path);
}
