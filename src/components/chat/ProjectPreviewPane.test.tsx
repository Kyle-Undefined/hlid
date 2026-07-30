// @vitest-environment jsdom
import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyProjectPreview } from "#/hooks/projectPreviewStore";
import {
	captureProjectPreviewFeedbackFn,
	getProjectPreviewAgentFrameFn,
	type ProjectPreviewAgentFrame,
	restartProjectPreviewFn,
	stopProjectPreviewFn,
} from "#/lib/serverFns/projectPreviews";
import type { ProjectPreviewSnapshot } from "#/server/protocol";
import { ProjectPreviewPane } from "./ProjectPreviewPane";

vi.mock("#/hooks/projectPreviewStore", () => ({
	applyProjectPreview: vi.fn(),
}));
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
	vi.mocked(getProjectPreviewAgentFrameFn).mockResolvedValue(null);
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
		expect(new URL(frame.src).searchParams.get("__hlid_preview_open")).toBe(
			"1",
		);
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

	it("reloads the current app route through the selected preview", () => {
		render(<ProjectPreviewPane preview={preview()} />);
		const oldFrame = screen.getByTitle("Web app") as HTMLIFrameElement;
		window.dispatchEvent(
			new MessageEvent("message", {
				origin: new URL(oldFrame.src).origin,
				source: oldFrame.contentWindow,
				data: {
					type: "hlid:project-preview-state",
					version: 1,
					preview_id: preview().id,
					path: "/forge?tab=events#tail",
					width: 1280,
					height: 720,
					scroll_x: 0,
					scroll_y: 240,
				},
			}),
		);

		fireEvent.click(screen.getByLabelText("Reload preview"));

		const newFrame = screen.getByTitle("Web app") as HTMLIFrameElement;
		const reloaded = new URL(newFrame.src);
		expect(newFrame).not.toBe(oldFrame);
		expect(reloaded.pathname).toBe(
			"/api/project-previews/123e4567-e89b-12d3-a456-426614174000/relay/forge",
		);
		expect(reloaded.searchParams.get("tab")).toBe("events");
		expect(reloaded.searchParams.get("__hlid_preview_open")).toBe("1");
		expect(reloaded.hash).toBe("#tail");
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

	it("runs shared lifecycle actions and preserves action errors", async () => {
		const current = preview();
		const restarted = {
			...current,
			id: "223e4567-e89b-42d3-a456-426614174001",
		};
		vi.mocked(restartProjectPreviewFn).mockResolvedValueOnce(restarted);
		vi.mocked(stopProjectPreviewFn).mockRejectedValueOnce(
			new Error("Stop failed"),
		);
		render(<ProjectPreviewPane preview={current} />);

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

		fireEvent.click(screen.getByLabelText("Stop preview"));
		expect(await screen.findByText("Stop failed")).not.toBeNull();
		expect(stopProjectPreviewFn).toHaveBeenCalledWith({
			data: {
				sessionId: current.session_id,
				previewId: current.id,
			},
		});
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

	it("clears an old agent frame when a replacement preview becomes active", async () => {
		const current = preview();
		const oldFrame: ProjectPreviewAgentFrame = {
			preview_id: current.id,
			session_id: current.session_id,
			path: "/old",
			viewport: "desktop",
			width: 1440,
			height: 1000,
			full_page: false,
			captured_at: 10,
			mime: "image/png",
			size_bytes: 3,
			image_base64: "AQID",
			frame_id: "e16b1643-591f-4d67-8c22-9df105659385",
			title: "Web app",
			elements: [],
			console_messages: [],
			failed_requests: [],
		};
		const replacementFrame = new Promise<ProjectPreviewAgentFrame | null>(
			() => {},
		);
		vi.mocked(getProjectPreviewAgentFrameFn)
			.mockResolvedValueOnce(oldFrame)
			.mockReturnValue(replacementFrame);
		const { rerender } = render(<ProjectPreviewPane preview={current} />);

		fireEvent.click(screen.getByLabelText("Show agent view"));
		expect(
			await screen.findByRole("button", {
				name: "View Agent browser at /old",
			}),
		).not.toBeNull();

		const replacementId = "223e4567-e89b-42d3-a456-426614174001";
		rerender(
			<ProjectPreviewPane
				preview={{
					...current,
					id: replacementId,
					relay_url: `/api/project-previews/${replacementId}/relay/`,
				}}
			/>,
		);

		expect(
			screen.queryByRole("button", {
				name: "View Agent browser at /old",
			}),
		).toBeNull();
		expect(screen.getByText("No agent frame yet.")).not.toBeNull();
		expect(getProjectPreviewAgentFrameFn).toHaveBeenLastCalledWith({
			data: {
				sessionId: current.session_id,
				previewId: replacementId,
			},
		});
	});

	it("renders a high-density full-page frame at its capture width and offers the raw PNG", async () => {
		const frame: ProjectPreviewAgentFrame = {
			preview_id: preview().id,
			session_id: "session-1",
			path: "/settings?tab=display",
			viewport: "mobile",
			width: 390,
			height: 844,
			pixel_width: 780,
			pixel_height: 8000,
			device_scale_factor: 2,
			pixel_ratio: 2,
			full_page: true,
			captured_at: Date.UTC(2026, 6, 29, 14, 5, 6),
			mime: "image/png",
			size_bytes: 3,
			image_base64: "AQID",
			frame_id: "e16b1643-591f-4d67-8c22-9df105659385",
			title: "Web app",
			elements: [],
			console_messages: [],
			failed_requests: [],
		};
		vi.mocked(getProjectPreviewAgentFrameFn).mockResolvedValue(frame);
		render(<ProjectPreviewPane preview={preview()} />);

		fireEvent.click(screen.getByLabelText("Show agent view"));
		const opener = await screen.findByRole("button", {
			name: "View Agent browser at /settings?tab=display",
		});
		expect((opener as HTMLElement).style.width).toBe("390px");
		const resolution = screen.getByTitle(
			"390×844 viewport pixels · 390×4000 capture pixels · 780×8000 PNG",
		);
		expect(resolution.textContent).toContain("390×844");
		expect(resolution.textContent).toContain("2×");

		fireEvent.click(opener);
		const download = screen.getByRole("link", { name: "Download image" });
		expect(download.getAttribute("href")).toBe("data:image/png;base64,AQID");
		expect(download.getAttribute("download")).toBe(
			"project-preview-mobile-settings-20260729T140506Z.png",
		);
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
