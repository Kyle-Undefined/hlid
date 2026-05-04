// Lifecycle operations: autostart, shutdown.
// Single source of truth. UI endpoints in src/routes/api/lifecycle.ts call these.

const REG_KEY = "HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
const REG_VALUE_NAME = "Hlid";

function isWindows(): boolean {
	return process.platform === "win32";
}

export type LifecycleResult =
	| { ok: true; data?: unknown }
	| { ok: false; error: string };

// Run a PowerShell command hidden. powershell.exe is a Windows-subsystem-aware
// process that respects -WindowStyle Hidden, so no console window flashes when
// spawned from a --windows-hide-console exe (unlike reg.exe which is a raw
// console-subsystem binary).
async function ps(
	command: string,
): Promise<{ stdout: string; stderr: string; code: number }> {
	const proc = Bun.spawn(
		[
			"powershell.exe",
			"-NonInteractive",
			"-WindowStyle",
			"Hidden",
			"-Command",
			command,
		],
		{ stdout: "pipe", stderr: "pipe" },
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

export async function getAutostart(): Promise<LifecycleResult> {
	if (!isWindows())
		return { ok: true, data: { enabled: false, supported: false } };
	const { stdout, code } = await ps(
		`(Get-ItemProperty -Path '${REG_KEY}' -Name '${REG_VALUE_NAME}' -ErrorAction SilentlyContinue).'${REG_VALUE_NAME}'`,
	);
	if (code !== 0 || !stdout)
		return { ok: true, data: { enabled: false, supported: true } };
	return { ok: true, data: { enabled: true, supported: true, path: stdout } };
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
	return { ok: true };
}

export function shutdown(): LifecycleResult {
	setTimeout(() => process.exit(0), 250);
	return { ok: true };
}
