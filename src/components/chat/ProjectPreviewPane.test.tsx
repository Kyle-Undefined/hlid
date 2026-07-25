// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProjectPreviewSnapshot } from "#/server/protocol";
import { ProjectPreviewPane } from "./ProjectPreviewPane";

vi.mock("#/lib/serverFns/projectPreviews", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("#/lib/serverFns/projectPreviews")>();
	return {
		...actual,
		getProjectPreviewAgentFrameFn: vi.fn(async () => null),
		restartProjectPreviewFn: vi.fn(),
		stopProjectPreviewFn: vi.fn(),
	};
});

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
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
		const viewport = screen.getByLabelText("Preview viewport");
		fireEvent.change(viewport, { target: { value: "mobile" } });
		expect(frame.parentElement?.style.width).toBe("390px");
		expect(screen.getByLabelText("Show agent view")).not.toBeNull();
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
});
