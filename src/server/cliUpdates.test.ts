import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CliUpdateStatus } from "../lib/cliUpdateTypes";
import type { AcpCatalogItem } from "./acpRegistry";
import {
	__resetCliUpdateStatusCacheForTesting,
	buildWslCliProbeScript,
	type CliUpdateStatusDependencies,
	compareCliVersions,
	getCliUpdateStatuses,
	inspectAcpUpdates,
	inspectCliUpdates,
	inspectWindowsDesktopUpdates,
	inspectWslUpdates,
	parseCliUpdateStatusCache,
	parseCliVersion,
	parseCodexDesktopStoreUpdateManifest,
	parseWindowsStoreVersions,
	readElectronAsarPackageVersion,
} from "./cliUpdates";

function cachedStatus(id: CliUpdateStatus["id"] = "codex"): CliUpdateStatus {
	return {
		id,
		label: "Codex",
		installedVersion: "1.0.0",
		latestVersion: "1.0.1",
		available: true,
		checkedAt: 1_800_000_000_000,
	};
}

function statusDependencies(
	overrides: Partial<CliUpdateStatusDependencies> = {},
): CliUpdateStatusDependencies {
	return {
		now: () => 1_800_000_001_000,
		readCache: vi.fn().mockResolvedValue(null),
		writeCache: vi.fn().mockResolvedValue(undefined),
		inspectNative: vi.fn().mockResolvedValue([]),
		inspectDesktop: vi.fn().mockResolvedValue([]),
		inspectWsl: vi.fn().mockResolvedValue([]),
		inspectAcp: vi.fn().mockResolvedValue([]),
		...overrides,
	};
}

beforeEach(() => {
	__resetCliUpdateStatusCacheForTesting();
});

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
		expect(parseCliVersion("26.707.9981.0")).toBe("26.707.9981.0");
		expect(parseCliVersion("unknown")).toBeNull();
	});

	it("compares release and prerelease versions", () => {
		expect(compareCliVersions("0.144.2", "0.144.1")).toBeGreaterThan(0);
		expect(compareCliVersions("2.1.207", "2.1.207")).toBe(0);
		expect(
			compareCliVersions("26.707.9981.1", "26.707.9981.0"),
		).toBeGreaterThan(0);
		expect(compareCliVersions("1.0.0-beta", "1.0.0")).toBeLessThan(0);
	});

	it("parses installed and available versions from an exact Store row", () => {
		expect(
			parseWindowsStoreVersions(`
Name    Id           Version       Available      Source
----------------------------------------------------------
ChatGPT 9PLM9XGG6VKS 26.707.9981.0 26.708.10000.0 msstore
`),
		).toEqual({
			installedVersion: "26.707.9981.0",
			latestVersion: "26.708.10000.0",
		});
		expect(
			parseWindowsStoreVersions("ChatGPT 9PLM9XGG6VKS 26.707.9981.0"),
		).toEqual({
			installedVersion: "26.707.9981.0",
			latestVersion: "26.707.9981.0",
		});
	});

	it("parses Codex Desktop's advisory Windows Store manifest", () => {
		expect(
			parseCodexDesktopStoreUpdateManifest({
				schemaVersion: 1,
				buildVersion: "26.715.2305.0",
				storeProductId: "9PLM9XGG6VKS",
				packageIdentity: "OpenAI.Codex",
			}),
		).toBe("26.715.2305.0");
		expect(
			parseCodexDesktopStoreUpdateManifest({
				buildVersion: "26.715.2305.0",
				storeProductId: "different-product",
				packageIdentity: "OpenAI.Codex",
			}),
		).toBeNull();
	});

	it("tracks the installed Codex desktop app against Microsoft Store", async () => {
		const statuses = await inspectWindowsDesktopUpdates({
			isWindows: () => true,
			readInstalledVersions: vi.fn().mockResolvedValue({
				packageVersion: "26.707.9981.0",
				appVersion: "26.707.91948",
			}),
			readStoreVersions: vi.fn().mockResolvedValue({
				installedVersion: "26.707.9981.0",
				latestVersion: "26.708.10000.0",
			}),
			now: () => 1_800_000_000_000,
		});

		expect(statuses).toEqual([
			{
				id: "codex-desktop",
				label: "Codex desktop app",
				surface: "desktop",
				appVersion: "26.707.91948",
				installedVersion: "26.707.9981.0",
				latestVersion: "26.708.10000.0",
				available: true,
				updateCommand:
					"winget upgrade --id 9PLM9XGG6VKS --source msstore --exact --silent --accept-source-agreements --accept-package-agreements --disable-interactivity",
				updateMode: "automatic",
				requiresElevation: false,
				checkedAt: 1_800_000_000_000,
			},
		]);
	});

	it("does not probe Store metadata away from the Windows host", async () => {
		const readInstalledVersions = vi.fn();
		expect(
			await inspectWindowsDesktopUpdates({
				isWindows: () => false,
				readInstalledVersions,
				readStoreVersions: vi.fn(),
				now: () => 1_800_000_000_000,
			}),
		).toEqual([]);
		expect(readInstalledVersions).not.toHaveBeenCalled();
	});

	it("reports a manifest update that winget cannot apply yet", async () => {
		const statuses = await inspectWindowsDesktopUpdates({
			isWindows: () => true,
			readInstalledVersions: vi.fn().mockResolvedValue({
				packageVersion: "26.707.12708.0",
				appVersion: "26.707.91948",
			}),
			readStoreVersions: vi.fn().mockResolvedValue({
				installedVersion: "26.707.12708.0",
				latestVersion: "26.715.2305.0",
				automaticUpdateAvailable: false,
			}),
			now: () => 1_800_000_000_000,
		});

		expect(statuses[0]).toMatchObject({
			available: true,
			latestVersion: "26.715.2305.0",
			updateInstructions: "Install the update from the Codex desktop app.",
		});
		expect(statuses[0].updateCommand).toBeUndefined();
	});

	it("reads the human-facing version from an Electron ASAR package", async () => {
		const { mkdtemp, rm, writeFile } = await import("node:fs/promises");
		const { tmpdir } = await import("node:os");
		const { join } = await import("node:path");
		const directory = await mkdtemp(join(tmpdir(), "hlid-asar-version-"));
		try {
			const packageBody = Buffer.from(
				JSON.stringify({
					name: "openai-codex-electron",
					version: "26.707.91948",
				}),
			);
			const headerJson = Buffer.from(
				JSON.stringify({
					files: {
						"package.json": { size: packageBody.length, offset: "0" },
					},
				}),
			);
			const padding = (4 - ((4 + headerJson.length) % 4)) % 4;
			const headerSize = 8 + headerJson.length + padding;
			const archive = Buffer.alloc(8 + headerSize + packageBody.length);
			archive.writeUInt32LE(4, 0);
			archive.writeUInt32LE(headerSize, 4);
			archive.writeUInt32LE(headerSize - 4, 8);
			archive.writeUInt32LE(headerJson.length, 12);
			headerJson.copy(archive, 16);
			packageBody.copy(archive, 8 + headerSize);
			const archivePath = join(directory, "app.asar");
			await writeFile(archivePath, archive);

			await expect(readElectronAsarPackageVersion(archivePath)).resolves.toBe(
				"26.707.91948",
			);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
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

describe("CLI update status cache", () => {
	it("strictly validates persisted cache data", () => {
		const status = cachedStatus();
		expect(
			parseCliUpdateStatusCache(
				JSON.stringify({
					schemaVersion: 4,
					checkedAt: 1_800_000_000_000,
					statuses: [status],
				}),
			),
		).toEqual({ checkedAt: 1_800_000_000_000, statuses: [status] });
		expect(parseCliUpdateStatusCache("not-json")).toBeNull();
		expect(
			parseCliUpdateStatusCache(
				JSON.stringify({
					schemaVersion: 4,
					checkedAt: 1_800_000_000_000,
					statuses: [{ ...status, installedVersion: { bad: true } }],
				}),
			),
		).toBeNull();
	});

	it("serves a fresh persisted snapshot without running discovery", async () => {
		const status = cachedStatus();
		const dependencies = statusDependencies({
			readCache: vi.fn().mockResolvedValue({
				checkedAt: 1_800_000_000_000,
				statuses: [status],
			}),
		});

		expect(await getCliUpdateStatuses(undefined, dependencies)).toEqual([
			status,
		]);
		expect(dependencies.inspectNative).not.toHaveBeenCalled();
		expect(dependencies.writeCache).not.toHaveBeenCalled();
	});

	it("refreshes an older desktop version in the background before the full cache expires", async () => {
		const now = 1_800_000_600_000;
		const staleDesktop = {
			...cachedStatus("codex-desktop"),
			installedVersion: "26.707.9981.0",
			checkedAt: now - 6 * 60_000,
		};
		const freshDesktop = {
			...staleDesktop,
			installedVersion: "26.707.12708.0",
			checkedAt: now,
		};
		const dependencies = statusDependencies({
			now: () => now,
			readCache: vi.fn().mockResolvedValue({
				checkedAt: now - 1_000,
				statuses: [staleDesktop],
			}),
			inspectDesktop: vi.fn().mockResolvedValue([freshDesktop]),
		});

		expect(
			await getCliUpdateStatuses(
				{ background: true, backgroundDelayMs: 0 },
				dependencies,
			),
		).toEqual([staleDesktop]);
		await vi.waitFor(() =>
			expect(dependencies.inspectDesktop).toHaveBeenCalledOnce(),
		);
		await vi.waitFor(() =>
			expect(dependencies.writeCache).toHaveBeenCalledWith({
				checkedAt: now,
				statuses: [freshDesktop],
			}),
		);
	});

	it("returns a stale snapshot immediately while refreshing in the background", async () => {
		const stale = cachedStatus();
		const fresh = cachedStatus("claude");
		let resolveNative!: (statuses: CliUpdateStatus[]) => void;
		const dependencies = statusDependencies({
			now: () => 1_900_000_000_000,
			readCache: vi.fn().mockResolvedValue({
				checkedAt: 1_800_000_000_000,
				statuses: [stale],
			}),
			inspectNative: vi.fn().mockReturnValue(
				new Promise((resolve) => {
					resolveNative = resolve;
				}),
			),
		});

		const result = await getCliUpdateStatuses(
			{ background: true, backgroundDelayMs: 0 },
			dependencies,
		);
		expect(result).toEqual([stale]);
		expect(dependencies.writeCache).not.toHaveBeenCalled();

		await vi.waitFor(() =>
			expect(dependencies.inspectNative).toHaveBeenCalled(),
		);
		resolveNative([fresh]);
		await vi.waitFor(() =>
			expect(dependencies.writeCache).toHaveBeenCalledWith({
				checkedAt: 1_900_000_000_000,
				statuses: [fresh],
			}),
		);
	});

	it("coalesces forced discovery and awaits the shared result", async () => {
		const fresh = cachedStatus();
		let resolveNative!: (statuses: CliUpdateStatus[]) => void;
		const inspectNative = vi.fn().mockReturnValue(
			new Promise((resolve) => {
				resolveNative = resolve;
			}),
		);
		const dependencies = statusDependencies({ inspectNative });

		const first = getCliUpdateStatuses({ force: true }, dependencies);
		const second = getCliUpdateStatuses({ force: true }, dependencies);
		await vi.waitFor(() => expect(inspectNative).toHaveBeenCalledOnce());
		resolveNative([fresh]);

		expect(await first).toEqual([fresh]);
		expect(await second).toEqual([fresh]);
		expect(inspectNative).toHaveBeenCalledOnce();
	});
});
