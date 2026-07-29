// @vitest-environment jsdom
import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("#/hooks/projectPreviewStore", () => ({
	applyProjectPreview: vi.fn(),
	requestProjectPreviewPresentation: vi.fn(),
	useProjectPreview: () => null,
	useProjectPreviewUnavailable: () => false,
}));
vi.mock("#/hooks/toolEventDetailStore", () => ({
	loadToolEventDetail: vi.fn(),
}));
vi.mock("#/lib/serverFns/projectPreviews", () => ({
	getProjectPreviewAgentFrameFn: vi.fn(async () => null),
	restartProjectPreviewFn: vi.fn(),
	stopProjectPreviewFn: vi.fn(),
}));

import {
	applyProjectPreview,
	requestProjectPreviewPresentation,
} from "#/hooks/projectPreviewStore";
import { loadToolEventDetail } from "#/hooks/toolEventDetailStore";
import {
	getProjectPreviewAgentFrameFn,
	type ProjectPreviewAgentFrame,
	type ProjectPreviewSnapshot,
	restartProjectPreviewFn,
	stopProjectPreviewFn,
} from "#/lib/serverFns/projectPreviews";
import {
	groupProjectPreviewEventLifecycles,
	ProjectPreviewActivityCard,
	ProjectPreviewCaptureToolBlock,
	ProjectPreviewToolBlock,
	selectActiveProjectPreviewEvents,
} from "./ProjectPreviewToolBlock";

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
	vi.mocked(getProjectPreviewAgentFrameFn).mockReset();
	vi.mocked(getProjectPreviewAgentFrameFn).mockResolvedValue(null);
	vi.mocked(loadToolEventDetail).mockReset();
});

function snapshotEvent(
	id: string,
	previewId: string,
	state: "ready" | "stopped",
) {
	return {
		type: "tool_event" as const,
		id,
		name: "mcp__hlid__start_project_preview",
		input: {},
		result: JSON.stringify({
			id: previewId,
			session_id: "lifecycle-session",
			label: previewId,
			command: "bun run dev",
			cwd: "/work",
			port: 4173,
			path: "/",
			url: "http://127.0.0.1:4173/",
			relay_url: `/api/project-previews/${previewId}/relay/`,
			state,
			present: true,
			started_at: "2026-07-24T10:00:00.000Z",
			expires_at: "2026-07-24T14:00:00.000Z",
			logs: [],
		}),
	};
}

describe("ProjectPreviewCaptureToolBlock", () => {
	it("shows capture provenance without presenting it as a Relic", () => {
		render(
			<ProjectPreviewCaptureToolBlock
				event={{
					type: "tool_event",
					id: "capture-1",
					name: "mcp__hlid__capture_project_preview",
					input: { viewport: "mobile" },
					result: JSON.stringify({
						preview_id: "preview-1",
						path: "/settings",
						viewport: "mobile",
						width: 390,
						height: 844,
						full_page: false,
						size_bytes: 1024,
					}),
				}}
			/>,
		);

		expect(screen.getByText("Project Preview captured for agent")).toBeTruthy();
		expect(screen.getByText(/mobile · 390×844 · \/settings/i)).toBeTruthy();
		expect(screen.queryByText(/Relic/i)).toBeNull();
	});

	it("shows the bounded agent browser action and resulting frame", () => {
		render(
			<ProjectPreviewCaptureToolBlock
				event={{
					type: "tool_event",
					id: "control-1",
					name: "mcp__hlid__control_project_preview",
					input: { action: "click", ref: "e1" },
					result: JSON.stringify({
						preview_id: "preview-1",
						path: "/settings",
						viewport: "desktop",
						width: 1440,
						height: 1000,
						full_page: false,
						size_bytes: 2048,
						last_action: "click",
					}),
				}}
			/>,
		);

		expect(
			screen.getByText("Project Preview controlled by agent"),
		).toBeTruthy();
		expect(screen.getByText(/click · desktop · 1440×1000/i)).toBeTruthy();
	});

	it("reopens a historical capture from its tool-call action", async () => {
		const frameId = "323e4567-e89b-12d3-a456-426614174001";
		vi.mocked(getProjectPreviewAgentFrameFn).mockResolvedValueOnce({
			preview_id: "323e4567-e89b-12d3-a456-426614174000",
			session_id: "historical-session",
			path: "/history",
			viewport: "desktop",
			width: 1440,
			height: 1000,
			full_page: false,
			captured_at: Date.now(),
			mime: "image/png",
			size_bytes: 1024,
			image_base64: "historical",
			frame_id: frameId,
			title: "History",
			elements: [],
			console_messages: [],
			failed_requests: [],
		});
		render(
			<ProjectPreviewCaptureToolBlock
				event={{
					type: "tool_event",
					id: "capture-history",
					name: "mcp__hlid__capture_project_preview",
					input: {},
					result: `${JSON.stringify({
						preview_id: "323e4567-e89b-12d3-a456-426614174000",
						session_id: "historical-session",
						path: "/history",
						viewport: "desktop",
						width: 1440,
						height: 1000,
						full_page: false,
						size_bytes: 1024,
						frame_id: frameId,
					})}[image]`,
				}}
			/>,
		);

		fireEvent.click(
			screen.getByRole("button", {
				name: "View Preview capture at /history",
			}),
		);
		expect(
			await screen.findByRole("dialog", { name: "Image viewer" }),
		).toBeTruthy();
	});
});

describe("ProjectPreviewActivityCard", () => {
	it("contains a turn's Preview tool calls in one expandable card", () => {
		render(
			<ProjectPreviewActivityCard
				events={[
					{
						type: "tool_event",
						id: "start-1",
						name: "mcp__hlid__start_project_preview",
						input: { port: 4173 },
						result: JSON.stringify({
							id: "123e4567-e89b-12d3-a456-426614174000",
							session_id: "session-1",
							label: "Web app",
							command: "bun run dev",
							cwd: "/work/web",
							port: 4173,
							path: "/",
							url: "http://127.0.0.1:4173/",
							relay_url:
								"/api/project-previews/123e4567-e89b-12d3-a456-426614174000/relay/",
							state: "ready",
							present: true,
							started_at: "2026-07-24T10:00:00.000Z",
							expires_at: "2026-07-24T14:00:00.000Z",
							logs: [],
						}),
					},
					{
						type: "tool_event",
						id: "capture-1",
						name: "mcp__hlid__capture_project_preview",
						input: { viewport: "mobile" },
						result: JSON.stringify({
							preview_id: "123e4567-e89b-12d3-a456-426614174000",
							path: "/settings",
							viewport: "mobile",
							width: 390,
							height: 844,
							full_page: false,
							size_bytes: 1024,
						}),
					},
				]}
			/>,
		);

		expect(screen.getByText("Web app")).toBeTruthy();
		expect(screen.getByText("2 actions")).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: "Preview activity" }));
		expect(screen.getByText("Start")).toBeTruthy();
		expect(screen.getByText("Capture")).toBeTruthy();
		expect(screen.getByText(/mobile · 390×844 · \/settings/i)).toBeTruthy();
	});

	it("shares lifecycle controls across grouped and standalone displays", async () => {
		const event = snapshotEvent("start-actions", "preview-actions", "ready");
		const current = JSON.parse(event.result) as ProjectPreviewSnapshot;
		const restarted = {
			...current,
			id: "preview-restarted",
		};
		const stopped = {
			...current,
			state: "stopped" as const,
		};
		vi.mocked(restartProjectPreviewFn).mockResolvedValueOnce(restarted);
		vi.mocked(stopProjectPreviewFn).mockResolvedValueOnce(stopped);

		const grouped = render(
			<ProjectPreviewActivityCard events={[event]} active />,
		);
		fireEvent.click(screen.getByLabelText("Show preview"));
		expect(requestProjectPreviewPresentation).toHaveBeenCalledWith(
			current.session_id,
		);
		fireEvent.click(screen.getByLabelText("Restart preview"));
		await waitFor(() =>
			expect(restartProjectPreviewFn).toHaveBeenCalledWith({
				data: {
					sessionId: current.session_id,
					previewId: current.id,
				},
			}),
		);
		expect(applyProjectPreview).toHaveBeenCalledWith(restarted);

		grouped.unmount();
		render(<ProjectPreviewToolBlock event={event} />);
		fireEvent.click(screen.getByLabelText("Stop preview"));
		await waitFor(() =>
			expect(stopProjectPreviewFn).toHaveBeenCalledWith({
				data: {
					sessionId: current.session_id,
					previewId: current.id,
				},
			}),
		);
		expect(applyProjectPreview).toHaveBeenLastCalledWith(stopped);
	});

	it("opens the exact agent capture from its activity action", async () => {
		const frame: ProjectPreviewAgentFrame = {
			preview_id: "123e4567-e89b-12d3-a456-426614174000",
			session_id: "session-1",
			path: "/settings",
			viewport: "mobile",
			width: 390,
			height: 844,
			full_page: false,
			captured_at: Date.now(),
			mime: "image/png",
			size_bytes: 1024,
			image_base64: "capture",
			frame_id: "123e4567-e89b-12d3-a456-426614174001",
			title: "Settings",
			elements: [],
			console_messages: [],
			failed_requests: [],
			last_action: "click",
		};
		vi.mocked(getProjectPreviewAgentFrameFn).mockResolvedValueOnce(frame);

		render(
			<ProjectPreviewActivityCard
				active
				events={[
					{
						type: "tool_event",
						id: "capture-1",
						name: "mcp__hlid__capture_project_preview",
						detailSessionId: "session-1",
						input: { viewport: "mobile" },
						result: JSON.stringify({
							preview_id: frame.preview_id,
							session_id: frame.session_id,
							path: frame.path,
							viewport: frame.viewport,
							width: frame.width,
							height: frame.height,
							full_page: frame.full_page,
							size_bytes: frame.size_bytes,
							frame_id: frame.frame_id,
						}),
					},
				]}
			/>,
		);

		fireEvent.click(screen.getByRole("button", { name: "Preview activity" }));
		const captureAction = await screen.findByRole("button", {
			name: "View Preview capture at /settings",
		});
		expect(screen.getByTestId("preview-capture-open-indicator")).toBeTruthy();
		fireEvent.click(captureAction);
		expect(
			await screen.findByRole("dialog", { name: "Image viewer" }),
		).toBeTruthy();
		expect(getProjectPreviewAgentFrameFn).toHaveBeenCalledWith({
			data: {
				sessionId: frame.session_id,
				previewId: frame.preview_id,
				frameId: frame.frame_id,
			},
		});
	});

	it("hydrates a compacted capture before opening its retained frame", async () => {
		const frame: ProjectPreviewAgentFrame = {
			preview_id: "523e4567-e89b-12d3-a456-426614174000",
			session_id: "compacted-session",
			path: "/compacted",
			viewport: "desktop",
			width: 1440,
			height: 1000,
			full_page: false,
			captured_at: Date.now(),
			mime: "image/png",
			size_bytes: 1024,
			image_base64: "compacted",
			frame_id: "523e4567-e89b-12d3-a456-426614174001",
			title: "Compacted",
			elements: [],
			console_messages: [],
			failed_requests: [],
		};
		vi.mocked(loadToolEventDetail).mockResolvedValueOnce({
			result: JSON.stringify({
				type: "dynamicToolCall",
				id: "compacted-capture",
				namespace: "hlid",
				tool: "capture_project_preview",
				status: "completed",
				contentItems: [
					{
						type: "inputText",
						text: JSON.stringify({
							preview_id: frame.preview_id,
							session_id: frame.session_id,
							path: frame.path,
							viewport: frame.viewport,
							width: frame.width,
							height: frame.height,
							full_page: frame.full_page,
							size_bytes: frame.size_bytes,
							frame_id: frame.frame_id,
							elements: [{ ref: "e1", role: "button", name: "Continue" }],
						}),
					},
					{ type: "inputImage", image_url: "data:image/png;base64,..." },
				],
			}),
		});
		vi.mocked(getProjectPreviewAgentFrameFn).mockResolvedValueOnce(frame);

		render(
			<ProjectPreviewActivityCard
				active
				events={[
					{
						type: "tool_event",
						id: "compacted-capture",
						name: "mcp__hlid__capture_project_preview",
						detailSessionId: frame.session_id,
						resultTruncated: true,
						input: { viewport: "desktop" },
						result:
							'{"preview_id":"523e4567-e89b-12d3-a456-426614174000","session_id":"compacted-session","path":"/compacted","viewport":"desktop","width":1440,"height":1000,"full_page":false,"size_bytes":1024,"frame_id":"523e4567-e89b-12d3-a456-426614174001","elements":[',
					},
				]}
			/>,
		);

		expect(screen.getByText(/1 capture/i)).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: "Preview activity" }));
		fireEvent.click(
			await screen.findByRole("button", { name: "View Preview capture" }),
		);
		expect(
			await screen.findByRole("dialog", { name: "Image viewer" }),
		).toBeTruthy();
		expect(loadToolEventDetail).toHaveBeenCalledWith(
			frame.session_id,
			"compacted-capture",
		);
		expect(getProjectPreviewAgentFrameFn).toHaveBeenCalledWith({
			data: {
				sessionId: frame.session_id,
				previewId: frame.preview_id,
				frameId: frame.frame_id,
			},
		});
	});

	it("hydrates Claude's compacted rich capture before opening it", async () => {
		const frame: ProjectPreviewAgentFrame = {
			preview_id: "623e4567-e89b-12d3-a456-426614174000",
			session_id: "claude-session",
			path: "/claude",
			viewport: "desktop",
			width: 1440,
			height: 1000,
			full_page: false,
			captured_at: Date.now(),
			mime: "image/png",
			size_bytes: 1024,
			image_base64: "claude",
			frame_id: "623e4567-e89b-12d3-a456-426614174001",
			title: "Claude",
			elements: [],
			console_messages: [],
			failed_requests: [],
		};
		vi.mocked(loadToolEventDetail).mockResolvedValueOnce({
			result: `${JSON.stringify({
				preview_id: frame.preview_id,
				session_id: frame.session_id,
				path: frame.path,
				viewport: frame.viewport,
				width: frame.width,
				height: frame.height,
				full_page: frame.full_page,
				size_bytes: frame.size_bytes,
				frame_id: frame.frame_id,
			})}[image]`,
		});
		vi.mocked(getProjectPreviewAgentFrameFn).mockResolvedValueOnce(frame);

		render(
			<ProjectPreviewActivityCard
				active
				events={[
					{
						type: "tool_event",
						id: "claude-capture",
						name: "mcp__hlid__capture_project_preview",
						detailSessionId: frame.session_id,
						resultTruncated: true,
						input: { viewport: "desktop" },
						result: '{"preview_id":"623e4567-e89b-12d3-a456-',
					},
				]}
			/>,
		);

		fireEvent.click(screen.getByRole("button", { name: "Preview activity" }));
		fireEvent.click(
			await screen.findByRole("button", { name: "View Preview capture" }),
		);
		expect(
			await screen.findByRole("dialog", { name: "Image viewer" }),
		).toBeTruthy();
		expect(loadToolEventDetail).toHaveBeenCalledWith(
			frame.session_id,
			"claude-capture",
		);
		expect(getProjectPreviewAgentFrameFn).toHaveBeenCalledWith({
			data: {
				sessionId: frame.session_id,
				previewId: frame.preview_id,
				frameId: frame.frame_id,
			},
		});
	});

	it("shows an unparseable historical lifecycle as stopped", () => {
		render(
			<ProjectPreviewActivityCard
				historicalGroup
				events={[
					{
						type: "tool_event",
						id: "compacted-start",
						name: "mcp__hlid__start_project_preview",
						detailSessionId: "historical-session",
						resultTruncated: true,
						input: {},
						result: '{"id":"historical-preview","session_id":"historical-',
					},
					{
						type: "tool_event",
						id: "compacted-stop",
						name: "mcp__hlid__stop_project_preview",
						detailSessionId: "historical-session",
						resultTruncated: true,
						input: {},
						result: '{"id":"historical-preview","session_id":"historical-',
					},
				]}
			/>,
		);

		expect(
			screen.getByRole("button", { name: "Project Preview stopped" }),
		).toBeTruthy();
		expect(screen.queryByText("starting")).toBeNull();
	});

	it("preserves an explicit collapse when the session card remounts", () => {
		const event = {
			type: "tool_event" as const,
			id: "start-1",
			name: "mcp__hlid__start_project_preview",
			input: { port: 4173 },
			result: JSON.stringify({
				id: "223e4567-e89b-12d3-a456-426614174000",
				session_id: "collapse-session",
				label: "Web app",
				command: "bun run dev",
				cwd: "/work/web",
				port: 4173,
				path: "/",
				url: "http://127.0.0.1:4173/",
				relay_url:
					"/api/project-previews/223e4567-e89b-12d3-a456-426614174000/relay/",
				state: "ready",
				present: true,
				started_at: "2026-07-24T10:00:00.000Z",
				expires_at: "2026-07-24T14:00:00.000Z",
				logs: [],
			}),
		};
		const first = render(
			<ProjectPreviewActivityCard events={[event]} active />,
		);
		const toggle = screen.getByRole("button", { name: "Web app ready" });
		expect(toggle.getAttribute("aria-expanded")).toBe("true");
		fireEvent.click(toggle);
		expect(toggle.getAttribute("aria-expanded")).toBe("false");

		first.unmount();
		render(<ProjectPreviewActivityCard events={[event]} active />);

		expect(
			screen
				.getByRole("button", { name: "Web app ready" })
				.getAttribute("aria-expanded"),
		).toBe("false");
	});

	it("keeps the activity log nested and expands full error details", () => {
		const errorMessage =
			"Preview control failed because the requested element was detached from the current document.";
		render(
			<ProjectPreviewActivityCard
				active
				events={[
					{
						type: "tool_event",
						id: "start-error-preview",
						name: "mcp__hlid__start_project_preview",
						input: {},
						result: JSON.stringify({
							id: "423e4567-e89b-12d3-a456-426614174000",
							session_id: "error-session",
							label: "Error app",
							command: "bun run dev",
							cwd: "/work/web",
							port: 4173,
							path: "/",
							url: "http://127.0.0.1:4173/",
							relay_url:
								"/api/project-previews/423e4567-e89b-12d3-a456-426614174000/relay/",
							state: "ready",
							present: true,
							started_at: "2026-07-24T10:00:00.000Z",
							expires_at: "2026-07-24T14:00:00.000Z",
							logs: [],
						}),
					},
					{
						type: "tool_event",
						id: "failed-control",
						name: "mcp__hlid__control_project_preview",
						input: { action: "click" },
						result: errorMessage,
						isError: true,
					},
				]}
			/>,
		);

		expect(
			screen
				.getByRole("button", { name: "Preview activity" })
				.getAttribute("aria-expanded"),
		).toBe("false");
		fireEvent.click(screen.getByRole("button", { name: "Preview activity" }));
		const errorToggle = screen.getByRole("button", {
			name: "Control error details",
		});
		expect(errorToggle.getAttribute("aria-expanded")).toBe("false");
		fireEvent.click(errorToggle);
		expect(errorToggle.getAttribute("aria-expanded")).toBe("true");
		expect(screen.getByText(errorMessage, { selector: "pre" })).toBeTruthy();
	});
});

describe("selectActiveProjectPreviewEvents", () => {
	it("groups only the latest active lifecycle", () => {
		const oldStart = snapshotEvent("old-start", "old-preview", "ready");
		const oldStop = {
			...snapshotEvent("old-stop", "old-preview", "stopped"),
			name: "mcp__hlid__stop_project_preview",
		};
		const newStart = snapshotEvent("new-start", "new-preview", "ready");
		const newCapture = {
			type: "tool_event" as const,
			id: "new-capture",
			name: "mcp__hlid__capture_project_preview",
			input: {},
			result: JSON.stringify({
				preview_id: "new-preview",
				session_id: "lifecycle-session",
				path: "/",
				viewport: "desktop",
				width: 1440,
				height: 1000,
				full_page: false,
				size_bytes: 10,
			}),
		};

		expect(
			selectActiveProjectPreviewEvents(
				[oldStart, oldStop, newStart, newCapture],
				JSON.parse(newStart.result),
				true,
			).map((event) => event.id),
		).toEqual(["new-start", "new-capture"]);
	});

	it("returns a stopped lifecycle to the transcript tool list", () => {
		const stopped = snapshotEvent(
			"stopped-start",
			"stopped-preview",
			"stopped",
		);
		expect(
			selectActiveProjectPreviewEvents(
				[stopped],
				JSON.parse(stopped.result),
				false,
			),
		).toEqual([]);
	});

	it("keeps a UI-restarted Preview on the latest pinned lifecycle", () => {
		const start = snapshotEvent("start-before-restart", "old-preview", "ready");
		const capture = {
			type: "tool_event" as const,
			id: "capture-before-restart",
			name: "mcp__hlid__capture_project_preview",
			input: {},
			result: JSON.stringify({
				preview_id: "old-preview",
				session_id: "lifecycle-session",
				path: "/",
				viewport: "desktop",
				width: 1440,
				height: 1000,
				full_page: false,
				size_bytes: 10,
			}),
		};
		const liveAfterRestart = {
			...JSON.parse(start.result),
			id: "new-preview-without-tool-event",
		} as ProjectPreviewSnapshot;

		expect(
			selectActiveProjectPreviewEvents(
				[start, capture],
				liveAfterRestart,
				false,
			).map((event) => event.id),
		).toEqual(["start-before-restart", "capture-before-restart"]);
	});

	it("keeps each start and its following actions in a separate lifecycle", () => {
		const first = snapshotEvent("first-start", "first-preview", "ready");
		const stop = {
			...snapshotEvent("first-stop", "first-preview", "stopped"),
			name: "mcp__hlid__stop_project_preview",
		};
		const second = snapshotEvent("second-start", "second-preview", "ready");

		expect(
			groupProjectPreviewEventLifecycles([first, stop, second]).map((group) =>
				group.map((event) => event.id),
			),
		).toEqual([["first-start", "first-stop"], ["second-start"]]);
	});
});
