// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfirmAction } from "./ConfirmAction";

afterEach(cleanup);

describe("ConfirmAction", () => {
	it("preserves the default open and confirm behavior", () => {
		const onConfirm = vi.fn();
		const onOpenChange = vi.fn();
		render(
			<ConfirmAction
				label="remove item?"
				onConfirm={onConfirm}
				onOpenChange={onOpenChange}
				trigger={(open) => (
					<button type="button" onClick={open}>
						Remove
					</button>
				)}
			/>,
		);

		fireEvent.click(screen.getByRole("button", { name: "Remove" }));
		fireEvent.click(screen.getByRole("button", { name: "confirm" }));

		expect(onConfirm).toHaveBeenCalledOnce();
		expect(onOpenChange.mock.calls).toEqual([[true], [false]]);
		expect(screen.getByRole("button", { name: "Remove" })).toBeTruthy();
	});

	it("suppresses opening while disabled", () => {
		const onConfirm = vi.fn();
		const onOpenChange = vi.fn();
		render(
			<ConfirmAction
				disabled
				onConfirm={onConfirm}
				onOpenChange={onOpenChange}
				trigger={(open) => (
					<button type="button" onClick={open}>
						Remove
					</button>
				)}
			/>,
		);

		fireEvent.click(screen.getByRole("button", { name: "Remove" }));

		expect(screen.queryByRole("button", { name: "confirm" })).toBeNull();
		expect(onConfirm).not.toHaveBeenCalled();
		expect(onOpenChange).not.toHaveBeenCalled();
	});

	it("closes an open confirmation when it becomes disabled", () => {
		const onConfirm = vi.fn();
		const onOpenChange = vi.fn();
		const view = render(
			<ConfirmAction
				onConfirm={onConfirm}
				onOpenChange={onOpenChange}
				trigger={(open) => (
					<button type="button" onClick={open}>
						Remove
					</button>
				)}
			/>,
		);
		fireEvent.click(screen.getByRole("button", { name: "Remove" }));
		expect(screen.getByRole("button", { name: "confirm" })).toBeTruthy();

		view.rerender(
			<ConfirmAction
				disabled
				onConfirm={onConfirm}
				onOpenChange={onOpenChange}
				trigger={(open) => (
					<button type="button" onClick={open}>
						Remove
					</button>
				)}
			/>,
		);

		expect(screen.queryByRole("button", { name: "confirm" })).toBeNull();
		expect(screen.getByRole("button", { name: "Remove" })).toBeTruthy();
		expect(onConfirm).not.toHaveBeenCalled();
		expect(onOpenChange.mock.calls).toEqual([[true], [false]]);
	});
});
