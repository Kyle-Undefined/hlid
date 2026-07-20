import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, win32 } from "node:path";
import type { HlidConfig } from "#/config";
import { CLIPROXY_DIR, parseWslUncSyntax } from "#/lib/paths";
import { runBoundedProcess } from "#/lib/process";
import * as db from "../db";
import { openInBrowser } from "./browser";

const USER_AGENT = "hlid-cliproxy-integration";
const MAX_ARCHIVE_BYTES = 100 * 1024 * 1024;
const MANAGED_BASE_URL = "http://127.0.0.1:8317";

export const CLIPROXY_APPROVED_VERSION = "7.2.88";

type ApprovedRelease = {
	version: string;
	archiveName: string;
	downloadUrl: string;
	sha256: string;
};

type ApprovedTarget = "windows" | "linux";

// Managed CLIProxy releases advance only through reviewed Hlid changes. Keep the
// archive digest here rather than trusting a checksum fetched beside the binary.
const APPROVED_RELEASES: Record<
	ApprovedTarget,
	Record<"x64" | "arm64", ApprovedRelease>
> = {
	windows: {
		x64: {
			version: CLIPROXY_APPROVED_VERSION,
			archiveName: "CLIProxyAPI_7.2.88_windows_amd64.zip",
			downloadUrl:
				"https://github.com/router-for-me/CLIProxyAPI/releases/download/v7.2.88/CLIProxyAPI_7.2.88_windows_amd64.zip",
			sha256:
				"426340530acc2c24f77b3072c03252d344a426025ffdc3f39662a0d4a8f105ac",
		},
		arm64: {
			version: CLIPROXY_APPROVED_VERSION,
			archiveName: "CLIProxyAPI_7.2.88_windows_aarch64.zip",
			downloadUrl:
				"https://github.com/router-for-me/CLIProxyAPI/releases/download/v7.2.88/CLIProxyAPI_7.2.88_windows_aarch64.zip",
			sha256:
				"50c7826d2ce3ef6246064bf83d4ee43308c180bee215f3c3e80fce062c357dc7",
		},
	},
	linux: {
		x64: {
			version: CLIPROXY_APPROVED_VERSION,
			archiveName: "CLIProxyAPI_7.2.88_linux_amd64.tar.gz",
			downloadUrl:
				"https://github.com/router-for-me/CLIProxyAPI/releases/download/v7.2.88/CLIProxyAPI_7.2.88_linux_amd64.tar.gz",
			sha256:
				"2cc3b38e3ba2474d0cdeb7a3f25b026891ba34e34d3a7e0501d4efd03c01f6fe",
		},
		arm64: {
			version: CLIPROXY_APPROVED_VERSION,
			archiveName: "CLIProxyAPI_7.2.88_linux_aarch64.tar.gz",
			downloadUrl:
				"https://github.com/router-for-me/CLIProxyAPI/releases/download/v7.2.88/CLIProxyAPI_7.2.88_linux_aarch64.tar.gz",
			sha256:
				"d8bec71bdc8bfa21bc1340b0794430297764c9f0739c00c4ad19cb78a1b0ff6c",
		},
	},
};

type InstalledState = {
	version: string;
	installDir: string;
	executable: string;
	linuxExecutable?: string;
	clientKey: string;
};

type WslRuntime = {
	child: ChildProcess;
	distro: string;
	pidFile: string;
};

export type CliProxyInstallState =
	| "unsupported"
	| "not_installed"
	| "installed"
	| "starting"
	| "running"
	| "downloading"
	| "error";

export const CLIPROXY_OAUTH_PROVIDERS = [
	{ id: "codex", label: "OpenAI Codex", flag: "--codex-device-login" },
	{ id: "claude", label: "Anthropic Claude", flag: "--claude-login" },
	{
		id: "antigravity",
		label: "Google Antigravity",
		flag: "--antigravity-login",
	},
	{ id: "kimi", label: "Moonshot Kimi", flag: "--kimi-login" },
	{ id: "xai", label: "xAI", flag: "--xai-login" },
] as const;

export type CliProxyOAuthProviderId =
	(typeof CLIPROXY_OAUTH_PROVIDERS)[number]["id"];
export type CliProxyOAuthState = "idle" | "running" | "connected" | "error";

export type CliProxyStatus = {
	state: CliProxyInstallState;
	managed: boolean;
	installedVersion?: string;
	approvedVersion?: string;
	versionMismatch?: boolean;
	wslInstalled?: boolean;
	authenticated: boolean;
	oauth: CliProxyOAuthState;
	accounts: Record<CliProxyOAuthProviderId, CliProxyOAuthState>;
	activeOAuth?: CliProxyOAuthProviderId;
	oauthUrl?: string;
	oauthCode?: string;
	oauthBrowserOpened?: boolean;
	error?: string;
	download?: { received: number; total: number | null };
};

function emptyAccounts(): Record<CliProxyOAuthProviderId, CliProxyOAuthState> {
	return {
		codex: "idle",
		claude: "idle",
		antigravity: "idle",
		kimi: "idle",
		xai: "idle",
	};
}

export function extractCliProxyOAuthPrompt(output: string): {
	url?: string;
	code?: string;
} {
	const url = output
		.match(/https?:\/\/[^\s<>"']+/i)?.[0]
		?.replace(/[),.;]+$/, "");
	const code = output.match(
		/(?:codex device code:|user code:|then enter this code:)\s*([A-Z0-9-]{4,})/i,
	)?.[1];
	return { url, code };
}

export function cliProxyLaunchError(
	error: unknown,
	executableExists: boolean,
	platform = process.platform,
): Error {
	if (platform === "win32" && !executableExists) {
		return new Error(
			"CLIProxy executable is missing after extraction. Windows Security may have quarantined it. Review Windows Security > Protection history before retrying.",
		);
	}
	const detail = error instanceof Error ? error.message : String(error);
	return new Error(`CLIProxy could not start: ${detail}`);
}

function oauthFailureDetail(output: string): string | undefined {
	const lines = output
		.replace(/https?:\/\/[^\s<>"']+/gi, "[authorization URL]")
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => /error|fail|timed? out|port.+use/i.test(line));
	const detail = lines.at(-1)?.replace(/[A-Za-z0-9_-]{48,}/g, "[redacted]");
	return detail?.slice(0, 500);
}

export async function terminateCliProxyChild(
	child: ChildProcess | null,
	timeoutMs = 5_000,
): Promise<void> {
	if (!child || child.exitCode !== null) return;
	await new Promise<void>((resolve) => {
		let settled = false;
		const finish = () => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			child.off("exit", finish);
			child.off("error", finish);
			resolve();
		};
		const timeout = setTimeout(finish, timeoutMs);
		child.once("exit", finish);
		child.once("error", finish);
		try {
			child.kill();
		} catch {
			finish();
		}
	});
}

export function approvedCliProxyRelease(
	arch = process.arch,
	target: ApprovedTarget = "windows",
): ApprovedRelease {
	if (arch !== "x64" && arch !== "arm64") {
		throw new Error(`managed CLIProxy does not support ${arch}`);
	}
	return APPROVED_RELEASES[target][arch];
}

export function windowsPathToWsl(value: string): string {
	const match = value.match(/^([A-Za-z]):[\\/](.*)$/);
	if (!match) throw new Error("CLIProxy WSL path is not on a Windows drive");
	return `/mnt/${match[1].toLowerCase()}/${match[2].replaceAll("\\", "/")}`;
}

export function windowsSystemExecutable(
	name: string,
	systemRoot = process.env.SystemRoot,
): string {
	return win32.join(systemRoot?.trim() || "C:\\Windows", "System32", name);
}

const WSL_DISTRO_RE = /^[A-Za-z0-9._-]+$/;
const WSL_LAUNCH_SCRIPT = 'printf "%s" "$$" > "$1"; exec "$2" --config "$3"';

export function wslCliProxyLaunchArgs(
	distro: string,
	pidFile: string,
	executable: string,
	configPath: string,
): string[] {
	if (!WSL_DISTRO_RE.test(distro)) {
		throw new Error(`invalid WSL distro name: ${JSON.stringify(distro)}`);
	}
	return [
		"-d",
		distro,
		"--exec",
		"sh",
		"-c",
		WSL_LAUNCH_SCRIPT,
		"hlid-cliproxy",
		pidFile,
		executable,
		configPath,
	];
}

function yamlString(value: string): string {
	return JSON.stringify(value);
}

export function managedCliProxyConfig(
	authDir: string,
	clientKey: string,
): string {
	return [
		`host: ${yamlString("127.0.0.1")}`,
		"port: 8317",
		`auth-dir: ${yamlString(authDir)}`,
		"api-keys:",
		`  - ${yamlString(clientKey)}`,
		"remote-management:",
		"  allow-remote: false",
		`  secret-key: ${yamlString("")}`,
		"  disable-control-panel: true",
		"usage-statistics-enabled: false",
		"logging-to-file: false",
		"",
	].join("\n");
}

async function boundedDownload(
	url: string,
	limit: number,
	onProgress?: (received: number, total: number | null) => void,
): Promise<Buffer> {
	const response = await fetch(url, {
		headers: { "User-Agent": USER_AGENT, Accept: "application/octet-stream" },
		signal: AbortSignal.timeout(120_000),
	});
	if (!response.ok || !response.body) {
		throw new Error(`download failed with HTTP ${response.status}`);
	}
	const declared = Number(response.headers.get("content-length")) || null;
	if (declared && declared > limit)
		throw new Error("download exceeds safety limit");
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let received = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		received += value.byteLength;
		if (received > limit) {
			await reader.cancel();
			throw new Error("download exceeds safety limit");
		}
		chunks.push(value);
		onProgress?.(received, declared);
	}
	return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
}

function findExecutable(root: string, target: ApprovedTarget): string {
	for (const entry of readdirSync(root, { withFileTypes: true })) {
		const candidate = join(root, entry.name);
		if (entry.isDirectory()) {
			const nested = findExecutable(candidate, target);
			if (nested) return nested;
		} else if (
			target === "windows"
				? /^(?:cli-proxy-api|cliproxyapi)\.exe$/i.test(entry.name)
				: /^(?:cli-proxy-api|cliproxyapi)$/i.test(entry.name)
		) {
			return candidate;
		}
	}
	return "";
}

function parseState(path: string): InstalledState | null {
	try {
		const value = JSON.parse(readFileSync(path, "utf8")) as InstalledState;
		if (
			typeof value.version !== "string" ||
			typeof value.installDir !== "string" ||
			typeof value.executable !== "string" ||
			typeof value.clientKey !== "string" ||
			!existsSync(value.executable)
		) {
			return null;
		}
		const rel = relative(dirname(path), value.executable);
		if (rel.startsWith("..") || isAbsolute(rel) || rel === "") return null;
		const installRel = relative(dirname(path), value.installDir);
		if (
			installRel.startsWith("..") ||
			isAbsolute(installRel) ||
			installRel === ""
		)
			return null;
		const executableRel = relative(value.installDir, value.executable);
		if (
			executableRel.startsWith("..") ||
			isAbsolute(executableRel) ||
			executableRel === ""
		)
			return null;
		if (value.linuxExecutable !== undefined) {
			if (
				typeof value.linuxExecutable !== "string" ||
				!existsSync(value.linuxExecutable)
			) {
				return null;
			}
			const linuxRel = relative(value.installDir, value.linuxExecutable);
			if (
				linuxRel.startsWith("..") ||
				isAbsolute(linuxRel) ||
				linuxRel === ""
			) {
				return null;
			}
		}
		return value;
	} catch {
		return null;
	}
}

export class CliProxyManager {
	private config: HlidConfig["cliproxy"];
	private runtime: ChildProcess | null = null;
	private oauthProcess: ChildProcess | null = null;
	private oauthLaunchTimer: ReturnType<typeof setTimeout> | null = null;
	private readonly wslRuntimes = new Map<string, WslRuntime>();
	private statusValue: CliProxyStatus;
	private operation: Promise<void> | null = null;

	constructor(
		config: HlidConfig["cliproxy"],
		private readonly root = CLIPROXY_DIR,
		private readonly platform = process.platform,
		private readonly browserOpen: (url: string) => boolean = openInBrowser,
	) {
		this.config = config;
		const installed = this.installed();
		this.statusValue = {
			state:
				platform !== "win32"
					? "unsupported"
					: installed
						? "installed"
						: "not_installed",
			managed: config.mode === "managed",
			installedVersion: installed?.version,
			approvedVersion: CLIPROXY_APPROVED_VERSION,
			versionMismatch:
				Boolean(installed) && installed?.version !== CLIPROXY_APPROVED_VERSION,
			wslInstalled: Boolean(installed?.linuxExecutable),
			authenticated: false,
			oauth: "idle",
			accounts: emptyAccounts(),
		};
	}

	private get statePath(): string {
		return join(this.root, "managed.json");
	}

	private get authDir(): string {
		return join(this.root, "auth");
	}

	private get configPath(): string {
		return join(this.root, "config.yaml");
	}

	private installed(): InstalledState | null {
		return parseState(this.statePath);
	}

	private connectedAccounts(): Set<CliProxyOAuthProviderId> {
		const found = new Set<CliProxyOAuthProviderId>();
		if (!existsSync(this.authDir)) return found;
		for (const entry of readdirSync(this.authDir, { withFileTypes: true })) {
			if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
			try {
				const value = JSON.parse(
					readFileSync(join(this.authDir, entry.name), "utf8"),
				) as Record<string, unknown>;
				for (const item of [value.type, value.provider]) {
					if (typeof item !== "string") continue;
					const normalized = item.toLowerCase();
					if (
						CLIPROXY_OAUTH_PROVIDERS.some(
							(provider) => provider.id === normalized,
						)
					) {
						found.add(normalized as CliProxyOAuthProviderId);
					}
				}
			} catch {}
		}
		return found;
	}

	private refreshAccounts(): void {
		const connected = this.connectedAccounts();
		const accounts = emptyAccounts();
		for (const provider of connected) accounts[provider] = "connected";
		this.statusValue.accounts = accounts;
		this.statusValue.authenticated = connected.has("codex");
		this.statusValue.oauth = connected.has("codex") ? "connected" : "idle";
	}

	status(): CliProxyStatus {
		return {
			...this.statusValue,
			accounts: { ...this.statusValue.accounts },
		};
	}

	connection(): { base_url: string; api_key: string } | null {
		if (this.config.mode === "external") {
			return this.config.enabled
				? { base_url: this.config.base_url, api_key: this.config.api_key }
				: null;
		}
		const installed = this.installed();
		return this.config.enabled && installed
			? { base_url: MANAGED_BASE_URL, api_key: installed.clientKey }
			: null;
	}

	async initialize(): Promise<void> {
		this.refreshAccounts();
		if (
			this.config.mode === "managed" &&
			this.config.enabled &&
			this.installed()
		) {
			await this.start();
		}
	}

	async syncConfig(config: HlidConfig["cliproxy"]): Promise<void> {
		this.config = config;
		this.statusValue.managed = config.mode === "managed";
		if (config.mode !== "managed" || !config.enabled) await this.stop();
		else if (this.installed()) await this.start();
	}

	async syncWslAgents(agentPaths: string[]): Promise<void> {
		const wanted = new Set(
			agentPaths
				.map((path) => parseWslUncSyntax(path)?.distro)
				.filter((distro): distro is string => Boolean(distro)),
		);
		const installed = this.installed();
		if (
			this.config.mode !== "managed" ||
			!this.config.enabled ||
			!installed?.linuxExecutable
		) {
			await this.stopWslRuntimes();
			return;
		}
		for (const [distro, runtime] of this.wslRuntimes) {
			if (wanted.has(distro)) continue;
			await this.stopWslRuntime(runtime);
			this.wslRuntimes.delete(distro);
		}
		for (const distro of wanted) {
			const current = this.wslRuntimes.get(distro);
			if (current?.child.exitCode === null) continue;
			await this.startWslRuntime(distro, installed);
		}
	}

	private async startWslRuntime(
		distro: string,
		installed: InstalledState,
	): Promise<void> {
		if (!installed.linuxExecutable) return;
		const suffix = createHash("sha256")
			.update(distro)
			.digest("hex")
			.slice(0, 12);
		const configPath = join(this.root, `config-wsl-${suffix}.yaml`);
		const pidFile = join(this.root, `wsl-${suffix}.pid`);
		writeFileSync(
			configPath,
			managedCliProxyConfig(
				windowsPathToWsl(this.authDir),
				installed.clientKey,
			),
			{ mode: 0o600 },
		);
		rmSync(pidFile, { force: true });
		const args = wslCliProxyLaunchArgs(
			distro,
			windowsPathToWsl(pidFile),
			windowsPathToWsl(installed.linuxExecutable),
			windowsPathToWsl(configPath),
		);
		const child = spawn("wsl.exe", args, {
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
		});
		const runtime = { child, distro, pidFile };
		this.wslRuntimes.set(distro, runtime);
		this.drainLogs(child, installed.clientKey, `cliproxy-wsl:${distro}`);
		child.once("exit", () => {
			if (this.wslRuntimes.get(distro)?.child === child) {
				this.wslRuntimes.delete(distro);
			}
		});
		child.once("error", (error) => {
			void db.appendLog(
				"error",
				`cliproxy-wsl:${distro}`,
				`WSL CLIProxy failed to start: ${error.message}`,
			);
		});
		const deadline = Date.now() + 15_000;
		while (Date.now() < deadline && child.exitCode === null) {
			const probe = await runBoundedProcess(
				"wsl.exe",
				[
					"-d",
					distro,
					"--exec",
					"bash",
					"-c",
					"exec 3<>/dev/tcp/127.0.0.1/8317",
				],
				{ timeoutMs: 2_000, timeoutError: "WSL CLIProxy probe timed out" },
			).catch(() => null);
			if (probe?.code === 0) return;
			await Bun.sleep(200);
		}
		await this.stopWslRuntime(runtime);
		this.wslRuntimes.delete(distro);
		throw new Error(`CLIProxy did not become ready in WSL distro ${distro}`);
	}

	private async stopWslRuntime(runtime: WslRuntime): Promise<void> {
		if (existsSync(runtime.pidFile)) {
			const pid = readFileSync(runtime.pidFile, "utf8").trim();
			if (/^\d+$/.test(pid)) {
				await runBoundedProcess(
					"wsl.exe",
					["-d", runtime.distro, "--exec", "kill", pid],
					{ timeoutMs: 3_000, timeoutError: "WSL CLIProxy stop timed out" },
				).catch(() => null);
			}
		}
		await terminateCliProxyChild(runtime.child);
		rmSync(runtime.pidFile, { force: true });
	}

	private async stopWslRuntimes(): Promise<void> {
		const runtimes = [...this.wslRuntimes.values()];
		this.wslRuntimes.clear();
		await Promise.all(runtimes.map((runtime) => this.stopWslRuntime(runtime)));
	}

	async refreshRelease(): Promise<CliProxyStatus> {
		const installed = this.installed();
		this.statusValue.approvedVersion = CLIPROXY_APPROVED_VERSION;
		this.statusValue.versionMismatch =
			Boolean(installed) && installed?.version !== CLIPROXY_APPROVED_VERSION;
		this.statusValue.wslInstalled = Boolean(installed?.linuxExecutable);
		this.statusValue.error = undefined;
		return this.status();
	}

	startInstall(): { status: CliProxyStatus; completion: Promise<void> } {
		if (this.platform !== "win32")
			throw new Error("managed CLIProxy requires Windows");
		if (this.operation) throw new Error("another CLIProxy operation is active");
		this.operation = this.installInner()
			.catch((error) => {
				this.statusValue = {
					...this.statusValue,
					state:
						this.runtime && this.runtime.exitCode === null
							? "running"
							: "error",
					download: undefined,
					error:
						error instanceof Error ? error.message : "CLIProxy install failed",
				};
				throw error;
			})
			.finally(() => {
				this.operation = null;
			});
		return { status: this.status(), completion: this.operation };
	}

	private async installInner(): Promise<void> {
		const prior = this.installed();
		const priorWasRunning = Boolean(
			this.runtime && this.runtime.exitCode === null,
		);
		this.statusValue = {
			...this.statusValue,
			state: "downloading",
			error: undefined,
			download: { received: 0, total: null },
		};
		const selected = approvedCliProxyRelease();
		const linuxSelected = approvedCliProxyRelease(process.arch, "linux");
		const archive = await boundedDownload(
			selected.downloadUrl,
			MAX_ARCHIVE_BYTES,
			(received, total) => {
				this.statusValue.download = { received, total };
			},
		);
		const actual = createHash("sha256").update(archive).digest("hex");
		if (actual !== selected.sha256)
			throw new Error("download checksum did not match the approved release");
		const linuxArchive = await boundedDownload(
			linuxSelected.downloadUrl,
			MAX_ARCHIVE_BYTES,
			(received, total) => {
				this.statusValue.download = { received, total };
			},
		);
		const linuxActual = createHash("sha256").update(linuxArchive).digest("hex");
		if (linuxActual !== linuxSelected.sha256) {
			throw new Error(
				"WSL download checksum did not match the approved release",
			);
		}

		await this.stop();
		mkdirSync(this.root, { recursive: true });
		const stage = join(this.root, `.stage-${randomBytes(8).toString("hex")}`);
		const archivePath = join(stage, selected.archiveName);
		const linuxArchivePath = join(stage, linuxSelected.archiveName);
		const extractPath = join(stage, "extract");
		const windowsExtractPath = join(extractPath, "windows");
		const linuxExtractPath = join(extractPath, "linux");
		mkdirSync(windowsExtractPath, { recursive: true });
		mkdirSync(linuxExtractPath, { recursive: true });
		writeFileSync(archivePath, archive, { mode: 0o600 });
		writeFileSync(linuxArchivePath, linuxArchive, { mode: 0o600 });
		try {
			const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;
			const result = await runBoundedProcess(
				"powershell.exe",
				[
					"-NoProfile",
					"-NonInteractive",
					"-Command",
					`Expand-Archive -LiteralPath ${literal(archivePath)} -DestinationPath ${literal(windowsExtractPath)} -Force`,
				],
				{ timeoutMs: 60_000, timeoutError: "CLIProxy extraction timed out" },
			);
			if (result.code !== 0)
				throw new Error("PowerShell could not extract CLIProxy");
			const linuxResult = await runBoundedProcess(
				windowsSystemExecutable("tar.exe"),
				["-xzf", linuxArchivePath, "-C", linuxExtractPath],
				{
					timeoutMs: 60_000,
					timeoutError: "CLIProxy WSL extraction timed out",
				},
			);
			if (linuxResult.code !== 0) {
				const detail = linuxResult.output.trim().slice(0, 500);
				throw new Error(
					`Windows tar could not extract CLIProxy for WSL${detail ? `: ${detail}` : ""}`,
				);
			}
			const stagedExecutable = findExecutable(windowsExtractPath, "windows");
			if (!stagedExecutable)
				throw new Error("release archive did not contain cli-proxy-api.exe");
			const stagedLinuxExecutable = findExecutable(linuxExtractPath, "linux");
			if (!stagedLinuxExecutable)
				throw new Error("WSL release archive did not contain cli-proxy-api");
			const versionDir = join(
				this.root,
				"versions",
				`${selected.version}-${randomBytes(6).toString("hex")}`,
			);
			mkdirSync(dirname(versionDir), { recursive: true });
			renameSync(extractPath, versionDir);
			const executable = join(
				versionDir,
				relative(extractPath, stagedExecutable),
			);
			const linuxExecutable = join(
				versionDir,
				relative(extractPath, stagedLinuxExecutable),
			);
			const clientKey =
				prior?.clientKey ?? randomBytes(32).toString("base64url");
			mkdirSync(this.authDir, { recursive: true, mode: 0o700 });
			writeFileSync(
				this.configPath,
				managedCliProxyConfig(this.authDir, clientKey),
				{ mode: 0o600 },
			);
			writeFileSync(
				this.statePath,
				JSON.stringify(
					{
						version: selected.version,
						installDir: versionDir,
						executable,
						linuxExecutable,
						clientKey,
					},
					null,
					2,
				),
				{ mode: 0o600 },
			);
			chmodSync(this.statePath, 0o600);
			this.statusValue = {
				...this.statusValue,
				state: "installed",
				installedVersion: selected.version,
				approvedVersion: selected.version,
				versionMismatch: false,
				wslInstalled: true,
				download: undefined,
			};
		} finally {
			rmSync(stage, { recursive: true, force: true });
		}
		try {
			await this.start(true);
		} catch (error) {
			const failed = this.installed();
			if (prior) {
				writeFileSync(this.statePath, JSON.stringify(prior, null, 2), {
					mode: 0o600,
				});
				writeFileSync(
					this.configPath,
					managedCliProxyConfig(this.authDir, prior.clientKey),
					{ mode: 0o600 },
				);
				this.statusValue.installedVersion = prior.version;
				this.statusValue.wslInstalled = Boolean(prior.linuxExecutable);
				if (
					priorWasRunning ||
					(this.config.mode === "managed" && this.config.enabled)
				) {
					await this.start(true).catch(() => {});
				}
			} else {
				rmSync(this.statePath, { force: true });
				rmSync(this.configPath, { force: true });
				this.statusValue.installedVersion = undefined;
				this.statusValue.wslInstalled = false;
			}
			if (failed && failed.executable !== prior?.executable) {
				rmSync(failed.installDir, { recursive: true, force: true });
			}
			throw error;
		}
		const current = this.installed();
		const versionsDir = join(this.root, "versions");
		if (current && existsSync(versionsDir)) {
			for (const entry of readdirSync(versionsDir, { withFileTypes: true })) {
				if (!entry.isDirectory()) continue;
				const candidate = join(versionsDir, entry.name);
				if (candidate !== current.installDir) {
					rmSync(candidate, { recursive: true, force: true });
				}
			}
		}
	}

	async start(force = false): Promise<void> {
		if (this.runtime && this.runtime.exitCode === null) return;
		if (!force && (this.config.mode !== "managed" || !this.config.enabled))
			return;
		const installed = this.installed();
		if (!installed) throw new Error("CLIProxy is not installed");
		if (!existsSync(installed.executable)) {
			throw cliProxyLaunchError(
				new Error("installed executable was not found"),
				false,
				this.platform,
			);
		}
		mkdirSync(this.authDir, { recursive: true, mode: 0o700 });
		writeFileSync(
			this.configPath,
			managedCliProxyConfig(this.authDir, installed.clientKey),
			{ mode: 0o600 },
		);
		this.statusValue.state = "starting";
		this.statusValue.error = undefined;
		let child: ChildProcess;
		try {
			child = spawn(installed.executable, ["--config", this.configPath], {
				cwd: dirname(installed.executable),
				stdio: ["ignore", "pipe", "pipe"],
				windowsHide: true,
			});
		} catch (error) {
			throw cliProxyLaunchError(
				error,
				existsSync(installed.executable),
				this.platform,
			);
		}
		this.runtime = child;
		this.drainLogs(child, installed.clientKey);
		let launchError: Error | undefined;
		child.once("error", (error) => {
			if (this.runtime !== child) return;
			launchError = cliProxyLaunchError(
				error,
				existsSync(installed.executable),
				this.platform,
			);
			this.statusValue = {
				...this.statusValue,
				state: "error",
				error: launchError.message,
			};
		});
		child.once("exit", (code) => {
			if (this.runtime !== child) return;
			this.runtime = null;
			if (this.statusValue.state !== "installed") {
				this.statusValue = {
					...this.statusValue,
					state: "error",
					error: `CLIProxy exited with code ${code ?? "unknown"}`,
				};
			}
		});
		const deadline = Date.now() + 15_000;
		while (Date.now() < deadline) {
			if (launchError) break;
			if (child.exitCode !== null) break;
			try {
				const response = await fetch(`${MANAGED_BASE_URL}/v1/models`, {
					headers: { Authorization: `Bearer ${installed.clientKey}` },
					signal: AbortSignal.timeout(500),
				});
				if (response.ok) {
					this.statusValue.state = "running";
					return;
				}
			} catch {}
			await Bun.sleep(200);
		}
		await this.stop();
		const error =
			launchError ??
			new Error("CLIProxy did not become ready within 15 seconds");
		this.statusValue = {
			...this.statusValue,
			state: "error",
			error: error.message,
		};
		throw error;
	}

	private drainLogs(
		child: ChildProcess,
		secret: string,
		source = "cliproxy",
	): void {
		const drain = (level: "info" | "error", chunk: Buffer | string) => {
			const message = chunk.toString().replaceAll(secret, "[redacted]").trim();
			if (message) void db.appendLog(level, source, message.slice(0, 8_000));
		};
		child.stdout?.on("data", (chunk) => drain("info", chunk));
		child.stderr?.on("data", (chunk) => drain("error", chunk));
	}

	async stop(): Promise<void> {
		await this.stopWslRuntimes();
		const child = this.runtime;
		this.runtime = null;
		await terminateCliProxyChild(child);
		const installed = this.installed();
		this.statusValue = {
			...this.statusValue,
			state: installed
				? "installed"
				: this.platform === "win32"
					? "not_installed"
					: "unsupported",
			installedVersion: installed?.version,
			wslInstalled: Boolean(installed?.linuxExecutable),
		};
	}

	beginOAuth(providerId: CliProxyOAuthProviderId = "codex"): CliProxyStatus {
		if (
			this.oauthLaunchTimer ||
			(this.oauthProcess && this.oauthProcess.exitCode === null) ||
			this.statusValue.activeOAuth
		) {
			throw new Error("another CLIProxy sign-in is already running");
		}
		const provider = CLIPROXY_OAUTH_PROVIDERS.find(
			(candidate) => candidate.id === providerId,
		);
		if (!provider) throw new Error("unsupported CLIProxy OAuth provider");
		const installed = this.installed();
		if (!installed)
			throw new Error("install CLIProxy before connecting an account");
		this.statusValue.accounts[providerId] = "running";
		this.statusValue.activeOAuth = providerId;
		if (providerId === "codex") this.statusValue.oauth = "running";
		this.statusValue.error = undefined;
		this.statusValue.oauthUrl = undefined;
		this.statusValue.oauthCode = undefined;
		this.statusValue.oauthBrowserOpened = undefined;
		// A freshly downloaded Windows executable can block briefly in CreateProcess
		// while security scanning runs. Launch after the initiating response has had
		// time to flush so Forge never hangs on the OAuth subprocess lifecycle.
		this.oauthLaunchTimer = setTimeout(() => {
			this.oauthLaunchTimer = null;
			this.launchOAuth(installed, provider);
		}, 250);
		return this.status();
	}

	private launchOAuth(
		installed: InstalledState,
		provider: (typeof CLIPROXY_OAUTH_PROVIDERS)[number],
	): void {
		const providerId = provider.id;
		let output = "";
		let child: ChildProcess;
		try {
			child = spawn(
				installed.executable,
				["--config", this.configPath, provider.flag, "--no-browser"],
				{
					cwd: dirname(installed.executable),
					// The authorization URL is held in memory only long enough to open it
					// and offer an authenticated fallback link in Forge.
					stdio: ["ignore", "pipe", "pipe"],
					windowsHide: true,
				},
			);
		} catch (error) {
			this.finishOAuthWithError(
				providerId,
				cliProxyLaunchError(
					error,
					existsSync(installed.executable),
					this.platform,
				).message,
			);
			return;
		}
		this.oauthProcess = child;
		const capture = (chunk: Buffer | string) => {
			output = `${output}${chunk.toString()}`.slice(-32_000);
			const prompt = extractCliProxyOAuthPrompt(output);
			if (prompt.code) this.statusValue.oauthCode = prompt.code;
			if (prompt.url && !this.statusValue.oauthUrl) {
				this.statusValue.oauthUrl = prompt.url;
				this.statusValue.oauthBrowserOpened = this.browserOpen(prompt.url);
			}
		};
		child.stdout?.on("data", capture);
		child.stderr?.on("data", capture);
		child.once("exit", (code) => {
			if (this.oauthProcess !== child) return;
			this.oauthProcess = null;
			this.refreshAccounts();
			const authenticated =
				code === 0 && this.statusValue.accounts[providerId] === "connected";
			if (!authenticated) {
				this.statusValue.accounts[providerId] = "error";
				if (providerId === "codex") this.statusValue.oauth = "error";
				const detail = oauthFailureDetail(output);
				const suffix = detail
					? `: ${detail}`
					: code === null
						? ""
						: ` (exit ${code})`;
				this.statusValue.error = `${provider.label} sign-in did not complete${suffix}`;
			}
			this.statusValue.activeOAuth = undefined;
			this.statusValue.oauthUrl = undefined;
			this.statusValue.oauthCode = undefined;
			this.statusValue.oauthBrowserOpened = undefined;
		});
		child.once("error", (error) => {
			if (this.oauthProcess !== child) return;
			this.oauthProcess = null;
			this.finishOAuthWithError(
				providerId,
				cliProxyLaunchError(
					error,
					existsSync(installed.executable),
					this.platform,
				).message,
			);
		});
	}

	private finishOAuthWithError(
		providerId: CliProxyOAuthProviderId,
		message: string,
	): void {
		this.statusValue.accounts[providerId] = "error";
		if (providerId === "codex") this.statusValue.oauth = "error";
		this.statusValue.activeOAuth = undefined;
		this.statusValue.oauthUrl = undefined;
		this.statusValue.oauthCode = undefined;
		this.statusValue.oauthBrowserOpened = undefined;
		this.statusValue.error = message;
	}

	async remove(): Promise<void> {
		if (this.oauthLaunchTimer) clearTimeout(this.oauthLaunchTimer);
		this.oauthLaunchTimer = null;
		await this.stop();
		const oauthProcess = this.oauthProcess;
		this.oauthProcess = null;
		await terminateCliProxyChild(oauthProcess);
		rmSync(this.root, {
			recursive: true,
			force: true,
			maxRetries: 10,
			retryDelay: 100,
		});
		this.statusValue = {
			state: this.platform === "win32" ? "not_installed" : "unsupported",
			managed: true,
			approvedVersion: CLIPROXY_APPROVED_VERSION,
			versionMismatch: false,
			wslInstalled: false,
			authenticated: false,
			oauth: "idle",
			accounts: emptyAccounts(),
		};
	}

	close(): void {
		if (this.oauthLaunchTimer) clearTimeout(this.oauthLaunchTimer);
		this.oauthLaunchTimer = null;
		if (this.runtime && this.runtime.exitCode === null) this.runtime.kill();
		if (this.oauthProcess && this.oauthProcess.exitCode === null)
			this.oauthProcess.kill();
		for (const runtime of this.wslRuntimes.values()) {
			if (runtime.child.exitCode === null) runtime.child.kill();
		}
		this.wslRuntimes.clear();
		this.runtime = null;
		this.oauthProcess = null;
	}
}

export const MANAGED_CLIPROXY_BASE_URL = MANAGED_BASE_URL;
