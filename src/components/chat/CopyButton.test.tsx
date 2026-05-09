// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(cleanup);

import { CopyButton } from "./CopyButton";

describe("CopyButton", () => {
	it("renders with accessible label", () => {
		render(<CopyButton onCopy={vi.fn()} copied={false} />);
		expect(screen.getByRole("button", { name: /copy/i })).toBeDefined();
	});

	it("calls onCopy when clicked", () => {
		const onCopy = vi.fn();
		render(<CopyButton onCopy={onCopy} copied={false} />);
		fireEvent.click(screen.getByRole("button"));
		expect(onCopy).toHaveBeenCalledTimes(1);
	});

	it("shows Copy icon when copied is false", () => {
		render(<CopyButton onCopy={vi.fn()} copied={false} />);
		// Button label is "Copy"; icon is aria-hidden (decorative)
		expect(screen.getByRole("button", { name: "Copy" })).toBeDefined();
	});

	it("shows Check icon and updates label when copied is true", () => {
		render(<CopyButton onCopy={vi.fn()} copied={true} />);
		expect(screen.getByRole("button", { name: /copied/i })).toBeDefined();
	});
});
