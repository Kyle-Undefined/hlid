// Lifecycle operations: autostart, shutdown, install location.
// Single source of truth. UI endpoints in src/routes/api/lifecycle.ts call these.

import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname } from "node:path";
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

export function restart(): LifecycleResult {
	// Spawn a replacement after the response has flushed. On Windows an
	// external PowerShell trampoline must own the relaunch: children spawned
	// directly by the compiled Bun process are not guaranteed to survive its
	// exit even when detached.
	setTimeout(() => {
		const runtime = basename(process.execPath).toLowerCase();
		const compiled = runtime !== "bun" && runtime !== "bun.exe";
		const appArgs = compiled
			? ["--restart", "--background", `--restart-parent=${process.pid}`]
			: [
					...process.argv
						.slice(1)
						.filter(
							(arg) =>
								arg !== "--restart" && !arg.startsWith("--restart-parent="),
						),
					"--restart",
					`--restart-parent=${process.pid}`,
				];
		if (process.platform === "win32") {
			const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
			const vbsQuote = (value: string) => value.replaceAll('"', '""');
			const command = [process.execPath, ...appArgs]
				.map((value) => `"${value.replaceAll('"', '\\"')}"`)
				.join(" ");
			const waiterPath = `${tmpdir()}\\hlid-restart-${process.pid}-${Date.now()}.vbs`;
			const waiterScript = [
				`Set wmi = GetObject("winmgmts:\\\\.\\root\\cimv2")`,
				`Do While wmi.ExecQuery("SELECT ProcessId FROM Win32_Process WHERE ProcessId = ${process.pid}").Count > 0`,
				`  WScript.Sleep 100`,
				`Loop`,
				`Set shell = CreateObject("WScript.Shell")`,
				`shell.CurrentDirectory = "${vbsQuote(process.cwd())}"`,
				`shell.Run "${vbsQuote(command)}", 0, False`,
				`CreateObject("Scripting.FileSystemObject").DeleteFile WScript.ScriptFullName, True`,
			].join("\r\n");
			writeFileSync(waiterPath, waiterScript, {
				encoding: "utf8",
				mode: 0o600,
			});
			const waiterCommand = `wscript.exe //B //NoLogo "${waiterPath}"`;
			// Ask WMI to create the waiter so it is owned by the Windows service
			// host, not by HLID's Bun process/job. wscript.exe is a GUI process, so
			// neither the waiter nor the restarted Hlid allocates a console window.
			const brokerScript = [
				`$startup = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly`,
				`$startup.ShowWindow = 0`,
				`$result = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = ${quote(waiterCommand)}; ProcessStartupInformation = $startup }`,
				`if ($result.ReturnValue -ne 0) { exit $result.ReturnValue }`,
			].join("; ");
			const brokerEncoded = Buffer.from(brokerScript, "utf16le").toString(
				"base64",
			);
			const broker = spawn(
				"powershell.exe",
				[
					"-NoProfile",
					"-NonInteractive",
					"-WindowStyle",
					"Hidden",
					"-EncodedCommand",
					brokerEncoded,
				],
				{
					cwd: process.cwd(),
					stdio: "ignore",
					windowsHide: true,
				},
			);
			broker.once("exit", (code) => {
				// Never kill the working server unless Windows confirmed that the
				// independent waiter was created successfully.
				if (code === 0) process.exit(0);
			});
			return;
		}

		const child = spawn(process.execPath, appArgs, {
			cwd: process.cwd(),
			detached: true,
			stdio: "ignore",
			windowsHide: true,
		});
		child.unref();
		process.exit(0);
	}, 250);
	return { ok: true };
}
