import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	handleGetAgentMcp,
	handlePostAgentMcp,
	handleToggleAgentMcp,
} from "./agent";

vi.mock("#/server/config", () => ({ loadConfig: vi.fn() }));
vi.mock("#/lib/originGate", () => ({ forbiddenResponse: vi.fn(() => null) }));
vi.mock("#/lib/agentMcp", () => ({
	validateAgentPath: vi.fn(),
	readAgentMcpFile: vi.fn(),
	writeAgentMcpFile: vi.fn(),
	toggleAgentMcpFile: vi.fn(),
}));

const { loadConfig } = await import("#/server/config");
const { forbiddenResponse } = await import("#/lib/originGate");
const {
	validateAgentPath,
	readAgentMcpFile,
	writeAgentMcpFile,
	toggleAgentMcpFile,
} = await import("#/lib/agentMcp");

const mockLoadConfig = vi.mocked(loadConfig);
const mockForbiddenResponse = vi.mocked(forbiddenResponse);
const mockValidate = vi.mocked(validateAgentPath);
const mockRead = vi.mocked(readAgentMcpFile);
const mockWrite = vi.mocked(writeAgentMcpFile);
const mockToggle = vi.mocked(toggleAgentMcpFile);

const AGENT_PATH = "/agents/my-agent";

function getReq(path?: string): Request {
	const url = new URL("http://localhost/api/mcp/agent");
	if (path) url.searchParams.set("path", path);
	return new Request(url, { method: "GET" });
}

function postReq(body: unknown, endpoint = "/api/mcp/agent"): Request {
	return new Request(`http://localhost${endpoint}`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
}

beforeEach(() => {
	vi.resetAllMocks();
	mockForbiddenResponse.mockReturnValue(null);
	mockLoadConfig.mockReturnValue({ agents: [{ path: AGENT_PATH }] } as never);
});

// ─── GET ─────────────────────────────────────────────────────────────────────

describe("handleGetAgentMcp", () => {
	it("returns 400 when path param is missing", async () => {
		const res = await handleGetAgentMcp(getReq());
		expect(res.status).toBe(400);
	});

	it("returns 403 when validateAgentPath throws Unauthorized", async () => {
		mockValidate.mockImplementation(() => {
			throw new Error("Unauthorized");
		});
		const res = await handleGetAgentMcp(getReq(AGENT_PATH));
		expect(res.status).toBe(403);
	});

	it("delegates to readAgentMcpFile and returns servers", async () => {
		mockValidate.mockReturnValue(undefined);
		const servers = [{ name: "fs", config: {}, disabled: false }];
		mockRead.mockReturnValue({ servers });
		const res = await handleGetAgentMcp(getReq(AGENT_PATH));
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ servers });
		expect(mockRead).toHaveBeenCalled();
	});

	it("returns 403 when origin blocked", async () => {
		mockForbiddenResponse.mockReturnValue(new Response("x", { status: 403 }));
		const res = await handleGetAgentMcp(getReq(AGENT_PATH));
		expect(res.status).toBe(403);
	});
});

// ─── POST (write) ─────────────────────────────────────────────────────────────

describe("handlePostAgentMcp", () => {
	it("returns 400 when agentPath is missing", async () => {
		const res = await handlePostAgentMcp(postReq({ servers: {} }));
		expect(res.status).toBe(400);
	});

	it("returns 403 when path is unauthorized", async () => {
		mockValidate.mockImplementation(() => {
			throw new Error("Unauthorized");
		});
		const res = await handlePostAgentMcp(
			postReq({ agentPath: AGENT_PATH, servers: {} }),
		);
		expect(res.status).toBe(403);
	});

	it("delegates to writeAgentMcpFile and returns ok", async () => {
		mockValidate.mockReturnValue(undefined);
		const servers = { filesystem: { command: "npx" } };
		const res = await handlePostAgentMcp(
			postReq({ agentPath: AGENT_PATH, servers }),
		);
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ ok: true });
		expect(mockWrite).toHaveBeenCalled();
	});
});

// ─── POST /toggle ─────────────────────────────────────────────────────────────

describe("handleToggleAgentMcp", () => {
	it("returns 400 when agentPath missing", async () => {
		const res = await handleToggleAgentMcp(
			postReq({ name: "fs", disabled: true }),
		);
		expect(res.status).toBe(400);
	});

	it("returns 403 when path is unauthorized", async () => {
		mockValidate.mockImplementation(() => {
			throw new Error("Unauthorized");
		});
		const res = await handleToggleAgentMcp(
			postReq({ agentPath: AGENT_PATH, name: "fs", disabled: true }),
		);
		expect(res.status).toBe(403);
	});

	it("delegates to toggleAgentMcpFile and returns ok", async () => {
		mockValidate.mockReturnValue(undefined);
		const res = await handleToggleAgentMcp(
			postReq({ agentPath: AGENT_PATH, name: "filesystem", disabled: false }),
		);
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ ok: true });
		expect(mockToggle).toHaveBeenCalled();
	});
});
