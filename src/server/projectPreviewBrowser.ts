import {
	isAllowedProjectPreviewBrowserUrl,
	normalizeProjectPreviewCapturePath,
	PROJECT_PREVIEW_CAPTURE_VIEWPORTS,
	type ProjectPreviewCaptureInput,
	type ProjectPreviewCaptureViewport,
} from "./projectPreviewCapture";
import {
	createProjectPreviewBrowserSession,
	type ProjectPreviewBrowserSession,
	type ProjectPreviewBrowserSessionFactory,
} from "./projectPreviewCdp";
import type { ProjectPreviewAgentFrame } from "./protocol";

export type { ProjectPreviewAgentFrame } from "./protocol";

const MAX_ELEMENTS = 100;
const MAX_QUEUED_ACTIONS = 8;
const AGENT_BROWSER_IDLE_MS = 30 * 60 * 1_000;
const MAX_RETAINED_FRAMES_PER_PREVIEW = 12;
const MAX_RETAINED_FRAME_BYTES = 64 * 1024 * 1024;

type ProjectPreviewControlBase = {
	previewId: string;
	sessionId: string;
	port: number;
	initialPath: string;
};

export type ProjectPreviewControlAction =
	| (ProjectPreviewControlBase & {
			action: "click";
			frameId: string;
			ref?: string;
			x?: number;
			y?: number;
	  })
	| (ProjectPreviewControlBase & {
			action: "type";
			frameId: string;
			ref: string;
			text: string;
	  })
	| (ProjectPreviewControlBase & {
			action: "key";
			key: string;
	  })
	| (ProjectPreviewControlBase & {
			action: "scroll";
			deltaX: number;
			deltaY: number;
	  })
	| (ProjectPreviewControlBase & {
			action: "navigate";
			path: string;
	  })
	| (ProjectPreviewControlBase & {
			action: "reload";
	  })
	| (ProjectPreviewControlBase & {
			action: "viewport";
			viewport: ProjectPreviewCaptureViewport;
	  });

type BrowserEntry = {
	previewId: string;
	sessionId: string;
	port: number;
	browser: ProjectPreviewBrowserSession;
	viewport: ProjectPreviewCaptureViewport;
	width: number;
	height: number;
	lastFrame: ProjectPreviewAgentFrame | null;
	idleTimer: ReturnType<typeof setTimeout>;
};

type BrowserManagerOptions = {
	browserFactory?: ProjectPreviewBrowserSessionFactory;
	idleMs?: number;
};
async function currentPath(
	browser: ProjectPreviewBrowserSession,
	port: number,
): Promise<string> {
	try {
		const url = new URL(await browser.currentUrl());
		if (!isAllowedProjectPreviewBrowserUrl(url.toString(), port)) return "/";
		return `${url.pathname}${url.search}${url.hash}`;
	} catch {
		return "/";
	}
}

function validateKey(key: string): string {
	const trimmed = key.trim();
	const named = new Set([
		"Enter",
		"Tab",
		"Escape",
		"Backspace",
		"Delete",
		"ArrowUp",
		"ArrowDown",
		"ArrowLeft",
		"ArrowRight",
		"Home",
		"End",
		"PageUp",
		"PageDown",
		"Space",
	]);
	if (
		named.has(trimmed) ||
		/^[A-Za-z0-9]$/.test(trimmed) ||
		/^(Control|Meta|Alt|Shift)\+([A-Za-z0-9]|Enter|Tab|Backspace|Delete)$/.test(
			trimmed,
		)
	) {
		return trimmed;
	}
	throw new Error(`Unsupported Preview key: ${trimmed || "(empty)"}.`);
}

export class ProjectPreviewBrowserManager {
	private readonly entries = new Map<string, BrowserEntry>();
	private readonly queues = new Map<string, Promise<void>>();
	private readonly pending = new Map<string, number>();
	private readonly generations = new Map<string, number>();
	private readonly launches = new Map<string, AbortController>();
	private readonly frameHistory = new Map<string, ProjectPreviewAgentFrame[]>();
	private retainedFrameBytes = 0;
	private readonly browserFactory: ProjectPreviewBrowserSessionFactory;
	private readonly idleMs: number;

	constructor(options: BrowserManagerOptions = {}) {
		this.browserFactory =
			options.browserFactory ?? createProjectPreviewBrowserSession;
		this.idleMs = options.idleMs ?? AGENT_BROWSER_IDLE_MS;
	}

	private resetIdle(entry: BrowserEntry): void {
		clearTimeout(entry.idleTimer);
		entry.idleTimer = setTimeout(() => {
			void this.close(entry.previewId);
		}, this.idleMs);
		entry.idleTimer.unref?.();
	}

	private assertGeneration(previewId: string, generation: number): void {
		if ((this.generations.get(previewId) ?? 0) !== generation) {
			throw new Error("Project Preview browser was closed.");
		}
	}

	private async serialized<T>(
		previewId: string,
		operation: (generation: number) => Promise<T>,
	): Promise<T> {
		const count = this.pending.get(previewId) ?? 0;
		if (count >= MAX_QUEUED_ACTIONS) {
			throw new Error("Too many queued Project Preview browser actions.");
		}
		this.pending.set(previewId, count + 1);
		const previous = this.queues.get(previewId) ?? Promise.resolve();
		const generation = this.generations.get(previewId) ?? 0;
		let release = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const tail = previous.catch(() => {}).then(() => gate);
		this.queues.set(previewId, tail);
		await previous.catch(() => {});
		try {
			this.assertGeneration(previewId, generation);
			return await operation(generation);
		} finally {
			release();
			const remaining = (this.pending.get(previewId) ?? 1) - 1;
			if (remaining > 0) this.pending.set(previewId, remaining);
			else {
				this.pending.delete(previewId);
				if (this.queues.get(previewId) === tail) {
					this.queues.delete(previewId);
				}
			}
		}
	}

	private async createEntry(
		input: ProjectPreviewControlBase,
		generation: number,
	): Promise<BrowserEntry> {
		const launch = new AbortController();
		this.launches.set(input.previewId, launch);
		let browser: ProjectPreviewBrowserSession | null = null;
		try {
			browser = await this.browserFactory(input.port, launch.signal);
			await browser.navigate(
				`http://127.0.0.1:${input.port}${normalizeProjectPreviewCapturePath(input.initialPath)}`,
			);
			const entry: BrowserEntry = {
				previewId: input.previewId,
				sessionId: input.sessionId,
				port: input.port,
				browser,
				viewport: "desktop",
				width: PROJECT_PREVIEW_CAPTURE_VIEWPORTS.desktop.width,
				height: PROJECT_PREVIEW_CAPTURE_VIEWPORTS.desktop.height,
				lastFrame: null,
				idleTimer: setTimeout(() => {}, this.idleMs),
			};
			entry.idleTimer.unref?.();
			if ((this.generations.get(input.previewId) ?? 0) !== generation) {
				await browser.close().catch(() => {});
				throw new Error("Project Preview browser was closed.");
			}
			this.entries.set(input.previewId, entry);
			this.resetIdle(entry);
			return entry;
		} catch (error) {
			await browser?.close().catch(() => {});
			throw error;
		} finally {
			if (this.launches.get(input.previewId) === launch) {
				this.launches.delete(input.previewId);
			}
		}
	}

	private async entry(
		input: ProjectPreviewControlBase,
		generation: number,
	): Promise<BrowserEntry> {
		const current = this.entries.get(input.previewId);
		if (
			current &&
			current.sessionId === input.sessionId &&
			current.port === input.port &&
			current.browser.isConnected()
		) {
			this.resetIdle(current);
			return current;
		}
		if (current) await this.closeEntry(current);
		return this.createEntry(input, generation);
	}

	private async frame(
		entry: BrowserEntry,
		fullPage: boolean,
		lastAction?: ProjectPreviewControlAction["action"],
	): Promise<ProjectPreviewAgentFrame> {
		const capture = await entry.browser.capture(fullPage);
		const diagnostics = entry.browser.diagnostics();
		const frame: ProjectPreviewAgentFrame = {
			preview_id: entry.previewId,
			session_id: entry.sessionId,
			path: await currentPath(entry.browser, entry.port),
			viewport: entry.viewport,
			width: entry.width,
			height: entry.height,
			pixel_width: capture.pixelWidth,
			pixel_height: capture.pixelHeight,
			device_scale_factor: capture.deviceScaleFactor,
			pixel_ratio: capture.pixelRatio,
			full_page: fullPage,
			captured_at: Date.now(),
			mime: "image/png",
			size_bytes: capture.png.byteLength,
			image_base64: capture.png.toString("base64"),
			frame_id: crypto.randomUUID(),
			title: (await entry.browser.title()).slice(0, 200),
			elements: await entry.browser.semanticSnapshot(MAX_ELEMENTS),
			console_messages: diagnostics.consoleMessages,
			failed_requests: diagnostics.failedRequests,
			...(lastAction ? { last_action: lastAction } : {}),
		};
		entry.lastFrame = frame;
		this.retainFrame(frame);
		this.resetIdle(entry);
		return frame;
	}

	private retainFrame(frame: ProjectPreviewAgentFrame): void {
		const history = this.frameHistory.get(frame.preview_id) ?? [];
		history.push(frame);
		this.retainedFrameBytes += frame.size_bytes;
		while (history.length > MAX_RETAINED_FRAMES_PER_PREVIEW) {
			const removed = history.shift();
			if (removed) this.retainedFrameBytes -= removed.size_bytes;
		}
		this.frameHistory.set(frame.preview_id, history);
		while (this.retainedFrameBytes > MAX_RETAINED_FRAME_BYTES) {
			let oldestPreviewId: string | null = null;
			let oldestCapturedAt = Number.POSITIVE_INFINITY;
			for (const [previewId, frames] of this.frameHistory) {
				const capturedAt = frames[0]?.captured_at;
				if (capturedAt !== undefined && capturedAt < oldestCapturedAt) {
					oldestPreviewId = previewId;
					oldestCapturedAt = capturedAt;
				}
			}
			if (!oldestPreviewId) break;
			const oldestHistory = this.frameHistory.get(oldestPreviewId);
			const removed = oldestHistory?.shift();
			if (removed) this.retainedFrameBytes -= removed.size_bytes;
			if (!oldestHistory || oldestHistory.length === 0) {
				this.frameHistory.delete(oldestPreviewId);
			}
		}
	}

	async capture(
		input: ProjectPreviewCaptureInput,
	): Promise<ProjectPreviewAgentFrame> {
		return this.serialized(input.previewId, async (generation) => {
			const entry = await this.entry(
				{
					previewId: input.previewId,
					sessionId: input.sessionId,
					port: input.port,
					initialPath: input.path,
				},
				generation,
			);
			const size =
				input.size ?? PROJECT_PREVIEW_CAPTURE_VIEWPORTS[input.viewport];
			if (
				entry.viewport !== input.viewport ||
				entry.width !== size.width ||
				entry.height !== size.height
			) {
				if (input.size) {
					await entry.browser.setViewport(input.viewport, input.size);
				} else {
					await entry.browser.setViewport(input.viewport);
				}
				entry.viewport = input.viewport;
				entry.width = size.width;
				entry.height = size.height;
			}
			const path = normalizeProjectPreviewCapturePath(input.path);
			if ((await currentPath(entry.browser, entry.port)) !== path) {
				await entry.browser.navigate(`http://127.0.0.1:${entry.port}${path}`);
			}
			if (input.scrollX !== undefined || input.scrollY !== undefined) {
				await entry.browser.settle();
				await entry.browser.scrollTo(input.scrollX ?? 0, input.scrollY ?? 0);
			}
			this.assertGeneration(input.previewId, generation);
			return this.frame(entry, input.fullPage);
		});
	}

	async control(
		input: ProjectPreviewControlAction,
	): Promise<ProjectPreviewAgentFrame> {
		return this.serialized(input.previewId, async (generation) => {
			const entry = await this.entry(input, generation);
			if (
				(input.action === "click" || input.action === "type") &&
				entry.lastFrame?.frame_id !== input.frameId
			) {
				throw new Error(
					"Project Preview frame is stale. Capture the Preview again before interacting.",
				);
			}
			if (input.action === "click") {
				if (input.ref) {
					await entry.browser.clickRef(input.ref);
				} else {
					if (
						input.x === undefined ||
						input.y === undefined ||
						input.x < 0 ||
						input.y < 0 ||
						input.x > entry.width ||
						input.y > entry.height
					) {
						throw new Error(
							"Preview click coordinates are outside the viewport.",
						);
					}
					await entry.browser.clickAt(input.x, input.y);
				}
			} else if (input.action === "type") {
				await entry.browser.fillRef(input.ref, input.text);
			} else if (input.action === "key") {
				await entry.browser.pressKey(validateKey(input.key));
			} else if (input.action === "scroll") {
				await entry.browser.scroll(input.deltaX, input.deltaY);
			} else if (input.action === "navigate") {
				const path = normalizeProjectPreviewCapturePath(input.path);
				await entry.browser.navigate(`http://127.0.0.1:${entry.port}${path}`);
			} else if (input.action === "reload") {
				await entry.browser.reload();
			} else {
				await entry.browser.setViewport(input.viewport);
				entry.viewport = input.viewport;
				entry.width = PROJECT_PREVIEW_CAPTURE_VIEWPORTS[input.viewport].width;
				entry.height = PROJECT_PREVIEW_CAPTURE_VIEWPORTS[input.viewport].height;
			}
			await entry.browser.settle();
			this.assertGeneration(input.previewId, generation);
			return this.frame(entry, false, input.action);
		});
	}

	getLatestFrame(
		previewId: string,
		sessionId: string,
	): ProjectPreviewAgentFrame | null {
		return this.getFrame(previewId, sessionId);
	}

	getFrame(
		previewId: string,
		sessionId: string,
		frameId?: string,
	): ProjectPreviewAgentFrame | null {
		const frames = this.frameHistory.get(previewId);
		const frame = frameId
			? frames?.find((candidate) => candidate.frame_id === frameId)
			: frames?.at(-1);
		if (!frame || frame.session_id !== sessionId) return null;
		return { ...frame };
	}

	private async closeEntry(entry: BrowserEntry): Promise<void> {
		clearTimeout(entry.idleTimer);
		if (this.entries.get(entry.previewId) === entry) {
			this.entries.delete(entry.previewId);
		}
		await entry.browser.close().catch(() => {});
	}

	async close(previewId: string): Promise<void> {
		this.generations.set(previewId, (this.generations.get(previewId) ?? 0) + 1);
		this.launches.get(previewId)?.abort();
		const entry = this.entries.get(previewId);
		if (entry) await this.closeEntry(entry);
	}

	async closeAll(): Promise<void> {
		await Promise.all(
			[
				...new Set([
					...this.entries.keys(),
					...this.queues.keys(),
					...this.launches.keys(),
				]),
			].map((id) => this.close(id)),
		);
		this.frameHistory.clear();
		this.retainedFrameBytes = 0;
	}
}

export const projectPreviewBrowserManager = new ProjectPreviewBrowserManager();
