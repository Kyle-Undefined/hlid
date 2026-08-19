import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import {
	mkdir,
	open,
	readdir,
	realpath,
	rename,
	rm,
	stat,
} from "node:fs/promises";
import { isAbsolute, join, relative, resolve, win32 } from "node:path";
import { canonicalInstallDir } from "#/lib/install";
import { samePath } from "#/lib/paths";
import { runBoundedProcess } from "#/lib/process";

export const OLLAMA_WINDOWS_RELEASE_API =
	"https://api.github.com/repos/ollama/ollama/releases/latest";
export const OLLAMA_WINDOWS_INSTALLER_NAME = "OllamaSetup.exe";
export const OLLAMA_WINDOWS_SETUP_MAX_BYTES = 3 * 1024 * 1024 * 1024;

const RELEASE_RESPONSE_MAX_BYTES = 1024 * 1024;
const RELEASE_TIMEOUT_MS = 15_000;
const DOWNLOAD_TIMEOUT_MS = 6 * 60 * 60_000;
const AUTHENTICODE_TIMEOUT_MS = 30_000;
const INSTALLER_LAUNCH_TIMEOUT_MS = 30_000;
const GITHUB_USER_AGENT = "hlid-ollama-windows-setup";
const SHA256_DIGEST_RE = /^sha256:([a-f0-9]{64})$/i;
const STABLE_TAG_RE = /^v?\d+(?:\.\d+){2}(?:\+[A-Za-z0-9.-]+)?$/;
const OFFICIAL_SIGNER_RE = /(^|, )O=Ollama Inc\.(,|$)/;
const STAGED_FILE_PREFIX = "hlid-ollama-setup-";
const STAGED_ID_RE =
	/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const STAGED_FILE_RE =
	/^hlid-ollama-setup-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(?:exe|part)$/i;

export type OllamaWindowsSetupState =
	| { phase: "idle" }
	| { phase: "resolving"; startedAt: number }
	| {
			phase: "downloading";
			startedAt: number;
			version: string;
			received: number;
			total: number;
	  }
	| {
			phase: "verifying";
			startedAt: number;
			version: string;
			received: number;
			total: number;
	  }
	| {
			phase: "ready";
			startedAt: number;
			completedAt: number;
			version: string;
			bytes: number;
	  }
	| {
			phase: "verification_failed";
			startedAt: number;
			completedAt: number;
			version: string;
			bytes: number;
			reason: string;
	  }
	| {
			phase: "launched";
			startedAt: number;
			launchedAt: number;
			version: string;
			bytes: number;
	  }
	| { phase: "complete"; version: string; detectedAt: number }
	| { phase: "canceled"; startedAt: number; completedAt: number }
	| {
			phase: "failed";
			startedAt: number;
			completedAt: number;
			reason: string;
	  };

export interface OllamaWindowsSetupController {
	status(): OllamaWindowsSetupState;
	startDownload(): OllamaWindowsSetupState;
	cancelDownload(): Promise<OllamaWindowsSetupState>;
	launch(): Promise<OllamaWindowsSetupState>;
	markDetected(version: string): Promise<OllamaWindowsSetupState>;
	close(): Promise<void>;
}

export type OllamaAuthenticodeResult = {
	status: string;
	subject: string | null;
};

type SetupFileHandle = {
	write(buffer: Uint8Array): Promise<{ bytesWritten: number }>;
	sync(): Promise<void>;
	close(): Promise<void>;
};

export type OllamaWindowsSetupFileSystem = {
	mkdir(
		path: string,
		options: { recursive: true; mode: number },
	): Promise<unknown>;
	open(path: string, flags: "wx", mode: number): Promise<SetupFileHandle>;
	read(path: string): AsyncIterable<Uint8Array>;
	readdir(path: string): Promise<string[]>;
	realpath(path: string): Promise<string>;
	rename(from: string, to: string): Promise<void>;
	rm(
		path: string,
		options: { force: true; recursive?: boolean },
	): Promise<void>;
	stat(path: string): Promise<{ isFile(): boolean; size: number }>;
};

export type OllamaWindowsSetupDependencies = {
	fetch?: typeof fetch;
	fs?: OllamaWindowsSetupFileSystem;
	launcher?: (installerPath: string) => Promise<void>;
	now?: () => number;
	platform?: NodeJS.Platform;
	randomId?: () => string;
	root?: string;
	runProcess?: typeof runBoundedProcess;
	verifyAuthenticode?: (
		installerPath: string,
	) => Promise<OllamaAuthenticodeResult>;
};

type ReleaseAsset = {
	version: string;
	url: string;
	sha256: string;
	size: number;
};

type StagedArtifact = ReleaseAsset & {
	path: string;
	startedAt: number;
};

const DEFAULT_FILE_SYSTEM: OllamaWindowsSetupFileSystem = {
	mkdir,
	open,
	read: (path) => createReadStream(path),
	readdir,
	realpath,
	rename,
	rm,
	stat,
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizedVersion(value: unknown): string {
	if (typeof value !== "string")
		throw new Error("Ollama release tag is invalid");
	const tag = value.trim();
	if (!STABLE_TAG_RE.test(tag)) {
		throw new Error("Ollama latest release is not a stable version");
	}
	return tag.replace(/^v/, "");
}

function officialInstallerUrl(value: unknown, tag: string): string {
	if (typeof value !== "string") {
		throw new Error("Ollama Windows installer URL is missing");
	}
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new Error("Ollama Windows installer URL is invalid");
	}
	const segments = url.pathname.split("/").filter(Boolean);
	if (
		url.protocol !== "https:" ||
		url.hostname !== "github.com" ||
		url.username ||
		url.password ||
		url.search ||
		url.hash ||
		segments.length !== 6 ||
		segments[0] !== "ollama" ||
		segments[1] !== "ollama" ||
		segments[2] !== "releases" ||
		segments[3] !== "download" ||
		segments[4] !== tag ||
		segments[5] !== OLLAMA_WINDOWS_INSTALLER_NAME
	) {
		throw new Error(
			"Ollama Windows installer URL is not an official release asset",
		);
	}
	return url.href;
}

function releaseAsset(value: unknown): ReleaseAsset {
	if (!isRecord(value)) throw new Error("Ollama release response is invalid");
	if (value.draft !== false || value.prerelease !== false) {
		throw new Error("Ollama latest release is not stable");
	}
	const tag = typeof value.tag_name === "string" ? value.tag_name.trim() : "";
	const version = normalizedVersion(tag);
	if (!Array.isArray(value.assets) || value.assets.length > 1_000) {
		throw new Error("Ollama release assets are invalid");
	}
	const installers = value.assets.filter(
		(asset) => isRecord(asset) && asset.name === OLLAMA_WINDOWS_INSTALLER_NAME,
	);
	if (installers.length !== 1) {
		throw new Error(
			"Ollama release must contain exactly one OllamaSetup.exe asset",
		);
	}
	const installer = installers[0];
	if (!isRecord(installer)) {
		throw new Error("Ollama Windows installer metadata is invalid");
	}
	const digest =
		typeof installer.digest === "string"
			? installer.digest.match(SHA256_DIGEST_RE)
			: null;
	if (!digest?.[1]) {
		throw new Error("Ollama Windows installer has no SHA-256 digest");
	}
	const size = installer.size;
	if (
		typeof size !== "number" ||
		!Number.isSafeInteger(size) ||
		size <= 0 ||
		size > OLLAMA_WINDOWS_SETUP_MAX_BYTES
	) {
		throw new Error(
			"Ollama Windows installer size is outside Hlid's safety limit",
		);
	}
	return {
		version,
		url: officialInstallerUrl(installer.browser_download_url, tag),
		sha256: digest[1].toLowerCase(),
		size,
	};
}

function contentLength(response: Response): number | null {
	const raw = response.headers.get("content-length");
	if (raw === null) return null;
	if (!/^\d+$/.test(raw)) throw new Error("Download content length is invalid");
	const value = Number(raw);
	if (!Number.isSafeInteger(value)) {
		throw new Error("Download content length is invalid");
	}
	return value;
}

async function boundedResponseBytes(
	response: Response,
	maxBytes: number,
): Promise<Uint8Array> {
	const declared = contentLength(response);
	if (declared !== null && declared > maxBytes) {
		throw new Error("Ollama release response exceeds the safety limit");
	}
	if (!response.body) throw new Error("Ollama release response has no body");
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let received = 0;
	try {
		while (true) {
			const item = await reader.read();
			if (item.done) break;
			received += item.value.byteLength;
			if (received > maxBytes) {
				throw new Error("Ollama release response exceeds the safety limit");
			}
			chunks.push(item.value);
		}
	} catch (error) {
		await reader.cancel(error).catch(() => {});
		throw error;
	} finally {
		reader.releaseLock();
	}
	const result = new Uint8Array(received);
	let offset = 0;
	for (const chunk of chunks) {
		result.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return result;
}

function combinedSignal(signal: AbortSignal, timeoutMs: number): AbortSignal {
	return AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
}

function officialAuthenticode(result: OllamaAuthenticodeResult): boolean {
	return (
		result.status === "Valid" && OFFICIAL_SIGNER_RE.test(result.subject ?? "")
	);
}

function quotedPowerShellLiteral(value: string): string {
	return `'${value.replaceAll("'", "''")}'`;
}

function windowsPowerShellPath(): string {
	const systemRoot = process.env.SystemRoot?.trim() || "C:\\Windows";
	if (!win32.isAbsolute(systemRoot)) {
		throw new Error("Windows SystemRoot is not absolute");
	}
	return win32.join(
		systemRoot,
		"System32",
		"WindowsPowerShell",
		"v1.0",
		"powershell.exe",
	);
}

class OllamaAuthenticodeInfrastructureError extends Error {
	readonly category: string;

	constructor(message: string, category: string) {
		super(message);
		this.name = "OllamaAuthenticodeInfrastructureError";
		this.category = category;
	}
}

async function verifyWindowsAuthenticode(
	installerPath: string,
	platform: NodeJS.Platform,
	runProcess: typeof runBoundedProcess,
): Promise<OllamaAuthenticodeResult> {
	if (platform !== "win32") {
		throw new Error("Ollama installer signature verification requires Windows");
	}
	const path = quotedPowerShellLiteral(installerPath);
	const script = [
		"$ErrorActionPreference = 'Stop'",
		"$ProgressPreference = 'SilentlyContinue'",
		'Import-Module -Name "$PSHOME\\Modules\\Microsoft.PowerShell.Security\\Microsoft.PowerShell.Security.psd1" -Force -ErrorAction Stop',
		`$signature = Microsoft.PowerShell.Security\\Get-AuthenticodeSignature -LiteralPath ${path}`,
		"[pscustomobject]@{ Status = $signature.Status.ToString(); Subject = if ($signature.SignerCertificate) { $signature.SignerCertificate.Subject } else { $null } } | ConvertTo-Json -Compress",
	].join("; ");
	let result: Awaited<ReturnType<typeof runBoundedProcess>>;
	try {
		result = await runProcess(
			windowsPowerShellPath(),
			[
				"-NoProfile",
				"-NonInteractive",
				"-EncodedCommand",
				Buffer.from(script, "utf16le").toString("base64"),
			],
			{
				timeoutMs: AUTHENTICODE_TIMEOUT_MS,
				timeoutError: "Ollama installer signature verification timed out",
				maxOutputChars: 8_192,
				shell: false,
			},
		);
	} catch (error) {
		const timedOut =
			error instanceof Error &&
			error.message === "Ollama installer signature verification timed out";
		throw new OllamaAuthenticodeInfrastructureError(
			timedOut
				? "Ollama installer signature verification timed out"
				: "Ollama installer signature verification could not start",
			timedOut ? "timeout" : "process-error",
		);
	}
	if (result.code !== 0) {
		throw new OllamaAuthenticodeInfrastructureError(
			"Ollama installer signature verification failed",
			`exit-code-${result.code ?? "signal"}`,
		);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(result.output.trim());
	} catch {
		throw new OllamaAuthenticodeInfrastructureError(
			"Ollama installer signature response is invalid",
			"invalid-response",
		);
	}
	if (
		!isRecord(parsed) ||
		typeof parsed.Status !== "string" ||
		(parsed.Subject !== null && typeof parsed.Subject !== "string")
	) {
		throw new OllamaAuthenticodeInfrastructureError(
			"Ollama installer signature response is invalid",
			"invalid-response",
		);
	}
	return { status: parsed.Status, subject: parsed.Subject };
}

async function launchWindowsInstaller(
	installerPath: string,
	platform: NodeJS.Platform,
	runProcess: typeof runBoundedProcess,
): Promise<void> {
	if (platform !== "win32") {
		throw new Error("Ollama installer launch requires Windows");
	}
	const path = quotedPowerShellLiteral(installerPath);
	const script = [
		"$ErrorActionPreference = 'Stop'",
		"$ProgressPreference = 'SilentlyContinue'",
		'Import-Module -Name "$PSHOME\\Modules\\Microsoft.PowerShell.Management\\Microsoft.PowerShell.Management.psd1" -Force -ErrorAction Stop',
		`$process = Microsoft.PowerShell.Management\\Start-Process -FilePath ${path} -PassThru`,
		"if (-not $process -or $process.Id -le 0) { throw 'Ollama Setup did not start' }",
		"$process.Id",
	].join("; ");
	const result = await runProcess(
		windowsPowerShellPath(),
		[
			"-NoProfile",
			"-NonInteractive",
			"-EncodedCommand",
			Buffer.from(script, "utf16le").toString("base64"),
		],
		{
			timeoutMs: INSTALLER_LAUNCH_TIMEOUT_MS,
			timeoutError: "Ollama installer launch timed out",
			maxOutputChars: 8_192,
			shell: false,
		},
	);
	if (result.code !== 0 || !/^\d+$/.test(result.output.trim())) {
		throw new Error("Windows could not launch Ollama Setup");
	}
}

function failureReason(error: unknown): string {
	if (error instanceof Error && error.message.trim())
		return error.message.trim();
	return "Ollama Windows setup failed";
}

function aborted(error: unknown, signal: AbortSignal): boolean {
	return (
		signal.aborted ||
		(error instanceof DOMException && error.name === "AbortError") ||
		(error instanceof Error && error.name === "AbortError")
	);
}

async function writeAll(
	handle: SetupFileHandle,
	chunk: Uint8Array,
): Promise<void> {
	let offset = 0;
	while (offset < chunk.byteLength) {
		const result = await handle.write(chunk.subarray(offset));
		if (result.bytesWritten <= 0)
			throw new Error("Ollama installer write stalled");
		offset += result.bytesWritten;
	}
}

export class OllamaWindowsSetupManager implements OllamaWindowsSetupController {
	private readonly fetchFn: typeof fetch;
	private readonly fileSystem: OllamaWindowsSetupFileSystem;
	private readonly launcher: (installerPath: string) => Promise<void>;
	private readonly now: () => number;
	private readonly platform: NodeJS.Platform;
	private readonly randomId: () => string;
	private readonly root: string;
	private readonly verifyAuthenticode: (
		installerPath: string,
	) => Promise<OllamaAuthenticodeResult>;

	private state: OllamaWindowsSetupState = { phase: "idle" };
	private artifact: StagedArtifact | null = null;
	private partialPath: string | null = null;
	private downloadController: AbortController | null = null;
	private downloadOperation: Promise<void> | null = null;
	private launchOperation: Promise<OllamaWindowsSetupState> | null = null;
	private closed = false;

	constructor(dependencies: OllamaWindowsSetupDependencies = {}) {
		const runProcess = dependencies.runProcess ?? runBoundedProcess;
		this.fetchFn = dependencies.fetch ?? fetch;
		this.fileSystem = dependencies.fs ?? DEFAULT_FILE_SYSTEM;
		this.now = dependencies.now ?? Date.now;
		this.platform = dependencies.platform ?? process.platform;
		this.launcher =
			dependencies.launcher ??
			((installerPath) =>
				launchWindowsInstaller(installerPath, this.platform, runProcess));
		this.randomId = dependencies.randomId ?? randomUUID;
		this.root = resolve(
			dependencies.root ?? join(canonicalInstallDir(), "ollama-setup"),
		);
		this.verifyAuthenticode =
			dependencies.verifyAuthenticode ??
			((installerPath) =>
				verifyWindowsAuthenticode(installerPath, this.platform, runProcess));
		if (!isAbsolute(this.root)) {
			throw new Error("Ollama setup staging root must be absolute");
		}
	}

	status(): OllamaWindowsSetupState {
		return { ...this.state };
	}

	private trackDownloadOperation(
		operation: Promise<void>,
		controller: AbortController,
	): OllamaWindowsSetupState {
		this.downloadOperation = operation;
		this.downloadController = controller;
		const clearOperation = () => {
			if (this.downloadOperation === operation) this.downloadOperation = null;
			if (this.downloadController === controller)
				this.downloadController = null;
		};
		void operation.then(clearOperation, clearOperation);
		return this.status();
	}

	startDownload(): OllamaWindowsSetupState {
		if (this.closed) throw new Error("Ollama Windows setup manager is closed");
		if (this.platform !== "win32") {
			throw new Error("Ollama Windows setup is available only on Windows");
		}
		if (this.downloadOperation || this.launchOperation) return this.status();
		if (this.state.phase === "verification_failed" && this.artifact) {
			const artifact = this.artifact;
			const controller = new AbortController();
			this.state = {
				phase: "verifying",
				startedAt: artifact.startedAt,
				version: artifact.version,
				received: artifact.size,
				total: artifact.size,
			};
			const operation = this.retryArtifactVerification(artifact, controller);
			return this.trackDownloadOperation(operation, controller);
		}
		if (this.state.phase === "ready" || this.state.phase === "launched") {
			return this.status();
		}
		const startedAt = this.now();
		const controller = new AbortController();
		this.state = { phase: "resolving", startedAt };
		const operation = this.runDownload(startedAt, controller);
		return this.trackDownloadOperation(operation, controller);
	}

	async cancelDownload(): Promise<OllamaWindowsSetupState> {
		const active = this.downloadOperation;
		const startedAt =
			"startedAt" in this.state ? this.state.startedAt : this.now();
		if (active) {
			this.downloadController?.abort(
				new DOMException("Ollama setup download canceled", "AbortError"),
			);
			await active;
			return this.status();
		}
		if (this.artifact || this.partialPath) {
			const cleaned = await this.cleanupFiles();
			this.state = cleaned
				? {
						phase: "canceled",
						startedAt,
						completedAt: this.now(),
					}
				: {
						phase: "failed",
						startedAt,
						completedAt: this.now(),
						reason:
							"Hlid could not remove the staged Ollama installer. Close Ollama Setup and retry.",
					};
		}
		return this.status();
	}

	launch(): Promise<OllamaWindowsSetupState> {
		if (this.closed) {
			return Promise.reject(
				new Error("Ollama Windows setup manager is closed"),
			);
		}
		if (this.platform !== "win32") {
			return Promise.reject(
				new Error("Ollama Windows setup is available only on Windows"),
			);
		}
		if (this.downloadOperation) {
			return Promise.reject(
				new Error("Wait for the Ollama installer download to finish"),
			);
		}
		if (this.launchOperation) return this.launchOperation;
		const operation = this.launchVerifiedArtifact();
		this.launchOperation = operation;
		const clearOperation = () => {
			if (this.launchOperation === operation) this.launchOperation = null;
		};
		void operation.then(clearOperation, clearOperation);
		return operation;
	}

	async markDetected(version: string): Promise<OllamaWindowsSetupState> {
		const detectedVersion = version.trim();
		if (!detectedVersion || detectedVersion.length > 256) {
			throw new Error("Detected Ollama version is invalid");
		}
		if (
			this.state.phase === "idle" ||
			this.state.phase === "canceled" ||
			this.state.phase === "failed" ||
			this.state.phase === "complete"
		) {
			await this.cleanupFiles();
			await this.cleanupStaleStage().catch(() => {});
			return this.status();
		}
		const active = this.downloadOperation;
		if (active) {
			this.downloadController?.abort(
				new DOMException("Ollama was detected", "AbortError"),
			);
			await active;
		}
		await this.cleanupFiles();
		this.state = {
			phase: "complete",
			version: detectedVersion,
			detectedAt: this.now(),
		};
		return this.status();
	}

	async close(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		const active = this.downloadOperation;
		if (active) {
			this.downloadController?.abort(
				new DOMException("Ollama setup manager closed", "AbortError"),
			);
			await active;
		}
		if (this.launchOperation) await this.launchOperation.catch(() => {});
		await this.cleanupFiles();
		this.state = { phase: "idle" };
	}

	private async resolveRelease(signal: AbortSignal): Promise<ReleaseAsset> {
		const response = await this.fetchFn(OLLAMA_WINDOWS_RELEASE_API, {
			headers: {
				Accept: "application/vnd.github+json",
				"User-Agent": GITHUB_USER_AGENT,
				"X-GitHub-Api-Version": "2022-11-28",
			},
			redirect: "error",
			signal: combinedSignal(signal, RELEASE_TIMEOUT_MS),
		});
		if (!response.ok) {
			await response.body?.cancel().catch(() => {});
			throw new Error(`Ollama release lookup returned HTTP ${response.status}`);
		}
		const bytes = await boundedResponseBytes(
			response,
			RELEASE_RESPONSE_MAX_BYTES,
		);
		let parsed: unknown;
		try {
			parsed = JSON.parse(
				new TextDecoder("utf-8", { fatal: true }).decode(bytes),
			);
		} catch {
			throw new Error("Ollama release response is invalid");
		}
		return releaseAsset(parsed);
	}

	private async runDownload(
		startedAt: number,
		controller: AbortController,
	): Promise<void> {
		try {
			if (!(await this.cleanupFiles())) {
				throw new Error(
					"Hlid could not remove the previous staged Ollama installer. Close Ollama Setup and retry.",
				);
			}
			await this.cleanupStaleStage();
			const release = await this.resolveRelease(controller.signal);
			if (controller.signal.aborted) throw controller.signal.reason;
			this.state = {
				phase: "downloading",
				startedAt,
				version: release.version,
				received: 0,
				total: release.size,
			};
			await this.downloadRelease(release, startedAt, controller.signal);
		} catch (error) {
			await this.settleDownloadFailure(
				error,
				controller,
				startedAt,
				this.artifact,
			);
		}
	}

	private async retryArtifactVerification(
		artifact: StagedArtifact,
		controller: AbortController,
	): Promise<void> {
		try {
			if (controller.signal.aborted) throw controller.signal.reason;
			await this.verifyArtifact(artifact);
			if (controller.signal.aborted) throw controller.signal.reason;
			this.state = {
				phase: "ready",
				startedAt: artifact.startedAt,
				completedAt: this.now(),
				version: artifact.version,
				bytes: artifact.size,
			};
		} catch (error) {
			await this.settleDownloadFailure(
				error,
				controller,
				artifact.startedAt,
				artifact,
			);
		}
	}

	private async settleDownloadFailure(
		error: unknown,
		controller: AbortController,
		startedAt: number,
		artifact: StagedArtifact | null,
	): Promise<void> {
		const canceled = aborted(error, controller.signal);
		if (
			!canceled &&
			error instanceof OllamaAuthenticodeInfrastructureError &&
			artifact &&
			this.artifact === artifact
		) {
			this.state = {
				phase: "verification_failed",
				startedAt: artifact.startedAt,
				completedAt: this.now(),
				version: artifact.version,
				bytes: artifact.size,
				reason: failureReason(error),
			};
			return;
		}
		const cleaned = await this.cleanupFiles();
		const reason = cleaned
			? failureReason(error)
			: `${failureReason(error)} Hlid could not remove a staged installer; close Ollama Setup and retry.`;
		this.state =
			canceled && cleaned
				? { phase: "canceled", startedAt, completedAt: this.now() }
				: {
						phase: "failed",
						startedAt,
						completedAt: this.now(),
						reason,
					};
	}

	private async downloadRelease(
		release: ReleaseAsset,
		startedAt: number,
		signal: AbortSignal,
	): Promise<void> {
		const root = await this.canonicalStagingRoot();
		const id = this.randomId();
		if (!STAGED_ID_RE.test(id)) {
			throw new Error("Ollama setup staging identifier is invalid");
		}
		const stagedName = `${STAGED_FILE_PREFIX}${id}`;
		const partialPath = join(root, `${stagedName}.part`);
		const artifactPath = join(root, `${stagedName}.exe`);
		this.partialPath = partialPath;
		const handle = await this.fileSystem.open(partialPath, "wx", 0o600);
		let closed = false;
		try {
			const response = await this.fetchFn(release.url, {
				headers: {
					Accept: "application/octet-stream",
					"User-Agent": GITHUB_USER_AGENT,
				},
				redirect: "follow",
				signal: combinedSignal(signal, DOWNLOAD_TIMEOUT_MS),
			});
			if (!response.ok || !response.body) {
				await response.body?.cancel().catch(() => {});
				throw new Error(
					`Ollama installer download returned HTTP ${response.status}`,
				);
			}
			const declared = contentLength(response);
			if (declared !== null && declared !== release.size) {
				throw new Error(
					"Ollama installer size does not match release metadata",
				);
			}
			const reader = response.body.getReader();
			const cancelReader = () =>
				void reader.cancel(signal.reason).catch(() => {});
			signal.addEventListener("abort", cancelReader, { once: true });
			const hash = createHash("sha256");
			let received = 0;
			try {
				while (true) {
					if (signal.aborted) throw signal.reason;
					const item = await reader.read();
					if (item.done) break;
					received += item.value.byteLength;
					if (
						received > release.size ||
						received > OLLAMA_WINDOWS_SETUP_MAX_BYTES
					) {
						throw new Error("Ollama installer exceeds the safety limit");
					}
					hash.update(item.value);
					await writeAll(handle, item.value);
					this.state = {
						phase: "downloading",
						startedAt,
						version: release.version,
						received,
						total: release.size,
					};
				}
			} finally {
				signal.removeEventListener("abort", cancelReader);
				reader.releaseLock();
			}
			if (received !== release.size) {
				throw new Error(
					"Ollama installer download ended before the expected size",
				);
			}
			if (hash.digest("hex") !== release.sha256) {
				throw new Error("Ollama installer SHA-256 digest did not match");
			}
			await handle.sync();
			await handle.close();
			closed = true;
			await this.fileSystem.rename(partialPath, artifactPath);
			this.partialPath = null;
			this.artifact = { ...release, path: artifactPath, startedAt };
			this.state = {
				phase: "verifying",
				startedAt,
				version: release.version,
				received,
				total: release.size,
			};
			await this.verifyArtifact(this.artifact);
			this.state = {
				phase: "ready",
				startedAt,
				completedAt: this.now(),
				version: release.version,
				bytes: received,
			};
		} finally {
			if (!closed) await handle.close().catch(() => {});
		}
	}

	private async verifiedArtifactPath(
		artifact: StagedArtifact,
	): Promise<string> {
		const root = await this.canonicalStagingRoot();
		const path = await this.fileSystem.realpath(artifact.path);
		const rel = relative(root, path);
		if (
			!rel ||
			rel.startsWith("..") ||
			isAbsolute(rel) ||
			resolve(root, rel) !== path
		) {
			throw new Error("Ollama installer escaped its private staging directory");
		}
		const metadata = await this.fileSystem.stat(path);
		if (!metadata.isFile() || metadata.size !== artifact.size) {
			throw new Error("Ollama installer staging file is invalid");
		}
		return path;
	}

	private async verifyArtifact(artifact: StagedArtifact): Promise<string> {
		const path = await this.verifiedArtifactPath(artifact);
		const hash = createHash("sha256");
		let received = 0;
		for await (const chunk of this.fileSystem.read(path)) {
			received += chunk.byteLength;
			if (
				received > artifact.size ||
				received > OLLAMA_WINDOWS_SETUP_MAX_BYTES
			) {
				throw new Error("Ollama installer staging file is invalid");
			}
			hash.update(chunk);
		}
		if (received !== artifact.size) {
			throw new Error("Ollama installer staging file is invalid");
		}
		if (hash.digest("hex") !== artifact.sha256) {
			throw new Error("Ollama installer SHA-256 digest did not match");
		}
		let signature: OllamaAuthenticodeResult;
		try {
			signature = await this.verifyAuthenticode(path);
		} catch (error) {
			const infrastructureError =
				error instanceof OllamaAuthenticodeInfrastructureError
					? error
					: new OllamaAuthenticodeInfrastructureError(
							"Ollama installer signature verification could not run",
							"verifier-error",
						);
			console.warn(
				`[ollama setup] Authenticode verifier infrastructure failure (${infrastructureError.category})`,
			);
			throw infrastructureError;
		}
		if (!officialAuthenticode(signature)) {
			throw new Error(
				"Ollama installer must have a valid Authenticode signature from Ollama Inc.",
			);
		}
		return path;
	}

	private async launchVerifiedArtifact(): Promise<OllamaWindowsSetupState> {
		const artifact = this.artifact;
		if (
			!artifact ||
			(this.state.phase !== "ready" && this.state.phase !== "launched")
		) {
			throw new Error("No verified Ollama Windows installer is ready");
		}
		let path: string;
		try {
			path = await this.verifyArtifact(artifact);
		} catch (error) {
			if (error instanceof OllamaAuthenticodeInfrastructureError) {
				this.state = {
					phase: "verification_failed",
					startedAt: artifact.startedAt,
					completedAt: this.now(),
					version: artifact.version,
					bytes: artifact.size,
					reason: failureReason(error),
				};
				return this.status();
			}
			await this.cleanupFiles();
			this.state = {
				phase: "failed",
				startedAt: artifact.startedAt,
				completedAt: this.now(),
				reason: failureReason(error),
			};
			return this.status();
		}
		try {
			await this.launcher(path);
			this.state = {
				phase: "launched",
				startedAt: artifact.startedAt,
				launchedAt: this.now(),
				version: artifact.version,
				bytes: artifact.size,
			};
			return this.status();
		} catch (error) {
			this.state = {
				phase: "ready",
				startedAt: artifact.startedAt,
				completedAt: this.now(),
				version: artifact.version,
				bytes: artifact.size,
			};
			throw new Error(
				`Windows could not launch Ollama Setup: ${failureReason(error)}`,
			);
		}
	}

	private async canonicalStagingRoot(): Promise<string> {
		await this.fileSystem.mkdir(this.root, { recursive: true, mode: 0o700 });
		const root = await this.fileSystem.realpath(this.root);
		if (!samePath(root, this.root)) {
			throw new Error(
				"Ollama setup staging directory must not be a symbolic link or junction",
			);
		}
		return root;
	}

	private async cleanupFiles(): Promise<boolean> {
		const partialPath = this.partialPath;
		const artifactPath = this.artifact?.path ?? null;
		if (!partialPath && !artifactPath) return true;
		try {
			await this.canonicalStagingRoot();
		} catch {
			return false;
		}
		let cleaned = true;
		if (partialPath) {
			try {
				await this.fileSystem.rm(partialPath, { force: true });
				if (this.partialPath === partialPath) this.partialPath = null;
			} catch {
				cleaned = false;
			}
		}
		if (artifactPath) {
			try {
				await this.fileSystem.rm(artifactPath, { force: true });
				if (this.artifact?.path === artifactPath) this.artifact = null;
			} catch {
				cleaned = false;
			}
		}
		return cleaned;
	}

	private async cleanupStaleStage(): Promise<void> {
		const root = await this.canonicalStagingRoot();
		const names = await this.fileSystem.readdir(root);
		for (const name of names) {
			if (!STAGED_FILE_RE.test(name)) continue;
			const path = resolve(root, name);
			const rel = relative(root, path);
			if (!rel || rel !== name || rel.startsWith("..") || isAbsolute(rel)) {
				throw new Error("Ollama stale installer escaped its staging directory");
			}
			await this.fileSystem.rm(path, { force: true });
		}
	}
}
