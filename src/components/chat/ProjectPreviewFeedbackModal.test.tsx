// @vitest-environment jsdom
import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
	ProjectPreviewAgentFrame,
	ProjectPreviewFeedbackAnnotation,
} from "#/server/protocol";
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

	it("binds a drawn mark to exact semantic element context on save", async () => {
		class RasterImage {
			onload: (() => void) | null = null;
			naturalWidth = 780;
			naturalHeight = 1688;
			set src(_value: string) {
				queueMicrotask(() => this.onload?.());
			}
		}
		vi.stubGlobal("Image", RasterImage);
		vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
			clearRect: vi.fn(),
			drawImage: vi.fn(),
			save: vi.fn(),
			restore: vi.fn(),
			strokeRect: vi.fn(),
		} as unknown as CanvasRenderingContext2D);
		vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation(
			(callback) => callback(new Blob(["png"], { type: "image/png" })),
		);
		const exactFrame = frame();
		exactFrame.elements = [
			{
				ref: "e1",
				role: "button",
				name: "Save",
				tag: "button",
				type: "submit",
				x: 100,
				y: 100,
				width: 100,
				height: 50,
			},
		];
		const onSave = vi.fn(
			async (
				_blob: Blob,
				_comment: string,
				_annotations: ProjectPreviewFeedbackAnnotation[],
			) => {},
		);
		render(
			<ProjectPreviewFeedbackModal
				frame={exactFrame}
				saving={false}
				error={null}
				onClose={vi.fn()}
				onSave={onSave}
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
		canvas.setPointerCapture = vi.fn();
		canvas.hasPointerCapture = vi.fn(() => true);
		canvas.releasePointerCapture = vi.fn();
		fireEvent.click(screen.getByLabelText("Rectangle"));
		fireEvent.pointerDown(canvas, { pointerId: 1, clientX: 100, clientY: 100 });
		fireEvent.pointerMove(canvas, { pointerId: 1, clientX: 200, clientY: 150 });
		fireEvent.pointerUp(canvas, { pointerId: 1, clientX: 200, clientY: 150 });

		await screen.findByText("Mark 1 · rectangle");
		fireEvent.click(screen.getByText("Save and send"));
		await waitFor(() => expect(onSave).toHaveBeenCalledOnce());
		expect(onSave.mock.calls[0]?.[2]).toEqual([
			expect.objectContaining({
				mark_index: 0,
				mark_kind: "rectangle",
				ref: "e1",
				role: "button",
				name: "Save",
				bounds: { x: 100, y: 100, width: 100, height: 50 },
			}),
		]);
	});
});
