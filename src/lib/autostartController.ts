const REG_KEY = "HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
const REG_VALUE_NAME = "Hlid";

export type CommandResult = { stdout: string; stderr: string; code: number };
type AutostartResult =
	| { ok: true; data?: unknown }
	| { ok: false; error: string };

export function createAutostartController(deps: {
	isWindows: () => boolean;
	execPath: () => string;
	runPowerShell: (command: string) => Promise<CommandResult>;
}) {
	let cache: AutostartResult | null = null;

	return {
		async get(): Promise<AutostartResult> {
			if (!deps.isWindows()) {
				return { ok: true, data: { enabled: false, supported: false } };
			}
			if (cache) return cache;
			const { stdout, code } = await deps.runPowerShell(
				`(Get-ItemProperty -Path '${REG_KEY}' -Name '${REG_VALUE_NAME}' -ErrorAction SilentlyContinue).'${REG_VALUE_NAME}'`,
			);
			cache =
				code !== 0 || !stdout
					? { ok: true, data: { enabled: false, supported: true } }
					: {
							ok: true,
							data: { enabled: true, supported: true, path: stdout },
						};
			return cache;
		},

		async install(): Promise<AutostartResult> {
			if (!deps.isWindows()) {
				return { ok: false, error: "Autostart only supported on Windows" };
			}
			const exePath = deps.execPath();
			if (!exePath.toLowerCase().endsWith(".exe")) {
				return {
					ok: false,
					error: "Cannot install autostart in dev mode (not running from .exe)",
				};
			}
			const command = `"${exePath}" --background`;
			const escaped = command.replaceAll("'", "''");
			const { code, stdout, stderr } = await deps.runPowerShell(
				`Set-ItemProperty -Path '${REG_KEY}' -Name '${REG_VALUE_NAME}' -Value '${escaped}' -Type String`,
			);
			if (code !== 0) {
				return {
					ok: false,
					error: `registry write failed: ${`${stdout}\n${stderr}`.trim()}`,
				};
			}
			cache = null;
			return { ok: true, data: { command } };
		},

		async uninstall(): Promise<AutostartResult> {
			if (!deps.isWindows()) {
				return { ok: false, error: "Autostart only supported on Windows" };
			}
			const { code, stdout, stderr } = await deps.runPowerShell(
				`Remove-ItemProperty -Path '${REG_KEY}' -Name '${REG_VALUE_NAME}' -ErrorAction SilentlyContinue`,
			);
			if (code !== 0) {
				return {
					ok: false,
					error: `registry delete failed: ${`${stdout}\n${stderr}`.trim()}`,
				};
			}
			cache = null;
			return { ok: true };
		},
	};
}
