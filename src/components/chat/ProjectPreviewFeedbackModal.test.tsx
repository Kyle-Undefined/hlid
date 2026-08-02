// @vitest-environment jsdom
import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProjectPreviewAgentFrame } from "#/server/protocol";
import { ProjectPreviewFeedbackModal } from "./ProjectPreviewFeedbackModal";

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

function frame(): ProjectPreviewAgentFrame {
	return {
		preview_id: "123e4567-e89b-12d3-a456-426614174000",
		session_id: "session-1",
		path: "/settings",
		viewport: "mobile",
		width: 390,
		height: 844,
		pixel_width: 780,
		pixel_height: 1688,
		device_scale_factor: 2,
		pixel_ratio: 2,
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
}

describe("ProjectPreviewFeedbackModal", () => {
	it("dismisses from the backdrop but stays locked while saving", () => {
		const onClose = vi.fn();
		const { rerender } = render(
			<ProjectPreviewFeedbackModal
				frame={frame()}
				saving={false}
				error={null}
				onClose={onClose}
				onSave={vi.fn(async () => {})}
			/>,
		);
		const dialog = screen.getByRole("dialog", {
			name: "Annotate Project Preview",
		});

		fireEvent.click(dialog);
		expect(onClose).not.toHaveBeenCalled();
		fireEvent.click(dialog.parentElement as HTMLElement);
		expect(onClose).toHaveBeenCalledOnce();

		onClose.mockClear();
		rerender(
			<ProjectPreviewFeedbackModal
				frame={frame()}
				saving
				error={null}
				onClose={onClose}
				onSave={vi.fn(async () => {})}
			/>,
		);
		const savingDialog = screen.getByRole("dialog", {
			name: "Annotate Project Preview",
		});
		fireEvent.click(savingDialog.parentElement as HTMLElement);
		fireEvent.keyDown(savingDialog, { key: "Escape" });
		expect(onClose).not.toHaveBeenCalled();
	});

	it("scales annotation strokes and text to the source raster density", async () => {
		class RasterImage {
			onload: (() => void) | null = null;
			naturalWidth = 780;
			naturalHeight = 1688;

			set src(_value: string) {
				queueMicrotask(() => this.onload?.());
			}
		}
		vi.stubGlobal("Image", RasterImage);

		const context = {
			beginPath: vi.fn(),
			clearRect: vi.fn(),
			drawImage: vi.fn(),
			fillRect: vi.fn(),
			fillText: vi.fn(),
			font: "",
			lineCap: "butt",
			lineJoin: "miter",
			lineTo: vi.fn(),
			lineWidth: 1,
			moveTo: vi.fn(),
			restore: vi.fn(),
			save: vi.fn(),
			stroke: vi.fn(),
			strokeRect: vi.fn(),
			strokeStyle: "",
			strokeText: vi.fn(),
			fillStyle: "",
		};
		vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
			context as unknown as CanvasRenderingContext2D,
		);

		render(
			<ProjectPreviewFeedbackModal
				frame={frame()}
				saving={false}
				error={null}
				onClose={vi.fn()}
				onSave={vi.fn(async () => {})}
			/>,
		);
		await waitFor(() =>
			expect(screen.getByText("Save and send").hasAttribute("disabled")).toBe(
				false,
			),
		);

		const canvas = screen.getByLabelText(
			"Preview annotation canvas",
		) as HTMLCanvasElement;
		vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue({
			bottom: 844,
			height: 844,
			left: 0,
			right: 390,
			toJSON: () => ({}),
			top: 0,
			width: 390,
			x: 0,
			y: 0,
		});
		fireEvent.click(screen.getByLabelText("Text"));
		fireEvent.change(screen.getByLabelText("Annotation text"), {
			target: { value: "Note" },
		});
		fireEvent.pointerDown(canvas, { clientX: 195, clientY: 422 });

		await waitFor(() =>
			expect(context.fillText).toHaveBeenCalledWith("Note", 390, 844),
		);
		expect(context.font).toBe("600 48px sans-serif");
		expect(context.lineWidth).toBe(10);
	});
});
