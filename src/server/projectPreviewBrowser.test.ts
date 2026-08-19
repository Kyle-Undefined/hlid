import { describe, expect, it, vi } from "vitest";
import {
	ProjectPreviewBrowserManager,
	type ProjectPreviewControlAction,
} from "./projectPreviewBrowser";
import {
	PROJECT_PREVIEW_CAPTURE_VIEWPORTS,
	type ProjectPreviewCaptureSize,
	type ProjectPreviewCaptureViewport,
} from "./projectPreviewCapture";
import type {
	ProjectPreviewBrowserSession,
	ProjectPreviewBrowserSessionFactory,
} from "./projectPreviewCdp";

function fakeBrowserSession() {
	let currentUrl = "about:blank";
	let connected = true;
	let viewport: "desktop" | "tablet" | "mobile" = "desktop";
	let viewportSize: ProjectPreviewCaptureSize =
		PROJECT_PREVIEW_CAPTURE_VIEWPORTS.desktop;
	const browser: ProjectPreviewBrowserSession = {
		isConnected: vi.fn(() => connected),
		currentUrl: vi.fn(async () => currentUrl),
		navigate: vi.fn(async (url: string) => {
			currentUrl = url;
		}),
		reload: vi.fn(async () => {}),
		setViewport: vi.fn(
			async (
				next: ProjectPreviewCaptureViewport,
				size?: ProjectPreviewCaptureSize,
			) => {
				viewport = next;
				viewportSize = size ?? PROJECT_PREVIEW_CAPTURE_VIEWPORTS[next];
			},
		),
		capture: vi.fn(async () => ({
			png: Buffer.from([1, 2, 3]),
			pixelWidth: viewportSize.width * 2,
			pixelHeight: viewportSize.height * 2,
			deviceScaleFactor: 2,
			pixelRatio: 2,
		})),
		title: vi.fn(async () => "Preview app"),
		semanticSnapshot: vi.fn(async () => [
			{
				ref: "e1",
				role: "button",
				name: "Save",
				tag: "button",
				x: 10,
				y: 20,
				width: 80,
				height: 30,
			},
		]),
		clickRef: vi.fn(async () => {}),
		clickAt: vi.fn(async () => {}),
		fillRef: vi.fn(async () => {}),
		pressKey: vi.fn(async () => {}),
		scroll: vi.fn(async () => {}),
		scrollTo: vi.fn(async () => {}),
		settle: vi.fn(async () => {}),
		diagnostics: vi.fn(() => ({
			consoleMessages: [],
			failedRequests: [],
		})),
		close: vi.fn(async () => {
			connected = false;
		}),
	};
	const factory = vi.fn(
		async () => browser,
	) satisfies ProjectPreviewBrowserSessionFactory;
	const relay = {
		browserAccess: {
			origin: "http://hlid-browser-test.localhost:6173",
			cookieName: "__hlid_agent_preview_test",
			cookieToken: "agent-relay-test-token",
		},
		close: vi.fn(async () => {}),
	};
	const relayFactory = vi.fn(async () => relay);
	return {
		browser,
		factory,
		relay,
		relayFactory,
		disconnect: () => {
			connected = false;
		},
		viewport: () => viewport,
	};
}

const base = {
	previewId: "123e4567-e89b-12d3-a456-426614174000",
	sessionId: "session-1",
	port: 5173,
	capability: { token: "preview-auth-test-token" },
	initialPath: "/",
};

describe("ProjectPreviewBrowserManager", () => {
	it("reuses one stateful browser and publishes semantic frames", async () => {
		const fake = fakeBrowserSession();
		const manager = new ProjectPreviewBrowserManager({
			browserFactory: fake.factory,
			relayFactory: fake.relayFactory,
		});

		const first = await manager.capture({
			previewId: base.previewId,
			sessionId: base.sessionId,
			port: base.port,
			capability: base.capability,
			path: "/app",
			viewport: "mobile",
			fullPage: false,
		});
		const second = await manager.capture({
			previewId: base.previewId,
			sessionId: base.sessionId,
			port: base.port,
			capability: base.capability,
			path: "/app",
			viewport: "mobile",
			fullPage: false,
		});

		expect(fake.factory).toHaveBeenCalledOnce();
		expect(fake.factory).toHaveBeenCalledWith(
			{ kind: "project", ...fake.relay.browserAccess },
			expect.any(AbortSignal),
		);
		expect(fake.relayFactory).toHaveBeenCalledWith({
			targetPort: base.port,
			capability: base.capability,
		});
		expect(fake.browser.setViewport).toHaveBeenCalledWith("mobile");
		expect(fake.viewport()).toBe("mobile");
		expect(first.frame_id).not.toBe(second.frame_id);
		expect(second).toMatchObject({
			path: "/app",
			title: "Preview app",
			pixel_width: 780,
			pixel_height: 1688,
			device_scale_factor: 2,
			pixel_ratio: 2,
			elements: [{ ref: "e1", role: "button", name: "Save" }],
		});
		expect(
			manager.getLatestFrame(base.previewId, base.sessionId)?.frame_id,
		).toBe(second.frame_id);
		expect(
			manager.getFrame(base.previewId, base.sessionId, first.frame_id)
				?.frame_id,
		).toBe(first.frame_id);
		const frameWindow = manager.getFrameWindow(base.previewId, base.sessionId);
		expect(frameWindow.frames).toEqual([
			expect.objectContaining({ frame_id: first.frame_id, path: "/app" }),
			expect.objectContaining({ frame_id: second.frame_id, path: "/app" }),
		]);
		expect(frameWindow.frames[0]).not.toHaveProperty("image_base64");
		expect(frameWindow.latest_frame?.frame_id).toBe(second.frame_id);
		expect(
			manager.getFrameWindow(base.previewId, base.sessionId, second.frame_id)
				.latest_frame,
		).toBeNull();

		await manager.close(base.previewId);
		expect(
			manager.getFrame(base.previewId, base.sessionId, first.frame_id)
				?.frame_id,
		).toBe(first.frame_id);
		expect(fake.browser.close).toHaveBeenCalledOnce();
		expect(fake.relay.close).toHaveBeenCalledOnce();
		await manager.closeAll();
	});

	it("recaptures at the reported user viewport and document scroll", async () => {
		const fake = fakeBrowserSession();
		const manager = new ProjectPreviewBrowserManager({
			browserFactory: fake.factory,
			relayFactory: fake.relayFactory,
		});

		const frame = await manager.capture({
			previewId: base.previewId,
			sessionId: base.sessionId,
			port: base.port,
			capability: base.capability,
			path: "/settings?tab=ui",
			viewport: "mobile",
			size: { width: 412, height: 715 },
			scrollX: 8,
			scrollY: 640,
			fullPage: false,
		});

		expect(fake.browser.setViewport).toHaveBeenCalledWith("mobile", {
			width: 412,
			height: 715,
		});
		expect(fake.browser.scrollTo).toHaveBeenCalledWith(8, 640);
		expect(frame).toMatchObject({
			path: "/settings?tab=ui",
			viewport: "mobile",
			width: 412,
			height: 715,
		});
		await manager.closeAll();
	});

	it("fails closed on stale frames and returns a frame after a bounded action", async () => {
		const fake = fakeBrowserSession();
		const manager = new ProjectPreviewBrowserManager({
			browserFactory: fake.factory,
			relayFactory: fake.relayFactory,
		});
		const observed = await manager.capture({
			previewId: base.previewId,
			sessionId: base.sessionId,
			port: base.port,
			capability: base.capability,
			path: "/",
			viewport: "desktop",
			fullPage: false,
		});

		await expect(
			manager.control({
				...base,
				action: "click",
				frameId: crypto.randomUUID(),
				ref: "e1",
			}),
		).rejects.toThrow("stale");

		const action: ProjectPreviewControlAction = {
			...base,
			action: "click",
			frameId: observed.frame_id,
			ref: "e1",
		};
		const result = await manager.control(action);

		expect(fake.browser.clickRef).toHaveBeenCalledWith("e1");
		expect(result.last_action).toBe("click");
		expect(result.frame_id).not.toBe(observed.frame_id);
		await manager.closeAll();
	});

	it("keeps navigation Preview-local and rejects unsupported keys", async () => {
		const fake = fakeBrowserSession();
		const manager = new ProjectPreviewBrowserManager({
			browserFactory: fake.factory,
			relayFactory: fake.relayFactory,
		});

		await expect(
			manager.control({
				...base,
				action: "navigate",
				path: "https://example.com",
			}),
		).rejects.toThrow("single slash");
		await expect(
			manager.control({
				...base,
				action: "key",
				key: "F12",
			}),
		).rejects.toThrow("Unsupported");

		await manager.closeAll();
	});

	it("dispatches the remaining bounded browser controls", async () => {
		const fake = fakeBrowserSession();
		const manager = new ProjectPreviewBrowserManager({
			browserFactory: fake.factory,
			relayFactory: fake.relayFactory,
		});
		let frame = await manager.capture({
			previewId: base.previewId,
			sessionId: base.sessionId,
			port: base.port,
			capability: base.capability,
			path: "/",
			viewport: "desktop",
			fullPage: false,
		});

		frame = await manager.control({
			...base,
			action: "click",
			frameId: frame.frame_id,
			x: 40,
			y: 50,
		});
		expect(fake.browser.clickAt).toHaveBeenCalledWith(40, 50);

		frame = await manager.control({ ...base, action: "key", key: "Enter" });
		expect(fake.browser.pressKey).toHaveBeenCalledWith("Enter");

		frame = await manager.control({
			...base,
			action: "scroll",
			deltaX: 10,
			deltaY: 500,
		});
		expect(fake.browser.scroll).toHaveBeenCalledWith(10, 500);

		frame = await manager.control({
			...base,
			action: "navigate",
			path: "/settings?tab=ui",
		});
		expect(frame.path).toBe("/settings?tab=ui");

		frame = await manager.control({ ...base, action: "reload" });
		expect(fake.browser.reload).toHaveBeenCalledOnce();

		frame = await manager.control({
			...base,
			action: "viewport",
			viewport: "tablet",
		});
		expect(frame).toMatchObject({
			last_action: "viewport",
			viewport: "tablet",
			width: 768,
			height: 1024,
		});

		await manager.closeAll();
	});

	it("lets Preview lifecycle cleanup preempt an active browser action", async () => {
		const fake = fakeBrowserSession();
		const manager = new ProjectPreviewBrowserManager({
			browserFactory: fake.factory,
			relayFactory: fake.relayFactory,
		});
		const frame = await manager.capture({
			previewId: base.previewId,
			sessionId: base.sessionId,
			port: base.port,
			capability: base.capability,
			path: "/",
			viewport: "desktop",
			fullPage: false,
		});
		let finishClick = () => {};
		vi.mocked(fake.browser.clickRef).mockImplementationOnce(
			() =>
				new Promise<void>((resolve) => {
					finishClick = resolve;
				}),
		);
		const action = manager.control({
			...base,
			action: "click",
			frameId: frame.frame_id,
			ref: "e1",
		});
		await vi.waitFor(() =>
			expect(fake.browser.clickRef).toHaveBeenCalledOnce(),
		);

		await manager.close(base.previewId);
		expect(fake.browser.close).toHaveBeenCalledOnce();
		const rejected = expect(action).rejects.toThrow("browser was closed");
		finishClick();

		await rejected;
	});

	it("aborts an in-progress browser launch when the Preview stops", async () => {
		const factory: ProjectPreviewBrowserSessionFactory = vi.fn(
			(_relay, signal) =>
				new Promise<ProjectPreviewBrowserSession>((_resolve, reject) => {
					signal.addEventListener(
						"abort",
						() => reject(new Error("launch cancelled")),
						{ once: true },
					);
				}),
		);
		const relay = {
			browserAccess: {
				origin: "http://hlid-abort-test.localhost:6174",
				cookieName: "__hlid_agent_preview_abort",
				cookieToken: "agent-relay-abort-token",
			},
			close: vi.fn(async () => {}),
		};
		const manager = new ProjectPreviewBrowserManager({
			browserFactory: factory,
			relayFactory: vi.fn(async () => relay),
		});
		const capture = manager.capture({
			previewId: base.previewId,
			sessionId: base.sessionId,
			port: base.port,
			capability: base.capability,
			path: "/",
			viewport: "desktop",
			fullPage: false,
		});
		await vi.waitFor(() => expect(factory).toHaveBeenCalledOnce());

		await manager.close(base.previewId);
		await expect(capture).rejects.toThrow("launch cancelled");
		expect(relay.close).toHaveBeenCalledOnce();
	});

	it("closes the private relay when initial navigation fails", async () => {
		const fake = fakeBrowserSession();
		vi.mocked(fake.browser.navigate).mockRejectedValueOnce(
			new Error("navigation failed"),
		);
		const manager = new ProjectPreviewBrowserManager({
			browserFactory: fake.factory,
			relayFactory: fake.relayFactory,
		});

		await expect(
			manager.capture({
				previewId: base.previewId,
				sessionId: base.sessionId,
				port: base.port,
				capability: base.capability,
				path: "/",
				viewport: "desktop",
				fullPage: false,
			}),
		).rejects.toThrow("navigation failed");
		expect(fake.browser.close).toHaveBeenCalledOnce();
		expect(fake.relay.close).toHaveBeenCalledOnce();
	});

	it("evicts a disconnected browser after preserving its timeout error", async () => {
		const first = fakeBrowserSession();
		const second = fakeBrowserSession();
		let browserLaunches = 0;
		const factory: ProjectPreviewBrowserSessionFactory = vi.fn(async () => {
			browserLaunches += 1;
			return browserLaunches === 1 ? first.browser : second.browser;
		});
		let relayLaunches = 0;
		const relayFactory = vi.fn(async () => {
			relayLaunches += 1;
			return relayLaunches === 1 ? first.relay : second.relay;
		});
		const manager = new ProjectPreviewBrowserManager({
			browserFactory: factory,
			relayFactory,
		});
		const frame = await manager.capture({
			previewId: base.previewId,
			sessionId: base.sessionId,
			port: base.port,
			capability: base.capability,
			path: "/",
			viewport: "desktop",
			fullPage: false,
		});
		vi.mocked(first.browser.clickRef).mockImplementationOnce(async () => {
			first.disconnect();
			throw new Error("Preview browser command Runtime.evaluate timed out.");
		});

		await expect(
			manager.control({
				...base,
				action: "click",
				frameId: frame.frame_id,
				ref: "e1",
			}),
		).rejects.toThrow("Preview browser command Runtime.evaluate timed out.");
		expect(first.browser.close).toHaveBeenCalledOnce();
		expect(first.relay.close).toHaveBeenCalledOnce();

		const recovered = await manager.capture({
			previewId: base.previewId,
			sessionId: base.sessionId,
			port: base.port,
			capability: base.capability,
			path: "/recovered",
			viewport: "desktop",
			fullPage: false,
		});
		expect(factory).toHaveBeenCalledTimes(2);
		expect(relayFactory).toHaveBeenCalledTimes(2);
		expect(recovered.path).toBe("/recovered");

		await manager.closeAll();
		expect(second.browser.close).toHaveBeenCalledOnce();
		expect(second.relay.close).toHaveBeenCalledOnce();
	});

	it("opens a public web target without a project relay", async () => {
		const fake = fakeBrowserSession();
		const manager = new ProjectPreviewBrowserManager({
			browserFactory: fake.factory,
			relayFactory: fake.relayFactory,
		});

		const frame = await manager.captureWeb({
			previewId: base.previewId,
			sessionId: base.sessionId,
			initialUrl: "https://example.com/docs",
			allowPrivateNetwork: false,
			viewport: "desktop",
			fullPage: false,
		});

		expect(fake.factory).toHaveBeenCalledWith(
			{
				kind: "web",
				initialUrl: "https://example.com/docs",
				approvedPrivateOrigin: null,
			},
			expect.any(AbortSignal),
		);
		expect(fake.relayFactory).not.toHaveBeenCalled();
		expect(frame).toMatchObject({
			target_kind: "browser",
			path: "https://example.com/docs",
		});
		await manager.closeAll();
	});

	it("requires an exact-origin grant for private Browser targets", async () => {
		const denied = fakeBrowserSession();
		const deniedManager = new ProjectPreviewBrowserManager({
			browserFactory: denied.factory,
			relayFactory: denied.relayFactory,
		});
		await expect(
			deniedManager.captureWeb({
				previewId: base.previewId,
				sessionId: base.sessionId,
				initialUrl: "http://127.0.0.1:8080/",
				allowPrivateNetwork: false,
				viewport: "desktop",
				fullPage: false,
			}),
		).rejects.toThrow(/allow_private_network/);

		const allowed = fakeBrowserSession();
		const manager = new ProjectPreviewBrowserManager({
			browserFactory: allowed.factory,
			relayFactory: allowed.relayFactory,
		});
		const frame = await manager.captureWeb({
			previewId: base.previewId,
			sessionId: base.sessionId,
			initialUrl: "http://127.0.0.1:8080/",
			allowPrivateNetwork: true,
			viewport: "desktop",
			fullPage: false,
		});
		await expect(
			manager.controlWeb({
				previewId: base.previewId,
				sessionId: base.sessionId,
				initialUrl: "http://127.0.0.1:8080/",
				allowPrivateNetwork: true,
				action: "navigate",
				url: "http://localhost:8080/elsewhere",
			}),
		).rejects.toThrow(/exact approved origin/);
		expect(frame.path).toBe("http://127.0.0.1:8080/");
		await manager.closeAll();
	});

	it("records bounded Browser capture states and clears the live indicator on stop", async () => {
		const fake = fakeBrowserSession();
		const manager = new ProjectPreviewBrowserManager({
			browserFactory: fake.factory,
			relayFactory: fake.relayFactory,
		});
		const recordingFrame = await manager.startWebRecording({
			previewId: base.previewId,
			sessionId: base.sessionId,
			initialUrl: "https://example.com/",
			allowPrivateNetwork: false,
		});
		expect(recordingFrame.recording).toBe(true);
		const clicked = await manager.controlWeb({
			previewId: base.previewId,
			sessionId: base.sessionId,
			initialUrl: "https://example.com/",
			allowPrivateNetwork: false,
			action: "click",
			frameId: recordingFrame.frame_id,
			ref: "e1",
		});
		expect(clicked.recording).toBe(true);
		const recording = await manager.stopWebRecording(
			base.previewId,
			base.sessionId,
		);
		expect(recording.frames).toHaveLength(2);
		expect(recording.frames[0]?.action).toBeUndefined();
		expect(recording.frames[1]?.action).toBe("click");
		expect(
			manager.getLatestFrame(base.previewId, base.sessionId)?.recording,
		).toBeUndefined();
		await manager.closeAll();
	});
});
