// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => ({
	dbFetch: vi.fn(),
}));

vi.mock("@tanstack/react-start", () => ({
	createServerFn: () => {
		const chain = {
			validator: () => chain,
			handler: (handler: (...args: never[]) => unknown) => handler,
		};
		return chain;
	},
}));

vi.mock("#/lib/dbClient", () => ({
	dbFetch: dbMocks.dbFetch,
	requireDbOk: async (response: Response) => response,
}));

import { EventLogSection } from "./EventLogSection";

afterEach(() => {
	cleanup();
	dbMocks.dbFetch.mockReset();
});

describe("EventLogSection", () => {
	it("keeps clear confirmation actions reachable on mobile", async () => {
		dbMocks.dbFetch.mockResolvedValue({
			json: async () => ({
				logs: [
					{
						id: 1,
						timestamp: 1,
						level: "warn",
						source: "test",
						message: "mobile log",
						detail: null,
					},
				],
				total: 1,
				counts: { error: 0, warn: 1, info: 0 },
			}),
		} as Response);

		render(<EventLogSection />);
		fireEvent.click(await screen.findByRole("button", { name: "clear" }));

		const confirmation = screen.getByText("clear all?").parentElement;
		expect(confirmation?.className).toContain("w-full");
		expect(confirmation?.className).toContain("justify-end");
		expect(confirmation?.className).toContain("sm:w-auto");
		expect(confirmation?.parentElement?.className).toContain("flex-wrap");
		expect(screen.getByRole("button", { name: "confirm" })).toBeTruthy();
		expect(screen.getByRole("button", { name: "cancel" })).toBeTruthy();
	});
});
