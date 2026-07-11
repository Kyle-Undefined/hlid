// Lifecycle operations: autostart, shutdown, install location.
// Single source of truth. UI endpoints in src/routes/api/lifecycle.ts call these.

import { dirname } from "node:path";
import { createAutostartController } from "./autostartController";
import { canonicalExePath, canonicalInstallDir } from "./install";
import { runCapturedProcess } from "./process";

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
	const result = await runCapturedProcess([
		"powershell.exe",
		"-NoProfile",
		"-NonInteractive",
		"-WindowStyle",
		"Hidden",
		"-Command",
		command,
	]);
	return {
		stdout: result.stdout.trim(),
		stderr: result.stderr.trim(),
		code: result.code,
	};
}

const autostart = createAutostartController({
	isWindows,
	execPath: () => process.execPath,
	runPowerShell: ps,
});

export async function getAutostart(): Promise<LifecycleResult> {
	return autostart.get();
}

export async function installAutostart(): Promise<LifecycleResult> {
	return autostart.install();
}

export async function uninstallAutostart(): Promise<LifecycleResult> {
	return autostart.uninstall();
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
