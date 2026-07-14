import { beforeEach, describe, expect, it, vi } from "vitest";

const drainCliRuntime = vi.hoisted(() => vi.fn());
const runBoundedProcess = vi.hoisted(() => vi.fn());
const getCliUpdateStatuses = vi.hoisted(() => vi.fn());
const resolveCliUpdateAction = vi.hoisted(() => vi.fn());

vi.mock("#/lib/cliUpdateRuntime", () => ({ drainCliRuntime }));
vi.mock("#/lib/process", () => ({ runBoundedProcess }));
vi.mock("./cliUpdates", () => ({
	getCliUpdateStatuses,
	resolveCliUpdateAction,
}));

import { applyCliUpdate, prepareCliUpdate } from "./cliUpdateActions";

beforeEach(() => {
	vi.clearAllMocks();
	getCliUpdateStatuses.mockResolvedValue([
		{
			id: "codex",
			label: "Codex",
			available: true,
		},
	]);
	drainCliRuntime.mockResolvedValue({ sessions: 2, appServers: 1 });
});

describe("CLI update actions", () => {
	it("drains provider processes and returns an interactive command", async () => {
		resolveCliUpdateAction.mockResolvedValue({
			id: "codex",
			displayCommand: "sudo npm install --global @openai/codex@latest",
			command: "npm",
			args: [],
			automatic: false,
			requiresElevation: true,
		});
		await expect(prepareCliUpdate("codex")).resolves.toEqual({
			sessions: 2,
			appServers: 1,
			command: "sudo npm install --global @openai/codex@latest",
			mode: "interactive",
		});
		expect(drainCliRuntime).toHaveBeenCalledOnce();
	});

	it("never tries to automate a sudo update", async () => {
		resolveCliUpdateAction.mockResolvedValue({
			id: "codex",
			displayCommand: "sudo npm update",
			command: "npm",
			args: [],
			automatic: false,
			requiresElevation: true,
		});
		await expect(applyCliUpdate("codex")).rejects.toThrow(
			"interactive sudo prompt",
		);
		expect(drainCliRuntime).not.toHaveBeenCalled();
		expect(runBoundedProcess).not.toHaveBeenCalled();
	});

	it("drains, applies, and refreshes an automatic update", async () => {
		resolveCliUpdateAction.mockResolvedValue({
			id: "codex",
			displayCommand: "npm update",
			command: "npm",
			args: ["update"],
			automatic: true,
			requiresElevation: false,
		});
		runBoundedProcess.mockResolvedValue({ output: "updated", code: 0 });
		await expect(applyCliUpdate("codex")).resolves.toEqual({
			command: "npm update",
			output: "updated",
			drained: { sessions: 2, appServers: 1 },
		});
		expect(runBoundedProcess).toHaveBeenCalledWith(
			"npm",
			["update"],
			expect.objectContaining({
				timeoutError: "CLI update timed out",
				maxOutputChars: 32_000,
			}),
		);
		expect(getCliUpdateStatuses).toHaveBeenLastCalledWith({ force: true });
	});
});
