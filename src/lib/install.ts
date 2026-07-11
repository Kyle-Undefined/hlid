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

const DATA_FILES = [
	"hlid.config.toml",
	"hlid.db",
	"hlid.db-shm",
	"hlid.db-wal",
] as const;
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

function pathEq(a: string, b: string): boolean {
	const norm = (p: string) => p.toLowerCase().replace(/\//g, "\\");
	return norm(a) === norm(b);
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
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (!(await isRunning(port))) return;
		await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
	}
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
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			const fd = openSync(file, "r+");
			closeSync(fd);
			return;
		} catch {
			await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
		}
	}
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

function parseExeFromCommand(cmd: string): string | null {
	const quoted = cmd.match(/^"([^"]+)"/);
	if (quoted) return quoted[1];
	const bare = cmd.match(/^(\S+)/);
	return bare ? bare[1] : null;
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

export async function maybeSelfInstall(): Promise<void> {
	if (process.platform !== "win32") return;
	if (!process.execPath.toLowerCase().endsWith(".exe")) return;

	const canonical = canonicalExePath();
	if (pathEq(process.execPath, canonical)) return;

	const canonicalDir = dirname(canonical);
	const versionedDir = dirname(process.execPath);

	// Find the legacy install dir (where existing config/db live, if any).
	// Prefer the path stored in the autostart registry entry; fall back to
	// the directory the versioned exe is being run from.
	const autostartCmd = await readAutostartCommand();
	const autostartExe = autostartCmd ? parseExeFromCommand(autostartCmd) : null;
	let legacyDir: string | null = null;
	if (autostartExe && existsSync(autostartExe)) {
		legacyDir = dirname(autostartExe);
	} else if (existsSync(join(versionedDir, "hlid.db"))) {
		legacyDir = versionedDir;
	}

	// Shut down any running instance (canonical or legacy) so files unlock.
	// Wait for the process to actually exit before continuing — sending the
	// POST is acked synchronously but exit is delayed ~250ms, and SQLite
	// needs that time to release WAL locks on hlid.db.
	const dirsToCheck = new Set<string>();
	if (existsSync(canonical)) dirsToCheck.add(canonicalDir);
	if (legacyDir && legacyDir !== canonicalDir) dirsToCheck.add(legacyDir);
	for (const dir of dirsToCheck) {
		const port = await readPortFromConfig(dir);
		if (await isRunning(port)) {
			await postShutdown(port);
			await waitForExit(port, SHUTDOWN_WAIT_TIMEOUT_MS);
		}
	}

	mkdirSync(canonicalDir, { recursive: true });

	// First-time migration: copy data files from legacy dir → canonical.
	if (legacyDir && !pathEq(legacyDir, canonicalDir)) {
		const canonicalHasDb = existsSync(join(canonicalDir, "hlid.db"));
		if (!canonicalHasDb) {
			for (const name of DATA_FILES) {
				const src = join(legacyDir, name);
				if (!existsSync(src)) continue;
				try {
					copyFileSync(src, join(canonicalDir, name));
				} catch {}
			}
		}
	}

	// Replace the canonical exe with the version we're running.
	if (existsSync(canonical)) {
		await waitForUnlock(canonical, FILE_UNLOCK_TIMEOUT_MS);
	}
	copyFileSync(process.execPath, canonical);

	// Re-point autostart at the canonical path if it was previously set.
	if (autostartCmd) await writeAutostart(canonical);

	// Drop / refresh a Start Menu shortcut so the user can find the app
	// without digging through AppData.
	await createStartMenuShortcut(canonical);

	// Tell the shell to invalidate its icon cache so the new exe's icon
	// shows up immediately instead of inheriting whatever was at this path
	// before (the Bun icon from a prior WSL test build, etc).
	await refreshShellIconCache();

	// Give the OS a moment to fully release socket handles after the old
	// canonical's process.exit fires (250ms timer). Without this, the new
	// canonical can race the OS cleanup and fail to bind port 3000.
	await new Promise((r) => setTimeout(r, 1000));

	// Relaunch from the canonical location. --restart tells the new canonical to
	// skip the running-instance probe (it knows the old instance was replaced).
	Bun.spawn([canonical, "--restart"], {
		stdio: ["ignore", "ignore", "ignore"],
		detached: true,
		windowsHide: true,
	});
	process.exit(0);
}
