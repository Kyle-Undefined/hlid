import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, win32 } from "node:path";
import type { Subprocess } from "bun";
import { loadConfig } from "./config";
import {
	isAllowedProjectPreviewBrowserUrl,
	MAX_PROJECT_PREVIEW_CAPTURE_ATTEMPTS,
	MAX_PROJECT_PREVIEW_CAPTURE_BYTES,
	MAX_PROJECT_PREVIEW_FULL_PAGE_HEIGHT,
	nextProjectPreviewCaptureScale,
	PROJECT_PREVIEW_CAPTURE_DEVICE_SCALE_FACTOR,
	PROJECT_PREVIEW_CAPTURE_TIMEOUT_MS,
	PROJECT_PREVIEW_CAPTURE_VIEWPORTS,
	type ProjectPreviewCaptureSize,
	type ProjectPreviewCaptureViewport,
	projectPreviewCaptureScale,
	readProjectPreviewPngDimensions,
} from "./projectPreviewCapture";
import type { ProjectPreviewAgentElement } from "./protocol";

export const PROJECT_PREVIEW_BROWSER_LAUNCH_TIMEOUT_MS = 12_000;
export const PROJECT_PREVIEW_REAL_PROFILE_CONNECT_TIMEOUT_MS = 30_000;
export const PROJECT_PREVIEW_ATTACHED_TARGET_PARAMS = {
	url: "about:blank",
	background: true,
	hidden: true,
} as const;
export const PROJECT_PREVIEW_SETTLE_EXPRESSION =
	"new Promise((resolve) => setTimeout(() => resolve(true), 100))";

const SUPPORTED_BROWSER_EXECUTABLES = new Set([
	"brave.exe",
	"chrome.exe",
	"chromium.exe",
	"msedge.exe",
	"opera.exe",
	"vivaldi.exe",
	"brave",
	"brave-browser",
	"google-chrome",
	"google-chrome-stable",
	"chromium",
	"chromium-browser",
	"microsoft-edge",
	"microsoft-edge-stable",
]);

const MAX_DIAGNOSTICS = 30;
const MAX_DIAGNOSTIC_CHARS = 500;

type CdpResponse = {
	id?: number;
	method?: string;
	params?: Record<string, unknown>;
	result?: Record<string, unknown>;
	error?: { message?: string; data?: string };
};

type CdpPending = {
	resolve: (value: Record<string, unknown>) => void;
	reject: (error: Error) => void;
	timer: ReturnType<typeof setTimeout>;
};

type CdpEventListener = (params: Record<string, unknown>) => void;

type CdpEventWaiter = {
	promise: Promise<Record<string, unknown>>;
	cancel: () => void;
};

type CdpTarget = {
	id: string;
	type: string;
	webSocketDebuggerUrl?: string;
};

type OwnedBrowserProcess = {
	child: Subprocess;
	userDataDir: string;
};

type BrowserCandidate = {
	name: string;
	executablePath: string;
};

type BrowserProfileRoot = "local" | "roaming";
type WindowsBrowserProfile = {
	root: BrowserProfileRoot;
	segments: readonly string[];
};

const WINDOWS_BROWSER_PROFILES: Readonly<
	Record<string, WindowsBrowserProfile>
> = {
	"brave.exe": {
		root: "local",
		segments: ["BraveSoftware", "Brave-Browser", "User Data"],
	},
	"chrome.exe": {
		root: "local",
		segments: ["Google", "Chrome", "User Data"],
	},
	"chromium.exe": {
		root: "local",
		segments: ["Chromium", "User Data"],
	},
	"msedge.exe": {
		root: "local",
		segments: ["Microsoft", "Edge", "User Data"],
	},
	"vivaldi.exe": {
		root: "local",
		segments: ["Vivaldi", "User Data"],
	},
	"opera.exe": {
		root: "roaming",
		segments: ["Opera Software", "Opera Stable"],
	},
};

const LINUX_BROWSER_PROFILES: Readonly<Record<string, readonly string[]>> = {
	brave: ["BraveSoftware", "Brave-Browser"],
	"brave-browser": ["BraveSoftware", "Brave-Browser"],
	"google-chrome": ["google-chrome"],
	"google-chrome-stable": ["google-chrome"],
	chromium: ["chromium"],
	"chromium-browser": ["chromium"],
	"microsoft-edge": ["microsoft-edge"],
	"microsoft-edge-stable": ["microsoft-edge"],
	vivaldi: ["vivaldi"],
};

function windowsBrowserUserDataDir(
	executable: string,
	env: NodeJS.ProcessEnv,
): string | null {
	if (!Object.hasOwn(WINDOWS_BROWSER_PROFILES, executable)) return null;
	const profile = WINDOWS_BROWSER_PROFILES[executable];
	const root = profile.root === "local" ? env.LOCALAPPDATA : env.APPDATA;
	return root ? win32.join(root, ...profile.segments) : null;
}

function linuxBrowserUserDataDir(
	executable: string,
	env: NodeJS.ProcessEnv,
): string | null {
	if (!Object.hasOwn(LINUX_BROWSER_PROFILES, executable)) return null;
	const segments = LINUX_BROWSER_PROFILES[executable];
	const configHome =
		env.CHROME_CONFIG_HOME ??
		env.XDG_CONFIG_HOME ??
		join(env.HOME ?? homedir(), ".config");
	return join(configHome, ...segments);
}

export function projectPreviewBrowserUserDataDir(
	executablePath: string,
	platform: NodeJS.Platform = process.platform,
	env: NodeJS.ProcessEnv = process.env,
): string | null {
	const executable =
		executablePath.replace(/\\/g, "/").split("/").at(-1)?.toLowerCase() ?? "";
	if (platform === "win32") {
		return windowsBrowserUserDataDir(executable, env);
	}
	if (platform === "linux") {
		return linuxBrowserUserDataDir(executable, env);
	}
	return null;
}

export type ProjectPreviewBrowserDiagnostics = {
	consoleMessages: string[];
	failedRequests: string[];
};

export type ProjectPreviewBrowserCapture = {
	png: Buffer;
	pixelWidth: number;
	pixelHeight: number;
	deviceScaleFactor: number;
	pixelRatio: number;
};

type ProjectPreviewScreenshotClip = {
	x: number;
	y: number;
	width: number;
	height: number;
	scale: number;
};

export function projectPreviewDeviceMetrics(
	size: ProjectPreviewCaptureSize,
): Record<string, number | boolean> {
	return {
		width: size.width,
		height: size.height,
		deviceScaleFactor: PROJECT_PREVIEW_CAPTURE_DEVICE_SCALE_FACTOR,
		mobile: false,
	};
}

export function projectPreviewScreenshotParams(
	fullPage: boolean,
	clip?: ProjectPreviewScreenshotClip,
): Record<string, unknown> {
	return {
		format: "png",
		fromSurface: true,
		captureBeyondViewport: fullPage,
		...(clip ? { clip } : {}),
	};
}

export interface ProjectPreviewBrowserSession {
	isConnected(): boolean;
	currentUrl(): Promise<string>;
	navigate(url: string): Promise<void>;
	reload(): Promise<void>;
	setViewport(
		viewport: ProjectPreviewCaptureViewport,
		size?: ProjectPreviewCaptureSize,
	): Promise<void>;
	capture(fullPage: boolean): Promise<ProjectPreviewBrowserCapture>;
	title(): Promise<string>;
	semanticSnapshot(limit: number): Promise<ProjectPreviewAgentElement[]>;
	clickRef(ref: string): Promise<void>;
	clickAt(x: number, y: number): Promise<void>;
	fillRef(ref: string, text: string): Promise<void>;
	pressKey(key: string): Promise<void>;
	scroll(deltaX: number, deltaY: number): Promise<void>;
	scrollTo(x: number, y: number): Promise<void>;
	settle(): Promise<void>;
	diagnostics(): ProjectPreviewBrowserDiagnostics;
	close(): Promise<void>;
}

export type ProjectPreviewBrowserSessionFactory = (
	port: number,
	signal: AbortSignal,
) => Promise<ProjectPreviewBrowserSession>;

function appendBounded(target: string[], value: string): void {
	const text = value.replace(/\s+/g, " ").trim().slice(0, MAX_DIAGNOSTIC_CHARS);
	if (!text) return;
	target.push(text);
	if (target.length > MAX_DIAGNOSTICS) {
		target.splice(0, target.length - MAX_DIAGNOSTICS);
	}
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function abortError(
	message = "Project Preview browser launch was cancelled.",
): Error {
	return new Error(message);
}

async function wait(ms: number, signal?: AbortSignal): Promise<void> {
	if (signal?.aborted) throw abortError();
	await new Promise<void>((resolve, reject) => {
		const onAbort = () => {
			clearTimeout(timer);
			reject(abortError());
		};
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

function withTimeoutSignal(
	signal: AbortSignal,
	timeoutMs: number,
): AbortSignal {
	return AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
}

export function isSupportedProjectPreviewBrowser(
	executablePath: string,
): boolean {
	const executable = executablePath.replace(/\\/g, "/").split("/").at(-1) ?? "";
	return SUPPORTED_BROWSER_EXECUTABLES.has(executable.toLowerCase());
}

export function parseWindowsBrowserCommand(command: string): string | null {
	const quoted = command.match(/"([^"]+\.exe)"/i)?.[1];
	if (quoted) return quoted.trim();
	const unquoted = command.match(/^\s*(.+?\.exe)(?:\s|$)/i)?.[1];
	return unquoted?.trim() ?? null;
}

export function orderProjectPreviewBrowserCandidates(
	defaultExecutable: string | null,
	fallbacks: BrowserCandidate[],
	pathExists: (path: string) => boolean = existsSync,
): BrowserCandidate[] {
	const candidates: BrowserCandidate[] = [];
	const seen = new Set<string>();
	const add = (candidate: BrowserCandidate) => {
		const key = candidate.executablePath.toLowerCase();
		if (
			seen.has(key) ||
			!isSupportedProjectPreviewBrowser(candidate.executablePath) ||
			!pathExists(candidate.executablePath)
		) {
			return;
		}
		seen.add(key);
		candidates.push(candidate);
	};
	if (defaultExecutable) {
		add({ name: "default browser", executablePath: defaultExecutable });
	}
	for (const fallback of fallbacks) add(fallback);
	return candidates;
}

async function runRegistryQuery(args: string[]): Promise<string | null> {
	try {
		const child = Bun.spawn(["reg.exe", "query", ...args], {
			stdin: "ignore",
			stdout: "pipe",
			stderr: "ignore",
			windowsHide: true,
		});
		const output = await new Response(child.stdout).text();
		if ((await child.exited) !== 0) return null;
		return output;
	} catch {
		return null;
	}
}

function registryStringValue(
	output: string,
	valueName?: string,
): string | null {
	for (const line of output.split(/\r?\n/)) {
		if (valueName && !line.toLowerCase().includes(valueName.toLowerCase())) {
			continue;
		}
		const match = line.match(/\bREG_\w+\s+(.+)\s*$/i);
		if (match?.[1]) return match[1].trim();
	}
	return null;
}

async function windowsDefaultBrowserExecutable(): Promise<string | null> {
	const choice = await runRegistryQuery([
		"HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\http\\UserChoice",
		"/v",
		"ProgId",
	]);
	const progId = choice ? registryStringValue(choice, "ProgId") : null;
	if (!progId) return null;
	const command = await runRegistryQuery([
		`HKCR\\${progId}\\shell\\open\\command`,
		"/ve",
	]);
	const commandValue = command ? registryStringValue(command) : null;
	return commandValue ? parseWindowsBrowserCommand(commandValue) : null;
}

function windowsBrowserFallbacks(): BrowserCandidate[] {
	const programFiles = process.env.PROGRAMFILES ?? "C:\\Program Files";
	const programFilesX86 =
		process.env["PROGRAMFILES(X86)"] ?? "C:\\Program Files (x86)";
	const localAppData = process.env.LOCALAPPDATA ?? "";
	return [
		{
			name: "Chrome",
			executablePath: join(
				programFiles,
				"Google",
				"Chrome",
				"Application",
				"chrome.exe",
			),
		},
		{
			name: "Chrome",
			executablePath: join(
				programFilesX86,
				"Google",
				"Chrome",
				"Application",
				"chrome.exe",
			),
		},
		{
			name: "Chrome",
			executablePath: join(
				localAppData,
				"Google",
				"Chrome",
				"Application",
				"chrome.exe",
			),
		},
		{
			name: "Brave",
			executablePath: join(
				programFiles,
				"BraveSoftware",
				"Brave-Browser",
				"Application",
				"brave.exe",
			),
		},
		{
			name: "Brave",
			executablePath: join(
				localAppData,
				"BraveSoftware",
				"Brave-Browser",
				"Application",
				"brave.exe",
			),
		},
		{
			name: "Vivaldi",
			executablePath: join(
				localAppData,
				"Vivaldi",
				"Application",
				"vivaldi.exe",
			),
		},
		{
			name: "Edge",
			executablePath: join(
				programFilesX86,
				"Microsoft",
				"Edge",
				"Application",
				"msedge.exe",
			),
		},
		{
			name: "Edge",
			executablePath: join(
				programFiles,
				"Microsoft",
				"Edge",
				"Application",
				"msedge.exe",
			),
		},
	];
}

function unixBrowserFallbacks(): BrowserCandidate[] {
	const names = [
		["Chrome", "google-chrome"],
		["Chrome", "google-chrome-stable"],
		["Brave", "brave-browser"],
		["Chromium", "chromium"],
		["Chromium", "chromium-browser"],
		["Edge", "microsoft-edge"],
	] as const;
	return names.flatMap(([name, executable]) => {
		const path = Bun.which(executable);
		return path ? [{ name, executablePath: path }] : [];
	});
}

export async function resolveProjectPreviewBrowserCandidates(): Promise<
	BrowserCandidate[]
> {
	if (process.platform === "win32") {
		return orderProjectPreviewBrowserCandidates(
			await windowsDefaultBrowserExecutable(),
			windowsBrowserFallbacks(),
		);
	}
	const configured = process.env.BROWSER?.trim() || null;
	return orderProjectPreviewBrowserCandidates(
		configured,
		unixBrowserFallbacks(),
	);
}

export function createProjectPreviewEventWaiter(
	subscribe: (listener: CdpEventListener) => () => void,
	method: string,
	timeoutMs = PROJECT_PREVIEW_CAPTURE_TIMEOUT_MS,
): CdpEventWaiter {
	let settled = false;
	let remove = () => {};
	let timer: ReturnType<typeof setTimeout> | undefined;
	let resolvePromise: (value: Record<string, unknown>) => void = () => {};
	let rejectPromise: (error: Error) => void = () => {};
	const cleanup = () => {
		if (timer) clearTimeout(timer);
		remove();
	};
	const promise = new Promise<Record<string, unknown>>((resolve, reject) => {
		resolvePromise = resolve;
		rejectPromise = reject;
	});
	const resolve = (params: Record<string, unknown>) => {
		if (settled) return;
		settled = true;
		cleanup();
		resolvePromise(params);
	};
	const reject = (error: Error) => {
		if (settled) return;
		settled = true;
		cleanup();
		rejectPromise(error);
	};
	remove = subscribe(resolve);
	if (settled) {
		remove();
	} else {
		timer = setTimeout(() => {
			reject(new Error(`Timed out waiting for ${method}.`));
		}, timeoutMs);
	}
	// Navigation and reload start this waiter before sending their CDP command.
	// Observe it immediately so an earlier command failure cannot leave a later
	// timeout as an unhandled rejection in the compiled app.
	void promise.catch(() => {});
	return {
		promise,
		cancel: () => resolve({}),
	};
}

class CdpClient {
	private nextId = 0;
	private readonly pending = new Map<number, CdpPending>();
	private readonly listeners = new Map<string, Set<CdpEventListener>>();
	private connected = false;

	private constructor(private readonly socket: WebSocket) {
		socket.onmessage = (event) => this.handleMessage(event.data);
		socket.onclose = () => this.handleClose("CDP connection closed.");
		socket.onerror = () => this.handleClose("CDP connection failed.");
	}

	static async connect(
		url: string,
		signal: AbortSignal,
		timeoutMs: number,
	): Promise<CdpClient> {
		const socket = new WebSocket(url);
		const client = new CdpClient(socket);
		await new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => {
				socket.close();
				reject(new Error("Timed out connecting to the Preview browser."));
			}, timeoutMs);
			const onAbort = () => {
				clearTimeout(timer);
				socket.close();
				reject(abortError());
			};
			signal.addEventListener("abort", onAbort, { once: true });
			socket.onopen = () => {
				clearTimeout(timer);
				signal.removeEventListener("abort", onAbort);
				client.connected = true;
				socket.onerror = () => client.handleClose("CDP connection failed.");
				resolve();
			};
			socket.onerror = () => {
				clearTimeout(timer);
				signal.removeEventListener("abort", onAbort);
				reject(new Error("Could not connect to the Preview browser."));
			};
		});
		return client;
	}

	isConnected(): boolean {
		return this.connected && this.socket.readyState === WebSocket.OPEN;
	}

	on(method: string, listener: CdpEventListener): () => void {
		const current = this.listeners.get(method) ?? new Set();
		current.add(listener);
		this.listeners.set(method, current);
		return () => current.delete(listener);
	}

	waitFor(
		method: string,
		timeoutMs = PROJECT_PREVIEW_CAPTURE_TIMEOUT_MS,
	): CdpEventWaiter {
		return createProjectPreviewEventWaiter(
			(listener) => this.on(method, listener),
			method,
			timeoutMs,
		);
	}

	send(
		method: string,
		params: Record<string, unknown> = {},
		timeoutMs = PROJECT_PREVIEW_CAPTURE_TIMEOUT_MS,
	): Promise<Record<string, unknown>> {
		if (!this.isConnected()) {
			return Promise.reject(new Error("Project Preview browser is closed."));
		}
		const id = ++this.nextId;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`Preview browser command ${method} timed out.`));
			}, timeoutMs);
			this.pending.set(id, { resolve, reject, timer });
			this.socket.send(JSON.stringify({ id, method, params }));
		});
	}

	close(): void {
		this.handleClose("CDP connection closed.");
		try {
			this.socket.close();
		} catch {
			// The browser process may already own the closed transport.
		}
	}

	private handleMessage(data: string | ArrayBuffer | Blob): void {
		if (typeof data !== "string") return;
		let message: CdpResponse;
		try {
			message = JSON.parse(data) as CdpResponse;
		} catch {
			return;
		}
		if (message.id !== undefined) {
			const pending = this.pending.get(message.id);
			if (!pending) return;
			this.pending.delete(message.id);
			clearTimeout(pending.timer);
			if (message.error) {
				pending.reject(
					new Error(
						`${message.error.message ?? "CDP command failed"}${message.error.data ? `: ${message.error.data}` : ""}`,
					),
				);
			} else {
				pending.resolve(message.result ?? {});
			}
			return;
		}
		if (!message.method) return;
		for (const listener of this.listeners.get(message.method) ?? []) {
			listener(message.params ?? {});
		}
	}

	private handleClose(message: string): void {
		if (!this.connected && this.pending.size === 0) return;
		this.connected = false;
		for (const pending of this.pending.values()) {
			clearTimeout(pending.timer);
			pending.reject(new Error(message));
		}
		this.pending.clear();
	}
}

function runtimeValue<T>(result: Record<string, unknown>): T {
	const exception = result.exceptionDetails as
		| { text?: string; exception?: { description?: string } }
		| undefined;
	if (exception) {
		throw new Error(
			exception.exception?.description ??
				exception.text ??
				"Preview page evaluation failed.",
		);
	}
	const remote = result.result as
		| { value?: T; description?: string }
		| undefined;
	if (!remote || !("value" in remote)) {
		throw new Error(remote?.description ?? "Preview page returned no value.");
	}
	return remote.value as T;
}

function keyDescriptor(key: string): {
	key: string;
	code?: string;
	text?: string;
	windowsVirtualKeyCode?: number;
	modifiers?: number;
} {
	const parts = key.split("+");
	const keyValue = parts.at(-1) ?? key;
	let modifiers = 0;
	for (const modifier of parts.slice(0, -1)) {
		if (modifier === "Alt") modifiers |= 1;
		if (modifier === "Control") modifiers |= 2;
		if (modifier === "Meta") modifiers |= 4;
		if (modifier === "Shift") modifiers |= 8;
	}
	const named: Record<
		string,
		{ key: string; code: string; windowsVirtualKeyCode: number; text?: string }
	> = {
		Enter: {
			key: "Enter",
			code: "Enter",
			windowsVirtualKeyCode: 13,
			text: "\r",
		},
		Tab: { key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 },
		Escape: { key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 },
		Backspace: {
			key: "Backspace",
			code: "Backspace",
			windowsVirtualKeyCode: 8,
		},
		Delete: { key: "Delete", code: "Delete", windowsVirtualKeyCode: 46 },
		ArrowUp: { key: "ArrowUp", code: "ArrowUp", windowsVirtualKeyCode: 38 },
		ArrowDown: {
			key: "ArrowDown",
			code: "ArrowDown",
			windowsVirtualKeyCode: 40,
		},
		ArrowLeft: {
			key: "ArrowLeft",
			code: "ArrowLeft",
			windowsVirtualKeyCode: 37,
		},
		ArrowRight: {
			key: "ArrowRight",
			code: "ArrowRight",
			windowsVirtualKeyCode: 39,
		},
		Home: { key: "Home", code: "Home", windowsVirtualKeyCode: 36 },
		End: { key: "End", code: "End", windowsVirtualKeyCode: 35 },
		PageUp: { key: "PageUp", code: "PageUp", windowsVirtualKeyCode: 33 },
		PageDown: {
			key: "PageDown",
			code: "PageDown",
			windowsVirtualKeyCode: 34,
		},
		Space: {
			key: " ",
			code: "Space",
			windowsVirtualKeyCode: 32,
			text: " ",
		},
	};
	const descriptor = named[keyValue] ?? {
		key: keyValue,
		code: /^[A-Za-z]$/.test(keyValue)
			? `Key${keyValue.toUpperCase()}`
			: `Digit${keyValue}`,
		windowsVirtualKeyCode: keyValue.toUpperCase().charCodeAt(0),
		text: modifiers === 0 || modifiers === 8 ? keyValue : undefined,
	};
	return { ...descriptor, ...(modifiers ? { modifiers } : {}) };
}

class CdpBrowserSession implements ProjectPreviewBrowserSession {
	private readonly consoleMessages: string[] = [];
	private readonly failedRequests: string[] = [];
	private readonly requests = new Map<
		string,
		{ method: string; url: string }
	>();
	private viewportSize: ProjectPreviewCaptureSize =
		PROJECT_PREVIEW_CAPTURE_VIEWPORTS.desktop;
	private closed = false;

	constructor(
		private readonly port: number,
		private readonly page: CdpClient,
		private readonly browser: CdpClient,
		private readonly mainTargetId: string,
		private readonly ownedProcess: OwnedBrowserProcess | null,
	) {}

	async initialize(): Promise<void> {
		await Promise.all([
			this.page.send("Page.enable"),
			this.page.send("Runtime.enable"),
			this.page.send("Network.enable"),
			this.page.send("Log.enable"),
			this.browser.send("Target.setDiscoverTargets", { discover: true }),
		]);
		this.page.on("Fetch.requestPaused", (params) => {
			const requestId = String(params.requestId ?? "");
			const request = params.request as { url?: string } | undefined;
			const allowed =
				request?.url &&
				isAllowedProjectPreviewBrowserUrl(request.url, this.port);
			void this.page
				.send(
					allowed ? "Fetch.continueRequest" : "Fetch.failRequest",
					allowed
						? { requestId }
						: { requestId, errorReason: "BlockedByClient" },
				)
				.catch(() => {});
		});
		this.page.on("Runtime.consoleAPICalled", (params) => {
			const type = String(params.type ?? "");
			if (type !== "error" && type !== "warning") return;
			const args = Array.isArray(params.args) ? params.args : [];
			const text = args
				.map((arg) => {
					const value = arg as {
						value?: unknown;
						description?: string;
						unserializableValue?: string;
					};
					return String(
						value.value ?? value.description ?? value.unserializableValue ?? "",
					);
				})
				.join(" ");
			appendBounded(this.consoleMessages, `${type}: ${text}`);
		});
		this.page.on("Runtime.exceptionThrown", (params) => {
			const details = params.exceptionDetails as
				| { text?: string; exception?: { description?: string } }
				| undefined;
			appendBounded(
				this.consoleMessages,
				`pageerror: ${details?.exception?.description ?? details?.text ?? "Unknown exception"}`,
			);
		});
		this.page.on("Network.requestWillBeSent", (params) => {
			const requestId = String(params.requestId ?? "");
			const request = params.request as
				| { method?: string; url?: string }
				| undefined;
			if (!requestId || !request?.url) return;
			this.requests.set(requestId, {
				method: request.method ?? "GET",
				url: request.url,
			});
			if (this.requests.size > 500) {
				this.requests.delete(this.requests.keys().next().value ?? "");
			}
		});
		this.page.on("Network.loadingFinished", (params) => {
			this.requests.delete(String(params.requestId ?? ""));
		});
		this.page.on("Network.loadingFailed", (params) => {
			const requestId = String(params.requestId ?? "");
			const request = this.requests.get(requestId);
			this.requests.delete(requestId);
			if (!request) return;
			let target = "invalid URL";
			try {
				const url = new URL(request.url);
				target = `${url.origin}${url.pathname}`;
			} catch {}
			appendBounded(
				this.failedRequests,
				`${request.method} ${target} · ${String(params.errorText ?? "request failed")}`,
			);
		});
		this.page.on("Page.javascriptDialogOpening", () => {
			void this.page
				.send("Page.handleJavaScriptDialog", { accept: false })
				.catch(() => {});
		});
		this.browser.on("Target.targetCreated", (params) => {
			const info = params.targetInfo as
				| { targetId?: string; type?: string; openerId?: string }
				| undefined;
			if (
				info?.type === "page" &&
				info.targetId &&
				info.targetId !== this.mainTargetId &&
				(this.ownedProcess !== null || info.openerId === this.mainTargetId)
			) {
				void this.browser
					.send("Target.closeTarget", { targetId: info.targetId })
					.catch(() => {});
			}
		});
		await this.page.send("Fetch.enable", {
			patterns: [{ urlPattern: "*", requestStage: "Request" }],
			handleAuthRequests: false,
		});
		if (this.ownedProcess) {
			await this.page.send("Page.bringToFront");
		}
		await this.setViewport("desktop");
	}

	isConnected(): boolean {
		return (
			!this.closed &&
			(this.ownedProcess === null ||
				this.ownedProcess.child.exitCode === null) &&
			this.page.isConnected() &&
			this.browser.isConnected()
		);
	}

	private async evaluate<T>(
		expression: string,
		awaitPromise = false,
	): Promise<T> {
		return runtimeValue<T>(
			await this.page.send("Runtime.evaluate", {
				expression,
				awaitPromise,
				returnByValue: true,
				userGesture: true,
			}),
		);
	}

	async currentUrl(): Promise<string> {
		return this.evaluate<string>("location.href");
	}

	async navigate(url: string): Promise<void> {
		const loaded = this.page.waitFor("Page.domContentEventFired");
		try {
			const result = await this.page.send("Page.navigate", { url });
			if (result.errorText) {
				throw new Error(
					`Preview navigation failed: ${String(result.errorText)}`,
				);
			}
			await loaded.promise;
		} finally {
			loaded.cancel();
		}
	}

	async reload(): Promise<void> {
		const loaded = this.page.waitFor("Page.domContentEventFired");
		try {
			await this.page.send("Page.reload", { ignoreCache: false });
			await loaded.promise;
		} finally {
			loaded.cancel();
		}
	}

	async setViewport(
		viewport: ProjectPreviewCaptureViewport,
		customSize?: ProjectPreviewCaptureSize,
	): Promise<void> {
		const size = customSize ?? PROJECT_PREVIEW_CAPTURE_VIEWPORTS[viewport];
		await this.page.send(
			"Emulation.setDeviceMetricsOverride",
			projectPreviewDeviceMetrics(size),
		);
		this.viewportSize = size;
	}

	async capture(fullPage: boolean): Promise<ProjectPreviewBrowserCapture> {
		await this.evaluate(
			`(async () => {
				await Promise.race([
					document.fonts?.ready ?? Promise.resolve(),
					new Promise((resolve) => setTimeout(resolve, 1500))
				]);
				await Promise.race([
					new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
					new Promise((resolve) => setTimeout(resolve, 250))
				]);
				return true;
			})()`,
			true,
		);
		let region: Omit<ProjectPreviewScreenshotClip, "scale"> | undefined;
		if (fullPage) {
			const metrics = await this.page.send("Page.getLayoutMetrics");
			const content = metrics.cssContentSize as
				| { width?: number; height?: number }
				| undefined;
			const width = Math.ceil(content?.width ?? 0);
			const height = Math.ceil(content?.height ?? 0);
			if (height > MAX_PROJECT_PREVIEW_FULL_PAGE_HEIGHT) {
				throw new Error(
					`Full-page Preview capture exceeds the ${MAX_PROJECT_PREVIEW_FULL_PAGE_HEIGHT}px height limit.`,
				);
			}
			if (width > 0 && height > 0) {
				region = { x: 0, y: 0, width, height };
			} else {
				throw new Error(
					"Project Preview browser returned an invalid full-page size.",
				);
			}
		}

		const logicalSize = region ?? {
			x: 0,
			y: 0,
			width: this.viewportSize.width,
			height: this.viewportSize.height,
		};
		let captureScale = projectPreviewCaptureScale(
			logicalSize.width,
			logicalSize.height,
		);
		for (
			let attempt = 0;
			attempt < MAX_PROJECT_PREVIEW_CAPTURE_ATTEMPTS;
			attempt += 1
		) {
			if (captureScale < 1 && !region) {
				const metrics = await this.page.send("Page.getLayoutMetrics");
				const visual = metrics.cssVisualViewport as
					| {
							pageX?: number;
							pageY?: number;
							clientWidth?: number;
							clientHeight?: number;
					  }
					| undefined;
				region = {
					x: visual?.pageX ?? 0,
					y: visual?.pageY ?? 0,
					width: visual?.clientWidth ?? this.viewportSize.width,
					height: visual?.clientHeight ?? this.viewportSize.height,
				};
			}
			const clip =
				region && (fullPage || captureScale < 1)
					? { ...region, scale: captureScale }
					: undefined;
			const result = await this.page.send(
				"Page.captureScreenshot",
				projectPreviewScreenshotParams(fullPage, clip),
			);
			const png = Buffer.from(String(result.data ?? ""), "base64");
			const dimensions = readProjectPreviewPngDimensions(png);
			if (png.byteLength <= MAX_PROJECT_PREVIEW_CAPTURE_BYTES) {
				const capturedRegion = region ?? logicalSize;
				const pixelRatio = Math.min(
					dimensions.width / capturedRegion.width,
					dimensions.height / capturedRegion.height,
				);
				return {
					png,
					pixelWidth: dimensions.width,
					pixelHeight: dimensions.height,
					deviceScaleFactor: PROJECT_PREVIEW_CAPTURE_DEVICE_SCALE_FACTOR,
					pixelRatio: Math.round(pixelRatio * 10_000) / 10_000,
				};
			}
			if (attempt + 1 < MAX_PROJECT_PREVIEW_CAPTURE_ATTEMPTS) {
				captureScale = nextProjectPreviewCaptureScale(
					captureScale,
					png.byteLength,
				);
				continue;
			}
			throw new Error(
				`Preview capture exceeds the ${MAX_PROJECT_PREVIEW_CAPTURE_BYTES} byte limit after adaptive downscaling.`,
			);
		}
		throw new Error("Project Preview capture failed.");
	}

	async title(): Promise<string> {
		return this.evaluate<string>("document.title");
	}

	async semanticSnapshot(limit: number): Promise<ProjectPreviewAgentElement[]> {
		return this.evaluate<ProjectPreviewAgentElement[]>(
			`(() => {
				for (const existing of document.querySelectorAll("[data-hlid-preview-ref]")) {
					existing.removeAttribute("data-hlid-preview-ref");
				}
				const selector = [
					"a[href]", "button", "input", "textarea", "select", "[role]",
					"[contenteditable='true']", "[tabindex]"
				].join(",");
				const elements = [];
				for (const candidate of document.querySelectorAll(selector)) {
					if (elements.length >= ${limit}) break;
					const rect = candidate.getBoundingClientRect();
					const style = getComputedStyle(candidate);
					if (
						rect.width <= 0 || rect.height <= 0 ||
						style.visibility === "hidden" || style.display === "none" ||
						rect.bottom < 0 || rect.right < 0 ||
						rect.top > innerHeight || rect.left > innerWidth
					) continue;
					const ref = "e" + (elements.length + 1);
					candidate.setAttribute("data-hlid-preview-ref", ref);
					const tag = candidate.tagName.toLowerCase();
					const input = candidate;
					const explicitRole = candidate.getAttribute("role");
					const role = explicitRole || (
						tag === "a" ? "link" :
						tag === "button" ? "button" :
						tag === "input" ? (
							input.type === "checkbox" ? "checkbox" :
							input.type === "radio" ? "radio" : "textbox"
						) : tag
					);
					const labelledBy = candidate.getAttribute("aria-labelledby");
					const labelledText = labelledBy?.split(/\\s+/)
						.map((id) => document.getElementById(id)?.textContent ?? "")
						.join(" ");
					const name = (
						candidate.getAttribute("aria-label") || labelledText ||
						candidate.getAttribute("title") ||
						(input.labels ? Array.from(input.labels).map((label) => label.textContent ?? "").join(" ") : "") ||
						input.placeholder || candidate.textContent || ""
					).replace(/\\s+/g, " ").trim().slice(0, 160);
					elements.push({
						ref, role, name, tag,
						...(tag === "input" && input.type ? { type: input.type } : {}),
						...(candidate.matches(":disabled, [aria-disabled='true']") ? { disabled: true } : {}),
						x: Math.round(rect.x), y: Math.round(rect.y),
						width: Math.round(rect.width), height: Math.round(rect.height)
					});
				}
				return elements;
			})()`,
		);
	}

	private async refPoint(ref: string): Promise<{ x: number; y: number }> {
		const result = await this.evaluate<{
			x?: number;
			y?: number;
			error?: string;
		}>(
			`(() => {
				const element = document.querySelector('[data-hlid-preview-ref="${ref}"]');
				if (!element || element.matches(":disabled, [aria-disabled='true']")) {
					return { error: "Preview element ${ref} is unavailable." };
				}
				const rect = element.getBoundingClientRect();
				if (rect.width <= 0 || rect.height <= 0) {
					return { error: "Preview element ${ref} is unavailable." };
				}
				element.scrollIntoView({ block: "center", inline: "center" });
				const next = element.getBoundingClientRect();
				return { x: next.x + next.width / 2, y: next.y + next.height / 2 };
			})()`,
		);
		if (result.error || result.x === undefined || result.y === undefined) {
			throw new Error(result.error ?? `Preview element ${ref} is unavailable.`);
		}
		return { x: result.x, y: result.y };
	}

	async clickRef(ref: string): Promise<void> {
		const point = await this.refPoint(ref);
		await this.clickAt(point.x, point.y);
	}

	async clickAt(x: number, y: number): Promise<void> {
		await this.page.send("Input.dispatchMouseEvent", {
			type: "mousePressed",
			x,
			y,
			button: "left",
			buttons: 1,
			clickCount: 1,
		});
		await this.page.send("Input.dispatchMouseEvent", {
			type: "mouseReleased",
			x,
			y,
			button: "left",
			buttons: 0,
			clickCount: 1,
		});
	}

	async fillRef(ref: string, text: string): Promise<void> {
		const result = await this.evaluate<{ error?: string }>(
			`(() => {
				const element = document.querySelector('[data-hlid-preview-ref="${ref}"]');
				if (!element || element.matches(":disabled, [aria-disabled='true']")) {
					return { error: "Preview element ${ref} is unavailable." };
				}
				if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
					const prototype = element instanceof HTMLTextAreaElement
						? HTMLTextAreaElement.prototype
						: HTMLInputElement.prototype;
					const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
					if (!setter) return { error: "Preview element ${ref} cannot accept text." };
					element.focus();
					setter.call(element, ${JSON.stringify(text)});
					element.dispatchEvent(new InputEvent("input", {
						bubbles: true, inputType: "insertText", data: ${JSON.stringify(text)}
					}));
					element.dispatchEvent(new Event("change", { bubbles: true }));
					return {};
				}
				if (element.isContentEditable) {
					element.focus();
					element.textContent = ${JSON.stringify(text)};
					element.dispatchEvent(new InputEvent("input", {
						bubbles: true, inputType: "insertText", data: ${JSON.stringify(text)}
					}));
					return {};
				}
				return { error: "Preview element ${ref} cannot accept text." };
			})()`,
		);
		if (result.error) throw new Error(result.error);
	}

	async pressKey(key: string): Promise<void> {
		const descriptor = keyDescriptor(key);
		await this.page.send("Input.dispatchKeyEvent", {
			type: "rawKeyDown",
			...descriptor,
			text: undefined,
		});
		if (descriptor.text) {
			await this.page.send("Input.dispatchKeyEvent", {
				type: "char",
				...descriptor,
			});
		}
		await this.page.send("Input.dispatchKeyEvent", {
			type: "keyUp",
			...descriptor,
			text: undefined,
		});
	}

	async scroll(deltaX: number, deltaY: number): Promise<void> {
		await this.page.send("Input.dispatchMouseEvent", {
			type: "mouseWheel",
			x: Math.round(this.viewportSize.width / 2),
			y: Math.round(this.viewportSize.height / 2),
			deltaX,
			deltaY,
		});
	}

	async scrollTo(x: number, y: number): Promise<void> {
		await this.evaluate(
			`(() => {
				window.scrollTo(${JSON.stringify(x)}, ${JSON.stringify(y)});
				return { x: window.scrollX, y: window.scrollY };
			})()`,
		);
	}

	async settle(): Promise<void> {
		await this.evaluate(PROJECT_PREVIEW_SETTLE_EXPRESSION, true);
	}

	diagnostics(): ProjectPreviewBrowserDiagnostics {
		return {
			consoleMessages: [...this.consoleMessages],
			failedRequests: [...this.failedRequests],
		};
	}

	async close(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		await this.browser
			.send("Target.closeTarget", { targetId: this.mainTargetId }, 1_000)
			.catch(() => {});
		this.page.close();
		this.browser.close();
		if (!this.ownedProcess) return;
		try {
			this.ownedProcess.child.kill();
		} catch {}
		await Promise.race([
			this.ownedProcess.child.exited.catch(() => -1),
			Bun.sleep(1_000),
		]);
		try {
			if (this.ownedProcess.child.exitCode === null) {
				this.ownedProcess.child.kill(9);
			}
		} catch {}
		await rm(this.ownedProcess.userDataDir, {
			recursive: true,
			force: true,
		}).catch(() => {});
	}
}

async function readDevToolsActivePort(
	userDataDir: string,
	child: Subprocess,
	signal: AbortSignal,
	deadline: number,
): Promise<{ port: number; browserPath: string }> {
	const path = join(userDataDir, "DevToolsActivePort");
	while (Date.now() < deadline) {
		if (signal.aborted) throw abortError();
		if (child.exitCode !== null) {
			throw new Error(
				`Preview browser exited during launch with code ${child.exitCode}.`,
			);
		}
		try {
			const active = parseDevToolsActivePort(await readFile(path, "utf8"));
			if (active) return active;
		} catch {}
		await wait(50, signal);
	}
	throw new Error("Timed out waiting for the Preview browser to start.");
}

export function parseDevToolsActivePort(
	value: string,
): { port: number; browserPath: string } | null {
	const [portText, browserPath] = value.split(/\r?\n/);
	const port = Number(portText);
	if (!Number.isInteger(port) || port <= 0 || !browserPath?.trim()) return null;
	return { port, browserPath: browserPath.trim() };
}

async function readConsentedDevToolsActivePort(
	userDataDir: string,
): Promise<{ port: number; browserPath: string }> {
	const path = join(userDataDir, "DevToolsActivePort");
	let active: { port: number; browserPath: string } | null = null;
	try {
		active = parseDevToolsActivePort(await readFile(path, "utf8"));
	} catch {}
	if (active) return active;
	throw new Error(
		`No consented remote debugging connection is available for ${userDataDir}. Enable it in the running browser at chrome://inspect/#remote-debugging or its browser-specific equivalent.`,
	);
}

async function createAttachedPageTarget(
	port: number,
	browser: CdpClient,
	deadline: number,
): Promise<CdpTarget> {
	const result = await browser.send(
		"Target.createTarget",
		PROJECT_PREVIEW_ATTACHED_TARGET_PARAMS,
		Math.max(1, deadline - Date.now()),
	);
	const targetId = String(result.targetId ?? "");
	if (!targetId) {
		throw new Error(
			"The real browser profile refused a hidden Preview target.",
		);
	}
	return {
		id: targetId,
		type: "page",
		webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/${targetId}`,
	};
}

async function fetchPageTarget(
	port: number,
	signal: AbortSignal,
	deadline: number,
): Promise<CdpTarget> {
	while (Date.now() < deadline) {
		if (signal.aborted) throw abortError();
		try {
			const response = await fetch(`http://127.0.0.1:${port}/json/list`, {
				signal: withTimeoutSignal(
					signal,
					Math.max(1, Math.min(1_000, deadline - Date.now())),
				),
			});
			if (response.ok) {
				const targets = (await response.json()) as CdpTarget[];
				const target = targets.find(
					(candidate) =>
						candidate.type === "page" && candidate.webSocketDebuggerUrl,
				);
				if (target) return target;
			}
		} catch (error) {
			if (signal.aborted) throw abortError();
			if (
				error instanceof DOMException &&
				error.name === "TimeoutError" &&
				Date.now() >= deadline
			) {
				break;
			}
		}
		await wait(50, signal);
	}
	throw new Error("Preview browser did not expose a page target.");
}

async function launchCandidate(
	candidate: BrowserCandidate,
	port: number,
	signal: AbortSignal,
	deadline: number,
): Promise<ProjectPreviewBrowserSession> {
	const userDataDir = await mkdtemp(
		join(tmpdir(), "hlid-project-preview-browser-"),
	);
	let child: Subprocess | null = null;
	let page: CdpClient | null = null;
	let browser: CdpClient | null = null;
	try {
		child = Bun.spawn(
			[
				candidate.executablePath,
				"--headless",
				"--disable-background-networking",
				"--disable-component-update",
				"--disable-default-apps",
				"--disable-extensions",
				"--disable-popup-blocking",
				"--disable-sync",
				"--metrics-recording-only",
				"--mute-audio",
				"--no-default-browser-check",
				"--no-first-run",
				"--remote-debugging-port=0",
				`--user-data-dir=${userDataDir}`,
				"--window-size=1440,1000",
				"about:blank",
			],
			{
				stdin: "ignore",
				stdout: "ignore",
				stderr: "ignore",
				windowsHide: true,
			},
		);
		const active = await readDevToolsActivePort(
			userDataDir,
			child,
			signal,
			deadline,
		);
		const target = await fetchPageTarget(active.port, signal, deadline);
		const remaining = Math.max(1, deadline - Date.now());
		[page, browser] = await Promise.all([
			CdpClient.connect(
				target.webSocketDebuggerUrl as string,
				signal,
				remaining,
			),
			CdpClient.connect(
				`ws://127.0.0.1:${active.port}${active.browserPath}`,
				signal,
				remaining,
			),
		]);
		const session = new CdpBrowserSession(port, page, browser, target.id, {
			child,
			userDataDir,
		});
		await session.initialize();
		return session;
	} catch (error) {
		page?.close();
		browser?.close();
		try {
			child?.kill();
		} catch {}
		if (child) {
			await Promise.race([child.exited.catch(() => -1), Bun.sleep(500)]);
		}
		await rm(userDataDir, { recursive: true, force: true }).catch(() => {});
		throw new Error(`${candidate.name}: ${errorMessage(error)}`);
	}
}

async function attachCandidate(
	candidate: BrowserCandidate,
	userDataDir: string,
	port: number,
	signal: AbortSignal,
	deadline: number,
): Promise<ProjectPreviewBrowserSession> {
	let page: CdpClient | null = null;
	let browser: CdpClient | null = null;
	let target: CdpTarget | null = null;
	try {
		const active = await readConsentedDevToolsActivePort(userDataDir);
		browser = await CdpClient.connect(
			`ws://127.0.0.1:${active.port}${active.browserPath}`,
			signal,
			Math.max(1, deadline - Date.now()),
		);
		target = await createAttachedPageTarget(active.port, browser, deadline);
		page = await CdpClient.connect(
			target.webSocketDebuggerUrl as string,
			signal,
			Math.max(1, deadline - Date.now()),
		);
		const session = new CdpBrowserSession(port, page, browser, target.id, null);
		await session.initialize();
		return session;
	} catch (error) {
		if (target && browser?.isConnected()) {
			await browser
				.send("Target.closeTarget", { targetId: target.id }, 1_000)
				.catch(() => {});
		}
		page?.close();
		browser?.close();
		throw new Error(`${candidate.name}: ${errorMessage(error)}`);
	}
}

async function attachRealProjectPreviewBrowserProfile(
	port: number,
	signal: AbortSignal,
): Promise<ProjectPreviewBrowserSession> {
	const connectSignal = withTimeoutSignal(
		signal,
		PROJECT_PREVIEW_REAL_PROFILE_CONNECT_TIMEOUT_MS,
	);
	const deadline = Date.now() + PROJECT_PREVIEW_REAL_PROFILE_CONNECT_TIMEOUT_MS;
	const candidates = await resolveProjectPreviewBrowserCandidates();
	const failures: string[] = [];
	const seen = new Set<string>();
	for (const candidate of candidates) {
		if (connectSignal.aborted || Date.now() >= deadline) break;
		const userDataDir = projectPreviewBrowserUserDataDir(
			candidate.executablePath,
		);
		if (!userDataDir || seen.has(userDataDir.toLowerCase())) continue;
		seen.add(userDataDir.toLowerCase());
		try {
			return await attachCandidate(
				candidate,
				userDataDir,
				port,
				connectSignal,
				deadline,
			);
		} catch (error) {
			failures.push(errorMessage(error));
		}
	}
	throw new Error(
		`Hlid could not connect to a consented real browser profile. ${failures.at(-1) ?? "Open a supported Chromium browser and enable consented remote debugging in its inspect page."}`.trim(),
	);
}

export const createProjectPreviewBrowserSession: ProjectPreviewBrowserSessionFactory =
	async (port, signal) => {
		if (loadConfig().project_preview.use_real_browser_profile) {
			return attachRealProjectPreviewBrowserProfile(port, signal);
		}
		const launchSignal = withTimeoutSignal(
			signal,
			PROJECT_PREVIEW_BROWSER_LAUNCH_TIMEOUT_MS,
		);
		const deadline = Date.now() + PROJECT_PREVIEW_BROWSER_LAUNCH_TIMEOUT_MS;
		const candidates = await resolveProjectPreviewBrowserCandidates();
		if (candidates.length === 0) {
			throw new Error(
				"Hlid could not find a Chromium-compatible browser. Set Chrome, Brave, Vivaldi, Chromium, or Edge as the default browser, or install one.",
			);
		}
		const failures: string[] = [];
		for (const candidate of candidates) {
			if (launchSignal.aborted || Date.now() >= deadline) break;
			try {
				return await launchCandidate(candidate, port, launchSignal, deadline);
			} catch (error) {
				failures.push(errorMessage(error));
			}
		}
		throw new Error(
			`Hlid could not start a Chromium-compatible browser for Preview capture. ${failures.at(-1) ?? ""}`.trim(),
		);
	};
