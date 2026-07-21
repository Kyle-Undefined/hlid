import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { runBoundedProcess } from "#/lib/process";

const DETECTION_TIMEOUT_MS = 5_000;
const COMMAND_TIMEOUT_MS = 20_000;
const STARTUP_TIMEOUT_MS = 20_000;
const STARTUP_POLL_MS = 500;
const MAX_COMMAND_OUTPUT_CHARS = 256_000;
export const MAX_OBSIDIAN_APPEND_CHARS = 20_000;
export const MAX_OBSIDIAN_CREATE_CHARS = 20_000;
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

type ObsidianCommandOptions = {
	launchIfNeeded?: boolean;
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

const WINDOWS_START_SCRIPT = [
	"& { param([string]$path)",
	"$process = Get-Process -Name Obsidian -ErrorAction SilentlyContinue | Select-Object -First 1",
	"$started = $false",
	"if (-not $process) { $process = Start-Process -FilePath $path -PassThru; $started = $true }",
	"[pscustomobject]@{ running = [bool]$process; started = $started; id = if ($process) { $process.Id } else { $null } } | ConvertTo-Json -Compress",
	"}",
].join("; ");

function parseWindowsStartOutput(output: string): {
	running: boolean;
	started: boolean;
} | null {
	try {
		const parsed = JSON.parse(output.trim()) as {
			running?: unknown;
			started?: unknown;
		};
		return {
			running: parsed.running === true,
			started: parsed.started === true,
		};
	} catch {
		return null;
	}
}

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
	options: ObsidianCommandOptions = {},
): Promise<string> {
	const resolved = await resolveObsidianCli(dependencies);
	return runResolvedObsidianCommand(
		resolved,
		vaultName,
		args,
		dependencies,
		options,
	);
}

async function runResolvedObsidianCommand(
	resolved: ResolvedObsidianCli,
	vaultName: string,
	args: string[],
	dependencies: ObsidianBridgeDependencies,
	options: ObsidianCommandOptions = {},
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
		options.launchIfNeeded !== false &&
		/unable to find obsidian/i.test(result.output)
	) {
		const launched = await run(
			"powershell.exe",
			[
				"-NoLogo",
				"-NoProfile",
				"-NonInteractive",
				"-Command",
				WINDOWS_START_SCRIPT,
				windowsAppExecutable,
			],
			{
				timeoutMs: DETECTION_TIMEOUT_MS,
				timeoutError: "Obsidian desktop did not start in time.",
				maxOutputChars: 16_384,
			},
		);
		const processState =
			launched.code === 0 ? parseWindowsStartOutput(launched.output) : null;
		if (launched.code !== 0 || !processState?.running) {
			throw new Error(
				launched.output.trim() ||
					"Obsidian desktop did not report a running process.",
			);
		}
		const wait =
			dependencies.wait ??
			((milliseconds: number) =>
				new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
		const attempts = Math.ceil(STARTUP_TIMEOUT_MS / STARTUP_POLL_MS);
		for (let attempt = 0; attempt < attempts; attempt++) {
			await wait(STARTUP_POLL_MS);
			result = await invoke();
			if (
				result.code === 0 ||
				!/unable to find obsidian/i.test(result.output)
			) {
				break;
			}
		}
		if (result.code !== 0 && /unable to find obsidian/i.test(result.output)) {
			throw new Error(
				`Obsidian ${processState.started ? "started" : "is running"}, but its CLI was not ready after ${STARTUP_TIMEOUT_MS / 1_000} seconds.`,
			);
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
	for (const rawLine of output.split(/\r?\n/)) {
		const line = rawLine.trim();
		const parsed = line.match(/^([^:\s]+)(?:\s*:\s*|\s+)(.*)$/);
		if (parsed?.[1]?.toLowerCase() !== field.toLowerCase()) continue;
		return parsed[2]?.trim() || null;
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

function safeTemplateName(name: string): string {
	const template = safeVaultPath(name.trim(), "template name").replace(
		/\.md$/i,
		"",
	);
	if (template.length > 256) {
		throw new Error("Obsidian template name is too long.");
	}
	return template;
}

function safeVaultFilename(name: string): string {
	const filename = name.trim();
	if (
		!filename ||
		filename.length > 255 ||
		filename === "." ||
		filename === ".." ||
		filename.includes("/") ||
		filename.includes("\\") ||
		/[\r\n\0]/.test(filename)
	) {
		throw new Error("Obsidian filename is invalid.");
	}
	return filename;
}

function safeNoteContent(content: string | undefined, limit: number): string {
	if (content === undefined) return "";
	if (content.length > limit || content.includes("\0")) {
		throw new Error(
			`Obsidian note content is limited to ${limit.toLocaleString()} characters.`,
		);
	}
	return content;
}

function cliError(output: string): string | null {
	const detail = output.trim();
	return /^Error:\s*/i.test(detail)
		? detail.replace(/^Error:\s*/i, "").trim()
		: null;
}

async function runObsidianMutationCommand(
	vaultName: string,
	args: string[],
	dependencies: ObsidianBridgeDependencies,
): Promise<void> {
	const output = await runObsidianCommand(vaultName, args, dependencies);
	const error = cliError(output);
	if (error) throw new Error(`Obsidian CLI failed: ${error}`);
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
	includeGraph?: boolean;
	countOnly?: boolean;
	limit?: number;
};

export type ObsidianHybridSearchResult = {
	path: string;
	sources: Array<"filename" | "content" | "backlink" | "outgoing">;
	relatedTo?: string[];
	graphUnavailable?: Array<"backlinks" | "outgoing">;
};

const MAX_GRAPH_SEARCH_SEEDS = 12;

function parseBacklinkPaths(output: string): string[] {
	try {
		const parsed: unknown = JSON.parse(output.trim());
		if (!Array.isArray(parsed)) return [];
		return parsed.flatMap((item) => {
			if (typeof item === "string") return [portableVaultPath(item)];
			if (!item || typeof item !== "object") return [];
			const file = (item as { file?: unknown }).file;
			return typeof file === "string" ? [portableVaultPath(file)] : [];
		});
	} catch {
		return [];
	}
}

function parseOutgoingLinkPaths(output: string): string[] {
	return output
		.split(/\r?\n/)
		.map((path) => portableVaultPath(path.trim()))
		.filter((path) => path.toLowerCase().endsWith(".md"));
}

function pathIsWithinFolder(path: string, folder: string | undefined): boolean {
	if (!folder) return true;
	const prefix = `${portableVaultPath(folder).replace(/\/$/, "")}/`;
	return path === prefix.slice(0, -1) || path.startsWith(prefix);
}

async function graphAwareSearchResults(
	vaultName: string,
	directPaths: string[],
	filenamePaths: Set<string>,
	contentPaths: Set<string>,
	query: ObsidianSearchQuery,
	dependencies: ObsidianBridgeDependencies,
): Promise<ObsidianHybridSearchResult[]> {
	const results = new Map<string, ObsidianHybridSearchResult>();
	const add = (
		path: string,
		source: ObsidianHybridSearchResult["sources"][number],
		relatedTo?: string,
	) => {
		const portable = portableVaultPath(path);
		if (
			!portable.toLowerCase().endsWith(".md") ||
			!pathIsWithinFolder(portable, query.path)
		) {
			return;
		}
		const current = results.get(portable) ?? { path: portable, sources: [] };
		if (!current.sources.includes(source)) current.sources.push(source);
		if (relatedTo) {
			current.relatedTo ??= [];
			if (!current.relatedTo.includes(relatedTo)) {
				current.relatedTo.push(relatedTo);
			}
		}
		results.set(portable, current);
	};
	const markGraphUnavailable = (
		path: string,
		direction: NonNullable<
			ObsidianHybridSearchResult["graphUnavailable"]
		>[number],
	) => {
		const current = results.get(path);
		if (!current) return;
		current.graphUnavailable ??= [];
		if (!current.graphUnavailable.includes(direction)) {
			current.graphUnavailable.push(direction);
		}
	};

	for (const path of directPaths) {
		if (filenamePaths.has(path)) add(path, "filename");
		if (contentPaths.has(path)) add(path, "content");
	}

	for (const seed of directPaths.slice(0, MAX_GRAPH_SEARCH_SEEDS)) {
		const [backlinks, outgoing] = await Promise.allSettled([
			queryObsidianLinks(
				vaultName,
				{ kind: "backlinks", path: seed },
				dependencies,
			),
			queryObsidianLinks(
				vaultName,
				{ kind: "outgoing", path: seed },
				dependencies,
			),
		]);
		if (backlinks.status === "fulfilled") {
			for (const path of parseBacklinkPaths(backlinks.value)) {
				if (portableVaultPath(path) === seed) continue;
				add(path, "backlink", seed);
			}
		} else {
			markGraphUnavailable(seed, "backlinks");
		}
		if (outgoing.status === "fulfilled") {
			for (const path of parseOutgoingLinkPaths(outgoing.value)) {
				if (portableVaultPath(path) === seed) continue;
				add(path, "outgoing", seed);
			}
		} else {
			markGraphUnavailable(seed, "outgoing");
		}
	}

	const sourceWeight: Record<
		ObsidianHybridSearchResult["sources"][number],
		number
	> = { filename: 8, content: 4, backlink: 2, outgoing: 1 };
	const ranked = Array.from(results.values()).sort((left, right) => {
		const leftScore =
			left.sources.reduce((total, source) => total + sourceWeight[source], 0) +
			(left.relatedTo?.length ?? 0) * 2;
		const rightScore =
			right.sources.reduce((total, source) => total + sourceWeight[source], 0) +
			(right.relatedTo?.length ?? 0) * 2;
		return rightScore - leftScore || left.path.localeCompare(right.path);
	});
	const limit = query.limit ?? 200;
	const direct = ranked.filter((result) =>
		result.sources.some(
			(source) => source === "filename" || source === "content",
		),
	);
	const graphOnly = ranked.filter((result) =>
		result.sources.every(
			(source) => source !== "filename" && source !== "content",
		),
	);
	const graphSlots = Math.min(
		graphOnly.length,
		Math.max(1, Math.ceil(limit / 3)),
	);
	return [
		...direct.slice(0, Math.max(0, limit - graphSlots)),
		...graphOnly.slice(0, graphSlots),
	].slice(0, limit);
}

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
	if (query.includeGraph && (query.context || query.countOnly)) {
		throw new Error(
			"Graph-aware Obsidian search returns ranked note paths and cannot be combined with context or countOnly.",
		);
	}
	const args = [
		query.context && !query.countOnly ? "search:context" : "search",
		`query=${searchQuery}`,
		...optionalPathArgument(query.path),
		...(query.caseSensitive ? ["case"] : []),
		...(query.limit && !query.countOnly ? [`limit=${query.limit}`] : []),
		...(query.countOnly ? ["total"] : query.context ? [] : ["format=json"]),
	];
	const contentOutput = await runObsidianCommand(vaultName, args, dependencies);
	if (
		query.context ||
		query.countOnly ||
		!/^[\p{L}\p{N}\s._-]+$/u.test(searchQuery)
	) {
		return contentOutput;
	}
	let contentPaths: string[];
	try {
		const parsed: unknown = JSON.parse(contentOutput.trim());
		if (
			!Array.isArray(parsed) ||
			!parsed.every((item) => typeof item === "string")
		) {
			return contentOutput;
		}
		contentPaths = parsed;
	} catch {
		return contentOutput;
	}
	const filesOutput = await runObsidianCommand(
		vaultName,
		[
			"files",
			...(query.path ? [`folder=${safeVaultPath(query.path)}`] : []),
			"ext=md",
		],
		dependencies,
	);
	const needle = query.caseSensitive ? searchQuery : searchQuery.toLowerCase();
	const filenamePaths = filesOutput
		.split(/\r?\n/)
		.map((path) => path.trim())
		.filter(Boolean)
		.filter((path) => {
			const candidate = query.caseSensitive ? path : path.toLowerCase();
			return candidate.includes(needle);
		});
	const combined = Array.from(new Set([...filenamePaths, ...contentPaths]));
	if (query.includeGraph) {
		return JSON.stringify(
			await graphAwareSearchResults(
				vaultName,
				combined,
				new Set(filenamePaths),
				new Set(contentPaths),
				query,
				dependencies,
			),
		);
	}
	return JSON.stringify(combined.slice(0, query.limit ?? 200));
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

export type ObsidianTaskUpdateInput = {
	path: string;
	line: number;
	action: "toggle" | "done" | "todo" | "status";
	status?: string;
};

export async function updateObsidianTask(
	vaultName: string,
	input: ObsidianTaskUpdateInput,
	dependencies: ObsidianBridgeDependencies = {},
): Promise<ObsidianTaskUpdateInput> {
	const path = safeVaultPath(input.path, "task note path");
	if (
		!Number.isInteger(input.line) ||
		input.line < 1 ||
		input.line > 1_000_000
	) {
		throw new Error("Obsidian task line must be a positive integer.");
	}
	const status = input.status?.trim();
	if (
		input.action === "status" &&
		(!status || status.length !== 1 || /[\r\n\0]/.test(status))
	) {
		throw new Error("Obsidian custom task status must be one character.");
	}
	await runObsidianMutationCommand(
		vaultName,
		[
			"task",
			`path=${path}`,
			`line=${input.line}`,
			input.action === "status" ? `status=${status}` : input.action,
		],
		dependencies,
	);
	return {
		path,
		line: input.line,
		action: input.action,
		...(input.action === "status" ? { status } : {}),
	};
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

export type ObsidianPropertyType =
	| "text"
	| "list"
	| "number"
	| "checkbox"
	| "date"
	| "datetime";

export type ObsidianPropertyValue = string | number | boolean | string[];

function safePropertyName(name: string): string {
	const trimmed = name.trim();
	if (!trimmed || trimmed.length > 256 || /[\r\n\0]/.test(trimmed)) {
		throw new Error("Obsidian property name is invalid.");
	}
	return trimmed;
}

function propertyCliValue(
	type: ObsidianPropertyType,
	value: ObsidianPropertyValue,
): string {
	if (type === "list") {
		if (
			!Array.isArray(value) ||
			value.length > 100 ||
			value.some(
				(item) => !item.trim() || item.length > 512 || /[,\r\n\0]/.test(item),
			)
		) {
			throw new Error(
				"Obsidian list properties require up to 100 non-empty string items without commas.",
			);
		}
		return value.join(",");
	}
	if (type === "number") {
		if (typeof value !== "number" || !Number.isFinite(value)) {
			throw new Error("Obsidian number properties require a finite number.");
		}
		return String(value);
	}
	if (type === "checkbox") {
		if (typeof value !== "boolean") {
			throw new Error("Obsidian checkbox properties require a boolean.");
		}
		return value ? "true" : "false";
	}
	if (type !== "text" && type !== "date" && type !== "datetime") {
		throw new Error("Obsidian property type is invalid.");
	}
	if (
		typeof value !== "string" ||
		!value.trim() ||
		value.length > 4_096 ||
		/[\r\n\0]/.test(value)
	) {
		throw new Error(`Obsidian ${type} properties require a non-empty string.`);
	}
	return value;
}

export async function setObsidianProperty(
	vaultName: string,
	input: {
		path: string;
		name: string;
		type: ObsidianPropertyType;
		value: ObsidianPropertyValue;
	},
	dependencies: ObsidianBridgeDependencies = {},
): Promise<{
	path: string;
	name: string;
	type: ObsidianPropertyType;
	value: ObsidianPropertyValue;
}> {
	const path = safeVaultPath(input.path, "property note path");
	const name = safePropertyName(input.name);
	const value = propertyCliValue(input.type, input.value);
	await runObsidianMutationCommand(
		vaultName,
		[
			"property:set",
			`path=${path}`,
			`name=${name}`,
			`value=${value}`,
			`type=${input.type}`,
		],
		dependencies,
	);
	return { path, name, type: input.type, value: input.value };
}

export async function removeObsidianProperty(
	vaultName: string,
	input: { path: string; name: string },
	dependencies: ObsidianBridgeDependencies = {},
): Promise<{ path: string; name: string }> {
	const path = safeVaultPath(input.path, "property note path");
	const name = safePropertyName(input.name);
	await runObsidianMutationCommand(
		vaultName,
		["property:remove", `path=${path}`, `name=${name}`],
		dependencies,
	);
	return { path, name };
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

export async function createObsidianBaseItem(
	vaultName: string,
	input: {
		path: string;
		view?: string;
		name: string;
		content?: string;
		open?: boolean;
	},
	dependencies: ObsidianBridgeDependencies = {},
): Promise<{ basePath: string; view?: string; name: string }> {
	const basePath = safeVaultPath(input.path, "Base path");
	if (!basePath.toLowerCase().endsWith(".base")) {
		throw new Error("Obsidian Base item creation requires a .base file.");
	}
	const view = input.view?.trim();
	if (view && (view.length > 256 || /[\r\n\0]/.test(view))) {
		throw new Error("Obsidian Base view name is invalid.");
	}
	const name = safeVaultFilename(input.name);
	const content = safeNoteContent(input.content, MAX_OBSIDIAN_CREATE_CHARS);
	await runObsidianMutationCommand(
		vaultName,
		[
			"base:create",
			`path=${basePath}`,
			...(view ? [`view=${view}`] : []),
			`name=${name}`,
			...(content ? [`content=${content}`] : []),
			...(input.open ? ["open"] : []),
		],
		dependencies,
	);
	return { basePath, ...(view ? { view } : {}), name };
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

export async function readObsidianNote(
	vaultName: string,
	path: string,
	dependencies: ObsidianBridgeDependencies = {},
): Promise<string> {
	return runObsidianCommand(
		vaultName,
		["read", `path=${safeVaultPath(path, "note path")}`],
		dependencies,
	);
}

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

export async function readObsidianDailyNote(
	vaultName: string,
	dependencies: ObsidianBridgeDependencies = {},
): Promise<{ path: string; content: string }> {
	const resolved = await resolveObsidianCli(dependencies);
	const path = safeVaultPath(
		await runResolvedObsidianCommand(
			resolved,
			vaultName,
			["daily:path"],
			dependencies,
		),
		"daily note path",
	);
	const content = await runResolvedObsidianCommand(
		resolved,
		vaultName,
		["daily:read"],
		dependencies,
	);
	return { path, content };
}

export async function openObsidianDailyNote(
	vaultName: string,
	dependencies: ObsidianBridgeDependencies = {},
): Promise<{ path: string }> {
	const resolved = await resolveObsidianCli(dependencies);
	await runResolvedObsidianCommand(
		resolved,
		vaultName,
		["daily"],
		dependencies,
	);
	const path = safeVaultPath(
		await runResolvedObsidianCommand(
			resolved,
			vaultName,
			["daily:path"],
			dependencies,
		),
		"daily note path",
	);
	return { path };
}

export type ObsidianVaultInfo = {
	name: string;
	version: string;
	activeNote: string | null;
};

export async function queryObsidianVaultInfo(
	vaultName: string,
	dependencies: ObsidianBridgeDependencies = {},
): Promise<ObsidianVaultInfo> {
	const resolved = await resolveObsidianCli(dependencies);
	const version = await runResolvedObsidianCommand(
		resolved,
		vaultName,
		["version"],
		dependencies,
	);
	const activeOutput = await runResolvedObsidianCommand(
		resolved,
		vaultName,
		["file"],
		dependencies,
	);
	const activePath = outputField(activeOutput, "path");
	const activeNote = activePath ? portableVaultPath(activePath) : null;
	return { name: vaultName, version, activeNote };
}

export async function listObsidianTemplates(
	vaultName: string,
	countOnly = false,
	dependencies: ObsidianBridgeDependencies = {},
): Promise<string> {
	return runObsidianCommand(
		vaultName,
		["templates", ...(countOnly ? ["total"] : [])],
		dependencies,
	);
}

export async function listObsidianCommands(
	vaultName: string,
	dependencies: ObsidianBridgeDependencies = {},
): Promise<string> {
	return runObsidianCommand(vaultName, ["commands"], dependencies);
}

export async function executeObsidianCommand(
	vaultName: string,
	id: string,
	dependencies: ObsidianBridgeDependencies = {},
): Promise<void> {
	const commandId = id.trim();
	if (!commandId || commandId.length > 512 || /[\r\n\0]/.test(commandId)) {
		throw new Error("Obsidian command ID is invalid.");
	}
	const output = await runObsidianCommand(
		vaultName,
		["command", `id=${commandId}`],
		dependencies,
	);
	const error = cliError(output);
	if (error) throw new Error(`Obsidian CLI failed: ${error}`);
}

export async function readObsidianTemplate(
	vaultName: string,
	input: { name: string; resolve?: boolean; title?: string },
	dependencies: ObsidianBridgeDependencies = {},
): Promise<string> {
	const name = safeTemplateName(input.name);
	const title = input.title?.trim();
	if (title && (title.length > 512 || /[\r\n\0]/.test(title))) {
		throw new Error("Obsidian template title is invalid.");
	}
	const output = await runObsidianCommand(
		vaultName,
		[
			"template:read",
			`name=${name}`,
			...(input.resolve ? ["resolve"] : []),
			...(title ? [`title=${title}`] : []),
		],
		dependencies,
	);
	const error = cliError(output);
	if (error) throw new Error(`Obsidian CLI failed: ${error}`);
	return output;
}

export type ObsidianCreateNoteInput = {
	path: string;
	template?: string;
	content?: string;
	open?: boolean;
};

function templaterCreateCode(input: {
	path: string;
	template: string;
	content: string;
	open: boolean;
}): string {
	const payload = Buffer.from(JSON.stringify(input), "utf8").toString("base64");
	return [
		"(async()=>{",
		`const bytes=Uint8Array.from(atob("${payload}"),c=>c.charCodeAt(0));`,
		"const data=JSON.parse(new TextDecoder().decode(bytes));",
		'const plugin=app.plugins.plugins["templater-obsidian"];',
		'if(!plugin?.templater?.create_new_note_from_template)throw new Error("Templater is not enabled");',
		'const folder=String(plugin.settings?.templates_folder||"").replace(/^\\/+|\\/+$/g,"");',
		'const templatePath=[folder,data.template+".md"].filter(Boolean).join("/");',
		"const template=app.vault.getAbstractFileByPath(templatePath);",
		'if(!template)throw new Error("Template not found: "+data.template);',
		'const slash=data.path.lastIndexOf("/");',
		'const parent=slash<0?"":data.path.slice(0,slash);',
		'const name=(slash<0?data.path:data.path.slice(slash+1)).replace(/\\.md$/i,"");',
		"const file=await plugin.templater.create_new_note_from_template(template,parent,name,data.open);",
		'if(!file)throw new Error("Templater did not create the note");',
		"if(data.content)await app.vault.append(file,data.content);",
		"return JSON.stringify({path:file.path});",
		"})()",
	].join("");
}

function parseObsidianEvalJson(output: string): Record<string, unknown> {
	const error = cliError(output);
	if (error) throw new Error(`Obsidian CLI failed: ${error}`);
	const json = output.trim().replace(/^=>\s*/, "");
	try {
		return JSON.parse(json) as Record<string, unknown>;
	} catch {
		throw new Error("Obsidian returned an invalid note creation result.");
	}
}

export async function createObsidianNote(
	vaultName: string,
	input: ObsidianCreateNoteInput,
	dependencies: ObsidianBridgeDependencies = {},
): Promise<{ path: string }> {
	const path = safeVaultPath(input.path, "note path");
	if (!path.toLowerCase().endsWith(".md")) {
		throw new Error("Obsidian note creation requires a .md path.");
	}
	const content = safeNoteContent(input.content, MAX_OBSIDIAN_CREATE_CHARS);
	const template = input.template
		? safeTemplateName(input.template)
		: undefined;

	if (template) {
		const source = await readObsidianTemplate(
			vaultName,
			{ name: template },
			dependencies,
		);
		if (/tp\.system\.(?:prompt|suggester)\s*\(/.test(source)) {
			throw new Error(
				`Obsidian template "${template}" requires interactive Templater input and cannot run unattended.`,
			);
		}
		if (source.includes("<%")) {
			const output = await runObsidianCommand(
				vaultName,
				[
					"eval",
					`code=${templaterCreateCode({
						path,
						template,
						content,
						open: input.open === true,
					})}`,
				],
				dependencies,
			);
			const result = parseObsidianEvalJson(output);
			if (typeof result.path !== "string") {
				throw new Error("Templater did not report the created note path.");
			}
			return { path: safeVaultPath(result.path, "created note path") };
		}
	}

	const output = await runObsidianCommand(
		vaultName,
		[
			"create",
			`path=${path}`,
			...(template ? [`template=${template}`] : []),
			...(content ? [`content=${content}`] : []),
			...(input.open ? ["open"] : []),
		],
		dependencies,
	);
	const error = cliError(output);
	if (error) throw new Error(`Obsidian CLI failed: ${error}`);
	return { path };
}

export type ObsidianNoteMutationInput = {
	target: "active" | "daily" | "path";
	path?: string;
	content: string;
	open?: boolean;
};

export async function mutateObsidianNote(
	vaultName: string,
	action: "append" | "prepend",
	input: ObsidianNoteMutationInput,
	dependencies: ObsidianBridgeDependencies = {},
): Promise<{ path: string }> {
	const content = safeNoteContent(
		input.content,
		MAX_OBSIDIAN_APPEND_CHARS,
	).trim();
	if (!content) throw new Error("There is nothing to save to Obsidian.");
	if (input.target === "path" && !input.path) {
		throw new Error(
			"An exact vault path is required for this Obsidian target.",
		);
	}
	const exactPath = input.path
		? safeVaultPath(input.path, "note path")
		: undefined;
	const pathBeforeMutation =
		input.target === "active"
			? await getActiveObsidianNote(vaultName, dependencies)
			: exactPath;
	const command = input.target === "daily" ? `daily:${action}` : action;
	const output = await runObsidianCommand(
		vaultName,
		[
			command,
			...(input.target === "path" && exactPath ? [`path=${exactPath}`] : []),
			`content=${content}`,
		],
		dependencies,
	);
	const error = cliError(output);
	if (error) throw new Error(`Obsidian CLI failed: ${error}`);
	const path =
		input.target === "daily"
			? portableVaultPath(
					await runObsidianCommand(vaultName, ["daily:path"], dependencies),
				)
			: pathBeforeMutation;
	if (!path) throw new Error("Obsidian did not report the updated note path.");
	if (input.open) await openObsidianNote(vaultName, path, dependencies);
	return { path };
}

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

export async function getActiveObsidianNote(
	vaultName: string,
	dependencies: ObsidianBridgeDependencies = {},
	options: ObsidianCommandOptions = {},
): Promise<string> {
	const output = await runObsidianCommand(
		vaultName,
		["file"],
		dependencies,
		options,
	);
	const path = outputField(output, "path");
	if (!path)
		throw new Error("No active Obsidian note was found in this vault.");
	return portableVaultPath(path);
}

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

export async function moveObsidianFile(
	vaultName: string,
	input: { path: string; to: string },
	dependencies: ObsidianBridgeDependencies = {},
): Promise<{ path: string }> {
	const source = safeVaultPath(input.path, "source path");
	const destination = safeVaultPath(input.to, "destination path");
	const output = await runObsidianCommand(
		vaultName,
		["move", `path=${source}`, `to=${destination}`],
		dependencies,
	);
	const error = cliError(output);
	if (error) throw new Error(`Obsidian CLI failed: ${error}`);
	return { path: destination };
}

export async function renameObsidianFile(
	vaultName: string,
	input: { path: string; name: string },
	dependencies: ObsidianBridgeDependencies = {},
): Promise<{ path: string }> {
	const source = safeVaultPath(input.path, "source path");
	const name = safeVaultFilename(input.name);
	const output = await runObsidianCommand(
		vaultName,
		["rename", `path=${source}`, `name=${name}`],
		dependencies,
	);
	const error = cliError(output);
	if (error) throw new Error(`Obsidian CLI failed: ${error}`);
	const parent = dirname(source);
	return {
		path: parent === "." ? name : `${portableVaultPath(parent)}/${name}`,
	};
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
