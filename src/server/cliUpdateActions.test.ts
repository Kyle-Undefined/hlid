import { beforeEach, describe, expect, it, vi } from "vitest";

const drainCliRuntime = vi.hoisted(() => vi.fn());
const reconcileAcpCliRuntime = vi.hoisted(() => vi.fn());
const releaseCliRuntimeLease = vi.hoisted(() => vi.fn());
const runBoundedProcess = vi.hoisted(() => vi.fn());
const getCliUpdateStatuses = vi.hoisted(() => vi.fn());
const resolveCliUpdateAction = vi.hoisted(() => vi.fn());
const loadConfig = vi.hoisted(() => vi.fn());
const parseWslUnc = vi.hoisted(() => vi.fn());

vi.mock("#/lib/cliUpdateRuntime", () => ({
	drainCliRuntime,
	reconcileAcpCliRuntime,
	releaseCliRuntimeLease,
}));
vi.mock("#/lib/paths", () => ({ parseWslUnc }));
vi.mock("#/lib/process", () => ({ runBoundedProcess }));
vi.mock("#/server/config", () => ({ loadConfig }));
vi.mock("./cliUpdates", () => ({
	getCliUpdateStatuses,
	resolveCliUpdateAction,
}));

import { applyCliUpdate, prepareCliUpdate } from "./cliUpdateActions";

beforeEach(() => {
	vi.clearAllMocks();
	reconcileAcpCliRuntime.mockResolvedValue(undefined);
	releaseCliRuntimeLease.mockResolvedValue(undefined);
	getCliUpdateStatuses.mockResolvedValue([
		{
			id: "codex",
			label: "Codex",
			available: true,
		},
	]);
	drainCliRuntime.mockResolvedValue({
		sessions: 2,
		appServers: 1,
		leaseId: "lease-1",
	});
	loadConfig.mockReturnValue({
		vault: { path: "C:\\Vault" },
		agents: [
			{
				path: "\\\\wsl.localhost\\Ubuntu-24.04\\home\\kyle\\project",
			},
		],
	});
	parseWslUnc.mockImplementation((path: string) =>
		path.includes("Ubuntu-24.04")
			? { distro: "Ubuntu-24.04", posixPath: "/home/kyle/project" }
			: null,
	);
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
			leaseId: "lease-1",
			command: "sudo npm install --global @openai/codex@latest",
			mode: "interactive",
			terminalCwd: "C:\\Vault",
		});
		expect(drainCliRuntime).toHaveBeenCalledOnce();
	});

	it("returns an authorized workspace in the matching WSL distro", async () => {
		getCliUpdateStatuses.mockResolvedValue([
			{
				id: "wsl:Ubuntu-24.04:claude",
				label: "Claude Code (Ubuntu-24.04)",
				available: true,
			},
		]);
		resolveCliUpdateAction.mockResolvedValue({
			id: "wsl:Ubuntu-24.04:claude",
			displayCommand: "sudo claude update",
			command: "wsl.exe",
			args: [],
			automatic: false,
			requiresElevation: true,
		});

		await expect(
			prepareCliUpdate("wsl:Ubuntu-24.04:claude"),
		).resolves.toMatchObject({
			command: "sudo claude update",
			terminalCwd: "\\\\wsl.localhost\\Ubuntu-24.04\\home\\kyle\\project",
		});
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
		expect(releaseCliRuntimeLease).toHaveBeenCalledWith("lease-1");
	});

	it("reconciles the owner runtime before rechecking an applied ACP update", async () => {
		getCliUpdateStatuses.mockResolvedValue([
			{
				id: "acp:opencode",
				label: "OpenCode (ACP)",
				available: true,
			},
		]);
		resolveCliUpdateAction.mockResolvedValue({
			id: "acp:opencode",
			displayCommand: "npm install --global opencode-ai@1.18.16",
			command: "npm",
			args: ["install", "--global", "opencode-ai@1.18.16"],
			automatic: true,
			requiresElevation: false,
		});
		runBoundedProcess.mockResolvedValue({ output: "updated", code: 0 });

		await applyCliUpdate("acp:opencode");

		expect(reconcileAcpCliRuntime).toHaveBeenCalledWith("lease-1");
		expect(reconcileAcpCliRuntime.mock.invocationCallOrder[0]).toBeLessThan(
			getCliUpdateStatuses.mock.invocationCallOrder.at(-1) ?? 0,
		);
	});

	it("keeps the lease retryable when ACP runtime reconciliation fails", async () => {
		getCliUpdateStatuses.mockResolvedValue([
			{
				id: "acp:opencode",
				label: "OpenCode (ACP)",
				available: true,
			},
		]);
		resolveCliUpdateAction.mockResolvedValue({
			id: "acp:opencode",
			displayCommand: "npm install --global opencode-ai@1.18.16",
			command: "npm",
			args: ["install", "--global", "opencode-ai@1.18.16"],
			automatic: true,
			requiresElevation: false,
		});
		runBoundedProcess.mockResolvedValue({ output: "updated", code: 0 });
		reconcileAcpCliRuntime.mockRejectedValue(
			new Error("owner runtime refresh failed"),
		);

		await expect(applyCliUpdate("acp:opencode")).resolves.toEqual({
			command: "npm install --global opencode-ai@1.18.16",
			output: "updated",
			drained: { sessions: 2, appServers: 1 },
			reconcilePending: {
				id: "acp:opencode",
				leaseId: "lease-1",
				error: "owner runtime refresh failed",
			},
		});
		expect(releaseCliRuntimeLease).not.toHaveBeenCalled();
		expect(getCliUpdateStatuses).toHaveBeenCalledTimes(1);
	});

	it("releases the update lease when the package-manager process fails", async () => {
		resolveCliUpdateAction.mockResolvedValue({
			id: "codex",
			displayCommand: "npm update",
			command: "npm",
			args: ["update"],
			automatic: true,
			requiresElevation: false,
		});
		runBoundedProcess.mockResolvedValue({
			output: "installer failed",
			code: 1,
		});

		await expect(applyCliUpdate("codex")).rejects.toThrow(
			"CLI update exited 1: installer failed",
		);
		expect(releaseCliRuntimeLease).toHaveBeenCalledWith("lease-1");
		expect(getCliUpdateStatuses).toHaveBeenCalledTimes(1);
	});

	it("updates the desktop app without stopping provider sessions", async () => {
		getCliUpdateStatuses.mockResolvedValue([
			{
				id: "codex-desktop",
				label: "Codex desktop app",
				available: true,
			},
		]);
		resolveCliUpdateAction.mockResolvedValue({
			id: "codex-desktop",
			displayCommand: "winget upgrade --id 9PLM9XGG6VKS",
			command: "winget.exe",
			args: ["upgrade", "--id", "9PLM9XGG6VKS"],
			automatic: true,
			requiresElevation: false,
			drainSessions: false,
		});
		runBoundedProcess.mockResolvedValue({ output: "updated", code: 0 });

		await expect(applyCliUpdate("codex-desktop")).resolves.toEqual({
			command: "winget upgrade --id 9PLM9XGG6VKS",
			output: "updated",
			drained: { sessions: 0, appServers: 0 },
		});
		expect(drainCliRuntime).not.toHaveBeenCalled();
	});

	it("does not send a manifest-only desktop update through winget", async () => {
		getCliUpdateStatuses.mockResolvedValue([
			{
				id: "codex-desktop",
				label: "Codex desktop app",
				available: true,
				updateInstructions: "Install the update from the Codex desktop app.",
			},
		]);

		await expect(applyCliUpdate("codex-desktop")).rejects.toThrow(
			"Install the update from the Codex desktop app.",
		);
		expect(resolveCliUpdateAction).not.toHaveBeenCalled();
		expect(runBoundedProcess).not.toHaveBeenCalled();
	});
});
