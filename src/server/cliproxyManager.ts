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
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import type { HlidConfig } from "#/config";
import { CLIPROXY_DIR } from "#/lib/paths";
import { runBoundedProcess } from "#/lib/process";
import * as db from "../db";
import { openInBrowser } from "./browser";

const RELEASE_URL =
	"https://api.github.com/repos/router-for-me/CLIProxyAPI/releases/latest";
const USER_AGENT = "hlid-cliproxy-integration";
const MAX_ARCHIVE_BYTES = 100 * 1024 * 1024;
const MAX_CHECKSUM_BYTES = 128 * 1024;
const MANAGED_BASE_URL = "http://127.0.0.1:8317";
const RELEASE_CACHE_MS = 10 * 60 * 1000;

type ReleaseAsset = {
	name: string;
	browser_download_url: string;
	size?: number;
};

type Release = {
	tag_name: string;
	assets: ReleaseAsset[];
};

type InstalledState = {
	version: string;
	installDir: string;
	executable: string;
	clientKey: string;
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
	latestVersion?: string;
	updateAvailable?: boolean;
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

function safeVersion(tag: string): string {
	const version = tag.replace(/^v/i, "").trim();
	if (!/^\d+(?:\.\d+){1,3}(?:[-+][A-Za-z0-9.-]+)?$/.test(version)) {
		throw new Error("release returned an invalid version");
	}
	return version;
}

function assetSuffix(arch = process.arch): string {
	return arch === "arm64" ? "windows_arm64.zip" : "windows_amd64.zip";
}

export function selectCliProxyReleaseAssets(
	release: Release,
	arch = process.arch,
): { version: string; archive: ReleaseAsset; checksums: ReleaseAsset } {
	const suffix = assetSuffix(arch);
	const archive = release.assets.find((asset) => asset.name.endsWith(suffix));
	const checksums = release.assets.find(
		(asset) => asset.name.toLowerCase() === "checksums.txt",
	);
	if (!archive || !checksums) {
		throw new Error(`release is missing ${suffix} or checksums.txt`);
	}
	if ((archive.size ?? 0) > MAX_ARCHIVE_BYTES) {
		throw new Error("release archive exceeds the safety limit");
	}
	return { version: safeVersion(release.tag_name), archive, checksums };
}

export function checksumForAsset(text: string, assetName: string): string {
	for (const line of text.split(/\r?\n/)) {
		const match = line.trim().match(/^([a-fA-F0-9]{64})\s+\*?(.+)$/);
		if (match && basename(match[2]) === assetName)
			return match[1].toLowerCase();
	}
	throw new Error(`checksum not found for ${assetName}`);
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

function findExecutable(root: string): string {
	for (const entry of readdirSync(root, { withFileTypes: true })) {
		const candidate = join(root, entry.name);
		if (entry.isDirectory()) {
			const nested = findExecutable(candidate);
			if (nested) return nested;
		} else if (/^(?:cli-proxy-api|cliproxyapi)\.exe$/i.test(entry.name)) {
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
	private releaseCache: { value: Release; at: number } | null = null;
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

	private async release(refresh = false): Promise<Release> {
		if (
			!refresh &&
			this.releaseCache &&
			Date.now() - this.releaseCache.at < RELEASE_CACHE_MS
		) {
			return this.releaseCache.value;
		}
		const response = await fetch(RELEASE_URL, {
			headers: {
				"User-Agent": USER_AGENT,
				Accept: "application/vnd.github+json",
			},
			signal: AbortSignal.timeout(10_000),
		});
		if (!response.ok)
			throw new Error(`release check failed with HTTP ${response.status}`);
		const value = (await response.json()) as Release;
		if (!Array.isArray(value.assets))
			throw new Error("release response is invalid");
		this.releaseCache = { value, at: Date.now() };
		return value;
	}

	async refreshRelease(): Promise<CliProxyStatus> {
		try {
			const selected = selectCliProxyReleaseAssets(await this.release(true));
			const installed = this.installed();
			this.statusValue.latestVersion = selected.version;
			this.statusValue.updateAvailable =
				Boolean(installed) && installed?.version !== selected.version;
			this.statusValue.error = undefined;
		} catch (error) {
			this.statusValue.error =
				error instanceof Error ? error.message : "release check failed";
		}
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
		const selected = selectCliProxyReleaseAssets(await this.release(true));
		const checksums = await boundedDownload(
			selected.checksums.browser_download_url,
			MAX_CHECKSUM_BYTES,
		);
		const expected = checksumForAsset(
			checksums.toString("utf8"),
			selected.archive.name,
		);
		const archive = await boundedDownload(
			selected.archive.browser_download_url,
			MAX_ARCHIVE_BYTES,
			(received, total) => {
				this.statusValue.download = { received, total };
			},
		);
		const actual = createHash("sha256").update(archive).digest("hex");
		if (actual !== expected) throw new Error("download checksum did not match");

		await this.stop();
		mkdirSync(this.root, { recursive: true });
		const stage = join(this.root, `.stage-${randomBytes(8).toString("hex")}`);
		const archivePath = join(stage, selected.archive.name);
		const extractPath = join(stage, "extract");
		mkdirSync(extractPath, { recursive: true });
		writeFileSync(archivePath, archive, { mode: 0o600 });
		try {
			const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;
			const result = await runBoundedProcess(
				"powershell.exe",
				[
					"-NoProfile",
					"-NonInteractive",
					"-Command",
					`Expand-Archive -LiteralPath ${literal(archivePath)} -DestinationPath ${literal(extractPath)} -Force`,
				],
				{ timeoutMs: 60_000, timeoutError: "CLIProxy extraction timed out" },
			);
			if (result.code !== 0)
				throw new Error("PowerShell could not extract CLIProxy");
			const stagedExecutable = findExecutable(extractPath);
			if (!stagedExecutable)
				throw new Error("release archive did not contain cli-proxy-api.exe");
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
				latestVersion: selected.version,
				updateAvailable: false,
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

	private drainLogs(child: ChildProcess, secret: string): void {
		const drain = (level: "info" | "error", chunk: Buffer | string) => {
			const message = chunk.toString().replaceAll(secret, "[redacted]").trim();
			if (message)
				void db.appendLog(level, "cliproxy", message.slice(0, 8_000));
		};
		child.stdout?.on("data", (chunk) => drain("info", chunk));
		child.stderr?.on("data", (chunk) => drain("error", chunk));
	}

	async stop(): Promise<void> {
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
		this.runtime = null;
		this.oauthProcess = null;
	}
}

export const MANAGED_CLIPROXY_BASE_URL = MANAGED_BASE_URL;
