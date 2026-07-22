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

	it("imports selected discovery IDs and invalidates the shared skill snapshot", async () => {
		const id = "a".repeat(24);
		const response = await handleSkillRoute(
			new URL("http://localhost/skills/import"),
			request("/skills/import", { ids: [id] }),
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
		expect(mocks.invalidateVaultSnapshot).toHaveBeenCalledWith(
			"skill-install",
			config,
		);
		expect(mocks.getVaultSnapshot).toHaveBeenCalledWith({ refresh: true });
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
