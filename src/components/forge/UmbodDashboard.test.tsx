// @vitest-environment jsdom
import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { UmbodDashboard } from "./UmbodDashboard";

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
});

describe("UmbodDashboard", () => {
	it("renders Umbod insights and expands audited call context", async () => {
		vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
			Response.json({
				entries: [
					{
						id: 7,
						timestamp: "2026-07-11T12:00:00.000Z",
						agent: "claude",
						tool: "bash",
						command: "git push origin main",
						decision: "approve",
						classification: "destructive",
						workingDirectory: "/home/kyle/project",
						sessionId: "session-1",
						matchedRule: "git push *",
						reason: "matched approval rule",
						inputs: { command: "git push origin main" },
					},
				],
				page: 1,
				total: 1,
				totalPages: 1,
			}),
		);

		render(
			<UmbodDashboard
				tools={{
					totals: {
						entries: 12,
						sessions: 3,
						agents: ["claude"],
						projects: ["/home/kyle/project"],
					},
					byTool: [
						{
							agent: "claude",
							tool: "bash",
							count: 12,
							decisions: { allow: 8, approve: 3, block: 1 },
						},
					],
				}}
				rules={{
					rules: [
						{
							pattern: "git push *",
							decision: "approve",
							status: "active",
							matchCount: 3,
						},
					],
				}}
			/>,
		);

		await screen.findByText("git push origin main");
		expect(screen.getAllByText("12")).toHaveLength(2);
		expect(screen.getByText("active")).toBeTruthy();

		fireEvent.click(screen.getByText("git push origin main"));
		expect(screen.getByText("session-1")).toBeTruthy();
		expect(screen.getByText("matched approval rule")).toBeTruthy();
		expect(screen.getByText(/"command": "git push origin main"/)).toBeTruthy();

		fireEvent.change(screen.getByLabelText("Filter project"), {
			target: { value: "/home/kyle/project" },
		});
		await waitFor(() =>
			expect(fetch).toHaveBeenLastCalledWith(
				expect.stringContaining("project=%2Fhome%2Fkyle%2Fproject"),
			),
		);
	});
});
