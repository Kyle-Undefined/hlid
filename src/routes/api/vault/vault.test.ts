import { beforeEach, describe, expect, it, vi } from "vitest";
import { handleGetMemory } from "./memory";
import { handleGetSkills } from "./skills";

vi.mock("#/server/config", () => ({ loadConfig: vi.fn() }));
vi.mock("#/lib/originGate", () => ({ forbiddenResponse: vi.fn(() => null) }));
vi.mock("#/lib/vault", () => ({
	scanSkills: vi.fn(),
	scanMemory: vi.fn(),
}));

const { loadConfig } = await import("#/server/config");
const { forbiddenResponse } = await import("#/lib/originGate");
const { scanSkills, scanMemory } = await import("#/lib/vault");

const mockLoadConfig = vi.mocked(loadConfig);
const mockForbiddenResponse = vi.mocked(forbiddenResponse);
const mockScanSkills = vi.mocked(scanSkills);
const mockScanMemory = vi.mocked(scanMemory);

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

	it("delegates to scanSkills and returns skills + sectionOrder", async () => {
		withVault();
		mockScanSkills.mockReturnValue({ skills: [], sectionOrder: ["A", "B"] });
		const res = await handleGetSkills(getReq("/api/vault/skills"));
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ skills: [], sectionOrder: ["A", "B"] });
		expect(mockScanSkills).toHaveBeenCalledWith("/vault", "skills", false);
	});
});

// ─── /api/vault/memory ───────────────────────────────────────────────────────

describe("handleGetMemory", () => {
	it("returns 400 when no vault configured", async () => {
		noVault();
		const res = await handleGetMemory(getReq("/api/vault/memory"));
		expect(res.status).toBe(400);
	});

	it("delegates to scanMemory with correct args", async () => {
		withVault();
		mockScanMemory.mockReturnValue([]);
		await handleGetMemory(getReq("/api/vault/memory"));
		expect(mockScanMemory).toHaveBeenCalledWith("/vault", "memory");
	});

	it("returns memory files", async () => {
		withVault();
		const files = [{ path: "/vault/memory/note.md", name: "note" }];
		mockScanMemory.mockReturnValue(files as never);
		const res = await handleGetMemory(getReq("/api/vault/memory"));
		expect(await res.json()).toEqual(files);
	});
});
