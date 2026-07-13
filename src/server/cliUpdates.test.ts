import { describe, expect, it, vi } from "vitest";
import {
	compareCliVersions,
	inspectCliUpdates,
	parseCliVersion,
} from "./cliUpdates";

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
});
