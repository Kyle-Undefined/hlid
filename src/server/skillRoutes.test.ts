import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HlidConfig } from "../config";

const mocks = vi.hoisted(() => ({
	discoverSkillPackages: vi.fn(),
	importDiscoveredSkillPackages: vi.fn(),
	readDiscoveredSkillDocument: vi.fn(),
	removeManagedSkill: vi.fn(),
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
