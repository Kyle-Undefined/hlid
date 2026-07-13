// @vitest-environment jsdom
import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LockButton } from "./LockButton";

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

describe("LockButton", () => {
	it("posts logout and disables while locking", async () => {
		let resolveFetch: (r: Response) => void = () => {};
		const fetchMock = vi.fn(
			() =>
				new Promise<Response>((resolve) => {
					resolveFetch = resolve;
				}),
		);
		vi.stubGlobal("fetch", fetchMock);

		render(<LockButton />);
		const btn = screen.getByRole("button", {
			name: /lock/i,
		}) as HTMLButtonElement;
		fireEvent.click(btn);

		expect(fetchMock).toHaveBeenCalledWith("/api/auth/logout", {
			method: "POST",
		});
		await waitFor(() => expect(btn.disabled).toBe(true));
		expect(screen.getByText("Locking…")).toBeTruthy();
		resolveFetch(new Response());
	});

	it("renders the compact mobile variant", () => {
		vi.stubGlobal("fetch", vi.fn());
		render(<LockButton mobile />);
		expect(screen.getByText("Lock")).toBeTruthy();
	});
});
