import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { win32 } from "node:path";
import {
	type AcpExecutionTarget,
	acpExecutionTargetKey,
	normalizeAcpExecutionTarget,
} from "../lib/acpExecutionTarget";
import {
	isPathAccessibleFromRuntime,
	parseWslUncSyntax,
	toHostRuntimePath,
	toProviderRuntimePath,
} from "../lib/paths";
import {
	acpCmdShimCommand,
	acpLaunchUsesShell,
	findAcpExecutable,
} from "./acpExecutable";
import { childIsRunning, waitForChildExit } from "./childProcessLifecycle";

const WSL_ACP_PROCESS_GROUP_PREFIX = "/tmp/hlid-acp-";
const WSL_ACP_LAUNCH_SCRIPT =
	'umask 077; printf "%s\\n" "$$" > "$1"; shift; exec "$@"';
const WSL_ACP_TERMINATE_SCRIPT =
	'process_group_file=$1; attempt=0; while [ ! -r "$process_group_file" ] && [ "$attempt" -lt 20 ]; do attempt=$((attempt + 1)); sleep 0.05; done; if [ ! -r "$process_group_file" ]; then exit 0; fi; IFS= read -r process_group_id < "$process_group_file" || process_group_id=; rm -f -- "$process_group_file"; case "$process_group_id" in ""|*[!0-9]*) exit 0 ;; esac; /bin/kill -TERM -- "-$process_group_id" 2>/dev/null || exit 0; sleep 0.5; /bin/kill -KILL -- "-$process_group_id" 2>/dev/null || true';
const WSL_HELPER_TIMEOUT_MS = 2_500;
const WSL_PLATFORM_PROBE_TIMEOUT_MS = 2_500;
const WSL_PLATFORM_PROBE_SUCCESS_TTL_MS = 6 * 60 * 60_000;
const WSL_PLATFORM_PROBE_FAILURE_TTL_MS = 5_000;
const INTERNAL_MCP_ENV_PREFIX = "HLID_INTERNAL_MCP_";

type WslPlatform = {
	platform: NodeJS.Platform;
	architecture: NodeJS.Architecture;
};

type WslPlatformProbe = (
	distro: string,
	options: { signal?: AbortSignal; timeoutMs: number },
) => Promise<WslPlatform>;

type WslPlatformProbeCacheEntry = {
	probe: Promise<WslPlatform>;
	expiresAt: number;
};

const wslPlatformProbeCache = new Map<string, WslPlatformProbeCacheEntry>();

export type AcpTargetEnvironment = Record<string, string | undefined>;

export type AcpStartedProcess = {
	child: ChildProcessWithoutNullStreams;
	providerCwd: string;
	stderr: () => string;
	terminate: (graceMs: number, immediate?: boolean) => Promise<void>;
	initiateTermination: () => void;
};

export type AcpExecutionAdapterFactory = (
	target: AcpExecutionTarget | undefined,
) => AcpExecutionAdapter;

export type StartAcpTargetProcessInput = {
	command: string;
	args: string[];
	hostCwd: string;
	env: AcpTargetEnvironment;
	/** Exact values intentionally forwarded from the Windows host into WSL. */
	forwardedEnvNames?: string[];
	signal?: AbortSignal;
	spawnTimeoutMs: number;
	preparationTimeoutMs: number;
};

export type ResolveAcpTargetExecutablesOptions = {
	hostCwd: string;
	env: AcpTargetEnvironment;
	/** Exact host values intentionally forwarded while resolving in WSL. */
	forwardedEnvNames?: string[];
	signal?: AbortSignal;
	timeoutMs: number;
};

export interface AcpExecutionAdapter {
	readonly target: AcpExecutionTarget;
	readonly key: string;
	registryPlatform(options?: {
		signal?: AbortSignal;
		timeoutMs?: number;
	}): Promise<{
		platform: NodeJS.Platform;
		architecture: NodeJS.Architecture;
	}>;
	providerPath(hostCwd: string, path: string): string;
	pathAccessible(hostCwd: string, path: string): boolean;
	resolveExecutable(
		command: string,
		options: ResolveAcpTargetExecutablesOptions,
	): Promise<string | null>;
	start(input: StartAcpTargetProcessInput): Promise<AcpStartedProcess>;
	adaptMcpServer<T extends AcpMcpServerLike>(server: T, hostCwd: string): T;
}

type AcpMcpServerLike = {
	name: string;
	type?: "stdio" | "http" | "sse" | "acp";
	command?: string;
	args?: string[];
	env?: Array<{ name: string; value: string }>;
};

type Launch = {
	executable: string;
	args: string[];
	cwd?: string;
	env: AcpTargetEnvironment;
	shell: boolean;
	detached: boolean;
	wslTermination?: { distro: string; processGroupFile: string };
};

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function waitForSpawn(
	child: ChildProcessWithoutNullStreams,
	timeoutMs: number,
	signal?: AbortSignal,
): Promise<void> {
	if (signal?.aborted) {
		return Promise.reject(
			signal.reason ?? new Error("ACP process spawn cancelled"),
		);
	}
	if (child.pid !== undefined) return Promise.resolve();
	return new Promise((resolve, reject) => {
		let timer: ReturnType<typeof setTimeout> | undefined;
		const cleanup = () => {
			if (timer !== undefined) clearTimeout(timer);
			child.off("spawn", onSpawn);
			child.off("error", onError);
			signal?.removeEventListener("abort", onAbort);
		};
		const onSpawn = () => {
			cleanup();
			resolve();
		};
		const onError = (error: Error) => {
			cleanup();
			reject(error);
		};
		const onAbort = () => {
			cleanup();
			reject(signal?.reason ?? new Error("ACP process spawn cancelled"));
		};
		child.once("spawn", onSpawn);
		child.once("error", onError);
		timer = setTimeout(() => {
			cleanup();
			reject(new Error(`ACP process spawn timed out after ${timeoutMs}ms`));
		}, timeoutMs);
		if (signal?.aborted) onAbort();
		else signal?.addEventListener("abort", onAbort, { once: true });
	});
}

function withWslEnvironment(
	environment: AcpTargetEnvironment,
	forwardedNames: Iterable<string>,
	flag: "u" | "w",
): AcpTargetEnvironment {
	const forwarded = new Map(
		[...forwardedNames]
			.filter((name) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name))
			.map((name) => [name.toUpperCase(), name] as const),
	);
	const sanitizedEnvironment = Object.fromEntries(
		Object.entries(environment).filter(
			([name]) => name.toUpperCase() !== "WSLENV",
		),
	);
	return {
		...sanitizedEnvironment,
		WSLENV: [...forwarded.values()]
			.sort((a, b) => a.localeCompare(b))
			.map((name) => `${name}/${flag}`)
			.join(":"),
	};
}

export function windowsPathToWsl(value: string): string | null {
	const match = value.match(/^([A-Za-z]):[\\/](.*)$/);
	if (!match) return null;
	return `/mnt/${match[1].toLowerCase()}/${match[2].replaceAll("\\", "/")}`;
}

function internalMcpEnvironmentNames(server: AcpMcpServerLike): string[] {
	return (server.env ?? [])
		.map((entry) => entry.name)
		.filter(
			(name) =>
				name === "HLID_SKIP_SELF_INSTALL" ||
				name.startsWith(INTERNAL_MCP_ENV_PREFIX),
		);
}

function adaptInternalMcpServer<T extends AcpMcpServerLike>(server: T): T {
	if (!server.command) return server;
	const serverCommand = server.command;
	const internalNames = internalMcpEnvironmentNames(server);
	if (internalNames.length === 0) return server;
	const command = windowsPathToWsl(serverCommand);
	if (!command) {
		throw new Error(
			`Hlid's internal MCP executable is not visible from WSL: ${serverCommand}`,
		);
	}
	const args = (server.args ?? []).map((arg, index) => {
		if (index !== 0) return arg;
		return windowsPathToWsl(arg) ?? arg;
	});
	const wslEnv = withWslEnvironment({}, internalNames, "w").WSLENV;
	return {
		...server,
		command,
		args,
		env: [
			...(server.env ?? []).filter(
				(entry) => entry.name.toUpperCase() !== "WSLENV",
			),
			{ name: "WSLENV", value: wslEnv ?? "" },
		],
	};
}

function spawnWindowsTaskkill(pid: number) {
	const systemRoot =
		process.env.SystemRoot ?? process.env.WINDIR ?? "C:\\Windows";
	return spawn(
		win32.join(systemRoot, "System32", "taskkill.exe"),
		["/PID", String(pid), "/T", "/F"],
		{ stdio: "ignore", windowsHide: true },
	);
}

async function runHelper(
	executable: string,
	args: string[],
	env: AcpTargetEnvironment,
	timeoutMs = WSL_HELPER_TIMEOUT_MS,
): Promise<void> {
	await new Promise<void>((resolve) => {
		let settled = false;
		let helper: ReturnType<typeof spawn> | undefined;
		const finish = () => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve();
		};
		const timer = setTimeout(() => {
			helper?.kill();
			finish();
		}, timeoutMs);
		try {
			helper = spawn(executable, args, {
				env,
				windowsHide: true,
				stdio: "ignore",
			});
			helper.once("close", finish);
			helper.once("error", finish);
		} catch {
			finish();
		}
	});
}

async function terminateWindowsChild(
	child: ChildProcessWithoutNullStreams,
	graceMs: number,
	immediate: boolean,
): Promise<void> {
	if (await childAlreadyStopped(child, graceMs, immediate)) return;
	if (child.pid) {
		const killer = spawnWindowsTaskkill(child.pid);
		await waitForChildExit(killer, graceMs).catch(() => false);
		killer.kill();
	}
	if (childIsRunning(child)) child.kill("SIGKILL");
	await waitForChildExit(child, graceMs);
}

async function terminatePosixChild(
	child: ChildProcessWithoutNullStreams,
	graceMs: number,
	immediate: boolean,
): Promise<void> {
	if (await childAlreadyStopped(child, graceMs, immediate)) return;
	const pid = child.pid;
	try {
		if (pid) process.kill(-pid, "SIGTERM");
		else child.kill("SIGTERM");
	} catch {
		child.kill("SIGTERM");
	}
	if (await waitForChildExit(child, graceMs)) return;
	try {
		if (pid) process.kill(-pid, "SIGKILL");
		else child.kill("SIGKILL");
	} catch {
		child.kill("SIGKILL");
	}
	await waitForChildExit(child, graceMs);
}

async function childAlreadyStopped(
	child: ChildProcessWithoutNullStreams,
	graceMs: number,
	immediate: boolean,
): Promise<boolean> {
	if (!childIsRunning(child)) return true;
	if (immediate) return false;
	child.stdin.end();
	return waitForChildExit(child, Math.min(100, graceMs));
}

type CapturedWslProcessOptions<T> = {
	launch: Pick<Launch, "executable" | "args" | "env">;
	signal?: AbortSignal;
	timeoutMs: number;
	maxOutput: number;
	cancelledMessage: string;
	timeoutMessage: string;
	closeError?: (code: number | null) => Error | undefined;
	map: (output: string) => T;
};

function captureWslProcess<T>(
	options: CapturedWslProcessOptions<T>,
): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const child = spawn(options.launch.executable, options.launch.args, {
			env: options.launch.env,
			windowsHide: true,
			stdio: ["ignore", "pipe", "ignore"],
		});
		let output = "";
		let settled = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const cleanup = () => {
			if (timer !== undefined) clearTimeout(timer);
			options.signal?.removeEventListener("abort", onAbort);
		};
		const finish = (error?: unknown) => {
			if (settled) return;
			settled = true;
			cleanup();
			if (error) reject(error);
			else resolve(options.map(output));
		};
		const terminate = (error: unknown) => {
			if (settled) return;
			settled = true;
			cleanup();
			const complete = () => reject(error);
			if (process.platform !== "win32" || !child.pid) {
				child.kill();
				complete();
				return;
			}
			const killer = spawnWindowsTaskkill(child.pid);
			void waitForChildExit(killer, WSL_HELPER_TIMEOUT_MS)
				.catch(() => false)
				.finally(() => {
					killer.kill();
					if (childIsRunning(child)) child.kill("SIGKILL");
					complete();
				});
		};
		const onAbort = () => {
			terminate(options.signal?.reason ?? new Error(options.cancelledMessage));
		};
		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => {
			output = `${output}${chunk}`.slice(-options.maxOutput);
		});
		child.once("error", finish);
		child.once("close", (code) => finish(options.closeError?.(code)));
		timer = setTimeout(() => {
			terminate(new Error(options.timeoutMessage));
		}, options.timeoutMs);
		if (options.signal?.aborted) onAbort();
		else options.signal?.addEventListener("abort", onAbort, { once: true });
	});
}

function hostAdapter(target: AcpExecutionTarget): AcpExecutionAdapter {
	return {
		target,
		key: acpExecutionTargetKey(target),
		registryPlatform: async () => ({
			platform: process.platform,
			architecture: process.arch,
		}),
		providerPath: (hostCwd, path) =>
			parseWslUncSyntax(hostCwd) && path.startsWith("/")
				? toHostRuntimePath(hostCwd, path)
				: path,
		pathAccessible: () => true,
		resolveExecutable: (command, options) =>
			findAcpExecutable(command, {
				cwd: options.hostCwd,
				env: options.env,
			}),
		start: async (input) => {
			const resolved = await findAcpExecutable(input.command, {
				cwd: input.hostCwd,
				env: input.env,
			});
			if (!resolved) throw new Error(`${input.command} is not installed`);
			const useShell = acpLaunchUsesShell(resolved);
			const launch: Launch = {
				executable: useShell
					? acpCmdShimCommand(resolved, input.args)
					: resolved,
				args: useShell ? [] : input.args,
				cwd: input.hostCwd,
				env: input.env,
				shell: useShell,
				detached: process.platform !== "win32",
			};
			return spawnLaunch(launch, input);
		},
		adaptMcpServer: (server) => server,
	};
}

async function probeWslRegistryPlatform(
	distro: string,
	options: { signal?: AbortSignal; timeoutMs: number },
): Promise<WslPlatform> {
	const timeoutMs = options.timeoutMs;
	const architecture = await captureWslProcess({
		launch: {
			executable: "wsl.exe",
			args: ["-d", distro, "--exec", "uname", "-m"],
			env: withWslEnvironment(process.env, [], "u"),
		},
		signal: options.signal,
		timeoutMs,
		maxOutput: 256,
		cancelledMessage: "WSL platform probe cancelled",
		timeoutMessage: `WSL platform probe timed out after ${timeoutMs}ms`,
		closeError: (code) =>
			code === 0 ? undefined : new Error(`WSL uname exited ${code}`),
		map: wslArchitectureFromUname,
	});
	return { platform: "linux", architecture };
}

async function wslRegistryPlatform(
	distro: string,
	options: { signal?: AbortSignal; timeoutMs?: number } = {},
	probePlatform: WslPlatformProbe = probeWslRegistryPlatform,
): Promise<WslPlatform> {
	const timeoutMs = Math.max(
		options.timeoutMs ?? 0,
		WSL_PLATFORM_PROBE_TIMEOUT_MS,
	);
	// Abortable callers own their probe. Normal registry discovery is shared
	// process-wide so every integration reuses one exact distro observation.
	if (options.signal) {
		return probePlatform(distro, { signal: options.signal, timeoutMs });
	}
	const key = distro.trim().toLowerCase();
	const now = Date.now();
	const cached = wslPlatformProbeCache.get(key);
	if (cached && cached.expiresAt > now) return cached.probe;

	const pending = probePlatform(distro, { timeoutMs });
	const entry: WslPlatformProbeCacheEntry = {
		probe: pending,
		expiresAt: now + WSL_PLATFORM_PROBE_SUCCESS_TTL_MS,
	};
	wslPlatformProbeCache.set(key, entry);
	void pending.catch(() => {
		if (wslPlatformProbeCache.get(key) === entry) {
			entry.expiresAt = Date.now() + WSL_PLATFORM_PROBE_FAILURE_TTL_MS;
		}
	});
	return pending;
}

function clearWslPlatformProbeCache(): void {
	wslPlatformProbeCache.clear();
}

export function wslArchitectureFromUname(value: string): NodeJS.Architecture {
	const normalized = value.trim().toLowerCase();
	if (normalized === "x86_64" || normalized === "amd64") return "x64";
	if (normalized === "aarch64" || normalized === "arm64") return "arm64";
	throw new Error(`Unsupported WSL architecture: ${normalized || "unknown"}`);
}

const WSL_ACP_FILTER_INHERITED_WINDOWS_PATH =
	'IFS=: read -r -a hlid_path_entries <<< "$PATH"; hlid_path=(); for hlid_dir in "$' +
	'{hlid_path_entries[@]}"; do case "$hlid_dir" in /mnt/[A-Za-z]/*) ;; *) hlid_path+=("$hlid_dir") ;; esac; done; PATH=$(IFS=:; printf "%s" "$' +
	'{hlid_path[*]}"); ';

function wslExecutableSearchPathScript(forwardedEnvNames: string[]): string {
	// Linux environment names are case-sensitive. Only an exact PATH override
	// replaces the inherited WSL search path; `Path` remains a distinct variable.
	return forwardedEnvNames.some((name) => name === "PATH")
		? ""
		: WSL_ACP_FILTER_INHERITED_WINDOWS_PATH;
}

function wslExecutableProbeLaunch(
	distro: string,
	command: string,
	providerCwd: string,
	env: AcpTargetEnvironment,
	forwardedEnvNames: string[],
): Pick<Launch, "executable" | "args" | "env"> {
	const filterInheritedWindowsPath =
		wslExecutableSearchPathScript(forwardedEnvNames);
	const script = command.includes("/")
		? 'candidate=$1; [ -f "$candidate" ] && [ -x "$candidate" ] && printf "%s\\n" "$candidate"'
		: `${filterInheritedWindowsPath}command -v -- "$1" 2>/dev/null || true`;
	return {
		executable: "wsl.exe",
		args: [
			"-d",
			distro,
			"--cd",
			providerCwd,
			"--exec",
			"bash",
			"-lc",
			script,
			"hlid-acp-resolve",
			command,
		],
		env: withWslEnvironment(env, forwardedEnvNames, "u"),
	};
}

async function resolveWslExecutable(
	distro: string,
	command: string,
	hostCwd: string,
	env: AcpTargetEnvironment,
	forwardedEnvNames: string[],
	timeoutMs: number,
	signal?: AbortSignal,
): Promise<string | null> {
	if (!command) return null;
	const providerCwd = wslProviderPath(distro, hostCwd, hostCwd);
	if (!providerCwd.startsWith("/")) return null;
	const launch = wslExecutableProbeLaunch(
		distro,
		command,
		providerCwd,
		env,
		forwardedEnvNames,
	);
	return captureWslProcess({
		launch,
		signal,
		timeoutMs,
		maxOutput: 4_096,
		cancelledMessage: "WSL executable resolution cancelled",
		timeoutMessage: `WSL executable resolution timed out after ${timeoutMs}ms`,
		map: (output) => {
			const candidate = output.trim().split(/\r?\n/).at(-1) ?? "";
			return candidate.startsWith("/") ? candidate : null;
		},
	});
}

function wslProviderPath(
	distro: string,
	hostCwd: string,
	path: string,
): string {
	const runtime = parseWslUncSyntax(hostCwd);
	if (runtime) {
		if (runtime.distro.toLowerCase() !== distro.toLowerCase()) return path;
		return toProviderRuntimePath(hostCwd, path);
	}
	const resource = parseWslUncSyntax(path);
	if (resource) {
		return resource.distro.toLowerCase() === distro.toLowerCase()
			? resource.posixPath
			: path;
	}
	return windowsPathToWsl(path) ?? path;
}

function wslPathAccessible(
	distro: string,
	hostCwd: string,
	path: string,
): boolean {
	const runtime = parseWslUncSyntax(hostCwd);
	if (runtime && runtime.distro.toLowerCase() !== distro.toLowerCase()) {
		return false;
	}
	const resource = parseWslUncSyntax(path);
	if (resource && resource.distro.toLowerCase() !== distro.toLowerCase()) {
		return false;
	}
	return isPathAccessibleFromRuntime(hostCwd, path);
}

function wslLaunch(
	distro: string,
	executable: string,
	input: StartAcpTargetProcessInput,
): Launch {
	const providerCwd = wslProviderPath(distro, input.hostCwd, input.hostCwd);
	if (!providerCwd.startsWith("/")) {
		throw new Error(
			`ACP target WSL · ${distro} cannot access ${input.hostCwd}`,
		);
	}
	const processGroupFile = `${WSL_ACP_PROCESS_GROUP_PREFIX}${randomUUID()}.pid`;
	const forwardedNames = (input.forwardedEnvNames ?? []).filter(
		(name) => name.toUpperCase() !== "WSLENV",
	);
	return {
		executable: "wsl.exe",
		args: [
			"-d",
			distro,
			"--cd",
			providerCwd,
			"--exec",
			"setsid",
			"-w",
			"sh",
			"-c",
			WSL_ACP_LAUNCH_SCRIPT,
			"hlid-acp",
			processGroupFile,
			executable,
			...input.args,
		],
		env: withWslEnvironment(input.env, forwardedNames, "u"),
		shell: false,
		detached: false,
		wslTermination: { distro, processGroupFile },
	};
}

async function terminateWslLaunch(
	child: ChildProcessWithoutNullStreams,
	termination: NonNullable<Launch["wslTermination"]>,
	graceMs: number,
	immediate: boolean,
): Promise<void> {
	if (!immediate && childIsRunning(child)) {
		child.stdin.end();
		await waitForChildExit(child, Math.min(100, graceMs));
	}
	const helper = wslTerminationHelper(termination);
	await runHelper(helper.executable, helper.args, helper.env);
	await waitForChildExit(child, graceMs);
	if (childIsRunning(child)) {
		await terminateWindowsChild(child, graceMs, true);
	}
}

function wslTerminationHelper(
	termination: NonNullable<Launch["wslTermination"]>,
): Pick<Launch, "executable" | "args" | "env"> {
	return {
		executable: "wsl.exe",
		args: [
			"-d",
			termination.distro,
			"--exec",
			"sh",
			"-c",
			WSL_ACP_TERMINATE_SCRIPT,
			"hlid-acp-stop",
			termination.processGroupFile,
		],
		env: withWslEnvironment(process.env, [], "u"),
	};
}

async function spawnLaunch(
	launch: Launch,
	input: StartAcpTargetProcessInput,
): Promise<AcpStartedProcess> {
	let child: ChildProcessWithoutNullStreams;
	try {
		child = spawn(launch.executable, launch.args, {
			cwd: launch.cwd,
			env: launch.env,
			stdio: ["pipe", "pipe", "pipe"],
			windowsHide: true,
			detached: launch.detached,
			shell: launch.shell,
		});
	} catch (error) {
		throw new Error(`ACP process spawn failed: ${errorText(error)}`, {
			cause: error,
		});
	}
	let capturedStderr = "";
	child.stderr.setEncoding("utf8");
	child.stderr.on("data", (chunk: string) => {
		capturedStderr = `${capturedStderr}${chunk}`.slice(-8_000);
	});
	const terminate = (graceMs: number, immediate = false) =>
		launch.wslTermination
			? terminateWslLaunch(child, launch.wslTermination, graceMs, immediate)
			: process.platform === "win32"
				? terminateWindowsChild(child, graceMs, immediate)
				: terminatePosixChild(child, graceMs, immediate);
	try {
		await waitForSpawn(child, input.spawnTimeoutMs, input.signal);
	} catch (error) {
		await terminate(750, true);
		throw new Error(`ACP process spawn failed: ${errorText(error)}`, {
			cause: error,
		});
	}
	return {
		child,
		providerCwd: launch.wslTermination
			? wslProviderPath(
					launch.wslTermination.distro,
					input.hostCwd,
					input.hostCwd,
				)
			: input.hostCwd,
		stderr: () => capturedStderr,
		terminate,
		initiateTermination: () => {
			void terminate(750, true);
		},
	};
}

function wslAdapter(
	target: Extract<AcpExecutionTarget, { kind: "wsl" }>,
): AcpExecutionAdapter {
	return {
		target,
		key: acpExecutionTargetKey(target),
		registryPlatform: (options) => wslRegistryPlatform(target.distro, options),
		providerPath: (hostCwd, path) =>
			wslProviderPath(target.distro, hostCwd, path),
		pathAccessible: (hostCwd, path) =>
			wslPathAccessible(target.distro, hostCwd, path),
		resolveExecutable: (command, options) =>
			resolveWslExecutable(
				target.distro,
				command,
				options.hostCwd,
				options.env,
				options.forwardedEnvNames ?? [],
				options.timeoutMs,
				options.signal,
			),
		start: async (input) => {
			const executable = await resolveWslExecutable(
				target.distro,
				input.command,
				input.hostCwd,
				input.env,
				input.forwardedEnvNames ?? [],
				input.preparationTimeoutMs,
				input.signal,
			);
			if (!executable) throw new Error(`${input.command} is not installed`);
			return spawnLaunch(wslLaunch(target.distro, executable, input), input);
		},
		adaptMcpServer: (server) => adaptInternalMcpServer(server),
	};
}

export function createAcpExecutionAdapter(
	target: AcpExecutionTarget | undefined,
): AcpExecutionAdapter {
	const normalized = normalizeAcpExecutionTarget(target);
	return normalized.kind === "wsl"
		? wslAdapter(normalized)
		: hostAdapter(normalized);
}

// fallow-ignore-next-line unused-export -- Vitest imports these test seams for exact WSL argv, environment, path, and cleanup assertions.
export const acpExecutionAdapterInternals = {
	withWslEnvironment,
	windowsPathToWsl,
	wslProviderPath,
	wslPathAccessible,
	adaptInternalMcpServer,
	wslLaunch,
	wslTerminationHelper,
	wslExecutableProbeLaunch,
	wslRegistryPlatform,
	clearWslPlatformProbeCache,
};
