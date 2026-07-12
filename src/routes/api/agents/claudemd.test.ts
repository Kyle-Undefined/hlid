import { beforeEach, describe, expect, it, vi } from "vitest";
import { handleGetClaudeMd } from "./claudemd";

vi.mock("#/server/config", () => ({ loadConfig: vi.fn() }));
vi.mock("#/lib/originGate", () => ({ forbiddenResponse: vi.fn(() => null) }));
vi.mock("#/lib/agentMcp", () => ({ validateAgentPath: vi.fn() }));
vi.mock("#/lib/agentInstructions", () => ({
	readAgentInstructions: vi.fn(() => null),
}));

const { loadConfig } = await import("#/server/config");
const { forbiddenResponse } = await import("#/lib/originGate");
const { validateAgentPath } = await import("#/lib/agentMcp");
const { readAgentInstructions } = await import("#/lib/agentInstructions");

const mockLoadConfig = vi.mocked(loadConfig);
const mockForbiddenResponse = vi.mocked(forbiddenResponse);
const mockValidate = vi.mocked(validateAgentPath);
const mockReadAgentInstructions = vi.mocked(readAgentInstructions);

const AGENT_PATH = "/agents/my-agent";

function getReq(path?: string): Request {
	const url = new URL("http://localhost/api/agents/claudemd");
	if (path) url.searchParams.set("path", path);
	return new Request(url, { method: "GET" });
}

beforeEach(() => {
	vi.resetAllMocks();
	mockForbiddenResponse.mockReturnValue(null);
	mockLoadConfig.mockReturnValue({ agents: [{ path: AGENT_PATH }] } as never);
	mockReadAgentInstructions.mockReturnValue(null);
});

describe("handleGetClaudeMd", () => {
	it("returns 400 when path param is missing", async () => {
		const res = await handleGetClaudeMd(getReq());
		expect(res.status).toBe(400);
	});

	it("returns 403 when validateAgentPath throws Unauthorized", async () => {
		mockValidate.mockImplementation(() => {
			throw new Error("Unauthorized");
		});
		const res = await handleGetClaudeMd(getReq(AGENT_PATH));
		expect(res.status).toBe(403);
	});

	it("returns null fields when no instruction file exists", async () => {
		mockValidate.mockReturnValue(undefined);
		const res = await handleGetClaudeMd(getReq(AGENT_PATH));
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ filename: null, content: null });
	});

	it("returns the selected instruction filename and content", async () => {
		mockValidate.mockReturnValue(undefined);
		mockReadAgentInstructions.mockReturnValue({
			filename: "AGENTS.md",
			content: "# My Agent\nDo things.",
		});
		const res = await handleGetClaudeMd(getReq(AGENT_PATH));
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({
			filename: "AGENTS.md",
			content: "# My Agent\nDo things.",
		});
	});

	it("returns 403 when origin blocked", async () => {
		mockForbiddenResponse.mockReturnValue(new Response("x", { status: 403 }));
		const res = await handleGetClaudeMd(getReq(AGENT_PATH));
		expect(res.status).toBe(403);
	});
});
