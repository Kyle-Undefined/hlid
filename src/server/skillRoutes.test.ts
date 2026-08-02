import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HlidConfig } from "../config";

const mocks = vi.hoisted(() => ({
	discoverSkillPackages: vi.fn(),
	importDiscoveredSkillPackages: vi.fn(),
	readDiscoveredSkillDocument: vi.fn(),
	removeManagedSkill: vi.fn(),
	listManagedSkills: vi.fn(),
	discoverRemoteSkills: vi.fn(),
	readManagedSkillDocument: vi.fn(),
	readStagedSkillFile: vi.fn(),
	stageGitHubSkill: vi.fn(),
	installStagedSkill: vi.fn(),
	discardStagedSkill: vi.fn(),
	loadConfig: vi.fn(),
	invalidateVaultSnapshot: vi.fn(),
	getVaultSnapshot: vi.fn(),
	refreshVaultSnapshotWithStatus: vi.fn(),
}));

vi.mock("./skillImports", () => ({
	discoverSkillPackages: mocks.discoverSkillPackages,
	importDiscoveredSkillPackages: mocks.importDiscoveredSkillPackages,
	readDiscoveredSkillDocument: mocks.readDiscoveredSkillDocument,
	removeManagedSkill: mocks.removeManagedSkill,
}));
vi.mock("./skillInstalls", () => ({
	listManagedSkills: mocks.listManagedSkills,
	discoverRemoteSkills: mocks.discoverRemoteSkills,
	readManagedSkillDocument: mocks.readManagedSkillDocument,
	readStagedSkillFile: mocks.readStagedSkillFile,
	stageGitHubSkill: mocks.stageGitHubSkill,
	installStagedSkill: mocks.installStagedSkill,
	discardStagedSkill: mocks.discardStagedSkill,
}));
vi.mock("./config", () => ({ loadConfig: mocks.loadConfig }));
vi.mock("./vaultSnapshot", () => ({
	invalidateVaultSnapshot: mocks.invalidateVaultSnapshot,
	getVaultSnapshot: mocks.getVaultSnapshot,
	refreshVaultSnapshotWithStatus: mocks.refreshVaultSnapshotWithStatus,
}));

import { handleSkillRoute } from "./skillRoutes";

const config = {
	vault: { path: "", name: "Test" },
	agents: [],
} as unknown as HlidConfig;

function request(path: string, body?: unknown, method = "POST") {
	return new Request(`http://localhost${path}`, {
		method,
		headers: { "content-type": "application/json" },
		...(body !== undefined ? { body: JSON.stringify(body) } : {}),
	});
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.loadConfig.mockReturnValue(config);
	mocks.discoverSkillPackages.mockResolvedValue([{ id: "a".repeat(24) }]);
	mocks.importDiscoveredSkillPackages.mockResolvedValue({
		imported: [{ id: "a".repeat(24), name: "review", source: "codex" }],
		failed: [],
	});
	mocks.readDiscoveredSkillDocument.mockResolvedValue({
		id: "a".repeat(24),
		name: "review",
		content: "# Review\n",
	});
	mocks.removeManagedSkill.mockResolvedValue({
		id: "c".repeat(24),
		name: "review",
	});
	mocks.listManagedSkills.mockResolvedValue([
		{ id: "c".repeat(24), name: "review" },
	]);
	mocks.discoverRemoteSkills.mockResolvedValue({
		repository: "openai/skills",
		requestedRef: "main",
		resolvedSha: "e".repeat(40),
		skills: [{ name: "review" }],
	});
	mocks.readManagedSkillDocument.mockResolvedValue({
		id: "c".repeat(24),
		name: "review",
		content: "# Managed review\n",
	});
	mocks.readStagedSkillFile.mockResolvedValue({
		path: "helper.md",
		content: "# Helper\n",
	});
	mocks.stageGitHubSkill.mockResolvedValue({
		id: "d".repeat(24),
		name: "review",
	});
	mocks.installStagedSkill.mockResolvedValue({
		id: "d".repeat(24),
		name: "review",
	});
	mocks.discardStagedSkill.mockResolvedValue(true);
	mocks.getVaultSnapshot.mockResolvedValue({});
	mocks.refreshVaultSnapshotWithStatus.mockResolvedValue({
		status: "refreshed",
		snapshot: {},
	});
});

describe("handleSkillRoute", () => {
	it("returns the provider-discovered catalog", async () => {
		const response = await handleSkillRoute(
			new URL("http://localhost/skills/catalog"),
			request("/skills/catalog", undefined, "GET"),
			config,
		);
		expect(response?.status).toBe(200);
		expect(await response?.json()).toEqual({
			skills: [{ id: "a".repeat(24) }],
		});
		expect(mocks.discoverSkillPackages).toHaveBeenCalledWith(
			config,
			expect.any(Map),
		);
	});

	it("reloads live Claude skills and returns the rescanned import catalog", async () => {
		const refreshProviderSkills = vi.fn().mockResolvedValue({
			providerId: "claude",
			status: "reloaded",
			matchingSessions: 1,
			reloadedSessions: 1,
			deferredSessions: 0,
			failedSessions: 0,
			skillCount: 3,
			reason:
				"Claude refreshed 1 session and found 3 native skills. Hlid rescanned installed skills for review and import.",
		});
		const response = await handleSkillRoute(
			new URL("http://localhost/skills/refresh"),
			request("/skills/refresh"),
			config,
			new Map(),
			{ refreshProviderSkills },
		);

		expect(response?.status).toBe(200);
		expect(refreshProviderSkills).toHaveBeenCalledOnce();
		expect(mocks.refreshVaultSnapshotWithStatus).toHaveBeenCalledWith(
			"provider-skill-refresh",
			config,
		);
		expect(await response?.json()).toMatchObject({
			ok: true,
			providerRefresh: {
				status: "reloaded",
				reloadedSessions: 1,
				skillCount: 3,
			},
			skills: [{ id: "a".repeat(24) }],
		});
	});

	it("keeps disk discovery available when no live Claude Query exists", async () => {
		const response = await handleSkillRoute(
			new URL("http://localhost/skills/refresh"),
			request("/skills/refresh"),
			config,
		);

		expect(response?.status).toBe(200);
		expect(await response?.json()).toMatchObject({
			ok: true,
			providerRefresh: { status: "not-live", reloadedSessions: 0 },
			skills: [{ id: "a".repeat(24) }],
		});
		const methodResponse = await handleSkillRoute(
			new URL("http://localhost/skills/refresh"),
			request("/skills/refresh", undefined, "GET"),
			config,
		);
		expect(methodResponse?.status).toBe(405);
	});

	it("uses the startup config when the live config cannot be loaded", async () => {
		const startupConfig = {
			...config,
			vault: { path: "/startup-vault", name: "Startup" },
		} as HlidConfig;
		mocks.loadConfig.mockImplementationOnce(() => {
			throw new Error("config unavailable");
		});

		await handleSkillRoute(
			new URL("http://localhost/skills/catalog"),
			request("/skills/catalog", undefined, "GET"),
			startupConfig,
		);

		expect(mocks.discoverSkillPackages).toHaveBeenCalledWith(
			startupConfig,
			expect.any(Map),
		);
	});

	it("imports selected discovery IDs and invalidates the shared skill snapshot", async () => {
		const id = "a".repeat(24);
		const response = await handleSkillRoute(
			new URL("http://localhost/skills/import"),
			request("/skills/import", { ids: [id, id] }),
			config,
		);
		expect(response?.status).toBe(200);
		expect(mocks.importDiscoveredSkillPackages).toHaveBeenCalledWith({
			ids: [id],
			config,
			providers: expect.any(Map),
		});
		expect(mocks.invalidateVaultSnapshot).toHaveBeenCalledWith(
			"skill-import",
			config,
		);
		expect(mocks.getVaultSnapshot).toHaveBeenCalledWith({ refresh: true });
		expect(
			mocks.invalidateVaultSnapshot.mock.invocationCallOrder[0],
		).toBeLessThan(mocks.getVaultSnapshot.mock.invocationCallOrder[0]);
	});

	it("lists managed skills separately from provider imports", async () => {
		const managed = await handleSkillRoute(
			new URL("http://localhost/skills/managed"),
			request("/skills/managed", undefined, "GET"),
			config,
		);
		expect(await managed?.json()).toEqual({
			skills: [{ id: "c".repeat(24), name: "review" }],
		});
	});

	it("reads managed and staged content through their exact routes", async () => {
		const managedId = "c".repeat(24);
		const stagedId = "d".repeat(24);
		const managed = await handleSkillRoute(
			new URL(`http://localhost/skills/managed/content?id=${managedId}`),
			request(`/skills/managed/content?id=${managedId}`, undefined, "GET"),
			config,
		);
		const staged = await handleSkillRoute(
			new URL(
				`http://localhost/skills/staged/content?id=${stagedId}&path=helper.md`,
			),
			request(
				`/skills/staged/content?id=${stagedId}&path=helper.md`,
				undefined,
				"GET",
			),
			config,
		);

		expect(await managed?.json()).toMatchObject({
			id: managedId,
			content: "# Managed review\n",
		});
		expect(await staged?.json()).toEqual({
			path: "helper.md",
			content: "# Helper\n",
		});
		expect(mocks.readManagedSkillDocument).toHaveBeenCalledWith(managedId);
		expect(mocks.readStagedSkillFile).toHaveBeenCalledWith(
			stagedId,
			"helper.md",
		);
	});

	it("maps staged content read failures without changing the active snapshot", async () => {
		const id = "d".repeat(24);
		mocks.readStagedSkillFile.mockRejectedValueOnce(
			new Error("staged file unavailable"),
		);
		const response = await handleSkillRoute(
			new URL(`http://localhost/skills/staged/content?id=${id}&path=helper.md`),
			request(
				`/skills/staged/content?id=${id}&path=helper.md`,
				undefined,
				"GET",
			),
			config,
		);

		expect(response?.status).toBe(400);
		expect(await response?.json()).toEqual({
			error: "staged_skill_read_failed",
			message: "staged file unavailable",
		});
		expect(mocks.invalidateVaultSnapshot).not.toHaveBeenCalled();
	});

	it("discovers remote repository skills without staging them", async () => {
		const response = await handleSkillRoute(
			new URL("http://localhost/skills/discover"),
			request("/skills/discover", { source: "openai/skills" }),
			config,
		);
		expect(await response?.json()).toEqual({
			ok: true,
			discovery: {
				repository: "openai/skills",
				requestedRef: "main",
				resolvedSha: "e".repeat(40),
				skills: [{ name: "review" }],
			},
		});
		expect(mocks.discoverRemoteSkills).toHaveBeenCalledWith("openai/skills");
		expect(mocks.stageGitHubSkill).not.toHaveBeenCalled();
	});

	it("stages a GitHub skill without refreshing the active snapshot", async () => {
		const sourceUrl =
			"https://github.com/openai/skills/tree/main/skills/review";
		const response = await handleSkillRoute(
			new URL("http://localhost/skills/stage"),
			request("/skills/stage", { sourceUrl }),
			config,
		);
		expect(await response?.json()).toEqual({
			ok: true,
			skill: { id: "d".repeat(24), name: "review" },
		});
		expect(mocks.stageGitHubSkill).toHaveBeenCalledWith(sourceUrl);
		expect(mocks.invalidateVaultSnapshot).not.toHaveBeenCalled();
	});

	it("installs an approved stage and refreshes the shared skill snapshot", async () => {
		const id = "d".repeat(24);
		const response = await handleSkillRoute(
			new URL("http://localhost/skills/install"),
			request("/skills/install", { id }),
			config,
		);
		expect(await response?.json()).toEqual({
			ok: true,
			installed: { id, name: "review" },
		});
		expect(mocks.refreshVaultSnapshotWithStatus).toHaveBeenCalledWith(
			"skill-install",
			config,
		);
		expect(mocks.getVaultSnapshot).not.toHaveBeenCalled();
	});

	it("reports a committed install with a warning when snapshot refresh fails", async () => {
		const id = "d".repeat(24);
		mocks.refreshVaultSnapshotWithStatus.mockResolvedValueOnce({
			status: "degraded",
			snapshot: {},
			error: "snapshot refresh failed",
			retryAt: Date.now() + 30_000,
		});
		const response = await handleSkillRoute(
			new URL("http://localhost/skills/install"),
			request("/skills/install", { id }),
			config,
		);

		expect(response?.status).toBe(200);
		expect(await response?.json()).toEqual({
			ok: true,
			installed: { id, name: "review" },
			warning: {
				code: "skill_snapshot_refresh_failed",
				message: "snapshot refresh failed",
			},
		});
		expect(mocks.refreshVaultSnapshotWithStatus).toHaveBeenCalledWith(
			"skill-install",
			config,
		);
		expect(mocks.getVaultSnapshot).not.toHaveBeenCalled();
	});

	it("keeps a committed install successful when refresh status throws", async () => {
		const id = "d".repeat(24);
		mocks.refreshVaultSnapshotWithStatus.mockRejectedValueOnce(
			new Error("refresh status unavailable"),
		);

		const response = await handleSkillRoute(
			new URL("http://localhost/skills/install"),
			request("/skills/install", { id }),
			config,
		);

		expect(response?.status).toBe(200);
		expect(await response?.json()).toEqual({
			ok: true,
			installed: { id, name: "review" },
			warning: {
				code: "skill_snapshot_refresh_failed",
				message: "refresh status unavailable",
			},
		});
	});

	it("discards a declined stage without refreshing the snapshot", async () => {
		const id = "d".repeat(24);
		const response = await handleSkillRoute(
			new URL("http://localhost/skills/discard"),
			request("/skills/discard", { id }),
			config,
		);
		expect(await response?.json()).toEqual({ ok: true });
		expect(mocks.discardStagedSkill).toHaveBeenCalledWith(id);
		expect(mocks.invalidateVaultSnapshot).not.toHaveBeenCalled();
	});

	it("removes a managed skill and refreshes the picker snapshot", async () => {
		const id = "c".repeat(24);
		const response = await handleSkillRoute(
			new URL("http://localhost/skills/remove"),
			request("/skills/remove", { id }),
			config,
		);
		expect(response?.status).toBe(200);
		expect(await response?.json()).toEqual({
			ok: true,
			removed: { id, name: "review" },
		});
		expect(mocks.removeManagedSkill).toHaveBeenCalledWith(id);
		expect(mocks.invalidateVaultSnapshot).toHaveBeenCalledWith(
			"skill-remove",
			config,
		);
		expect(mocks.getVaultSnapshot).toHaveBeenCalledWith({ refresh: true });
	});

	it("does not refresh when the managed skill has already disappeared", async () => {
		const id = "c".repeat(24);
		mocks.removeManagedSkill.mockResolvedValueOnce(null);
		const response = await handleSkillRoute(
			new URL("http://localhost/skills/remove"),
			request("/skills/remove", { id }),
			config,
		);

		expect(response?.status).toBe(404);
		expect(await response?.json()).toEqual({
			error: "managed_skill_not_found",
		});
		expect(mocks.invalidateVaultSnapshot).not.toHaveBeenCalled();
		expect(mocks.getVaultSnapshot).not.toHaveBeenCalled();
	});

	it("returns SKILL.md content by opaque discovery ID", async () => {
		const id = "a".repeat(24);
		const response = await handleSkillRoute(
			new URL(`http://localhost/skills/content?id=${id}`),
			request(`/skills/content?id=${id}`, undefined, "GET"),
			config,
		);
		expect(response?.status).toBe(200);
		expect(await response?.json()).toEqual({
			id,
			name: "review",
			content: "# Review\n",
		});
		expect(mocks.readDiscoveredSkillDocument).toHaveBeenCalledWith({
			id,
			config,
			providers: expect.any(Map),
		});
	});

	it("rejects malformed skill preview IDs", async () => {
		const response = await handleSkillRoute(
			new URL("http://localhost/skills/content?id=bad"),
			request("/skills/content?id=bad", undefined, "GET"),
			config,
		);
		expect(response?.status).toBe(400);
		expect(mocks.readDiscoveredSkillDocument).not.toHaveBeenCalled();
	});

	it("rejects malformed or oversized selections", async () => {
		const response = await handleSkillRoute(
			new URL("http://localhost/skills/import"),
			request("/skills/import", { ids: ["not-an-id"] }),
			config,
		);
		expect(response?.status).toBe(400);
		expect(mocks.importDiscoveredSkillPackages).not.toHaveBeenCalled();
	});

	it.each([
		"/skills/import",
		"/skills/remove",
		"/skills/discover",
		"/skills/stage",
		"/skills/install",
		"/skills/discard",
	])("shares method and JSON validation for %s", async (path) => {
		const methodResponse = await handleSkillRoute(
			new URL(`http://localhost${path}`),
			request(path, undefined, "GET"),
			config,
		);
		expect(methodResponse?.status).toBe(405);

		const jsonResponse = await handleSkillRoute(
			new URL(`http://localhost${path}`),
			new Request(`http://localhost${path}`, {
				method: "POST",
				body: "not-json",
			}),
			config,
		);
		expect(jsonResponse?.status).toBe(400);
		expect(await jsonResponse?.json()).toEqual({ error: "invalid_json" });
	});

	it("does not invalidate the snapshot when every selection fails", async () => {
		mocks.importDiscoveredSkillPackages.mockResolvedValueOnce({
			imported: [],
			failed: [{ id: "a".repeat(24), name: "review", message: "exists" }],
		});
		const response = await handleSkillRoute(
			new URL("http://localhost/skills/import"),
			request("/skills/import", { ids: ["a".repeat(24)] }),
			config,
		);
		expect(response?.status).toBe(200);
		expect(await response?.json()).toMatchObject({ ok: false });
		expect(mocks.invalidateVaultSnapshot).not.toHaveBeenCalled();
	});

	it("falls through for unrelated paths", async () => {
		expect(
			await handleSkillRoute(
				new URL("http://localhost/other"),
				request("/other", undefined, "GET"),
				config,
			),
		).toBeNull();
	});
});
