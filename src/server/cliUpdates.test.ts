import { describe, expect, it, vi } from "vitest";
import type { AcpCatalogItem } from "./acpRegistry";
import {
	buildWslCliProbeScript,
	compareCliVersions,
	inspectAcpUpdates,
	inspectCliUpdates,
	inspectWslUpdates,
	parseCliVersion,
} from "./cliUpdates";

function acpItem(overrides: Partial<AcpCatalogItem> = {}): AcpCatalogItem {
	return {
		id: "other",
		name: "Other Agent",
		version: "1.2.0",
		description: "Other ACP agent",
		distribution: { npx: { package: "other-acp@1.2.0" } },
		providerId: "acp:other",
		enabled: true,
		available: true,
		command: "other-acp",
		args: [],
		env: {},
		installGuidance: "bun add --global other-acp@1.2.0",
		...overrides,
	};
}

describe("CLI update discovery", () => {
	it("parses Codex and Claude version output", () => {
		expect(parseCliVersion("codex-cli 0.144.1")).toBe("0.144.1");
		expect(parseCliVersion("2.1.207 (Claude Code)")).toBe("2.1.207");
		expect(parseCliVersion("unknown")).toBeNull();
	});

	it("compares release and prerelease versions", () => {
		expect(compareCliVersions("0.144.2", "0.144.1")).toBeGreaterThan(0);
		expect(compareCliVersions("2.1.207", "2.1.207")).toBe(0);
		expect(compareCliVersions("1.0.0-beta", "1.0.0")).toBeLessThan(0);
	});

	it("resolves WSL CLIs after the login shell loads the user PATH", () => {
		const script = buildWslCliProbeScript("claude");

		expect(script).toBe(
			"command -v claude && claude --version && command -v claude | xargs -r readlink -f",
		);
		expect(script).not.toContain("$(command -v");
	});

	it("reports updates only for installed CLIs", async () => {
		const statuses = await inspectCliUpdates({
			resolveExecutable: (id) =>
				id === "codex"
					? "/usr/lib/node_modules/@openai/codex/bin/codex.js"
					: undefined,
			readVersion: vi.fn().mockResolvedValue("0.144.1"),
			fetchLatest: vi.fn().mockResolvedValue("0.144.2"),
			now: () => 1_800_000_000_000,
		});

		expect(statuses).toEqual([
			{
				id: "codex",
				label: "Codex",
				installedVersion: "0.144.1",
				latestVersion: "0.144.2",
				available: true,
				updateCommand: "sudo npm install --global @openai/codex@latest",
				updateMode: "interactive",
				requiresElevation: true,
				checkedAt: 1_800_000_000_000,
			},
		]);
	});

	it("shows the npm update command for a Windows npm shim", async () => {
		const statuses = await inspectCliUpdates({
			resolveExecutable: (id) =>
				id === "codex"
					? "C:\\Users\\Kyle\\AppData\\Roaming\\npm\\codex.cmd"
					: undefined,
			readVersion: vi.fn().mockResolvedValue("0.144.1"),
			fetchLatest: vi.fn().mockResolvedValue("0.144.2"),
			now: () => 1_800_000_000_000,
		});

		expect(statuses[0]?.updateCommand).toBe(
			"npm install --global @openai/codex@latest",
		);
		expect(statuses[0]).toMatchObject({
			updateMode: "automatic",
			requiresElevation: false,
		});
	});

	it("keeps a usable installed version when the registry check fails", async () => {
		const statuses = await inspectCliUpdates({
			resolveExecutable: (id) => (id === "claude" ? "/bin/claude" : undefined),
			readVersion: vi.fn().mockResolvedValue("2.1.207"),
			fetchLatest: vi.fn().mockRejectedValue(new Error("offline")),
			now: () => 1_800_000_000_000,
		});

		expect(statuses[0]).toMatchObject({
			id: "claude",
			installedVersion: "2.1.207",
			latestVersion: null,
			available: false,
			updateCommand: "sudo claude update",
			updateMode: "interactive",
			requiresElevation: true,
			error: "latest version: offline",
		});
	});

	it("compares enabled ACP agent protocol versions with the ACP registry", async () => {
		const statuses = await inspectAcpUpdates({
			listCandidates: vi
				.fn()
				.mockResolvedValue([{ item: acpItem(), customExecutable: false }]),
			readVersion: vi.fn().mockResolvedValue("1.1.0"),
			now: () => 1_800_000_000_000,
		});

		expect(statuses).toEqual([
			{
				id: "acp:other",
				label: "Other Agent (ACP)",
				installedVersion: "1.1.0",
				latestVersion: "1.2.0",
				available: true,
				updateCommand: "bun add --global other-acp@1.2.0",
				updateMode: "automatic",
				requiresElevation: false,
				checkedAt: 1_800_000_000_000,
			},
		]);
	});

	it("does not guess an update command for custom ACP executables", async () => {
		const statuses = await inspectAcpUpdates({
			listCandidates: vi.fn().mockResolvedValue([
				{
					item: acpItem({
						command: "/opt/custom-agent",
						distribution: {
							binary: {
								"linux-x86_64": { cmd: "other-acp" },
							},
						},
					}),
					customExecutable: true,
				},
			]),
			readVersion: vi.fn().mockResolvedValue("1.1.0"),
			now: () => 1_800_000_000_000,
		});

		expect(statuses[0]).toMatchObject({
			id: "acp:other",
			available: true,
			installedVersion: "1.1.0",
			latestVersion: "1.2.0",
		});
		expect(statuses[0]?.updateCommand).toBeUndefined();
	});

	it("marks a root-owned WSL Codex install as interactive sudo", async () => {
		const statuses = await inspectWslUpdates({
			listDistros: () => ["Ubuntu-24.04"],
			readCli: vi.fn(async (_distro, id) => {
				if (id === "claude") throw new Error("not installed");
				return {
					version: "0.144.1",
					executable: "/usr/lib/node_modules/@openai/codex/bin/codex.js",
				};
			}),
			fetchLatest: vi.fn().mockResolvedValue("0.144.2"),
			now: () => 1_800_000_000_000,
		});
		expect(statuses).toEqual([
			{
				id: "wsl:Ubuntu-24.04:codex",
				label: "Codex (Ubuntu-24.04)",
				installedVersion: "0.144.1",
				latestVersion: "0.144.2",
				available: true,
				updateCommand: "sudo npm install --global @openai/codex@latest",
				updateMode: "interactive",
				requiresElevation: true,
				checkedAt: 1_800_000_000_000,
			},
		]);
	});

	it("can automatically update a user-local WSL Claude install", async () => {
		const statuses = await inspectWslUpdates({
			listDistros: () => ["Ubuntu-24.04"],
			readCli: vi.fn(async (_distro, id) => {
				if (id === "codex") throw new Error("not installed");
				return {
					version: "2.1.207",
					executable: "/home/kyle/.local/share/claude/versions/2.1.207",
				};
			}),
			fetchLatest: vi.fn().mockResolvedValue("2.1.208"),
			now: () => 1_800_000_000_000,
		});

		expect(statuses).toEqual([
			{
				id: "wsl:Ubuntu-24.04:claude",
				label: "Claude Code (Ubuntu-24.04)",
				installedVersion: "2.1.207",
				latestVersion: "2.1.208",
				available: true,
				updateCommand: "claude update",
				updateMode: "automatic",
				requiresElevation: false,
				checkedAt: 1_800_000_000_000,
			},
		]);
	});
});
