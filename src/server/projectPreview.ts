import { type ChildProcess, spawn } from "node:child_process";
import {
	createConnection,
	createServer,
	isIP,
	type Server,
	type Socket,
} from "node:net";
import { isAbsolute, posix, resolve, win32 } from "node:path";
import { parseWslUncSyntax } from "#/lib/paths";
import { projectPreviewBrowserManager } from "./projectPreviewBrowser";
import { disposeProjectPreviewRelay } from "./projectPreviewRelay";
import {
	createProjectPreviewCapability,
	PROJECT_PREVIEW_AUTH_ENV,
	type ProjectPreviewCapability,
} from "./projectPreviewTrust";
import type { ProjectPreviewSnapshot } from "./protocol";
import { broadcast } from "./runState";

export type StartProjectPreviewInput = {
	sessionId: string;
	runtimeCwd: string;
	command: string;
	port: number;
	path?: string;
	workingDirectory?: string;
	label?: string;
	present?: boolean;
	replaceExisting?: boolean;
	readinessTimeoutSeconds?: number;
};

type PreviewEntry = {
	snapshot: ProjectPreviewSnapshot;
	child: ChildProcess;
	wslTermination: ProjectPreviewWslTermination | null;
	input: StartProjectPreviewInput;
	bridge: LoopbackBridge | null;
	capability: ProjectPreviewCapability | null;
	stopping: boolean;
	stopPromise: Promise<ProjectPreviewSnapshot> | null;
	lifetimeTimer: ReturnType<typeof setTimeout>;
	persistTimer: ReturnType<typeof setTimeout> | null;
};

type LoopbackBridge = {
	server: Server;
	sockets: Set<Socket>;
	close: () => Promise<void>;
};

const MAX_LOG_LINES = 200;
const MAX_LOG_LINE_CHARS = 2_000;
export const PROJECT_PREVIEW_LIFETIME_MS = 4 * 60 * 60 * 1_000;
const PROJECT_PREVIEW_BROWSER_CLOSE_TIMEOUT_MS = 5_000;

type ProjectPreviewManagerOptions = {
	lifetimeMs?: number;
	browserCloseTimeoutMs?: number;
	persist?: (preview: ProjectPreviewSnapshot) => Promise<void>;
	browserManager?: Pick<
		typeof projectPreviewBrowserManager,
		"close" | "closeAll"
	>;
	capabilityFactory?: () => ProjectPreviewCapability;
};

function normalizePreviewPath(value = "/"): string {
	const trimmed = value.trim();
	if (!trimmed.startsWith("/") || trimmed.startsWith("//")) {
		throw new Error("Preview path must start with a single slash.");
	}
	return trimmed;
}

export function resolveProjectPreviewCwd(
	runtimeCwd: string,
	workingDirectory?: string,
	platform: NodeJS.Platform = process.platform,
): string {
	if (!workingDirectory || workingDirectory === ".") return runtimeCwd;
	if (
		isAbsolute(workingDirectory) ||
		/^[A-Za-z]:[\\/]/.test(workingDirectory) ||
		workingDirectory.startsWith("\\\\")
	) {
		throw new Error(
			"working_directory must be relative to the active workspace.",
		);
	}

	const wsl = parseWslUncSyntax(runtimeCwd);
	if (wsl) {
		const logical = posix.resolve(wsl.posixPath, workingDirectory);
		const root = wsl.posixPath.endsWith("/")
			? wsl.posixPath
			: `${wsl.posixPath}/`;
		if (logical !== wsl.posixPath && !logical.startsWith(root)) {
			throw new Error("working_directory cannot leave the active workspace.");
		}
		const share = runtimeCwd.match(
			/^(\\\\(?:wsl\$|wsl\.localhost)\\[^\\]+)/i,
		)?.[1];
		if (!share) throw new Error("Could not resolve the WSL workspace.");
		return `${share}\\${logical.slice(1).replaceAll("/", "\\")}`;
	}

	const resolved =
		platform === "win32"
			? win32.resolve(runtimeCwd, workingDirectory)
			: resolve(runtimeCwd, workingDirectory);
	const root =
		runtimeCwd.endsWith("/") || runtimeCwd.endsWith("\\")
			? runtimeCwd
			: `${runtimeCwd}${platform === "win32" ? "\\" : "/"}`;
	const comparable = platform === "win32" ? resolved.toLowerCase() : resolved;
	const comparableRoot = platform === "win32" ? root.toLowerCase() : root;
	if (
		comparable !== comparableRoot.slice(0, -1) &&
		!comparable.startsWith(comparableRoot)
	) {
		throw new Error("working_directory cannot leave the active workspace.");
	}
	return resolved;
}

export type ProjectPreviewLaunch = {
	executable: string;
	args: string[];
	cwd?: string;
	shell: boolean;
	detached: boolean;
	wslTermination?: ProjectPreviewWslTermination;
};

export type ProjectPreviewWslTermination = {
	distro: string;
	processGroupFile: string;
};

type ProjectPreviewHelperLaunch = {
	executable: string;
	args: string[];
};

const HLID_SKIP_SELF_INSTALL = "HLID_SKIP_SELF_INSTALL";
const WSL_PREVIEW_PROCESS_GROUP_PREFIX = "/tmp/hlid-project-preview-";
const WSL_PREVIEW_LAUNCH_SCRIPT =
	'umask 077; printf "%s\\n" "$$" > "$2"; exec sh -lc "$1"';
const WSL_PREVIEW_TERMINATE_SCRIPT =
	'process_group_file=$1; if [ ! -r "$process_group_file" ]; then exit 0; fi; IFS= read -r process_group_id < "$process_group_file" || process_group_id=; rm -f -- "$process_group_file"; case "$process_group_id" in ""|*[!0-9]*) exit 0 ;; esac; /bin/kill -TERM -- "-$process_group_id" 2>/dev/null || exit 0; sleep 0.5; /bin/kill -KILL -- "-$process_group_id" 2>/dev/null || true';
const PROCESS_HELPER_TIMEOUT_MS = 2_500;

export function projectPreviewEnvironment(
	environment: NodeJS.ProcessEnv = process.env,
	capability?: ProjectPreviewCapability,
): NodeJS.ProcessEnv {
	const forwardedNames = new Set([
		HLID_SKIP_SELF_INSTALL,
		PROJECT_PREVIEW_AUTH_ENV,
	]);
	const wslEnvironment = (environment.WSLENV ?? "")
		.split(":")
		.filter(
			(entry) =>
				entry &&
				!forwardedNames.has(entry.split("/", 1)[0]?.toUpperCase() ?? ""),
		);
	const result: NodeJS.ProcessEnv = {
		...environment,
		[HLID_SKIP_SELF_INSTALL]: "1",
		WSLENV: [
			`${HLID_SKIP_SELF_INSTALL}/u`,
			...(capability ? [`${PROJECT_PREVIEW_AUTH_ENV}/u`] : []),
			...wslEnvironment,
		].join(":"),
	};
	if (capability) result[PROJECT_PREVIEW_AUTH_ENV] = capability.token;
	else delete result[PROJECT_PREVIEW_AUTH_ENV];
	return result;
}

export function projectPreviewLaunch(
	command: string,
	cwd: string,
	platform: NodeJS.Platform = process.platform,
	processGroupFile?: string,
): ProjectPreviewLaunch {
	const wsl = parseWslUncSyntax(cwd);
	if (platform === "win32" && wsl) {
		const receipt =
			processGroupFile ??
			`${WSL_PREVIEW_PROCESS_GROUP_PREFIX}${crypto.randomUUID()}.pid`;
		return {
			executable: "wsl.exe",
			args: [
				"-d",
				wsl.distro,
				"--cd",
				wsl.posixPath,
				"--exec",
				"setsid",
				"-w",
				"sh",
				"-c",
				WSL_PREVIEW_LAUNCH_SCRIPT,
				"hlid-project-preview",
				command,
				receipt,
			],
			shell: false,
			detached: false,
			wslTermination: {
				distro: wsl.distro,
				processGroupFile: receipt,
			},
		};
	}
	return {
		executable: command,
		args: [],
		cwd,
		shell: true,
		detached: platform !== "win32",
	};
}

function spawnPreview(
	command: string,
	cwd: string,
	capability: ProjectPreviewCapability,
): {
	child: ChildProcess;
	wslTermination: ProjectPreviewWslTermination | null;
} {
	const launch = projectPreviewLaunch(command, cwd);
	const child = spawn(launch.executable, launch.args, {
		cwd: launch.cwd,
		shell: launch.shell,
		detached: launch.detached,
		windowsHide: true,
		stdio: ["ignore", "pipe", "pipe"],
		env: projectPreviewEnvironment(process.env, capability),
	});
	return { child, wslTermination: launch.wslTermination ?? null };
}

export function parseWslIpv4Address(output: string): string | undefined {
	return output
		.trim()
		.split(/\s+/)
		.find(
			(candidate) => isIP(candidate) === 4 && !candidate.startsWith("127."),
		);
}

async function resolveWslIpv4Address(
	distro: string,
): Promise<string | undefined> {
	return new Promise((resolveResult) => {
		const child = spawn("wsl.exe", ["-d", distro, "--exec", "hostname", "-I"], {
			windowsHide: true,
			stdio: ["ignore", "pipe", "ignore"],
		});
		let stdout = "";
		let settled = false;
		const finish = (value?: string) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolveResult(value);
		};
		const timer = setTimeout(() => {
			child.kill();
			finish();
		}, 5_000);
		timer.unref?.();
		child.stdout?.on("data", (chunk: Buffer) => {
			if (stdout.length < 4_096) stdout += chunk.toString("utf8");
		});
		child.once("error", () => finish());
		child.once("close", (code) =>
			finish(code === 0 ? parseWslIpv4Address(stdout) : undefined),
		);
	});
}

async function canConnect(port: number, host = "127.0.0.1"): Promise<boolean> {
	return new Promise((resolveResult) => {
		const socket = createConnection({ host, port });
		const finish = (result: boolean) => {
			socket.destroy();
			resolveResult(result);
		};
		socket.setTimeout(350);
		socket.once("connect", () => finish(true));
		socket.once("timeout", () => finish(false));
		socket.once("error", () => finish(false));
	});
}

export async function createProjectPreviewLoopbackBridge(
	localPort: number,
	targetHost: string,
	targetPort = localPort,
): Promise<LoopbackBridge> {
	const sockets = new Set<Socket>();
	const track = (socket: Socket) => {
		sockets.add(socket);
		socket.once("close", () => sockets.delete(socket));
		return socket;
	};
	const server = createServer((client) => {
		track(client);
		const upstream = track(
			createConnection({ host: targetHost, port: targetPort }),
		);
		const closePair = () => {
			client.destroy();
			upstream.destroy();
		};
		client.once("error", closePair);
		upstream.once("error", closePair);
		client.pipe(upstream).pipe(client);
	});
	await new Promise<void>((resolveResult, reject) => {
		server.once("error", reject);
		server.listen(localPort, "127.0.0.1", () => {
			server.off("error", reject);
			resolveResult();
		});
	});
	server.on("error", () => {
		for (const socket of sockets) socket.destroy();
	});
	return {
		server,
		sockets,
		close: async () => {
			for (const socket of sockets) socket.destroy();
			await new Promise<void>((resolveResult) =>
				server.close(() => resolveResult()),
			);
		},
	};
}

async function waitForPortRelease(
	port: number,
	timeoutMs = 5_000,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (!(await canConnect(port))) return;
		await new Promise((resolveResult) => setTimeout(resolveResult, 100));
	}
	throw new Error(
		`Preview process stopped, but port ${port} did not become available for restart.`,
	);
}

export function projectPreviewWslTerminationLaunch(
	termination: ProjectPreviewWslTermination,
): ProjectPreviewHelperLaunch {
	return {
		executable: "wsl.exe",
		args: [
			"-d",
			termination.distro,
			"--exec",
			"sh",
			"-c",
			WSL_PREVIEW_TERMINATE_SCRIPT,
			"hlid-project-preview-stop",
			termination.processGroupFile,
		],
	};
}

async function runBoundedProcessHelper(
	launch: ProjectPreviewHelperLaunch,
	timeoutMs = PROCESS_HELPER_TIMEOUT_MS,
): Promise<void> {
	await new Promise<void>((resolveResult) => {
		let settled = false;
		let helper: ChildProcess | undefined;
		const finish = () => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolveResult();
		};
		const timer = setTimeout(() => {
			try {
				helper?.kill();
			} catch {}
			finish();
		}, timeoutMs);
		try {
			helper = spawn(launch.executable, launch.args, {
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

function childIsRunning(child: ChildProcess): boolean {
	return child.exitCode === null && child.signalCode === null;
}

async function waitForChildExit(
	child: ChildProcess,
	timeoutMs: number,
): Promise<boolean> {
	if (!childIsRunning(child)) return true;
	return new Promise((resolveResult) => {
		let settled = false;
		const finish = (exited: boolean) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			child.off("close", onClose);
			resolveResult(exited);
		};
		const onClose = () => finish(true);
		const timer = setTimeout(() => finish(false), timeoutMs);
		child.once("close", onClose);
	});
}

async function waitForCleanup(
	cleanup: Promise<void>,
	timeoutMs: number,
): Promise<boolean> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			cleanup.then(() => true),
			new Promise<boolean>((resolveResult) => {
				timer = setTimeout(() => resolveResult(false), timeoutMs);
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

async function terminateWslProcessGroup(
	termination: ProjectPreviewWslTermination | null,
): Promise<void> {
	if (!termination) return;
	await runBoundedProcessHelper(
		projectPreviewWslTerminationLaunch(termination),
	);
}

async function terminateProcess(
	child: ChildProcess,
	wslTermination: ProjectPreviewWslTermination | null,
): Promise<void> {
	const pid = child.pid;
	if (process.platform === "win32" && wslTermination) {
		// taskkill owns only the Windows wsl.exe process tree. The Linux command
		// and its descendants live in a separate process namespace, so stop the
		// exact process group recorded by this preview before cleaning up wsl.exe.
		await terminateWslProcessGroup(wslTermination);
		await waitForChildExit(child, 750);
	}
	if (!pid || !childIsRunning(child)) {
		return;
	}
	if (process.platform === "win32") {
		if (childIsRunning(child)) {
			await runBoundedProcessHelper({
				executable: "taskkill.exe",
				args: ["/PID", String(pid), "/T", "/F"],
			});
			await waitForChildExit(child, 500);
		}
		return;
	}
	try {
		process.kill(-pid, "SIGTERM");
	} catch {
		child.kill("SIGTERM");
	}
	if (!(await waitForChildExit(child, 500))) {
		try {
			process.kill(-pid, "SIGKILL");
		} catch {
			child.kill("SIGKILL");
		}
		await waitForChildExit(child, 500);
	}
}

export class ProjectPreviewManager {
	private entries = new Map<string, PreviewEntry>();
	private bySession = new Map<string, string>();
	private readonly lifetimeMs: number;
	private readonly persistSnapshot: (
		preview: ProjectPreviewSnapshot,
	) => Promise<void>;
	private readonly browserManager: Pick<
		typeof projectPreviewBrowserManager,
		"close" | "closeAll"
	>;
	private readonly browserCloseTimeoutMs: number;
	private readonly capabilityFactory: () => ProjectPreviewCapability;

	constructor(options: ProjectPreviewManagerOptions = {}) {
		this.lifetimeMs = options.lifetimeMs ?? PROJECT_PREVIEW_LIFETIME_MS;
		this.browserCloseTimeoutMs =
			options.browserCloseTimeoutMs ?? PROJECT_PREVIEW_BROWSER_CLOSE_TIMEOUT_MS;
		this.persistSnapshot =
			options.persist ??
			(async (preview) => {
				const { saveProjectPreview } = await import("../db");
				await saveProjectPreview(preview);
			});
		this.browserManager =
			options.browserManager ?? projectPreviewBrowserManager;
		this.capabilityFactory =
			options.capabilityFactory ?? createProjectPreviewCapability;
	}

	private async persist(entry: PreviewEntry): Promise<void> {
		try {
			await this.persistSnapshot({
				...entry.snapshot,
				logs: [...entry.snapshot.logs],
			});
		} catch (error) {
			console.error(
				"[project-preview] failed to persist lifecycle:",
				error instanceof Error ? error.message : String(error),
			);
		}
	}

	private schedulePersist(entry: PreviewEntry): void {
		if (entry.persistTimer) return;
		entry.persistTimer = setTimeout(() => {
			entry.persistTimer = null;
			void this.persist(entry);
		}, 1_000);
		entry.persistTimer.unref?.();
	}

	private publish(entry: PreviewEntry, persist = false): void {
		entry.snapshot = { ...entry.snapshot, logs: [...entry.snapshot.logs] };
		broadcast({
			type: "project_preview_status",
			session_id: entry.snapshot.session_id,
			preview: entry.snapshot,
		});
		if (persist) void this.persist(entry);
	}

	private appendLogs(entry: PreviewEntry, chunk: Buffer): void {
		for (const rawLine of chunk.toString("utf8").split(/\r?\n/)) {
			const line = rawLine.trimEnd();
			if (!line) continue;
			entry.snapshot.logs.push(line.slice(0, MAX_LOG_LINE_CHARS));
		}
		if (entry.snapshot.logs.length > MAX_LOG_LINES) {
			entry.snapshot.logs.splice(0, entry.snapshot.logs.length - MAX_LOG_LINES);
		}
		this.publish(entry);
		this.schedulePersist(entry);
	}

	private requireSessionEntry(
		sessionId: string,
		previewId?: string,
	): PreviewEntry {
		const id = previewId ?? this.bySession.get(sessionId);
		const entry = id ? this.entries.get(id) : undefined;
		if (!entry || entry.snapshot.session_id !== sessionId) {
			throw new Error("Project preview not found for this session.");
		}
		return entry;
	}

	async start(
		input: StartProjectPreviewInput,
	): Promise<ProjectPreviewSnapshot> {
		const currentId = this.bySession.get(input.sessionId);
		if (currentId) {
			if (!input.replaceExisting) {
				throw new Error(
					"This session already owns a project preview. Stop it or set replace_existing.",
				);
			}
			const currentPort = this.entries.get(currentId)?.snapshot.port;
			await this.stop(input.sessionId, currentId, "replaced");
			if (currentPort === input.port) {
				await waitForPortRelease(input.port);
			}
		}
		if (await canConnect(input.port)) {
			throw new Error(
				`Port ${input.port} is already in use. Choose a free preview port.`,
			);
		}

		const cwd = resolveProjectPreviewCwd(
			input.runtimeCwd,
			input.workingDirectory,
		);
		const wsl =
			process.platform === "win32" ? parseWslUncSyntax(cwd) : undefined;
		const wslHostPromise = wsl
			? resolveWslIpv4Address(wsl.distro)
			: Promise.resolve(undefined);
		const path = normalizePreviewPath(input.path);
		const id = crypto.randomUUID();
		const capability = this.capabilityFactory();
		const spawned = spawnPreview(input.command, cwd, capability);
		const { child } = spawned;
		const startedAt = new Date();
		const snapshot: ProjectPreviewSnapshot = {
			id,
			session_id: input.sessionId,
			label: input.label?.trim() || "Project Preview",
			command: input.command,
			cwd,
			port: input.port,
			path,
			url: `http://127.0.0.1:${input.port}${path}`,
			relay_url: `/api/project-previews/${id}/relay${path}`,
			state: "starting",
			present: input.present ?? true,
			started_at: startedAt.toISOString(),
			expires_at: new Date(startedAt.getTime() + this.lifetimeMs).toISOString(),
			logs: [],
		};
		const lifetimeTimer = setTimeout(() => {
			void this.stop(input.sessionId, id, "lifetime_expired");
		}, this.lifetimeMs);
		lifetimeTimer.unref?.();
		const entry: PreviewEntry = {
			snapshot,
			child,
			wslTermination: spawned.wslTermination,
			input: { ...input, path, workingDirectory: input.workingDirectory },
			bridge: null,
			capability,
			stopping: false,
			stopPromise: null,
			lifetimeTimer,
			persistTimer: null,
		};
		this.entries.set(snapshot.id, entry);
		this.bySession.set(input.sessionId, snapshot.id);
		child.stdout?.on("data", (chunk: Buffer) => this.appendLogs(entry, chunk));
		child.stderr?.on("data", (chunk: Buffer) => this.appendLogs(entry, chunk));
		child.once("error", (error) => {
			void this.browserManager.close(snapshot.id);
			void entry.bridge?.close();
			entry.bridge = null;
			entry.snapshot.state = "failed";
			entry.snapshot.error = error.message;
			entry.snapshot.stop_reason = "launch_error";
			entry.snapshot.ended_at = new Date().toISOString();
			entry.capability = null;
			clearTimeout(entry.lifetimeTimer);
			this.publish(entry, true);
		});
		child.once("exit", (code) => {
			// A wrapper can exit while a server it started remains alive. The WSL
			// receipt lets Hlid reap that exact process group even after wsl.exe exits.
			void terminateWslProcessGroup(entry.wslTermination);
			void this.browserManager.close(snapshot.id);
			void entry.bridge?.close();
			entry.bridge = null;
			if (entry.snapshot.state === "failed") return;
			entry.snapshot.state = entry.stopping ? "stopped" : "failed";
			entry.snapshot.exit_code = code ?? undefined;
			entry.snapshot.ended_at = new Date().toISOString();
			entry.capability = null;
			clearTimeout(entry.lifetimeTimer);
			if (!entry.stopping) {
				entry.snapshot.error = `Preview command exited${code == null ? "" : ` with code ${code}`}.`;
				entry.snapshot.stop_reason = "process_exit";
			}
			this.publish(entry, true);
		});
		this.publish(entry);
		await this.persist(entry);

		const timeoutMs = (input.readinessTimeoutSeconds ?? 30) * 1_000;
		const deadline = Date.now() + timeoutMs;
		let wslHost: string | undefined;
		void wslHostPromise.then((resolvedHost) => {
			wslHost = resolvedHost;
		});
		while (Date.now() < deadline && entry.snapshot.state === "starting") {
			if (await canConnect(input.port)) {
				entry.snapshot.state = "ready";
				this.publish(entry);
				await this.persist(entry);
				return this.inspect(input.sessionId, snapshot.id);
			}
			if (wslHost && !entry.bridge && (await canConnect(input.port, wslHost))) {
				try {
					entry.bridge = await createProjectPreviewLoopbackBridge(
						input.port,
						wslHost,
					);
					entry.snapshot.logs.push(
						"[Hlid] Connected the WSL preview through a managed loopback bridge.",
					);
					this.publish(entry);
					continue;
				} catch {
					// Windows localhost forwarding may have become ready between the
					// reachability check and bridge creation. Let the next probe decide.
				}
			}
			await new Promise((resolveResult) => setTimeout(resolveResult, 250));
		}
		if (entry.snapshot.state === "starting") {
			entry.snapshot.state = "failed";
			entry.snapshot.error = `Preview did not become reachable at 127.0.0.1:${input.port} within ${Math.round(timeoutMs / 1_000)} seconds. Ensure the command binds the exact port on IPv4 loopback (127.0.0.1). Hlid also supports a WSL server's IPv4 wildcard bind through its managed bridge.`;
			entry.snapshot.stop_reason = "readiness_timeout";
			entry.snapshot.ended_at = new Date().toISOString();
			clearTimeout(entry.lifetimeTimer);
			this.publish(entry);
			await terminateProcess(child, entry.wslTermination);
			entry.capability = null;
			await this.persist(entry);
		}
		return this.inspect(input.sessionId, snapshot.id);
	}

	inspect(sessionId: string, previewId?: string): ProjectPreviewSnapshot {
		const entry = this.requireSessionEntry(sessionId, previewId);
		return { ...entry.snapshot, logs: [...entry.snapshot.logs] };
	}

	relayTarget(previewId: string): {
		port: number;
		capability: ProjectPreviewCapability;
	} {
		const entry = this.entries.get(previewId);
		if (!entry || entry.snapshot.state !== "ready" || !entry.capability) {
			throw new Error("Project preview is not running.");
		}
		return {
			port: entry.snapshot.port,
			capability: entry.capability,
		};
	}

	stop(
		sessionId: string,
		previewId?: string,
		reason = "explicit",
	): Promise<ProjectPreviewSnapshot> {
		const entry = this.requireSessionEntry(sessionId, previewId);
		if (entry.stopPromise) return entry.stopPromise;

		const stopPromise = this.stopEntry(entry, sessionId, reason);
		entry.stopPromise = stopPromise;
		void stopPromise.catch(() => {
			if (entry.stopPromise === stopPromise) entry.stopPromise = null;
		});
		return stopPromise;
	}

	private async stopEntry(
		entry: PreviewEntry,
		sessionId: string,
		reason: string,
	): Promise<ProjectPreviewSnapshot> {
		entry.stopping = true;
		entry.snapshot.stop_reason = reason;
		disposeProjectPreviewRelay(entry.snapshot.id);
		clearTimeout(entry.lifetimeTimer);
		if (entry.persistTimer) {
			clearTimeout(entry.persistTimer);
			entry.persistTimer = null;
		}
		const browserClosed = await waitForCleanup(
			this.browserManager.close(entry.snapshot.id),
			this.browserCloseTimeoutMs,
		);
		if (!browserClosed) {
			const message = `[Hlid] Preview browser cleanup exceeded ${this.browserCloseTimeoutMs}ms; continuing shutdown.`;
			entry.snapshot.logs.push(message);
			if (entry.snapshot.logs.length > MAX_LOG_LINES) {
				entry.snapshot.logs.splice(
					0,
					entry.snapshot.logs.length - MAX_LOG_LINES,
				);
			}
			console.warn(`[project-preview] ${message}`);
		}
		await entry.bridge?.close();
		entry.bridge = null;
		await terminateProcess(entry.child, entry.wslTermination);
		entry.capability = null;
		entry.snapshot.state = "stopped";
		entry.snapshot.ended_at ??= new Date().toISOString();
		this.bySession.delete(sessionId);
		this.publish(entry);
		await this.persist(entry);
		return this.inspect(sessionId, entry.snapshot.id);
	}

	async restart(
		sessionId: string,
		previewId?: string,
	): Promise<ProjectPreviewSnapshot> {
		const previous = this.inspect(sessionId, previewId);
		const entry = this.entries.get(previous.id);
		if (!entry) throw new Error("Project preview not found.");
		const input = { ...entry.input, replaceExisting: true };
		return this.start(input);
	}

	async closeSession(
		sessionId: string,
		reason = "session_closed",
	): Promise<void> {
		const id = this.bySession.get(sessionId);
		if (id) await this.stop(sessionId, id, reason);
	}

	async closeAll(): Promise<void> {
		await Promise.all(
			[...this.bySession.keys()].map((sessionId) =>
				this.closeSession(sessionId, "hlid_shutdown"),
			),
		);
		disposeProjectPreviewRelay();
		await this.browserManager.closeAll();
	}
}

export const projectPreviewManager = new ProjectPreviewManager();
