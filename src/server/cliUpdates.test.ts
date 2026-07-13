import { describe, expect, it, vi } from "vitest";
import type { AcpCatalogItem } from "./acpRegistry";
import {
	compareCliVersions,
	inspectAcpUpdates,
	inspectCliUpdates,
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
				updateCommand: "npm install --global @openai/codex@latest",
				checkedAt: 1_800_000_000_000,
			},
		]);
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
			updateCommand: "claude update",
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
});
