import { beforeEach, describe, expect, it, vi } from "vitest";
import { handleGetFolderGroups } from "./folder-groups";
import { handleGetMemory } from "./memory";
import { handleGetProjects } from "./projects";
import { handleGetSkills } from "./skills";

vi.mock("#/server/config", () => ({ loadConfig: vi.fn() }));
vi.mock("#/lib/originGate", () => ({ forbiddenResponse: vi.fn(() => null) }));
vi.mock("#/lib/vault", () => ({
	scanProjects: vi.fn(),
	scanSkills: vi.fn(),
	scanMemory: vi.fn(),
	scanFolderGroups: vi.fn(),
}));

const { loadConfig } = await import("#/server/config");
const { forbiddenResponse } = await import("#/lib/originGate");
const { scanProjects, scanSkills, scanMemory, scanFolderGroups } = await import(
	"#/lib/vault"
);

const mockLoadConfig = vi.mocked(loadConfig);
const mockForbiddenResponse = vi.mocked(forbiddenResponse);
const mockScanProjects = vi.mocked(scanProjects);
const mockScanSkills = vi.mocked(scanSkills);
const mockScanMemory = vi.mocked(scanMemory);
const mockScanFolderGroups = vi.mocked(scanFolderGroups);

function withVault(extras: Record<string, unknown> = {}) {
	mockLoadConfig.mockReturnValue({
		vault: {
			path: "/vault",
			projects: "projects",
			skills: "skills",
			memory: "memory",
			areas: "areas",
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

// ─── /api/vault/projects ─────────────────────────────────────────────────────

describe("handleGetProjects", () => {
	it("returns 400 when no vault configured", async () => {
		noVault();
		const res = await handleGetProjects(getReq("/api/vault/projects"));
		expect(res.status).toBe(400);
	});

	it("delegates to scanProjects with correct args", async () => {
		withVault();
		const projects = [{ name: "Proj A" }];
		mockScanProjects.mockReturnValue(projects as never);
		const res = await handleGetProjects(getReq("/api/vault/projects"));
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual(projects);
		expect(mockScanProjects).toHaveBeenCalledWith(
			"/vault",
			"projects",
			expect.any(Object),
		);
	});

	it("returns 403 when origin blocked", async () => {
		mockForbiddenResponse.mockReturnValue(new Response("x", { status: 403 }));
		const res = await handleGetProjects(getReq("/api/vault/projects"));
		expect(res.status).toBe(403);
	});
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

	it("uses vault.memory folder by default", async () => {
		withVault();
		mockScanMemory.mockReturnValue([]);
		await handleGetMemory(getReq("/api/vault/memory"));
		expect(mockScanMemory).toHaveBeenCalledWith("/vault", "memory");
	});

	it("uses custom folder param when provided", async () => {
		withVault();
		mockScanMemory.mockReturnValue([]);
		await handleGetMemory(getReq("/api/vault/memory", { folder: "inbox" }));
		expect(mockScanMemory).toHaveBeenCalledWith("/vault", "inbox");
	});

	it("returns memory files", async () => {
		withVault();
		const files = [{ path: "/vault/memory/note.md", name: "note" }];
		mockScanMemory.mockReturnValue(files as never);
		const res = await handleGetMemory(getReq("/api/vault/memory"));
		expect(await res.json()).toEqual(files);
	});
});

// ─── /api/vault/folder-groups ────────────────────────────────────────────────

describe("handleGetFolderGroups", () => {
	it("returns 400 when no vault configured", async () => {
		noVault();
		const res = await handleGetFolderGroups(getReq("/api/vault/folder-groups"));
		expect(res.status).toBe(400);
	});

	it("uses vault.areas folder by default", async () => {
		withVault();
		mockScanFolderGroups.mockReturnValue([]);
		await handleGetFolderGroups(getReq("/api/vault/folder-groups"));
		expect(mockScanFolderGroups).toHaveBeenCalledWith("/vault", "areas");
	});

	it("uses custom folder param when provided", async () => {
		withVault();
		mockScanFolderGroups.mockReturnValue([]);
		await handleGetFolderGroups(
			getReq("/api/vault/folder-groups", { folder: "resources" }),
		);
		expect(mockScanFolderGroups).toHaveBeenCalledWith("/vault", "resources");
	});

	it("returns folder groups", async () => {
		withVault();
		const groups = [{ name: "Work", folders: [] }];
		mockScanFolderGroups.mockReturnValue(groups as never);
		const res = await handleGetFolderGroups(getReq("/api/vault/folder-groups"));
		expect(await res.json()).toEqual(groups);
	});
});
