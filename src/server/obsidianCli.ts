import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { runBoundedProcess } from "#/lib/process";

const DETECTION_TIMEOUT_MS = 5_000;
const COMMAND_TIMEOUT_MS = 20_000;
const MAX_COMMAND_OUTPUT_CHARS = 256_000;
export const MAX_OBSIDIAN_APPEND_CHARS = 20_000;
export const MAX_OBSIDIAN_AGENT_OUTPUT_CHARS = 120_000;

type ProcessRunner = typeof runBoundedProcess;

export type ObsidianBridgeDependencies = {
	platform?: NodeJS.Platform;
	env?: NodeJS.ProcessEnv;
	exists?: (path: string) => boolean;
	run?: ProcessRunner;
	wait?: (milliseconds: number) => Promise<void>;
};

export type ObsidianCliStatus = {
	supported: boolean;
	installed: boolean;
	registered: boolean;
	version: string | null;
	state: "available" | "not_installed" | "unsupported";
	detail: string;
};

export type ObsidianConnection = {
	version: string;
	vaultPath: string;
};

type ResolvedObsidianCli = ObsidianCliStatus & {
	executable: string | null;
	windowsAppExecutable: string | null;
};

function isWsl(env: NodeJS.ProcessEnv): boolean {
	return Boolean(env.WSL_DISTRO_NAME || env.WSL_INTEROP);
}

function windowsPathForWsl(path: string): string {
	const drivePath = path.match(/^([A-Za-z]):[\\/](.*)$/);
	if (!drivePath) return path;
	return `/mnt/${drivePath[1]?.toLowerCase()}/${drivePath[2]?.replace(/\\/g, "/")}`;
}

function unixPathCandidate(
	env: NodeJS.ProcessEnv,
	exists: (path: string) => boolean,
): string | null {
	for (const directory of (env.PATH ?? "").split(":")) {
		if (!directory) continue;
		const candidate = join(directory, "obsidian");
		if (exists(candidate)) return candidate;
	}
	return null;
}

function parseWindowsDetectionOutput(output: string): {
	executable: string | null;
	registered: boolean;
	version: string | null;
} | null {
	try {
		const parsed = JSON.parse(output.trim()) as {
			executable?: unknown;
			registered?: unknown;
			version?: unknown;
		};
		return {
			executable:
				typeof parsed.executable === "string" && parsed.executable.trim()
					? parsed.executable.trim()
					: null,
			registered: parsed.registered === true,
			version:
				typeof parsed.version === "string" && parsed.version.trim()
					? parsed.version.trim()
					: null,
		};
	} catch {
		return null;
	}
}

const WINDOWS_DETECTION_SCRIPT = [
	"$registered = Get-Command obsidian -ErrorAction SilentlyContinue",
	"$candidates = @()",
	"if ($registered) { $candidates += $registered.Source }",
	"if ($env:LOCALAPPDATA) { $candidates += (Join-Path $env:LOCALAPPDATA 'Programs\\Obsidian\\Obsidian.com') }",
	"if ($env:ProgramFiles) { $candidates += (Join-Path $env:ProgramFiles 'Obsidian\\Obsidian.com') }",
	"$entry = Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*' -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -eq 'Obsidian' } | Select-Object -First 1",
	"if ($entry -and $entry.DisplayIcon) { $icon = ($entry.DisplayIcon -split ',')[0].Trim([char]34); $candidates += (Join-Path (Split-Path $icon) 'Obsidian.com') }",
	"$executable = $candidates | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1",
	"[pscustomobject]@{ executable = $executable; registered = [bool]$registered; version = if ($entry) { $entry.DisplayVersion } else { $null } } | ConvertTo-Json -Compress",
].join("; ");

async function detectObsidianCli(
	dependencies: ObsidianBridgeDependencies = {},
): Promise<ResolvedObsidianCli> {
	const platform = dependencies.platform ?? process.platform;
	const env = dependencies.env ?? process.env;
	const exists = dependencies.exists ?? existsSync;
	const run = dependencies.run ?? runBoundedProcess;
	const wsl = platform === "linux" && isWsl(env);

	if (platform === "win32" || wsl) {
		try {
			const result = await run(
				"powershell.exe",
				[
					"-NoLogo",
					"-NoProfile",
					"-NonInteractive",
					"-Command",
					WINDOWS_DETECTION_SCRIPT,
				],
				{
					timeoutMs: DETECTION_TIMEOUT_MS,
					timeoutError: "Obsidian CLI detection timed out",
					maxOutputChars: 16_384,
				},
			);
			const parsed =
				result.code === 0 ? parseWindowsDetectionOutput(result.output) : null;
			const windowsExecutable = parsed?.executable ?? null;
			const executable =
				windowsExecutable && wsl
					? windowsPathForWsl(windowsExecutable)
					: windowsExecutable;
			if (executable && exists(executable)) {
				const windowsAppExecutable = windowsExecutable?.replace(
					/Obsidian\.com$/i,
					"Obsidian.exe",
				);
				return {
					supported: true,
					installed: true,
					registered: parsed?.registered ?? false,
					version: parsed?.version ?? null,
					state: "available",
					detail: parsed?.registered
						? "Obsidian CLI is installed and registered."
						: "Obsidian CLI is installed. Enable it in Obsidian settings if connection fails.",
					executable,
					windowsAppExecutable:
						windowsAppExecutable !== windowsExecutable
							? (windowsAppExecutable ?? null)
							: null,
				};
			}
		} catch {
			// Fall through to the normal not-installed result. Detection must stay
			// passive and should never make Forge fail to load.
		}
		return {
			supported: true,
			installed: false,
			registered: false,
			version: null,
			state: "not_installed",
			detail: "Obsidian 1.12.7 or newer was not detected on the Windows host.",
			executable: null,
			windowsAppExecutable: null,
		};
	}

	if (platform === "darwin" || platform === "linux") {
		const executable = unixPathCandidate(env, exists);
		if (executable) {
			return {
				supported: true,
				installed: true,
				registered: true,
				version: null,
				state: "available",
				detail: "Obsidian CLI is installed and registered.",
				executable,
				windowsAppExecutable: null,
			};
		}
		return {
			supported: true,
			installed: false,
			registered: false,
			version: null,
			state: "not_installed",
			detail: "Obsidian CLI was not found on this host.",
			executable: null,
			windowsAppExecutable: null,
		};
	}

	return {
		supported: false,
		installed: false,
		registered: false,
		version: null,
		state: "unsupported",
		detail: "Obsidian CLI is not supported on this host.",
		executable: null,
		windowsAppExecutable: null,
	};
}

const RESOLUTION_CACHE_MS = 30_000;
let cachedResolution:
	| { value: ResolvedObsidianCli; resolvedAt: number }
	| undefined;
let resolutionInflight: Promise<ResolvedObsidianCli> | undefined;

async function resolveObsidianCli(
	dependencies: ObsidianBridgeDependencies = {},
): Promise<ResolvedObsidianCli> {
	if (Object.keys(dependencies).length > 0) {
		return detectObsidianCli(dependencies);
	}
	if (
		cachedResolution &&
		Date.now() - cachedResolution.resolvedAt < RESOLUTION_CACHE_MS
	) {
		return cachedResolution.value;
	}
	if (!resolutionInflight) {
		resolutionInflight = detectObsidianCli().then((value) => {
			cachedResolution = { value, resolvedAt: Date.now() };
			return value;
		});
	}
	try {
		return await resolutionInflight;
	} finally {
		resolutionInflight = undefined;
	}
}

export async function getObsidianCliStatus(
	dependencies: ObsidianBridgeDependencies = {},
): Promise<ObsidianCliStatus> {
	const {
		executable: _executable,
		windowsAppExecutable: _windowsAppExecutable,
		...status
	} = await resolveObsidianCli(dependencies);
	return status;
}

function targetVaultArgument(vaultName: string): string {
	const name = vaultName.trim();
	if (!name || name.length > 200 || /[\r\n\0]/.test(name)) {
		throw new Error(
			"The configured vault name cannot be used with Obsidian CLI.",
		);
	}
	return `vault=${name}`;
}

async function runObsidianCommand(
	vaultName: string,
	args: string[],
	dependencies: ObsidianBridgeDependencies = {},
): Promise<string> {
	const resolved = await resolveObsidianCli(dependencies);
	return runResolvedObsidianCommand(resolved, vaultName, args, dependencies);
}

async function runResolvedObsidianCommand(
	resolved: ResolvedObsidianCli,
	vaultName: string,
	args: string[],
	dependencies: ObsidianBridgeDependencies,
): Promise<string> {
	if (!resolved.executable) throw new Error(resolved.detail);
	const executable = resolved.executable;
	const windowsAppExecutable = resolved.windowsAppExecutable;
	const run = dependencies.run ?? runBoundedProcess;
	const invoke = () =>
		run(executable, [targetVaultArgument(vaultName), ...args], {
			timeoutMs: COMMAND_TIMEOUT_MS,
			timeoutError: "Obsidian did not respond in time.",
			maxOutputChars: MAX_COMMAND_OUTPUT_CHARS,
		});
	let result = await invoke();
	if (
		result.code !== 0 &&
		windowsAppExecutable &&
		/unable to find obsidian/i.test(result.output)
	) {
		const launched = await run(
			"powershell.exe",
			[
				"-NoLogo",
				"-NoProfile",
				"-NonInteractive",
				"-Command",
				"& { param([string]$path) Start-Process -FilePath $path }",
				windowsAppExecutable,
			],
			{
				timeoutMs: DETECTION_TIMEOUT_MS,
				timeoutError: "Obsidian desktop did not start in time.",
				maxOutputChars: 16_384,
			},
		);
		if (launched.code !== 0) {
			throw new Error(
				launched.output.trim() || "Obsidian desktop could not be started.",
			);
		}
		const wait =
			dependencies.wait ??
			((milliseconds: number) =>
				new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
		for (let attempt = 0; attempt < 6; attempt++) {
			await wait(500);
			result = await invoke();
			if (
				result.code === 0 ||
				!/unable to find obsidian/i.test(result.output)
			) {
				break;
			}
		}
	}
	const detail = result.output.trim();
	if (result.code !== 0 || /^vault not found\.?$/i.test(detail)) {
		throw new Error(
			detail
				? `Obsidian CLI failed: ${detail}`
				: `Obsidian CLI exited with code ${result.code ?? "unknown"}.`,
		);
	}
	return result.output.trim();
}

function outputField(output: string, field: string): string | null {
	const prefix = `${field.toLowerCase()} `;
	for (const rawLine of output.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (line.toLowerCase().startsWith(prefix)) {
			return line.slice(prefix.length).trim() || null;
		}
	}
	return null;
}

function portableVaultPath(path: string): string {
	return path.replace(/\\/g, "/").replace(/^\.\//, "");
}

function safeVaultPath(path: string, label = "path"): string {
	const portable = portableVaultPath(path.trim());
	if (
		!portable ||
		portable.length > 4_096 ||
		portable.startsWith("/") ||
		/^[A-Za-z]:\//.test(portable) ||
		portable.split("/").some((part) => part === "..") ||
		/[\r\n\0]/.test(portable)
	) {
		throw new Error(`Obsidian ${label} must stay inside the configured vault.`);
	}
	return portable;
}

function optionalPathArgument(path: string | undefined): string[] {
	return path ? [`path=${safeVaultPath(path)}`] : [];
}

export type ObsidianLinksQuery = {
	kind: "backlinks" | "outgoing" | "unresolved" | "orphans" | "deadends";
	path?: string;
	counts?: boolean;
	countOnly?: boolean;
};

export type ObsidianSearchQuery = {
	query: string;
	path?: string;
	caseSensitive?: boolean;
	context?: boolean;
	countOnly?: boolean;
};

export async function queryObsidianSearch(
	vaultName: string,
	query: ObsidianSearchQuery,
	dependencies: ObsidianBridgeDependencies = {},
): Promise<string> {
	const searchQuery = query.query.trim();
	if (
		!searchQuery ||
		searchQuery.length > 4_096 ||
		/[\r\n\0]/.test(searchQuery)
	) {
		throw new Error("Obsidian search query is invalid.");
	}
	const args = [
		query.context && !query.countOnly ? "search:context" : "search",
		`query=${searchQuery}`,
		...optionalPathArgument(query.path),
		...(query.caseSensitive ? ["case"] : []),
		...(query.countOnly ? ["total"] : query.context ? [] : ["format=json"]),
	];
	return runObsidianCommand(vaultName, args, dependencies);
}

export async function queryObsidianLinks(
	vaultName: string,
	query: ObsidianLinksQuery,
	dependencies: ObsidianBridgeDependencies = {},
): Promise<string> {
	let args: string[];
	switch (query.kind) {
		case "backlinks":
			args = [
				"backlinks",
				...optionalPathArgument(query.path),
				...(query.countOnly
					? ["total"]
					: [...(query.counts ? ["counts"] : []), "format=json"]),
			];
			break;
		case "outgoing":
			args = [
				"links",
				...optionalPathArgument(query.path),
				...(query.countOnly ? ["total"] : []),
			];
			break;
		case "unresolved":
			args = [
				"unresolved",
				...(query.countOnly
					? ["total"]
					: [...(query.counts ? ["counts"] : []), "verbose", "format=json"]),
			];
			break;
		case "orphans":
			args = ["orphans", ...(query.countOnly ? ["total"] : [])];
			break;
		case "deadends":
			args = ["deadends", ...(query.countOnly ? ["total"] : [])];
			break;
	}
	return runObsidianCommand(vaultName, args, dependencies);
}

export type ObsidianTasksQuery = {
	path?: string;
	state?: "all" | "todo" | "done";
	status?: string;
	source?: "vault" | "active" | "daily";
	countOnly?: boolean;
};

export async function queryObsidianTasks(
	vaultName: string,
	query: ObsidianTasksQuery,
	dependencies: ObsidianBridgeDependencies = {},
): Promise<string> {
	const status = query.status?.trim();
	if (status && (status.length !== 1 || /[\r\n\0]/.test(status))) {
		throw new Error("Obsidian task status must be one character.");
	}
	const args = [
		"tasks",
		...optionalPathArgument(query.path),
		...(query.source === "active" ? ["active"] : []),
		...(query.source === "daily" ? ["daily"] : []),
		...(query.state === "todo" ? ["todo"] : []),
		...(query.state === "done" ? ["done"] : []),
		...(status ? [`status=${status}`] : []),
		...(query.countOnly ? ["total"] : ["verbose", "format=json"]),
	];
	return runObsidianCommand(vaultName, args, dependencies);
}

export type ObsidianPropertiesQuery = {
	path?: string;
	name?: string;
	active?: boolean;
	countOnly?: boolean;
};

export async function queryObsidianProperties(
	vaultName: string,
	query: ObsidianPropertiesQuery,
	dependencies: ObsidianBridgeDependencies = {},
): Promise<string> {
	const name = query.name?.trim();
	if (name && (name.length > 256 || /[\r\n\0]/.test(name))) {
		throw new Error("Obsidian property name is invalid.");
	}
	const args = [
		"properties",
		...optionalPathArgument(query.path),
		...(query.active ? ["active"] : []),
		...(name ? [`name=${name}`] : []),
		...(query.countOnly ? ["total"] : ["format=json"]),
	];
	return runObsidianCommand(vaultName, args, dependencies);
}

export async function queryObsidianBase(
	vaultName: string,
	path: string,
	view: string | undefined,
	dependencies: ObsidianBridgeDependencies = {},
): Promise<string> {
	const safePath = safeVaultPath(path, "Base path");
	if (!safePath.toLowerCase().endsWith(".base")) {
		throw new Error("Obsidian Base queries require a .base file.");
	}
	const viewName = view?.trim();
	if (viewName && (viewName.length > 256 || /[\r\n\0]/.test(viewName))) {
		throw new Error("Obsidian Base view name is invalid.");
	}
	return runObsidianCommand(
		vaultName,
		[
			"base:query",
			`path=${safePath}`,
			...(viewName ? [`view=${viewName}`] : []),
			"format=json",
		],
		dependencies,
	);
}

export type ObsidianHistoryQuery = {
	action: "versions" | "files" | "read" | "diff";
	path?: string;
	version?: number;
	from?: number;
	to?: number;
	filter?: "all" | "local" | "sync";
};

function positiveVersion(value: number | undefined, label: string): string[] {
	if (value === undefined) return [];
	if (!Number.isInteger(value) || value < 1 || value > 100_000) {
		throw new Error(`Obsidian history ${label} must be a positive integer.`);
	}
	return [`${label}=${value}`];
}

export async function queryObsidianHistory(
	vaultName: string,
	query: ObsidianHistoryQuery,
	dependencies: ObsidianBridgeDependencies = {},
): Promise<string> {
	const pathArgs = optionalPathArgument(query.path);
	let args: string[];
	switch (query.action) {
		case "versions":
			args = ["history", ...pathArgs];
			break;
		case "files":
			args = ["history:list"];
			break;
		case "read":
			if (!query.path)
				throw new Error("Obsidian history read requires a path.");
			args = [
				"history:read",
				...pathArgs,
				...positiveVersion(query.version, "version"),
			];
			break;
		case "diff":
			args = [
				"diff",
				...pathArgs,
				...positiveVersion(query.from, "from"),
				...positiveVersion(query.to, "to"),
				...(query.filter && query.filter !== "all"
					? [`filter=${query.filter}`]
					: []),
			];
			break;
	}
	return runObsidianCommand(vaultName, args, dependencies);
}

export type ObsidianCurrentNoteQuery = {
	action: "read" | "outline" | "info";
	countOnly?: boolean;
};

export async function queryObsidianCurrentNote(
	vaultName: string,
	query: ObsidianCurrentNoteQuery,
	dependencies: ObsidianBridgeDependencies = {},
): Promise<string> {
	let args: string[];
	switch (query.action) {
		case "read":
			args = ["read"];
			break;
		case "outline":
			args = ["outline", ...(query.countOnly ? ["total"] : ["format=json"])];
			break;
		case "info":
			args = ["file"];
			break;
	}
	return runObsidianCommand(vaultName, args, dependencies);
}

// fallow-ignore-next-line unused-export -- Loaded dynamically by the Obsidian server functions to keep host process code out of the client bundle.
export async function testObsidianConnection(
	vaultName: string,
	dependencies: ObsidianBridgeDependencies = {},
): Promise<ObsidianConnection> {
	const resolved = await resolveObsidianCli(dependencies);
	// Keep the first launch sequential. Two simultaneous CLI calls can otherwise
	// race while Obsidian is bringing up its local command socket.
	const version = await runResolvedObsidianCommand(
		resolved,
		vaultName,
		["version"],
		dependencies,
	);
	const vaultPathOutput = await runResolvedObsidianCommand(
		resolved,
		vaultName,
		["vault", "info=path"],
		dependencies,
	);
	const vaultPath =
		outputField(vaultPathOutput, "path") ?? vaultPathOutput.trim();
	if (!version) throw new Error("Obsidian did not report its version.");
	if (!vaultPath)
		throw new Error("Obsidian could not find the configured vault.");
	return { version, vaultPath };
}

// fallow-ignore-next-line unused-export -- Loaded dynamically by the Obsidian server functions to keep host process code out of the client bundle.
export async function getActiveObsidianNote(
	vaultName: string,
	dependencies: ObsidianBridgeDependencies = {},
): Promise<string> {
	const output = await runObsidianCommand(vaultName, ["file"], dependencies);
	const path = outputField(output, "path");
	if (!path)
		throw new Error("No active Obsidian note was found in this vault.");
	return portableVaultPath(path);
}

// fallow-ignore-next-line unused-export -- Loaded dynamically by the Obsidian server functions to keep host process code out of the client bundle.
export async function openObsidianNote(
	vaultName: string,
	relativePath: string,
	dependencies: ObsidianBridgeDependencies = {},
): Promise<void> {
	await runObsidianCommand(
		vaultName,
		["open", `path=${portableVaultPath(relativePath)}`],
		dependencies,
	);
}

// fallow-ignore-next-line unused-export -- Loaded dynamically by the Obsidian server functions to keep host process code out of the client bundle.
export async function appendToObsidian(
	vaultName: string,
	destination: "active" | "daily",
	content: string,
	dependencies: ObsidianBridgeDependencies = {},
): Promise<void> {
	const trimmed = content.trim();
	if (!trimmed) throw new Error("There is nothing to save to Obsidian.");
	if (trimmed.length > MAX_OBSIDIAN_APPEND_CHARS) {
		throw new Error(
			`Obsidian append is limited to ${MAX_OBSIDIAN_APPEND_CHARS.toLocaleString()} characters.`,
		);
	}
	await runObsidianCommand(
		vaultName,
		[destination === "daily" ? "daily:append" : "append", `content=${trimmed}`],
		dependencies,
	);
}

// fallow-ignore-next-line unused-export -- Loaded dynamically by the Obsidian server functions to keep host process code out of the client bundle.
export function obsidianReferenceItem(relativePath: string): {
	relativePath: string;
	name: string;
	directory: string;
} {
	const portable = portableVaultPath(relativePath);
	const directory = dirname(portable);
	return {
		relativePath: portable,
		name: basename(portable),
		directory: directory === "." ? "" : portableVaultPath(directory),
	};
}
