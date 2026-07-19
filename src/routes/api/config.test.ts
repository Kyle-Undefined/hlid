import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { HlidConfigSchema } from "#/config";
import { writeConfig } from "#/lib/config-writer";
import { dbFetch } from "#/lib/dbClient";
import { handleGetConfig, handlePostConfig } from "./config";

vi.mock("#/server/config", () => ({ loadConfig: vi.fn() }));
vi.mock("#/lib/originGate", () => ({ forbiddenResponse: vi.fn(() => null) }));
vi.mock("#/lib/config-writer", () => ({ writeConfig: vi.fn() }));
vi.mock("#/lib/dbClient", () => ({ dbFetch: vi.fn() }));
vi.mock("node:fs/promises", () => ({ stat: vi.fn() }));

const { loadConfig } = await import("#/server/config");
const { forbiddenResponse } = await import("#/lib/originGate");

const mockLoadConfig = vi.mocked(loadConfig);
const mockForbiddenResponse = vi.mocked(forbiddenResponse);

function makeRequest(url = "http://localhost/api/config"): Request {
	return new Request(url, { method: "GET" });
}

function post(body: unknown): Request {
	return new Request("http://localhost/api/config", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
}

describe("GET /api/config — handleGetConfig", () => {
	beforeEach(() => {
		vi.resetAllMocks();
		mockForbiddenResponse.mockReturnValue(null);
		vi.mocked(dbFetch).mockResolvedValue(new Response());
	});

	it("returns 200 with full config as JSON", async () => {
		const config = HlidConfigSchema.parse({
			vault: { path: "/v", name: "V" },
			server: { port: 3000 },
		});
		mockLoadConfig.mockReturnValue(config);
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

describe("POST /api/config — handlePostConfig", () => {
	beforeEach(() => {
		vi.resetAllMocks();
		mockForbiddenResponse.mockReturnValue(null);
		vi.mocked(dbFetch).mockResolvedValue(new Response());
	});

	it("expands a tilde vault path before validation and persists the config", async () => {
		vi.mocked(stat).mockResolvedValue({ isDirectory: () => true } as never);
		const config = HlidConfigSchema.parse({ vault: { path: "~/vault" } });

		const response = await handlePostConfig(post(config));

		expect(response.status).toBe(200);
		expect(stat).toHaveBeenCalledWith(resolve(homedir(), "vault"));
		expect(writeConfig).toHaveBeenCalledWith(config);
		expect(dbFetch).toHaveBeenCalledWith("/voice/sync", { method: "POST" });
		expect(dbFetch).toHaveBeenCalledWith("/cliproxy/sync", { method: "POST" });
	});

	it("keeps an existing CLIProxy key out of GET responses and preserves it on save", async () => {
		const current = HlidConfigSchema.parse({
			cliproxy: {
				enabled: true,
				mode: "external",
				api_key: "external-secret",
			},
		});
		mockLoadConfig.mockReturnValue(current);
		const getResponse = await handleGetConfig(makeRequest());
		const publicValue = (await getResponse.json()) as typeof current;
		expect(publicValue.cliproxy.api_key).toBe("__HLID_SECRET_SET__");

		const postResponse = await handlePostConfig(post(publicValue));
		expect(postResponse.status).toBe(200);
		expect(writeConfig).toHaveBeenCalledWith(current);
	});

	it.each([
		["a missing path", new Error("ENOENT"), "vault.path does not exist"],
		[
			"a non-directory path",
			{ isDirectory: () => false },
			"vault.path is not a directory",
		],
	])("rejects %s without persisting", async (_label, result, error) => {
		if (result instanceof Error) vi.mocked(stat).mockRejectedValue(result);
		else vi.mocked(stat).mockResolvedValue(result as never);
		const response = await handlePostConfig(
			post(HlidConfigSchema.parse({ vault: { path: "/vault" } })),
		);

		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({ error });
		expect(writeConfig).not.toHaveBeenCalled();
	});

	it("returns a server error when persistence fails", async () => {
		vi.mocked(writeConfig).mockImplementationOnce(() => {
			throw new Error("disk full");
		});
		const response = await handlePostConfig(post(HlidConfigSchema.parse({})));

		expect(response.status).toBe(500);
		expect(await response.json()).toEqual({ error: "Failed to write config" });
		expect(dbFetch).not.toHaveBeenCalled();
	});

	it("rejects malformed JSON and blocked origins before persistence", async () => {
		const malformed = new Request("http://localhost/api/config", {
			method: "POST",
			body: "{",
		});
		expect((await handlePostConfig(malformed)).status).toBe(400);

		mockForbiddenResponse.mockReturnValue(
			new Response("Forbidden", { status: 403 }),
		);
		expect((await handlePostConfig(post({}))).status).toBe(403);
		expect(writeConfig).not.toHaveBeenCalled();
	});
});
