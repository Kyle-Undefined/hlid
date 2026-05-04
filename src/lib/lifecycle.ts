// Lifecycle operations: autostart, shutdown.
// Single source of truth. UI endpoints in src/routes/api/lifecycle.ts call these.

const REG_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
const REG_VALUE_NAME = "Hlid";

function isWindows(): boolean {
	return process.platform === "win32";
}

export type LifecycleResult =
	| { ok: true; data?: unknown }
	| { ok: false; error: string };

async function reg(
	args: string[],
): Promise<{ stdout: string; stderr: string; code: number }> {
	const proc = Bun.spawn(["reg", ...args], {
		stdout: "pipe",
		stderr: "pipe",
	});
	// Drain pipes concurrently with awaiting exit. Awaiting exit first risks
	// deadlock if the child fills its stdout/stderr buffer before exiting.
	const stdoutP = new Response(proc.stdout).text();
	const stderrP = new Response(proc.stderr).text();
	const [stdout, stderr, code] = await Promise.all([
		stdoutP,
		stderrP,
		proc.exited,
	]);
	return { stdout, stderr, code };
}

export async function getAutostart(): Promise<LifecycleResult> {
	if (!isWindows())
		return { ok: true, data: { enabled: false, supported: false } };
	const { stdout, code } = await reg(["query", REG_KEY, "/v", REG_VALUE_NAME]);
	if (code !== 0)
		return { ok: true, data: { enabled: false, supported: true } };
	const match = stdout.match(/REG_SZ\s+(.+)/);
	const path = match ? match[1].trim() : "";
	return { ok: true, data: { enabled: true, supported: true, path } };
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
	// Quoted path + --background so login launches don't pop a browser.
	const command = `"${exePath}" --background`;
	const { code, stdout, stderr } = await reg([
		"add",
		REG_KEY,
		"/v",
		REG_VALUE_NAME,
		"/t",
		"REG_SZ",
		"/d",
		command,
		"/f",
	]);
	if (code !== 0)
		return {
			ok: false,
			error: `reg add failed: ${`${stdout}\n${stderr}`.trim()}`,
		};
	return { ok: true, data: { command } };
}

export async function uninstallAutostart(): Promise<LifecycleResult> {
	if (!isWindows())
		return { ok: false, error: "Autostart only supported on Windows" };
	const { code, stdout, stderr } = await reg([
		"delete",
		REG_KEY,
		"/v",
		REG_VALUE_NAME,
		"/f",
	]);
	// Exit code 1 also means the value didn't exist, treat as idempotent success.
	// `reg` writes the "cannot find" message to stderr.
	const combined = `${stdout}\n${stderr}`;
	if (code !== 0 && !/cannot find/i.test(combined)) {
		return { ok: false, error: `reg delete failed: ${combined.trim()}` };
	}
	return { ok: true };
}

export function shutdown(): LifecycleResult {
	setTimeout(() => process.exit(0), 250);
	return { ok: true };
}
