import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	inspect: vi.fn(),
	relayTarget: vi.fn(),
	getProjectPreview: vi.fn(),
	getLatestProjectPreviewForSession: vi.fn(),
	getFrame: vi.fn(),
}));

vi.mock("../db", () => ({
	getProjectPreview: mocks.getProjectPreview,
	getLatestProjectPreviewForSession: mocks.getLatestProjectPreviewForSession,
}));

vi.mock("./projectPreview", () => ({
	projectPreviewManager: {
		inspect: mocks.inspect,
		relayTarget: mocks.relayTarget,
	},
}));

vi.mock("./projectPreviewBrowser", () => ({
	projectPreviewBrowserManager: {
		capture: vi.fn(),
		control: vi.fn(),
		getFrame: mocks.getFrame,
	},
}));

import { handleProjectPreviewRoute } from "./projectPreviewRoutes";

describe("Project Preview capture route", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.inspect.mockReturnValue({
			id: "7c0eea4d-f74e-45c8-8674-a535fbb4412b",
			session_id: "session-1",
			path: "/app",
			state: "ready",
		});
		mocks.relayTarget.mockReturnValue({ port: 5173 });
		mocks.getFrame.mockReturnValue(null);
	});

	it("returns only the latest in-memory Agent view frame for its owner", async () => {
		mocks.getFrame.mockReturnValue({
			preview_id: "7c0eea4d-f74e-45c8-8674-a535fbb4412b",
			session_id: "session-1",
			path: "/app",
			viewport: "desktop",
			width: 1440,
			height: 1000,
			full_page: false,
			captured_at: Date.now(),
			mime: "image/png",
			size_bytes: 3,
			image_base64: "AQID",
			frame_id: crypto.randomUUID(),
			title: "App",
			elements: [],
			console_messages: [],
			failed_requests: [],
		});
		const response = await handleProjectPreviewRoute(
			new URL(
				"http://localhost/api/project-previews/7c0eea4d-f74e-45c8-8674-a535fbb4412b/agent-frame?session_id=session-1",
			),
			new Request(
				"http://localhost/api/project-previews/7c0eea4d-f74e-45c8-8674-a535fbb4412b/agent-frame?session_id=session-1",
			),
		);

		expect(response?.status).toBe(200);
		expect(mocks.inspect).toHaveBeenCalledWith(
			"session-1",
			"7c0eea4d-f74e-45c8-8674-a535fbb4412b",
		);
		expect(mocks.getFrame).toHaveBeenCalledWith(
			"7c0eea4d-f74e-45c8-8674-a535fbb4412b",
			"session-1",
			undefined,
		);
		expect(await response?.json()).toMatchObject({ image_base64: "AQID" });
	});

	it("returns the exact retained frame requested by a capture action", async () => {
		const frameId = "e16b1643-591f-4d67-8c22-9df105659385";
		mocks.getFrame.mockReturnValue({
			preview_id: "7c0eea4d-f74e-45c8-8674-a535fbb4412b",
			session_id: "session-1",
			path: "/settings",
			frame_id: frameId,
			image_base64: "AQID",
		});
		const response = await handleProjectPreviewRoute(
			new URL(
				`http://localhost/api/project-previews/7c0eea4d-f74e-45c8-8674-a535fbb4412b/agent-frame?session_id=session-1&frame_id=${frameId}`,
			),
			new Request(
				`http://localhost/api/project-previews/7c0eea4d-f74e-45c8-8674-a535fbb4412b/agent-frame?session_id=session-1&frame_id=${frameId}`,
			),
		);

		expect(response?.status).toBe(200);
		expect(mocks.getFrame).toHaveBeenCalledWith(
			"7c0eea4d-f74e-45c8-8674-a535fbb4412b",
			"session-1",
			frameId,
		);
		expect(await response?.json()).toMatchObject({ frame_id: frameId });
	});

	it("captures only the live Preview owned by the requested session", async () => {
		const capture = vi.fn(async (input) => ({
			preview_id: input.previewId,
			session_id: input.sessionId,
			path: input.path,
			viewport: input.viewport,
			width: 768,
			height: 1024,
			full_page: input.fullPage,
			captured_at: Date.now(),
			mime: "image/png" as const,
			size_bytes: 3,
			image_base64: "AQID",
		}));
		const response = await handleProjectPreviewRoute(
			new URL("http://localhost/api/project-previews/session/capture"),
			new Request("http://localhost/api/project-previews/session/capture", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					session_id: "session-1",
					viewport: "tablet",
					full_page: true,
				}),
			}),
			capture,
		);

		expect(response?.status).toBe(200);
		expect(response?.headers.get("cache-control")).toBe("no-store");
		expect(mocks.inspect).toHaveBeenCalledWith("session-1", undefined);
		expect(mocks.relayTarget).toHaveBeenCalledWith(
			"7c0eea4d-f74e-45c8-8674-a535fbb4412b",
		);
		expect(capture).toHaveBeenCalledWith({
			previewId: "7c0eea4d-f74e-45c8-8674-a535fbb4412b",
			sessionId: "session-1",
			port: 5173,
			path: "/app",
			viewport: "tablet",
			fullPage: true,
		});
		expect(await response?.json()).toMatchObject({
			image_base64: "AQID",
			viewport: "tablet",
		});
	});

	it("controls the live Preview with a bounded action and returns a frame", async () => {
		const frameId = "e16b1643-591f-4d67-8c22-9df105659385";
		const control = vi.fn(async (input) => ({
			preview_id: input.previewId,
			session_id: input.sessionId,
			path: "/app",
			viewport: "desktop" as const,
			width: 1440,
			height: 1000,
			full_page: false,
			captured_at: Date.now(),
			mime: "image/png" as const,
			size_bytes: 3,
			image_base64: "AQID",
			frame_id: crypto.randomUUID(),
			title: "App",
			elements: [],
			console_messages: [],
			failed_requests: [],
			last_action: input.action,
		}));
		const response = await handleProjectPreviewRoute(
			new URL("http://localhost/api/project-previews/session/control"),
			new Request("http://localhost/api/project-previews/session/control", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					session_id: "session-1",
					action: "click",
					frame_id: frameId,
					ref: "e1",
				}),
			}),
			vi.fn(),
			control,
		);

		expect(response?.status).toBe(200);
		expect(control).toHaveBeenCalledWith({
			previewId: "7c0eea4d-f74e-45c8-8674-a535fbb4412b",
			sessionId: "session-1",
			port: 5173,
			initialPath: "/app",
			action: "click",
			frameId,
			ref: "e1",
		});
		expect(await response?.json()).toMatchObject({
			last_action: "click",
			image_base64: "AQID",
		});
	});
});
