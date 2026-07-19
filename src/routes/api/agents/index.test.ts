import { beforeEach, describe, expect, it, vi } from "vitest";
import { handleGetAgents, handlePostAgents } from "./index";

vi.mock("#/server/config", () => ({ loadConfig: vi.fn() }));
vi.mock("#/lib/originGate", () => ({ forbiddenResponse: vi.fn(() => null) }));
vi.mock("#/lib/config-writer", () => ({ writeConfig: vi.fn() }));
vi.mock("node:fs", () => ({ existsSync: vi.fn(() => false) }));

const { loadConfig } = await import("#/server/config");
const { forbiddenResponse } = await import("#/lib/originGate");
const { writeConfig } = await import("#/lib/config-writer");
const { existsSync } = await import("node:fs");

const mockLoadConfig = vi.mocked(loadConfig);
const mockForbiddenResponse = vi.mocked(forbiddenResponse);
const mockWriteConfig = vi.mocked(writeConfig);
const mockExistsSync = vi.mocked(existsSync);

function getReq(): Request {
	return new Request("http://localhost/api/agents", { method: "GET" });
}

function postReq(body: unknown): Request {
	return new Request("http://localhost/api/agents", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
}

beforeEach(() => {
	vi.resetAllMocks();
	mockForbiddenResponse.mockReturnValue(null);
	mockExistsSync.mockReturnValue(false);
});

// ─── GET /api/agents ──────────────────────────────────────────────────────────

describe("handleGetAgents", () => {
	it("returns empty array when no agents configured", async () => {
		mockLoadConfig.mockReturnValue({ agents: [] } as never);
		const res = await handleGetAgents(getReq());
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual([]);
	});

	it("returns mapped agent entries", async () => {
		mockLoadConfig.mockReturnValue({
			agents: [
				{
					path: "/agents/my-proj",
					name: "My Proj",
					mode: "cwd",
					provider: "claude",
				},
			],
		} as never);
		mockExistsSync.mockReturnValue(true);
		const res = await handleGetAgents(getReq());
		expect(res.status).toBe(200);
		const body = (await res.json()) as unknown[];
		expect(body).toHaveLength(1);
		const entry = body[0] as Record<string, unknown>;
		expect(entry.path).toBe("/agents/my-proj");
		expect(entry.name).toBe("My Proj");
		expect(entry.dirExists).toBe(true);
	});

	it("derives name from path when name not set", async () => {
		mockLoadConfig.mockReturnValue({
			agents: [{ path: "/agents/my-cool-project" }],
		} as never);
		const res = await handleGetAgents(getReq());
		const body = (await res.json()) as Array<{ name: string }>;
		expect(body[0].name).toBe("My Cool Project");
	});

	it("does not synchronously probe configured WSL paths", async () => {
		mockLoadConfig.mockReturnValue({
			agents: [
				{
					path: "\\\\wsl.localhost\\Ubuntu-24.04\\home\\kyle\\project",
					name: "WSL project",
					mode: "cwd",
					provider: "codex",
				},
			],
		} as never);

		const res = await handleGetAgents(getReq());
		const body = (await res.json()) as Array<{
			dirExists: boolean;
			instructionFile: string | null;
		}>;

		expect(body[0]).toMatchObject({
			dirExists: true,
			instructionFile: null,
		});
		expect(mockExistsSync).not.toHaveBeenCalled();
	});

	it("returns 403 when origin blocked", async () => {
		mockForbiddenResponse.mockReturnValue(new Response("x", { status: 403 }));
		const res = await handleGetAgents(getReq());
		expect(res.status).toBe(403);
	});
});

// ─── POST /api/agents ─────────────────────────────────────────────────────────

describe("handlePostAgents", () => {
	it("saves agents and returns ok", async () => {
		mockLoadConfig.mockReturnValue({
			agents: [],
			vault: {},
			server: {},
			claude: {},
			ui: {},
		} as never);
		const agents = [{ path: "/agents/proj", mode: "cwd", provider: "claude" }];
		const res = await handlePostAgents(postReq(agents));
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ ok: true });
		expect(mockWriteConfig).toHaveBeenCalledWith(
			expect.objectContaining({ agents }),
		);
	});

	it("returns 400 on invalid body", async () => {
		const res = await handlePostAgents(
			new Request("http://localhost/api/agents", {
				method: "POST",
				body: "not-json",
			}),
		);
		expect(res.status).toBe(400);
	});

	it("returns 403 when origin blocked", async () => {
		mockForbiddenResponse.mockReturnValue(new Response("x", { status: 403 }));
		const res = await handlePostAgents(postReq([]));
		expect(res.status).toBe(403);
	});
});
