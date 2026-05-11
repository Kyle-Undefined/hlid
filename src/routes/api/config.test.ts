import { beforeEach, describe, expect, it, vi } from "vitest";
import { handleGetConfig } from "./config";

vi.mock("#/server/config", () => ({ loadConfig: vi.fn() }));
vi.mock("#/lib/originGate", () => ({ forbiddenResponse: vi.fn(() => null) }));

const { loadConfig } = await import("#/server/config");
const { forbiddenResponse } = await import("#/lib/originGate");

const mockLoadConfig = vi.mocked(loadConfig);
const mockForbiddenResponse = vi.mocked(forbiddenResponse);

function makeRequest(url = "http://localhost/api/config"): Request {
	return new Request(url, { method: "GET" });
}

describe("GET /api/config — handleGetConfig", () => {
	beforeEach(() => {
		vi.resetAllMocks();
		mockForbiddenResponse.mockReturnValue(null);
	});

	it("returns 200 with full config as JSON", async () => {
		const config = { vault: { path: "/v", name: "V" }, server: { port: 3000 } };
		mockLoadConfig.mockReturnValue(config as never);
		const res = await handleGetConfig(makeRequest());
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual(config);
	});

	it("returns forbidden response when origin is blocked", async () => {
		const forbidden = new Response("Forbidden", { status: 403 });
		mockForbiddenResponse.mockReturnValue(forbidden);
		const res = await handleGetConfig(makeRequest());
		expect(res.status).toBe(403);
	});
});
