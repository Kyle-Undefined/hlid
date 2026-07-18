import { beforeEach, describe, expect, it, vi } from "vitest";
import { handleGetMemory } from "./memory";
import { handleGetSkills } from "./skills";

vi.mock("#/server/config", () => ({ loadConfig: vi.fn() }));
vi.mock("#/lib/originGate", () => ({ forbiddenResponse: vi.fn(() => null) }));
vi.mock("#/server/vaultSnapshot", () => ({ getVaultSnapshot: vi.fn() }));

const { loadConfig } = await import("#/server/config");
const { forbiddenResponse } = await import("#/lib/originGate");
const { getVaultSnapshot } = await import("#/server/vaultSnapshot");

const mockLoadConfig = vi.mocked(loadConfig);
const mockForbiddenResponse = vi.mocked(forbiddenResponse);
const mockGetVaultSnapshot = vi.mocked(getVaultSnapshot);

function withVault(extras: Record<string, unknown> = {}) {
	mockLoadConfig.mockReturnValue({
		vault: {
			path: "/vault",
			skills: "skills",
			memory: "memory",
			...extras,
		},
		status_vocabulary: { active: [], planning: [], done: [] },
		ui: { hide_skills_index: false },
	} as never);
}

function noVault() {
	mockLoadConfig.mockReturnValue({ vault: {} } as never);
}

function getReq(path: string, params?: Record<string, string>): Request {
	const url = new URL(`http://localhost${path}`);
	if (params) {
		for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
	}
	return new Request(url, { method: "GET" });
}

beforeEach(() => {
	vi.resetAllMocks();
	mockForbiddenResponse.mockReturnValue(null);
});

// ─── /api/vault/skills ───────────────────────────────────────────────────────

describe("handleGetSkills", () => {
	it("returns 400 when no vault configured", async () => {
		noVault();
		const res = await handleGetSkills(getReq("/api/vault/skills"));
		expect(res.status).toBe(400);
	});

	it("returns skills and section order from the shared snapshot", async () => {
		withVault();
		mockGetVaultSnapshot.mockResolvedValue({
			vault: { skills: [], sectionOrder: ["A", "B"] },
		} as never);
		const res = await handleGetSkills(getReq("/api/vault/skills"));
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ skills: [], sectionOrder: ["A", "B"] });
		expect(mockGetVaultSnapshot).toHaveBeenCalledOnce();
	});
});

// ─── /api/vault/memory ───────────────────────────────────────────────────────

describe("handleGetMemory", () => {
	it("returns 400 when no vault configured", async () => {
		noVault();
		const res = await handleGetMemory(getReq("/api/vault/memory"));
		expect(res.status).toBe(400);
	});

	it("uses the shared snapshot", async () => {
		withVault();
		mockGetVaultSnapshot.mockResolvedValue({ vault: { memory: [] } } as never);
		await handleGetMemory(getReq("/api/vault/memory"));
		expect(mockGetVaultSnapshot).toHaveBeenCalledOnce();
	});

	it("returns memory files", async () => {
		withVault();
		const files = [{ path: "/vault/memory/note.md", name: "note" }];
		mockGetVaultSnapshot.mockResolvedValue({
			vault: { memory: files },
		} as never);
		const res = await handleGetMemory(getReq("/api/vault/memory"));
		expect(await res.json()).toEqual(files);
	});
});
