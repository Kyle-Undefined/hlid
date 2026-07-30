import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	start: vi.fn(),
	stop: vi.fn(),
	restart: vi.fn(),
	inspect: vi.fn(),
	relayTarget: vi.fn(),
	selectionRedirect: vi.fn().mockReturnValue(null),
	handleRelayRequest: vi.fn().mockResolvedValue(null),
	getProjectPreview: vi.fn(),
	getLatestProjectPreviewForSession: vi.fn(),
	getFrame: vi.fn(),
	retainProjectPreviewFeedback: vi.fn(),
	bumpDataRevision: vi.fn(),
}));

vi.mock("../db", () => ({
	getProjectPreview: mocks.getProjectPreview,
	getLatestProjectPreviewForSession: mocks.getLatestProjectPreviewForSession,
	retainProjectPreviewFeedback: mocks.retainProjectPreviewFeedback,
}));

vi.mock("./dataRevision", () => ({
	bumpDataRevision: mocks.bumpDataRevision,
}));

vi.mock("./projectPreview", () => ({
	projectPreviewManager: {
		start: mocks.start,
		stop: mocks.stop,
		restart: mocks.restart,
		inspect: mocks.inspect,
		relayTarget: mocks.relayTarget,
	},
}));

vi.mock("./projectPreviewRelay", () => ({
	projectPreviewSelectionRedirect: mocks.selectionRedirect,
	handleProjectPreviewRelayRequest: mocks.handleRelayRequest,
}));

vi.mock("./projectPreviewBrowser", () => ({
	projectPreviewBrowserManager: {
		capture: vi.fn(),
		control: vi.fn(),
		getFrame: mocks.getFrame,
	},
}));

import {
	handleProjectPreviewRoute,
	parseControlInput,
} from "./projectPreviewRoutes";

const controlBase = {
	previewId: "7c0eea4d-f74e-45c8-8674-a535fbb4412b",
	sessionId: "session-1",
	port: 5173,
	initialPath: "/app",
};

describe("Project Preview control input", () => {
	it("maps every supported action to its browser action", () => {
		const frameId = "e16b1643-591f-4d67-8c22-9df105659385";

		expect(
			parseControlInput(
				{
					session_id: "session-1",
					action: "click",
					frame_id: frameId,
					ref: "e1",
					x: 12,
					y: 24,
				},
				controlBase,
			),
		).toEqual({
			...controlBase,
			action: "click",
			frameId,
			ref: "e1",
		});
		expect(
			parseControlInput(
				{
					session_id: "session-1",
					action: "click",
					frame_id: frameId,
					x: 0,
					y: 0,
				},
				controlBase,
			),
		).toEqual({
			...controlBase,
			action: "click",
			frameId,
			x: 0,
			y: 0,
		});
		expect(
			parseControlInput(
				{
					session_id: "session-1",
					action: "type",
					frame_id: frameId,
					ref: "e2",
					text: "",
				},
				controlBase,
			),
		).toEqual({
			...controlBase,
			action: "type",
			frameId,
			ref: "e2",
			text: "",
		});
		expect(
			parseControlInput(
				{ session_id: "session-1", action: "key", key: "Control+L" },
				controlBase,
			),
		).toEqual({ ...controlBase, action: "key", key: "Control+L" });
		expect(
			parseControlInput(
				{ session_id: "session-1", action: "scroll", delta_x: -10 },
				controlBase,
			),
		).toEqual({ ...controlBase, action: "scroll", deltaX: -10, deltaY: 0 });
		expect(
			parseControlInput(
				{ session_id: "session-1", action: "scroll", delta_y: 250 },
				controlBase,
			),
		).toEqual({ ...controlBase, action: "scroll", deltaX: 0, deltaY: 250 });
		expect(
			parseControlInput(
				{ session_id: "session-1", action: "navigate", path: "/settings" },
				controlBase,
			),
		).toEqual({ ...controlBase, action: "navigate", path: "/settings" });
		expect(
			parseControlInput(
				{ session_id: "session-1", action: "viewport", viewport: "mobile" },
				controlBase,
			),
		).toEqual({ ...controlBase, action: "viewport", viewport: "mobile" });
		expect(
			parseControlInput(
				{ session_id: "session-1", action: "reload" },
				controlBase,
			),
		).toEqual({ ...controlBase, action: "reload" });
	});

	it.each([
		[
			{ session_id: "session-1", action: "click" },
			"click requires frame_id and either ref or x and y coordinates.",
		],
		[
			{
				session_id: "session-1",
				action: "click",
				frame_id: "e16b1643-591f-4d67-8c22-9df105659385",
				x: 10,
			},
			"click requires frame_id and either ref or x and y coordinates.",
		],
		[
			{ session_id: "session-1", action: "type" },
			"type requires frame_id, ref, and text.",
		],
		[
			{
				session_id: "session-1",
				action: "type",
				frame_id: "e16b1643-591f-4d67-8c22-9df105659385",
			},
			"type requires frame_id, ref, and text.",
		],
		[
			{
				session_id: "session-1",
				action: "type",
				frame_id: "e16b1643-591f-4d67-8c22-9df105659385",
				ref: "e1",
			},
			"type requires frame_id, ref, and text.",
		],
		[{ session_id: "session-1", action: "key" }, "key requires a key value."],
		[
			{ session_id: "session-1", action: "scroll" },
			"scroll requires delta_x or delta_y.",
		],
		[
			{ session_id: "session-1", action: "navigate" },
			"navigate requires a Preview-local path.",
		],
		[
			{ session_id: "session-1", action: "viewport" },
			"viewport requires a named viewport.",
		],
	] as const)("rejects incomplete control input %#", (input, message) => {
		expect(() =>
			parseControlInput(
				input as Parameters<typeof parseControlInput>[0],
				controlBase,
			),
		).toThrow(message);
	});
});

describe("Project Preview route dispatch", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.selectionRedirect.mockReturnValue(null);
		mocks.handleRelayRequest.mockResolvedValue(null);
		mocks.inspect.mockReturnValue({
			id: "7c0eea4d-f74e-45c8-8674-a535fbb4412b",
			session_id: "session-1",
			path: "/app",
			state: "ready",
		});
		mocks.relayTarget.mockReturnValue({ port: 5173 });
	});

	it("ignores paths outside the Project Preview API before routing", async () => {
		const response = await handleProjectPreviewRoute(
			new URL("http://localhost/api/sessions"),
			new Request("http://localhost/api/sessions"),
		);

		expect(response).toBeNull();
		expect(mocks.selectionRedirect).not.toHaveBeenCalled();
		expect(mocks.handleRelayRequest).not.toHaveBeenCalled();
	});

	it("returns a selection redirect before attempting relay or API dispatch", async () => {
		const selection = new Response(null, { status: 307 });
		mocks.selectionRedirect.mockReturnValueOnce(selection);

		const response = await handleProjectPreviewRoute(
			new URL(
				"http://localhost/api/project-previews/session?session_id=session-1",
			),
			new Request(
				"http://localhost/api/project-previews/session?session_id=session-1",
			),
		);

		expect(response).toBe(selection);
		expect(mocks.handleRelayRequest).not.toHaveBeenCalled();
		expect(mocks.inspect).not.toHaveBeenCalled();
	});

	it("returns a relay response before attempting API dispatch", async () => {
		const relay = new Response("relayed");
		mocks.handleRelayRequest.mockResolvedValueOnce(relay);

		const response = await handleProjectPreviewRoute(
			new URL(
				"http://localhost/api/project-previews/session?session_id=session-1",
			),
			new Request(
				"http://localhost/api/project-previews/session?session_id=session-1",
			),
		);

		expect(response).toBe(relay);
		expect(mocks.selectionRedirect).toHaveBeenCalledOnce();
		expect(mocks.inspect).not.toHaveBeenCalled();
	});

	it("dispatches API endpoints after selection and relay decline the request", async () => {
		const response = await handleProjectPreviewRoute(
			new URL(
				"http://localhost/api/project-previews/session?session_id=session-1",
			),
			new Request(
				"http://localhost/api/project-previews/session?session_id=session-1",
			),
		);

		expect(response?.status).toBe(200);
		expect(mocks.selectionRedirect).toHaveBeenCalledOnce();
		expect(mocks.handleRelayRequest).toHaveBeenCalledOnce();
		expect(mocks.inspect).toHaveBeenCalledWith("session-1", undefined);
	});

	it("maps a start request and preserves the ready response status", async () => {
		mocks.start.mockResolvedValueOnce({
			id: "7c0eea4d-f74e-45c8-8674-a535fbb4412b",
			session_id: "session-1",
			state: "ready",
		});
		const response = await handleProjectPreviewRoute(
			new URL("http://localhost/api/project-previews/start"),
			new Request("http://localhost/api/project-previews/start", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					session_id: "session-1",
					runtime_cwd: "/repo",
					command: "bun dev",
					port: 5173,
					path: "/app",
					working_directory: "apps/web",
					label: "Web",
					present: true,
					replace_existing: true,
					readiness_timeout_seconds: 30,
				}),
			}),
		);

		expect(response?.status).toBe(201);
		expect(mocks.start).toHaveBeenCalledWith({
			sessionId: "session-1",
			runtimeCwd: "/repo",
			command: "bun dev",
			port: 5173,
			path: "/app",
			workingDirectory: "apps/web",
			label: "Web",
			present: true,
			replaceExisting: true,
			readinessTimeoutSeconds: 30,
		});
	});

	it("keeps session and decoded by-id lifecycle actions distinct", async () => {
		mocks.stop.mockResolvedValueOnce({ state: "stopped" });
		mocks.restart.mockResolvedValueOnce({ state: "ready" });

		const sessionResponse = await handleProjectPreviewRoute(
			new URL("http://localhost/api/project-previews/session/stop"),
			new Request("http://localhost/api/project-previews/session/stop", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ session_id: "session-1" }),
			}),
		);
		const byIdResponse = await handleProjectPreviewRoute(
			new URL("http://localhost/api/project-previews/preview%20id/restart"),
			new Request(
				"http://localhost/api/project-previews/preview%20id/restart",
				{
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ session_id: "session-1" }),
				},
			),
		);

		expect(sessionResponse?.status).toBe(200);
		expect(byIdResponse?.status).toBe(200);
		expect(mocks.stop).toHaveBeenCalledWith("session-1");
		expect(mocks.restart).toHaveBeenCalledWith("session-1", "preview id");
	});

	it.each([
		[
			"unknown nested endpoint",
			"GET",
			"http://localhost/api/project-previews/session/missing",
			404,
			"Not found",
		],
		[
			"unsupported by-id method",
			"POST",
			"http://localhost/api/project-previews/preview-id",
			405,
			"Method not allowed",
		],
	])("returns the existing response for %s", async (_name, method, href, status, body) => {
		const response = await handleProjectPreviewRoute(
			new URL(href),
			new Request(href, { method }),
		);

		expect(response?.status).toBe(status);
		expect(await response?.text()).toBe(body);
	});
});

describe("Project Preview capture route", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.selectionRedirect.mockReturnValue(null);
		mocks.handleRelayRequest.mockResolvedValue(null);
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
					width: 740,
					height: 900,
					scroll_x: 12,
					scroll_y: 480,
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
			size: { width: 740, height: 900 },
			scrollX: 12,
			scrollY: 480,
			fullPage: true,
		});
		expect(await response?.json()).toMatchObject({
			image_base64: "AQID",
			viewport: "tablet",
		});
	});

	it("rejects a partial custom capture viewport", async () => {
		const response = await handleProjectPreviewRoute(
			new URL("http://localhost/api/project-previews/session/capture"),
			new Request("http://localhost/api/project-previews/session/capture", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					session_id: "session-1",
					width: 412,
				}),
			}),
		);

		expect(response?.status).toBe(400);
		expect(await response?.json()).toMatchObject({
			error: "width and height must be provided together",
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

	it("retains annotated feedback against the exact source frame", async () => {
		const frameId = "e16b1643-591f-4d67-8c22-9df105659385";
		mocks.getFrame.mockReturnValue({
			preview_id: "7c0eea4d-f74e-45c8-8674-a535fbb4412b",
			session_id: "session-1",
			path: "/settings",
			viewport: "tablet",
			width: 768,
			height: 1024,
			full_page: false,
			captured_at: 1_753_400_000_000,
			mime: "image/png",
			size_bytes: 3,
			image_base64: "AQID",
			frame_id: frameId,
			title: "Settings",
			elements: [],
			console_messages: [],
			failed_requests: [],
		});
		mocks.retainProjectPreviewFeedback.mockResolvedValue({
			id: "0591f46e-b4b3-4bfb-9aa2-14f65d625209",
			path: "/library/feedback.png",
			filename: "feedback.png",
			mime: "image/png",
			kind: "ephemeral",
		});

		const response = await handleProjectPreviewRoute(
			new URL(
				"http://localhost/api/project-previews/7c0eea4d-f74e-45c8-8674-a535fbb4412b/feedback",
			),
			new Request(
				"http://localhost/api/project-previews/7c0eea4d-f74e-45c8-8674-a535fbb4412b/feedback",
				{
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						session_id: "session-1",
						frame_id: frameId,
						attachment_id: "0591f46e-b4b3-4bfb-9aa2-14f65d625209",
						comment: "Check this alignment.",
					}),
				},
			),
		);

		expect(response?.status).toBe(200);
		expect(mocks.retainProjectPreviewFeedback).toHaveBeenCalledWith({
			attachmentId: "0591f46e-b4b3-4bfb-9aa2-14f65d625209",
			previewId: "7c0eea4d-f74e-45c8-8674-a535fbb4412b",
			sessionId: "session-1",
			sourceFrameId: frameId,
			path: "/settings",
			viewport: "tablet",
			width: 768,
			height: 1024,
			sourceSha256:
				"039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81",
			capturedAt: 1_753_400_000_000,
			comment: "Check this alignment.",
		});
		expect(mocks.bumpDataRevision).toHaveBeenCalledWith("relics", "storage");
		expect(await response?.json()).toMatchObject({
			attachment: {
				id: "0591f46e-b4b3-4bfb-9aa2-14f65d625209",
				reference: "relic",
			},
			open_url: "/api/attachments/0591f46e-b4b3-4bfb-9aa2-14f65d625209/raw",
		});
	});
});
