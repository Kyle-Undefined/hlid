// @vitest-environment jsdom
import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	dbFetch: vi.fn(),
	navigate: vi.fn(),
}));

vi.mock("../../lib/dbClient", () => ({ dbFetch: mocks.dbFetch }));
vi.mock("@tanstack/react-router", () => ({
	useNavigate: () => mocks.navigate,
}));

import { ApiSection } from "./ApiSection";

afterEach(cleanup);

describe("Forge API Reference", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.dbFetch.mockResolvedValue(
			Response.json({
				description: "Live API catalog",
				api_port: 4311,
				ui_port: 4310,
				endpoints: [
					{
						method: "GET",
						path: "/db/sessions?size=",
						server: "api",
						desc: "List session history.",
					},
					{
						method: "POST",
						path: "/api/config",
						server: "ui",
						desc: "Write configuration.",
					},
					{
						method: "GET",
						path: "/skills/catalog",
						server: "api",
						desc: "Review available skills.",
					},
				],
			}),
		);
	});

	it("renders endpoint groups and ports from the live catalog", async () => {
		render(<ApiSection />);

		await waitFor(() =>
			expect(
				screen.getByText("/db/sessions?size=", { exact: false }),
			).toBeTruthy(),
		);
		expect(mocks.dbFetch).toHaveBeenCalledWith("/api-index");
		expect(screen.getByText("127.0.0.1:4311")).toBeTruthy();
		expect(screen.getByText("127.0.0.1:4310")).toBeTruthy();
		expect(screen.getByText("Session API")).toBeTruthy();
		expect(screen.getByText("Extensions & Skills API")).toBeTruthy();
		expect(screen.getByText("Write configuration.")).toBeTruthy();
	});

	it("builds the skill prompt from the current group endpoints", async () => {
		render(<ApiSection />);
		await screen.findByText("Session API");

		const sessionCard = screen.getByText("Session API").closest(".border");
		expect(sessionCard).toBeTruthy();
		fireEvent.click(sessionCard?.querySelector("button") as HTMLButtonElement);

		expect(mocks.navigate).toHaveBeenCalledWith({
			to: "/raven",
			search: {
				prompt: expect.stringContaining("GET /db/sessions?size="),
			},
		});
		const prompt = mocks.navigate.mock.calls[0][0].search.prompt as string;
		expect(prompt).toContain("http://127.0.0.1:4311");
		expect(prompt).not.toContain("POST /api/config");
	});
});
