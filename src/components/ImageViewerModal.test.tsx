// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ImageViewerModal } from "./ImageViewerModal";

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
});
