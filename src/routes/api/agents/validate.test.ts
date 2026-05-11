import { beforeEach, describe, expect, it, vi } from "vitest";
import { handleValidateAgentPath } from "./validate";

vi.mock("#/server/config", () => ({ loadConfig: vi.fn() }));
vi.mock("#/lib/originGate", () => ({ forbiddenResponse: vi.fn(() => null) }));
vi.mock("node:fs", () => ({ existsSync: vi.fn(() => false) }));

const { loadConfig } = await import("#/server/config");
const { forbiddenResponse } = await import("#/lib/originGate");
const { existsSync } = await import("node:fs");

const mockLoadConfig = vi.mocked(loadConfig);
const mockForbiddenResponse = vi.mocked(forbiddenResponse);
const mockExistsSync = vi.mocked(existsSync);

function getReq(path?: string): Request {
	const url = new URL("http://localhost/api/agents/validate");
	if (path) url.searchParams.set("path", path);
	return new Request(url, { method: "GET" });
}

beforeEach(() => {
	vi.resetAllMocks();
	mockForbiddenResponse.mockReturnValue(null);
	mockLoadConfig.mockReturnValue({
		vault: { path: "/vault" },
		server: { allow_external_agents: false },
	} as never);
	mockExistsSync.mockReturnValue(false);
});

describe("handleValidateAgentPath", () => {
	it("returns 400 when path param is missing", async () => {
		const res = await handleValidateAgentPath(getReq());
		expect(res.status).toBe(400);
	});

	it("returns dirExists=false when directory does not exist", async () => {
		mockExistsSync.mockReturnValue(false);
		const res = await handleValidateAgentPath(getReq("/agents/proj"));
		expect(res.status).toBe(200);
		const body = (await res.json()) as { dirExists: boolean };
		expect(body.dirExists).toBe(false);
	});

	it("returns hasClaudemd=true when CLAUDE.md present", async () => {
		mockExistsSync.mockImplementation((p) => String(p).endsWith("CLAUDE.md"));
		const res = await handleValidateAgentPath(getReq("/agents/proj"));
		const body = (await res.json()) as {
			hasClaudemd: boolean;
			dirExists: boolean;
		};
		expect(body.hasClaudemd).toBe(true);
		expect(body.dirExists).toBe(false); // dir itself not found
	});

	it("derives suggestedName from path", async () => {
		const res = await handleValidateAgentPath(
			getReq("/agents/my-cool-project"),
		);
		const body = (await res.json()) as { suggestedName: string };
		expect(body.suggestedName).toBe("My Cool Project");
	});

	it("returns inVault=true when path is inside vault", async () => {
		mockLoadConfig.mockReturnValue({
			vault: { path: "/vault" },
			server: { allow_external_agents: false },
		} as never);
		const res = await handleValidateAgentPath(getReq("/vault/my-agent"));
		const body = (await res.json()) as { inVault: boolean };
		expect(body.inVault).toBe(true);
	});

	it("returns inVault=false when path is outside vault", async () => {
		const res = await handleValidateAgentPath(getReq("/agents/external"));
		const body = (await res.json()) as { inVault: boolean };
		expect(body.inVault).toBe(false);
	});

	it("returns externalAllowed from config", async () => {
		mockLoadConfig.mockReturnValue({
			vault: { path: "/vault" },
			server: { allow_external_agents: true },
		} as never);
		const res = await handleValidateAgentPath(getReq("/agents/proj"));
		const body = (await res.json()) as { externalAllowed: boolean };
		expect(body.externalAllowed).toBe(true);
	});

	it("returns 403 when origin blocked", async () => {
		mockForbiddenResponse.mockReturnValue(new Response("x", { status: 403 }));
		const res = await handleValidateAgentPath(getReq("/agents/proj"));
		expect(res.status).toBe(403);
	});
});
