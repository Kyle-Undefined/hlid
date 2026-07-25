// @vitest-environment jsdom
import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	captureProjectPreviewFeedbackFn,
	type ProjectPreviewAgentFrame,
} from "#/lib/serverFns/projectPreviews";
import type { ProjectPreviewSnapshot } from "#/server/protocol";
import { ProjectPreviewPane } from "./ProjectPreviewPane";

vi.mock("#/lib/serverFns/projectPreviews", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("#/lib/serverFns/projectPreviews")>();
	return {
		...actual,
		captureProjectPreviewFeedbackFn: vi.fn(),
		getProjectPreviewAgentFrameFn: vi.fn(async () => null),
		restartProjectPreviewFn: vi.fn(),
		saveProjectPreviewFeedbackFn: vi.fn(),
		stopProjectPreviewFn: vi.fn(),
	};
});

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
	vi.unstubAllGlobals();
});

function preview(): ProjectPreviewSnapshot {
	return {
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
		logs: ["ready"],
	};
}

describe("ProjectPreviewPane", () => {
	it("uses the isolated relay URL and exposes viewport sizes", () => {
		render(<ProjectPreviewPane preview={preview()} />);
		const frame = screen.getByTitle("Web app") as HTMLIFrameElement;
		expect(frame.src).toContain(
			"/api/project-previews/123e4567-e89b-12d3-a456-426614174000/relay/",
		);
		expect(frame.src).not.toContain("__hlid_preview_open");
		const viewport = screen.getByLabelText("Preview viewport");
		fireEvent.change(viewport, { target: { value: "mobile" } });
		expect(frame.parentElement?.style.width).toBe("390px");
		expect(screen.getByLabelText("Show agent view")).not.toBeNull();
	});

	it("remounts the user iframe when a replacement preview becomes active", () => {
		const initial = preview();
		const { rerender } = render(<ProjectPreviewPane preview={initial} />);
		const oldFrame = screen.getByTitle("Web app");
		const replacementId = "223e4567-e89b-42d3-a456-426614174001";
		rerender(
			<ProjectPreviewPane
				preview={{
					...initial,
					id: replacementId,
					relay_url: `/api/project-previews/${replacementId}/relay/`,
				}}
			/>,
		);
		const newFrame = screen.getByTitle("Web app") as HTMLIFrameElement;
		expect(newFrame).not.toBe(oldFrame);
		expect(newFrame.src).toContain(
			`/api/project-previews/${replacementId}/relay/`,
		);
	});

	it("toggles maximize and restores through the parent layout", () => {
		const onToggleMaximize = vi.fn();
		const { rerender } = render(
			<ProjectPreviewPane
				preview={preview()}
				onToggleMaximize={onToggleMaximize}
			/>,
		);
		fireEvent.click(screen.getByLabelText("Maximize preview"));
		expect(onToggleMaximize).toHaveBeenCalledOnce();
		rerender(
			<ProjectPreviewPane
				preview={preview()}
				maximized
				onToggleMaximize={onToggleMaximize}
			/>,
		);
		expect(screen.getByLabelText("Restore preview pane")).not.toBeNull();
	});

	it("shows bounded logs without stopping the preview", () => {
		render(<ProjectPreviewPane preview={preview()} />);
		fireEvent.click(screen.getByLabelText("Show preview logs"));
		expect(screen.getAllByText("ready")).toHaveLength(2);
		expect(screen.getByLabelText("Show preview")).not.toBeNull();
	});

	it("keeps the live iframe mounted while viewing an agent frame", () => {
		render(<ProjectPreviewPane preview={preview()} />);
		const liveFrame = screen.getByTitle("Web app");

		fireEvent.click(screen.getByLabelText("Show agent view"));
		expect(screen.getByTitle("Web app")).toBe(liveFrame);
		expect(liveFrame.parentElement?.className).toContain("hidden");

		fireEvent.click(screen.getByLabelText("Show user preview"));
		expect(screen.getByTitle("Web app")).toBe(liveFrame);
		expect(liveFrame.parentElement?.className).not.toContain("hidden");
	});

	it("captures the selected named viewport for user feedback", async () => {
		vi.stubGlobal(
			"matchMedia",
			vi.fn(() => ({
				matches: true,
				addEventListener: vi.fn(),
				removeEventListener: vi.fn(),
			})),
		);
		const frame: ProjectPreviewAgentFrame = {
			preview_id: preview().id,
			session_id: "session-1",
			path: "/",
			viewport: "mobile",
			width: 390,
			height: 844,
			full_page: false,
			captured_at: Date.now(),
			mime: "image/png",
			size_bytes: 3,
			image_base64: "AQID",
			frame_id: "e16b1643-591f-4d67-8c22-9df105659385",
			title: "Web app",
			elements: [],
			console_messages: [],
			failed_requests: [],
		};
		vi.mocked(captureProjectPreviewFeedbackFn).mockResolvedValue(frame);
		render(<ProjectPreviewPane preview={preview()} />);
		const liveFrame = screen.getByTitle("Web app") as HTMLIFrameElement;
		fireEvent.change(screen.getByLabelText("Preview viewport"), {
			target: { value: "mobile" },
		});
		window.dispatchEvent(
			new MessageEvent("message", {
				origin: new URL(liveFrame.src).origin,
				source: liveFrame.contentWindow,
				data: {
					type: "hlid:project-preview-state",
					version: 1,
					preview_id: preview().id,
					path: "/settings?tab=display",
					width: 412,
					height: 715,
					scroll_x: 8,
					scroll_y: 640,
				},
			}),
		);
		fireEvent.click(screen.getByLabelText("Capture Preview feedback"));

		await waitFor(() =>
			expect(captureProjectPreviewFeedbackFn).toHaveBeenCalledWith({
				data: {
					sessionId: "session-1",
					previewId: preview().id,
					path: "/settings?tab=display",
					viewport: "mobile",
					width: 412,
					height: 715,
					scrollX: 8,
					scrollY: 640,
				},
			}),
		);
		expect(
			screen.getByRole("dialog", { name: "Annotate Project Preview" }),
		).not.toBeNull();
		await waitFor(() =>
			expect(
				(
					screen.getByLabelText(
						"Preview annotation canvas",
					) as HTMLCanvasElement
				).style.touchAction,
			).toBe("pan-x pan-y"),
		);
		fireEvent.click(screen.getByLabelText("Pen"));
		expect(
			(screen.getByLabelText("Preview annotation canvas") as HTMLCanvasElement)
				.style.touchAction,
		).toBe("none");
	});

	it("ignores Preview view state from any other origin", async () => {
		const captured: ProjectPreviewAgentFrame = {
			preview_id: preview().id,
			session_id: "session-1",
			path: "/",
			viewport: "desktop",
			width: 1440,
			height: 1000,
			full_page: false,
			captured_at: Date.now(),
			mime: "image/png",
			size_bytes: 3,
			image_base64: "AQID",
			frame_id: "e16b1643-591f-4d67-8c22-9df105659385",
			title: "Web app",
			elements: [],
			console_messages: [],
			failed_requests: [],
		};
		vi.mocked(captureProjectPreviewFeedbackFn).mockResolvedValue(captured);
		render(<ProjectPreviewPane preview={preview()} />);
		const liveFrame = screen.getByTitle("Web app") as HTMLIFrameElement;
		window.dispatchEvent(
			new MessageEvent("message", {
				origin: "https://untrusted.example",
				source: liveFrame.contentWindow,
				data: {
					type: "hlid:project-preview-state",
					version: 1,
					preview_id: preview().id,
					path: "/forged",
					width: 300,
					height: 400,
					scroll_x: 0,
					scroll_y: 900,
				},
			}),
		);
		fireEvent.click(screen.getByLabelText("Capture Preview feedback"));

		await waitFor(() =>
			expect(captureProjectPreviewFeedbackFn).toHaveBeenCalledWith({
				data: {
					sessionId: "session-1",
					previewId: preview().id,
					path: "/",
					viewport: "desktop",
					width: 1440,
					height: 1000,
				},
			}),
		);
	});
});
