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

		render(
			<EventLogSection persistenceEnabled onPersistenceChange={vi.fn()} />,
		);
		fireEvent.click(await screen.findByRole("button", { name: "clear" }));

		const confirmation = screen.getByText("clear all?").parentElement;
		expect(confirmation?.className).toContain("w-full");
		expect(confirmation?.className).toContain("justify-end");
		expect(confirmation?.className).toContain("sm:w-auto");
		expect(confirmation?.parentElement?.className).toContain("flex-wrap");
		expect(screen.getByRole("button", { name: "confirm" })).toBeTruthy();
		expect(screen.getByRole("button", { name: "cancel" })).toBeTruthy();
	});

	it("labels the persistence control truthfully and keeps retained rows visible while off", async () => {
		dbMocks.dbFetch.mockResolvedValue({
			json: async () => ({
				logs: [
					{
						id: 1,
						timestamp: 1,
						level: "warn",
						source: "test",
						message: "retained log",
						detail: null,
					},
				],
				total: 1,
				counts: { error: 0, warn: 1, info: 0 },
			}),
		} as Response);
		const onPersistenceChange = vi.fn();

		render(
			<EventLogSection
				persistenceEnabled={false}
				onPersistenceChange={onPersistenceChange}
			/>,
		);

		const control = screen.getByRole("checkbox", {
			name: "Event Log persistence",
		});
		expect((control as HTMLInputElement).checked).toBe(false);
		expect(screen.getByText("off")).toBeTruthy();
		expect(
			screen.getByText(
				/stops new entries immediately after the setting saves/i,
			),
		).toBeTruthy();
		expect(await screen.findByText("retained log")).toBeTruthy();

		fireEvent.click(control);
		expect(onPersistenceChange).toHaveBeenCalledWith(true);
	});
});
