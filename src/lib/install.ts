// Self-install: when a versioned exe (hlid-vX.Y.Z-windows-x64.exe) is run,
// copy itself to a canonical %LOCALAPPDATA%\Hlid\hlid.exe path, migrate any
// existing config/db from the legacy install location, point autostart at
// the canonical path, and relaunch from there.
//
// Goal: autostart registry entry never breaks across version upgrades, and
// data files (hlid.config.toml, hlid.db) live in a stable, well-known dir.

import {
	closeSync,
	copyFileSync,
	existsSync,
	mkdirSync,
	openSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
	migrateInstallData,
	selectLegacyInstallDir,
	waitForCondition,
	windowsPathEquals,
} from "./windowsInstallPolicy";

const HEALTH_PROBE_TIMEOUT_MS = 800;
const SHUTDOWN_WAIT_TIMEOUT_MS = 10_000;
const FILE_UNLOCK_TIMEOUT_MS = 10_000;
const POLL_INTERVAL_MS = 200;

export function canonicalInstallDir(): string {
	const local = process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local");
	return join(local, "Hlid");
}

export function canonicalExePath(): string {
	return join(canonicalInstallDir(), "hlid.exe");
}

// True only if /api/health responds with our service marker. Plain port-open
// or generic 200 isn't enough — another web server on the same port would
// otherwise eat our shutdown POST.
async function isRunning(port: number): Promise<boolean> {
	try {
		const r = await fetch(`http://127.0.0.1:${port}/api/health`, {
			signal: AbortSignal.timeout(HEALTH_PROBE_TIMEOUT_MS),
		});
		if (!r.ok) return false;
		const body = (await r.json()) as { service?: unknown };
		return body.service === "hlid";
	} catch {
		return false;
	}
}

async function postShutdown(port: number): Promise<void> {
	try {
		const { loadToken } = await import("./token");
		await fetch(`http://127.0.0.1:${port}/api/lifecycle`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"x-hlid-internal": loadToken(),
			},
			body: JSON.stringify({ action: "shutdown" }),
			signal: AbortSignal.timeout(2000),
		});
	} catch {}
}

// Poll until isRunning returns false. The shutdown handler delays
// `process.exit(0)` by 250ms after acking the POST, plus SQLite needs to
// release its WAL/lock. Without this wait, copyFileSync of hlid.db hits
// EBUSY and the user loses data on first migration.
async function waitForExit(port: number, timeoutMs: number): Promise<void> {
	const exited = await waitForCondition(
		async () => !(await isRunning(port)),
		timeoutMs,
		{ intervalMs: POLL_INTERVAL_MS },
	);
	if (!exited) throw new Error(`Hlid on port ${port} did not exit in time`);
}

// Best-effort port lookup from a config file. Avoids importing the full
// TOML/zod stack so this module stays free of heavyweight init that could
// trigger AllocConsole before the prelude finishes setting up redirects.
async function readPortFromConfig(dir: string): Promise<number> {
	const path = join(dir, "hlid.config.toml");
	if (!existsSync(path)) return 3000;
	try {
		const raw = await Bun.file(path).text();
		const m = raw.match(/^\s*port\s*=\s*(\d+)/m);
		if (m) {
			const n = parseInt(m[1], 10);
			if (Number.isFinite(n) && n > 0 && n < 65536) return n;
		}
	} catch {}
	return 3000;
}

async function waitForUnlock(file: string, timeoutMs: number): Promise<void> {
	const unlocked = await waitForCondition(
		() => {
			try {
				const fd = openSync(file, "r+");
				closeSync(fd);
				return true;
			} catch {
				return false;
			}
		},
		timeoutMs,
		{ intervalMs: POLL_INTERVAL_MS },
	);
	if (!unlocked) throw new Error(`Timed out waiting for ${file} to unlock`);
}

async function runPs(command: string): Promise<string> {
	const proc = Bun.spawn(
		[
			"powershell.exe",
			"-NoProfile",
			"-NonInteractive",
			"-WindowStyle",
			"Hidden",
			"-Command",
			command,
		],
		{ stdout: "pipe", stderr: "ignore", windowsHide: true },
	);
	const out = await new Response(proc.stdout).text();
	await proc.exited;
	return out.trim();
}

async function readAutostartCommand(): Promise<string | null> {
	const out = await runPs(
		`(Get-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run' -Name 'Hlid' -ErrorAction SilentlyContinue).'Hlid'`,
	);
	return out || null;
}

async function writeAutostart(canonicalExe: string): Promise<void> {
	const value = `"${canonicalExe}" --background`;
	const escaped = value.replace(/'/g, "''");
	await runPs(
		`Set-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run' -Name 'Hlid' -Value '${escaped}' -Type String`,
	);
}

// Bust the Windows shell icon cache. Without this, replacing a file at a path
// that previously had a different icon shows the OLD icon in Explorer/taskbar
// until the user manually refreshes (kills explorer.exe, runs ie4uinit, etc).
// SHChangeNotify(SHCNE_ASSOCCHANGED, 0, NULL, NULL) tells the shell that file
// associations have changed; it re-reads icons on next render.
async function refreshShellIconCache(): Promise<void> {
	const memberDef =
		'[System.Runtime.InteropServices.DllImport(\\"Shell32.dll\\")] public static extern void SHChangeNotify(int eventId, int flags, System.IntPtr item1, System.IntPtr item2);';
	const cmd = [
		`Add-Type -Namespace Win32 -Name Shell32 -MemberDefinition "${memberDef}"`,
		`[Win32.Shell32]::SHChangeNotify(0x08000000, 0, [System.IntPtr]::Zero, [System.IntPtr]::Zero)`,
	].join("; ");
	try {
		await runPs(cmd);
	} catch {}
}

// Drop a Start Menu shortcut so users can find Hlid without hunting through
// AppData. Click → relaunches the canonical exe; the existing port-probe in
// index.ts detects a running instance and pops the browser instead of double-
// booting. Idempotent: overwriting an existing .lnk is fine.
async function createStartMenuShortcut(canonical: string): Promise<void> {
	const appData = process.env.APPDATA;
	if (!appData) return;
	const lnkPath = join(
		appData,
		"Microsoft",
		"Windows",
		"Start Menu",
		"Programs",
		"Hlid.lnk",
	);
	const workingDir = dirname(canonical);
	const esc = (s: string) => s.replace(/'/g, "''");
	const cmd = [
		`$ws = New-Object -ComObject WScript.Shell`,
		`$lnk = $ws.CreateShortcut('${esc(lnkPath)}')`,
		`$lnk.TargetPath = '${esc(canonical)}'`,
		`$lnk.WorkingDirectory = '${esc(workingDir)}'`,
		`$lnk.IconLocation = '${esc(canonical)},0'`,
		`$lnk.Description = 'Hlidskjalf - Watcher of Worlds'`,
		`$lnk.Save()`,
	].join("; ");
	await runPs(cmd);
}

type SelfInstallOperations = {
	platform: string;
	execPath: string;
	canonicalPath: string;
	exists: (path: string) => boolean;
	readAutostart: () => Promise<string | null>;
	readPort: (dir: string) => Promise<number>;
	isRunning: (port: number) => Promise<boolean>;
	shutdown: (port: number) => Promise<void>;
	waitForExit: (port: number) => Promise<void>;
	mkdir: (dir: string) => void;
	migrate: (legacyDir: string | null, canonicalDir: string) => void;
	waitForUnlock: (path: string) => Promise<void>;
	copyExecutable: (source: string, destination: string) => void;
	writeAutostart: (canonicalPath: string) => Promise<void>;
	createShortcut: (canonicalPath: string) => Promise<void>;
	refreshIconCache: () => Promise<void>;
	sleepBeforeRestart: () => Promise<void>;
	restart: (canonicalPath: string) => void;
	exit: () => void;
};

export async function runSelfInstall(
	operations: SelfInstallOperations,
): Promise<void> {
	if (operations.platform !== "win32") return;
	if (!operations.execPath.toLowerCase().endsWith(".exe")) return;
	if (windowsPathEquals(operations.execPath, operations.canonicalPath)) return;

	const canonicalDir = dirname(operations.canonicalPath);
	const versionedDir = dirname(operations.execPath);

	// Find the legacy install dir (where existing config/db live, if any).
	// Prefer the path stored in the autostart registry entry; fall back to
	// the directory the versioned exe is being run from.
	const autostartCmd = await operations.readAutostart();
	const legacyDir = selectLegacyInstallDir({
		autostartCommand: autostartCmd,
		versionedDir,
		exists: operations.exists,
	});

	// Shut down any running instance (canonical or legacy) so files unlock.
	// Wait for the process to actually exit before continuing — sending the
	// POST is acked synchronously but exit is delayed ~250ms, and SQLite
	// needs that time to release WAL locks on hlid.db.
	const dirsToCheck = new Set<string>();
	if (operations.exists(operations.canonicalPath))
		dirsToCheck.add(canonicalDir);
	if (legacyDir && legacyDir !== canonicalDir) dirsToCheck.add(legacyDir);
	for (const dir of dirsToCheck) {
		const port = await operations.readPort(dir);
		if (await operations.isRunning(port)) {
			await operations.shutdown(port);
			await operations.waitForExit(port);
		}
	}

	operations.mkdir(canonicalDir);

	// First-time migration: copy data files from legacy dir → canonical.
	operations.migrate(legacyDir, canonicalDir);

	// Replace the canonical exe with the version we're running.
	if (operations.exists(operations.canonicalPath)) {
		await operations.waitForUnlock(operations.canonicalPath);
	}
	operations.copyExecutable(operations.execPath, operations.canonicalPath);

	// Re-point autostart at the canonical path if it was previously set.
	if (autostartCmd) await operations.writeAutostart(operations.canonicalPath);

	// Drop / refresh a Start Menu shortcut so the user can find the app
	// without digging through AppData.
	await operations.createShortcut(operations.canonicalPath);

	// Tell the shell to invalidate its icon cache so the new exe's icon
	// shows up immediately instead of inheriting whatever was at this path
	// before (the Bun icon from a prior WSL test build, etc).
	await operations.refreshIconCache();

	// Give the OS a moment to fully release socket handles after the old
	// canonical's process.exit fires (250ms timer). Without this, the new
	// canonical can race the OS cleanup and fail to bind port 3000.
	await operations.sleepBeforeRestart();

	// Relaunch from the canonical location. --restart tells the new canonical to
	// skip the running-instance probe (it knows the old instance was replaced).
	operations.restart(operations.canonicalPath);
	operations.exit();
}

export async function maybeSelfInstall(): Promise<void> {
	await runSelfInstall({
		platform: process.platform,
		execPath: process.execPath,
		canonicalPath: canonicalExePath(),
		exists: existsSync,
		readAutostart: readAutostartCommand,
		readPort: readPortFromConfig,
		isRunning,
		shutdown: postShutdown,
		waitForExit: (port) => waitForExit(port, SHUTDOWN_WAIT_TIMEOUT_MS),
		mkdir: (dir) => mkdirSync(dir, { recursive: true }),
		migrate: (legacyDir, canonicalDir) => {
			migrateInstallData({
				legacyDir,
				canonicalDir,
				exists: existsSync,
				copy: copyFileSync,
			});
		},
		waitForUnlock: (path) => waitForUnlock(path, FILE_UNLOCK_TIMEOUT_MS),
		copyExecutable: copyFileSync,
		writeAutostart,
		createShortcut: createStartMenuShortcut,
		refreshIconCache: refreshShellIconCache,
		sleepBeforeRestart: () =>
			new Promise((resolve) => setTimeout(resolve, 1000)),
		restart: (canonicalPath) => {
			Bun.spawn([canonicalPath, "--restart"], {
				stdio: ["ignore", "ignore", "ignore"],
				detached: true,
				windowsHide: true,
			});
		},
		exit: () => process.exit(0),
	});
}
