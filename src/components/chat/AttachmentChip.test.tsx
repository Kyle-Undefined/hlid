// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { AttachmentChip } from "./AttachmentChip";

afterEach(cleanup);

function makeAttachment(
	overrides: Partial<{
		id: string;
		filename: string;
		mime: string;
		size_bytes: number;
		path: string;
		kind: "vault" | "upload";
	}> = {},
) {
	return {
		id: "att-1",
		filename: "photo.png",
		mime: "image/png",
		size_bytes: 1024,
		path: "/tmp/photo.png",
		kind: "upload" as const,
		...overrides,
	};
}

describe("AttachmentChip — image", () => {
	it("renders a button (not a link) for image attachments", () => {
		render(<AttachmentChip a={makeAttachment()} />);
		expect(screen.queryByRole("link")).toBeNull();
		expect(screen.getByRole("button")).toBeDefined();
	});

	it("clicking opens the image viewer modal", () => {
		render(<AttachmentChip a={makeAttachment()} />);
		fireEvent.click(screen.getByRole("button"));
		expect(screen.getByRole("dialog")).toBeDefined();
	});

	it("modal shows the correct image src", () => {
		render(<AttachmentChip a={makeAttachment({ id: "abc123" })} />);
		fireEvent.click(screen.getByRole("button"));
		const img = screen
			.getAllByRole("img")
			.find((el) =>
				(el as HTMLImageElement).src.includes("/api/attachments/abc123/raw"),
			);
		expect(img).toBeDefined();
	});

	it("closing the modal removes it from the DOM", () => {
		render(<AttachmentChip a={makeAttachment()} />);
		fireEvent.click(screen.getByRole("button"));
		expect(screen.getByRole("dialog")).toBeDefined();
		fireEvent.click(screen.getByRole("button", { name: /close/i }));
		expect(screen.queryByRole("dialog")).toBeNull();
	});
});

describe("AttachmentChip — non-image", () => {
	it("renders an anchor with target=_blank for non-image files", () => {
		render(
			<AttachmentChip
				a={makeAttachment({ filename: "doc.pdf", mime: "application/pdf" })}
			/>,
		);
		const link = screen.getByRole("link");
		expect(link).toBeDefined();
		expect(link.getAttribute("target")).toBe("_blank");
	});

	it("does not open a modal for non-image files", () => {
		render(
			<AttachmentChip
				a={makeAttachment({ filename: "doc.pdf", mime: "application/pdf" })}
			/>,
		);
		expect(screen.queryByRole("dialog")).toBeNull();
	});
});
