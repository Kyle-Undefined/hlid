// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ClickableImage, ImageViewerModal } from "./ImageViewerModal";

afterEach(cleanup);

describe("ImageViewerModal", () => {
	it("renders image with correct src and alt", () => {
		render(
			<ImageViewerModal
				src="https://example.com/cat.png"
				alt="a cat"
				onClose={vi.fn()}
			/>,
		);
		const img = screen.getByRole("img", { name: "a cat" });
		expect(img).toBeDefined();
		expect((img as HTMLImageElement).src).toBe("https://example.com/cat.png");
	});

	it("has role=dialog and aria-modal=true", () => {
		render(<ImageViewerModal src="x.png" alt="" onClose={vi.fn()} />);
		const dialog = screen.getByRole("dialog");
		expect(dialog).toBeDefined();
		expect(dialog.getAttribute("aria-modal")).toBe("true");
	});

	it("Escape key calls onClose", () => {
		const onClose = vi.fn();
		render(<ImageViewerModal src="x.png" alt="" onClose={onClose} />);
		const dialog = screen.getByRole("dialog");
		fireEvent.keyDown(dialog, { key: "Escape" });
		expect(onClose).toHaveBeenCalledTimes(1);
	});

	it("clicking backdrop calls onClose", () => {
		const onClose = vi.fn();
		const { container } = render(
			<ImageViewerModal src="x.png" alt="" onClose={onClose} />,
		);
		// The backdrop is the outermost fixed div (first child of container)
		const backdrop = container.firstChild as HTMLElement;
		fireEvent.click(backdrop);
		expect(onClose).toHaveBeenCalledTimes(1);
	});

	it("clicking the image does NOT call onClose", () => {
		const onClose = vi.fn();
		render(<ImageViewerModal src="x.png" alt="photo" onClose={onClose} />);
		const img = screen.getByRole("img", { name: "photo" });
		fireEvent.click(img);
		expect(onClose).not.toHaveBeenCalled();
	});

	it("close button calls onClose", () => {
		const onClose = vi.fn();
		render(<ImageViewerModal src="x.png" alt="" onClose={onClose} />);
		const closeBtn = screen.getByRole("button", { name: /close/i });
		fireEvent.click(closeBtn);
		expect(onClose).toHaveBeenCalledTimes(1);
	});

	it("shows alt text as caption when non-empty", () => {
		render(<ImageViewerModal src="x.png" alt="my caption" onClose={vi.fn()} />);
		expect(screen.getByText("my caption")).toBeDefined();
	});

	it("switches between fit, 1:1, and stepped zoom inside a scrollable viewport", () => {
		render(<ImageViewerModal src="x.png" alt="capture" onClose={vi.fn()} />);
		const image = screen.getByRole("img", { name: "capture" });
		Object.defineProperties(image, {
			naturalWidth: { configurable: true, value: 1600 },
			naturalHeight: { configurable: true, value: 1200 },
		});
		fireEvent.load(image);

		expect(
			screen.getByLabelText("Fit image").getAttribute("aria-pressed"),
		).toBe("true");
		expect(
			screen
				.getByTestId("image-viewer-viewport")
				.classList.contains("overflow-auto"),
		).toBe(true);

		fireEvent.click(screen.getByLabelText("View image at 1:1"));
		expect((image as HTMLImageElement).style.width).toBe("1600px");
		expect((image.parentElement as HTMLElement).style.width).toBe("1600px");
		expect(image.parentElement?.classList.contains("min-w-full")).toBe(true);
		expect(screen.getByText("100%")).toBeDefined();

		fireEvent.click(screen.getByLabelText("Zoom in"));
		expect((image as HTMLImageElement).style.width).toBe("2000px");
		expect((image.parentElement as HTMLElement).style.width).toBe("2000px");
		expect(screen.getByText("125%")).toBeDefined();

		fireEvent.click(screen.getByLabelText("Fit image"));
		expect((image as HTMLImageElement).style.width).toBe("");
	});

	it("downloads the original source with the provided filename", () => {
		const src = "data:image/png;base64,capture";
		render(
			<ImageViewerModal
				src={src}
				alt="Preview capture"
				downloadFilename="project-preview-mobile-settings.png"
				onClose={vi.fn()}
			/>,
		);
		const download = screen.getByRole("link", { name: "Download image" });
		expect(download.getAttribute("href")).toBe(src);
		expect(download.getAttribute("download")).toBe(
			"project-preview-mobile-settings.png",
		);
	});

	it("renders optional previous and next image navigation", () => {
		const onPrevious = vi.fn();
		const onNext = vi.fn();
		render(
			<ImageViewerModal
				src="x.png"
				alt="capture"
				onClose={vi.fn()}
				navigation={{
					position: 2,
					total: 3,
					onPrevious,
					onNext,
					previousLabel: "Previous Preview capture",
					nextLabel: "Next Preview capture",
				}}
			/>,
		);

		fireEvent.click(screen.getByLabelText("Previous Preview capture"));
		fireEvent.click(screen.getByLabelText("Next Preview capture"));
		expect(onPrevious).toHaveBeenCalledOnce();
		expect(onNext).toHaveBeenCalledOnce();
		expect(screen.getByText("2 / 3")).toBeDefined();
	});
});

describe("ClickableImage", () => {
	it("opens the full image in the viewer", () => {
		render(
			<ClickableImage
				src="data:image/png;base64,capture"
				alt="Preview capture at /settings"
				imageClassName="capture-thumbnail"
			/>,
		);

		const thumbnail = screen.getByRole("button", {
			name: "View Preview capture at /settings",
		});
		expect(
			screen
				.getByRole("img", { name: "Preview capture at /settings" })
				.classList.contains("capture-thumbnail"),
		).toBe(true);

		fireEvent.click(thumbnail);

		expect(screen.getByRole("dialog", { name: "Image viewer" })).toBeDefined();
		expect(
			screen.getAllByRole("img", {
				name: "Preview capture at /settings",
			}),
		).toHaveLength(2);
	});

	it("constrains a high-density source to its logical display width", () => {
		render(
			<ClickableImage
				src="data:image/png;base64,capture"
				alt="Desktop preview"
				displayWidth={1440}
				downloadFilename="project-preview-desktop-home.png"
			/>,
		);

		const thumbnail = screen.getByRole("button", {
			name: "View Desktop preview",
		});
		expect((thumbnail as HTMLElement).style.width).toBe("1440px");
		fireEvent.click(thumbnail);
		expect(
			screen
				.getByRole("link", { name: "Download image" })
				.getAttribute("download"),
		).toBe("project-preview-desktop-home.png");
	});
});
