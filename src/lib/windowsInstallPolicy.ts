import { win32 } from "node:path";

const INSTALL_DATA_FILES = [
	"hlid.config.toml",
	"hlid.db",
	"hlid.db-shm",
	"hlid.db-wal",
] as const;

export function windowsPathEquals(a: string, b: string): boolean {
	const normalize = (value: string) =>
		value.toLowerCase().replaceAll("/", "\\");
	return normalize(a) === normalize(b);
}

export function parseAutostartExecutable(command: string): string | null {
	const quoted = command.match(/^"([^"]+)"/);
	if (quoted) return quoted[1];
	const bare = command.match(/^(\S+)/);
	return bare ? bare[1] : null;
}

export function selectLegacyInstallDir(input: {
	autostartCommand: string | null;
	versionedDir: string;
	exists: (path: string) => boolean;
}): string | null {
	const autostartExe = input.autostartCommand
		? parseAutostartExecutable(input.autostartCommand)
		: null;
	if (autostartExe && input.exists(autostartExe)) {
		return win32.dirname(autostartExe);
	}
	return input.exists(win32.join(input.versionedDir, "hlid.db"))
		? input.versionedDir
		: null;
}

export function migrateInstallData(input: {
	legacyDir: string | null;
	canonicalDir: string;
	exists: (path: string) => boolean;
	copy: (source: string, destination: string) => void;
}): string[] {
	if (
		!input.legacyDir ||
		windowsPathEquals(input.legacyDir, input.canonicalDir) ||
		input.exists(win32.join(input.canonicalDir, "hlid.db"))
	) {
		return [];
	}
	const copied: string[] = [];
	for (const name of INSTALL_DATA_FILES) {
		const source = win32.join(input.legacyDir, name);
		if (!input.exists(source)) continue;
		input.copy(source, win32.join(input.canonicalDir, name));
		copied.push(name);
	}
	return copied;
}

export async function waitForCondition(
	condition: () => boolean | Promise<boolean>,
	timeoutMs: number,
	options: {
		intervalMs?: number;
		now?: () => number;
		sleep?: (milliseconds: number) => Promise<void>;
	} = {},
): Promise<boolean> {
	const intervalMs = options.intervalMs ?? 200;
	const now = options.now ?? Date.now;
	const sleep =
		options.sleep ??
		((milliseconds: number) =>
			new Promise((resolve) => setTimeout(resolve, milliseconds)));
	const deadline = now() + timeoutMs;
	while (now() < deadline) {
		if (await condition()) return true;
		await sleep(intervalMs);
	}
	return condition();
}
