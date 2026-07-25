import { describe, expect, it, vi } from "vitest";
import {
	ProjectPreviewBrowserManager,
	type ProjectPreviewControlAction,
} from "./projectPreviewBrowser";
import type {
	ProjectPreviewBrowserSession,
	ProjectPreviewBrowserSessionFactory,
} from "./projectPreviewCdp";

function fakeBrowserSession() {
	let currentUrl = "about:blank";
	let connected = true;
	let viewport: "desktop" | "tablet" | "mobile" = "desktop";
	const browser: ProjectPreviewBrowserSession = {
		isConnected: vi.fn(() => connected),
		currentUrl: vi.fn(async () => currentUrl),
		navigate: vi.fn(async (url: string) => {
			currentUrl = url;
		}),
		reload: vi.fn(async () => {}),
		setViewport: vi.fn(async (next) => {
			viewport = next;
		}),
		capture: vi.fn(async () => Buffer.from([1, 2, 3])),
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
	return {
		browser,
		factory,
		viewport: () => viewport,
	};
}

const base = {
	previewId: "123e4567-e89b-12d3-a456-426614174000",
	sessionId: "session-1",
	port: 5173,
	initialPath: "/",
};

describe("ProjectPreviewBrowserManager", () => {
	it("reuses one stateful browser and publishes semantic frames", async () => {
		const fake = fakeBrowserSession();
		const manager = new ProjectPreviewBrowserManager({
			browserFactory: fake.factory,
		});

		const first = await manager.capture({
			previewId: base.previewId,
			sessionId: base.sessionId,
			port: base.port,
			path: "/app",
			viewport: "mobile",
			fullPage: false,
		});
		const second = await manager.capture({
			previewId: base.previewId,
			sessionId: base.sessionId,
			port: base.port,
			path: "/app",
			viewport: "mobile",
			fullPage: false,
		});

		expect(fake.factory).toHaveBeenCalledOnce();
		expect(fake.browser.setViewport).toHaveBeenCalledWith("mobile");
		expect(fake.viewport()).toBe("mobile");
		expect(first.frame_id).not.toBe(second.frame_id);
		expect(second).toMatchObject({
			path: "/app",
			title: "Preview app",
			elements: [{ ref: "e1", role: "button", name: "Save" }],
		});
		expect(
			manager.getLatestFrame(base.previewId, base.sessionId)?.frame_id,
		).toBe(second.frame_id);
		expect(
			manager.getFrame(base.previewId, base.sessionId, first.frame_id)
				?.frame_id,
		).toBe(first.frame_id);

		await manager.close(base.previewId);
		expect(
			manager.getFrame(base.previewId, base.sessionId, first.frame_id)
				?.frame_id,
		).toBe(first.frame_id);
		expect(fake.browser.close).toHaveBeenCalledOnce();
		await manager.closeAll();
	});

	it("fails closed on stale frames and returns a frame after a bounded action", async () => {
		const fake = fakeBrowserSession();
		const manager = new ProjectPreviewBrowserManager({
			browserFactory: fake.factory,
		});
		const observed = await manager.capture({
			previewId: base.previewId,
			sessionId: base.sessionId,
			port: base.port,
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
		});
		let frame = await manager.capture({
			previewId: base.previewId,
			sessionId: base.sessionId,
			port: base.port,
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
		});
		const frame = await manager.capture({
			previewId: base.previewId,
			sessionId: base.sessionId,
			port: base.port,
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
			(_port, signal) =>
				new Promise<ProjectPreviewBrowserSession>((_resolve, reject) => {
					signal.addEventListener(
						"abort",
						() => reject(new Error("launch cancelled")),
						{ once: true },
					);
				}),
		);
		const manager = new ProjectPreviewBrowserManager({
			browserFactory: factory,
		});
		const capture = manager.capture({
			previewId: base.previewId,
			sessionId: base.sessionId,
			port: base.port,
			path: "/",
			viewport: "desktop",
			fullPage: false,
		});
		await vi.waitFor(() => expect(factory).toHaveBeenCalledOnce());

		await manager.close(base.previewId);
		await expect(capture).rejects.toThrow("launch cancelled");
	});
});
