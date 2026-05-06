// Lifecycle operations: autostart, shutdown, install location.
// Single source of truth. UI endpoints in src/routes/api/lifecycle.ts call these.

import { dirname } from "node:path";
import { canonicalExePath, canonicalInstallDir } from "./install";

const REG_KEY = "HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
const REG_VALUE_NAME = "Hlid";

export type LifecycleResult =
	| { ok: true; data?: unknown }
	| { ok: false; error: string };

function isWindows(): boolean {
	return process.platform === "win32";
}

export function getInstallPaths(): {
	exe: string;
	dir: string;
	canonical_exe: string;
	canonical_dir: string;
	is_canonical: boolean;
} {
	const exe = process.execPath;
	const dir = dirname(exe);
	const canonical_exe = isWindows() ? canonicalExePath() : exe;
	const canonical_dir = isWindows() ? canonicalInstallDir() : dir;
	const norm = (p: string) =>
		isWindows() ? p.toLowerCase().replace(/\//g, "\\") : p;
	return {
		exe,
		dir,
		canonical_exe,
		canonical_dir,
		is_canonical: norm(exe) === norm(canonical_exe),
	};
}

export async function openInstallDir(): Promise<LifecycleResult> {
	if (!isWindows())
		return { ok: false, error: "Open install dir only supported on Windows" };
	const { dir } = getInstallPaths();
	const proc = Bun.spawn(["explorer.exe", dir], {
		stdio: ["ignore", "ignore", "ignore"],
		windowsHide: true,
	});
	// explorer.exe returns code 1 on success — don't treat as error.
	await proc.exited;
	return { ok: true, data: { dir } };
}

// Run a PowerShell command without a visible console window.
// `windowsHide: true` passes CREATE_NO_WINDOW to CreateProcess, which prevents
// Windows from allocating a console for the child at all. Without this, a GUI-
// subsystem parent (our exe is subsystem=2) spawning a console-subsystem child
// causes a fresh console to be allocated and briefly flash before
// `-WindowStyle Hidden` takes effect.
async function ps(
	command: string,
): Promise<{ stdout: string; stderr: string; code: number }> {
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
		{ stdout: "pipe", stderr: "pipe", windowsHide: true },
	);
	const stdoutP = new Response(proc.stdout).text();
	const stderrP = new Response(proc.stderr).text();
	const [stdout, stderr, code] = await Promise.all([
		stdoutP,
		stderrP,
		proc.exited,
	]);
	return { stdout: stdout.trim(), stderr: stderr.trim(), code };
}

// Autostart status is read from the registry via PowerShell. Even with
// windowsHide, that's a heavy spawn for every UI page load. Cache the result
// in-process and only re-shell when install/uninstall mutates it.
let autostartCache: LifecycleResult | null = null;

function invalidateAutostartCache(): void {
	autostartCache = null;
}

export async function getAutostart(): Promise<LifecycleResult> {
	if (!isWindows())
		return { ok: true, data: { enabled: false, supported: false } };
	if (autostartCache) return autostartCache;
	const { stdout, code } = await ps(
		`(Get-ItemProperty -Path '${REG_KEY}' -Name '${REG_VALUE_NAME}' -ErrorAction SilentlyContinue).'${REG_VALUE_NAME}'`,
	);
	const result: LifecycleResult =
		code !== 0 || !stdout
			? { ok: true, data: { enabled: false, supported: true } }
			: { ok: true, data: { enabled: true, supported: true, path: stdout } };
	autostartCache = result;
	return result;
}

export async function installAutostart(): Promise<LifecycleResult> {
	if (!isWindows())
		return { ok: false, error: "Autostart only supported on Windows" };
	const exePath = process.execPath;
	if (!exePath.endsWith(".exe")) {
		return {
			ok: false,
			error: "Cannot install autostart in dev mode (not running from .exe)",
		};
	}
	const command = `"${exePath}" --background`;
	// Escape single quotes for PowerShell single-quoted string.
	const escaped = command.replace(/'/g, "''");
	const { code, stdout, stderr } = await ps(
		`Set-ItemProperty -Path '${REG_KEY}' -Name '${REG_VALUE_NAME}' -Value '${escaped}' -Type String`,
	);
	if (code !== 0)
		return {
			ok: false,
			error: `registry write failed: ${`${stdout}\n${stderr}`.trim()}`,
		};
	invalidateAutostartCache();
	return { ok: true, data: { command } };
}

export async function uninstallAutostart(): Promise<LifecycleResult> {
	if (!isWindows())
		return { ok: false, error: "Autostart only supported on Windows" };
	const { code, stdout, stderr } = await ps(
		`Remove-ItemProperty -Path '${REG_KEY}' -Name '${REG_VALUE_NAME}' -ErrorAction SilentlyContinue`,
	);
	if (code !== 0)
		return {
			ok: false,
			error: `registry delete failed: ${`${stdout}\n${stderr}`.trim()}`,
		};
	invalidateAutostartCache();
	return { ok: true };
}

type BunServer = { stop(force?: boolean): void };

// Bun's entry bundle and TanStack Start's SSR bundle are separate module
// instances. A plain module-level array would be duplicated — registerBunServer
// (called from the entry bundle) and shutdown (called from the SSR bundle) would
// see different arrays. globalThis is shared across both bundles in the same
// process, so we use it as the single source of truth.
const G = globalThis as Record<string, unknown>;
if (!G.__hlidServers) G.__hlidServers = [] as BunServer[];
const registeredServers = G.__hlidServers as BunServer[];

export function registerBunServer(s: BunServer): void {
	registeredServers.push(s);
}

export function shutdown(): LifecycleResult {
	// Delay exit so the HTTP response (the apply result) has time to flush
	// before the process dies. process.exit(0) releases all ports and handles;
	// calling stop(true) first can block the event loop on Windows when SSE or
	// WS connections are active, preventing this timer from ever firing.
	setTimeout(() => process.exit(0), 250);
	return { ok: true };
}
