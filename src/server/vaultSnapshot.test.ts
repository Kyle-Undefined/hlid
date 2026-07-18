import { beforeAll, describe, expect, it, vi } from "vitest";
import { type HlidConfig, HlidConfigSchema } from "../config";

const mocks = vi.hoisted(() => ({
	config: null as HlidConfig | null,
	projectVersion: 1,
	readdirSync: vi.fn(() => ["one.md", "notes.txt", "two.md"]),
	scanProjects: vi.fn((_: string, folder: string) => [
		{
			file: `${folder}-${mocks.projectVersion}.md`,
			title: folder,
			status: "active",
			rawStatus: "Active",
			tags: [],
			isFolder: false,
		},
	]),
	scanSkills: vi.fn((root: string) => ({
		skills: [
			{
				file: root.includes(".claude") ? "claude.md" : "vault.md",
				name: root.includes(".claude") ? "Claude" : "Vault",
				description: "skill",
				content: "",
				filePath: `${root}/skill.md`,
			},
		],
		sectionOrder: root.includes(".claude") ? [] : ["core"],
	})),
	scanMemory: vi.fn((_: string, folder: string) => [
		{ path: `${folder}.md`, name: folder, content: "" },
	]),
	scanFolderGroups: vi.fn(() => []),
	watchCallbacks: [] as (() => void)[],
	watch: vi.fn((_: string, __: unknown, callback: () => void) => {
		mocks.watchCallbacks.push(callback);
		return { close: vi.fn(), on: vi.fn() };
	}),
}));

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return {
		...actual,
		readdirSync: mocks.readdirSync,
		watch: mocks.watch,
	};
});

vi.mock("../lib/vault", () => ({
	scanProjects: mocks.scanProjects,
	scanSkills: mocks.scanSkills,
	scanMemory: mocks.scanMemory,
	scanFolderGroups: mocks.scanFolderGroups,
}));

vi.mock("./config", () => ({
	loadConfig: () => mocks.config,
}));

import { bumpDataRevision, getDataRevisions } from "./dataRevision";
import { getVaultSnapshot, invalidateVaultSnapshot } from "./vaultSnapshot";

beforeAll(() => {
	mocks.config = HlidConfigSchema.parse({
		vault: {
			path: "/vault",
			style: "para",
			inbox: "Inbox",
			projects: "Projects",
			areas: "Areas",
			resources: "Resources",
			archive: "Archive",
			raw: "Raw",
			wiki_folder: "Wiki",
			skills: "Skills",
			memory: "Memory",
			outputs: "Outputs",
		},
	});
});

describe("vault snapshot", () => {
	it("single-flights one shared Vault/Cockpit scan and reuses it", async () => {
		const [first, concurrent] = await Promise.all([
			getVaultSnapshot(),
			getVaultSnapshot(),
		]);

		expect(concurrent).toBe(first);
		expect(mocks.scanProjects).toHaveBeenCalledTimes(3);
		expect(mocks.scanSkills).toHaveBeenCalledTimes(2);
		expect(mocks.scanMemory).toHaveBeenCalledTimes(4);
		expect(mocks.scanFolderGroups).toHaveBeenCalledTimes(2);
		expect(first.vault.projects[0]?.file).toBe("Projects-1.md");
		expect(first.cockpit).toMatchObject({
			inboxCount: 2,
			activeCount: 1,
			totalCount: 1,
			sectionOrder: ["core", "claude"],
		});
		expect(first.cockpit.skills.map((skill) => skill.name)).toEqual([
			"Vault",
			"Claude",
		]);

		const cached = await getVaultSnapshot();
		expect(cached).toBe(first);
		expect(mocks.scanProjects).toHaveBeenCalledTimes(3);
	});

	it("coalesces invalidation and bumps the vault revision after data changes", async () => {
		vi.useFakeTimers();
		try {
			const beforeRevision = getDataRevisions().vault;
			mocks.projectVersion = 2;
			invalidateVaultSnapshot("test");
			invalidateVaultSnapshot("test");
			await vi.advanceTimersByTimeAsync(201);
			await Promise.resolve();

			const refreshed = await getVaultSnapshot();
			expect(refreshed.vault.projects[0]?.file).toBe("Projects-2.md");
			expect(refreshed.revision).toBe(2);
			expect(getDataRevisions().vault).toBe(beforeRevision + 1);
			expect(mocks.scanProjects).toHaveBeenCalledTimes(6);
		} finally {
			vi.useRealTimers();
		}
	});

	it("does not publish or replace snapshot data after an unchanged refresh", async () => {
		vi.useFakeTimers();
		try {
			const before = await getVaultSnapshot();
			const beforeDataRevision = getDataRevisions().vault;
			const scanCalls = mocks.scanProjects.mock.calls.length;
			invalidateVaultSnapshot("unchanged-test");
			await vi.advanceTimersByTimeAsync(201);
			await Promise.resolve();

			const refreshed = await getVaultSnapshot();
			expect(refreshed.revision).toBe(before.revision);
			expect(refreshed.vault).toBe(before.vault);
			expect(getDataRevisions().vault).toBe(beforeDataRevision);
			expect(mocks.scanProjects).toHaveBeenCalledTimes(scanCalls + 3);
		} finally {
			vi.useRealTimers();
		}
	});

	it("uses filesystem watchers to refresh while clients are idle", async () => {
		vi.useFakeTimers();
		try {
			expect(mocks.watchCallbacks.length).toBeGreaterThan(0);
			mocks.projectVersion = 3;
			mocks.watchCallbacks[0]?.();
			await vi.advanceTimersByTimeAsync(201);
			await Promise.resolve();

			const refreshed = await getVaultSnapshot();
			expect(refreshed.vault.projects[0]?.file).toBe("Projects-3.md");
			expect(refreshed.revision).toBe(3);
		} finally {
			vi.useRealTimers();
		}
	});

	it("invalidates immediately when the server config revision changes", async () => {
		vi.useFakeTimers();
		try {
			const beforeVaultRevision = getDataRevisions().vault;
			mocks.config = HlidConfigSchema.parse({
				...mocks.config,
				vault: { ...mocks.config?.vault, style: "wiki" },
			});
			bumpDataRevision("config");
			await vi.advanceTimersByTimeAsync(201);
			await Promise.resolve();

			const refreshed = await getVaultSnapshot();
			expect(refreshed.vault.tabConfig.map((tab) => tab.id)).toEqual([
				"raw",
				"wiki_folder",
				"outputs",
				"skills",
				"memory",
			]);
			expect(getDataRevisions().vault).toBe(beforeVaultRevision + 1);
		} finally {
			vi.useRealTimers();
		}
	});

	it("keeps the last-good snapshot when a background scan fails", async () => {
		vi.useFakeTimers();
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			const before = await getVaultSnapshot();
			const scanCalls = mocks.scanProjects.mock.calls.length;
			mocks.scanProjects.mockImplementationOnce(() => {
				throw new Error("mounted vault unavailable");
			});
			invalidateVaultSnapshot("test-failure");
			await vi.advanceTimersByTimeAsync(201);
			await Promise.resolve();

			const recovered = await getVaultSnapshot();
			expect(recovered).toBe(before);
			expect(mocks.scanProjects).toHaveBeenCalledTimes(scanCalls + 1);
			expect(warn).toHaveBeenCalledWith(
				"[vaultSnapshot] refresh failed: Error: mounted vault unavailable",
			);
		} finally {
			warn.mockRestore();
			vi.useRealTimers();
		}
	});
});
