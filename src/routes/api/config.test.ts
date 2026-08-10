import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { HlidConfigSchema } from "#/config";
import { writeConfig } from "#/lib/config-writer";
import { dbFetch } from "#/lib/dbClient";
import { makeRequest } from "#/test/routeTestKit";
import { handleGetConfig, handlePostConfig } from "./config";

vi.mock("#/server/config");
vi.mock("#/lib/originGate");
vi.mock("#/lib/config-writer", () => ({ writeConfig: vi.fn() }));
vi.mock("#/lib/dbClient");
vi.mock("node:fs/promises", () => ({ stat: vi.fn() }));

const { loadConfig } = await import("#/server/config");
const { forbiddenResponse } = await import("#/lib/originGate");

const mockLoadConfig = vi.mocked(loadConfig);
const mockForbiddenResponse = vi.mocked(forbiddenResponse);

const get = () => makeRequest("/api/config");
const post = (body: unknown) =>
	makeRequest("/api/config", { method: "POST", json: body });

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
		const res = await handleGetConfig(get());
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual(config);
	});

	it("returns forbidden response when origin is blocked", async () => {
		const forbidden = new Response("Forbidden", { status: 403 });
		mockForbiddenResponse.mockReturnValue(forbidden);
		const res = await handleGetConfig(get());
		expect(res.status).toBe(403);
	});
});

describe("POST /api/config — handlePostConfig", () => {
	beforeEach(() => {
		vi.resetAllMocks();
		mockForbiddenResponse.mockReturnValue(null);
		mockLoadConfig.mockReturnValue(HlidConfigSchema.parse({}));
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
		expect(dbFetch).not.toHaveBeenCalledWith("/acp/sync", { method: "POST" });
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
		const getResponse = await handleGetConfig(get());
		const publicValue = (await getResponse.json()) as typeof current;
		expect(publicValue.cliproxy.api_key).toBe("__HLID_SECRET_SET__");

		const postResponse = await handlePostConfig(post(publicValue));
		expect(postResponse.status).toBe(200);
		expect(writeConfig).toHaveBeenCalledWith(current);
	});

	it("keeps ACP environment values out of GET responses and preserves them on save", async () => {
		const current = HlidConfigSchema.parse({
			acp_agents: [
				{
					id: "opencode",
					env: {
						OPENCODE_CONFIG_CONTENT: '{"provider":{"opencode":{}}}',
						TOKEN: "external-secret",
					},
				},
			],
		});
		mockLoadConfig.mockReturnValue(current);

		const getResponse = await handleGetConfig(get());
		const publicValue = (await getResponse.json()) as typeof current;
		expect(publicValue.acp_agents?.[0]?.env).toEqual({
			OPENCODE_CONFIG_CONTENT: "__HLID_SECRET_SET__",
			TOKEN: "__HLID_SECRET_SET__",
		});

		const postResponse = await handlePostConfig(post(publicValue));
		expect(postResponse.status).toBe(200);
		expect(writeConfig).toHaveBeenCalledWith(current);
	});

	it("waits for runtime synchronization when Codex Live changes", async () => {
		let finishRuntimeSync: (response: Response) => void = () => {};
		const runtimeSync = new Promise<Response>((resolve) => {
			finishRuntimeSync = resolve;
		});
		vi.mocked(dbFetch).mockImplementation((path) =>
			path === "/cliproxy/sync" ? runtimeSync : Promise.resolve(new Response()),
		);
		const next = HlidConfigSchema.parse({
			voice: { codex_live_mode: true },
		});
		let settled = false;

		const pending = handlePostConfig(post(next)).then((response) => {
			settled = true;
			return response;
		});
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(settled).toBe(false);

		finishRuntimeSync(new Response());
		const response = await pending;
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			ok: true,
			runtime_synced: true,
			acp_runtime_synced: true,
		});
	});

	it.each([
		[
			"a rejected request",
			() => Promise.reject(new Error("bridge unavailable")),
			"Codex runtime synchronization failed: bridge unavailable.",
		],
		[
			"a non-success response",
			() => Promise.resolve(new Response(null, { status: 503 })),
			"Codex runtime synchronization returned 503.",
		],
	])("reports %s without claiming the persisted config save failed", async (_label, runtimeResult, warning) => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		vi.mocked(dbFetch).mockImplementation((path) =>
			path === "/cliproxy/sync"
				? runtimeResult()
				: Promise.resolve(new Response()),
		);
		const next = HlidConfigSchema.parse({
			voice: { codex_live_mode: true },
		});

		const response = await handlePostConfig(post(next));

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			ok: true,
			runtime_synced: false,
			acp_runtime_synced: true,
			warning,
		});
		expect(writeConfig).toHaveBeenCalledWith(next);
		expect(warn).toHaveBeenCalledWith(`[config] ${warning}`);
		warn.mockRestore();
	});

	it("waits for runtime synchronization when the Codex executable changes", async () => {
		const current = HlidConfigSchema.parse({
			codex: { executable: "/old/codex" },
		});
		mockLoadConfig.mockReturnValue(current);
		let finishRuntimeSync: (response: Response) => void = () => {};
		const runtimeSync = new Promise<Response>((resolve) => {
			finishRuntimeSync = resolve;
		});
		vi.mocked(dbFetch).mockImplementation((path) =>
			path === "/cliproxy/sync" ? runtimeSync : Promise.resolve(new Response()),
		);
		const next = structuredClone(current);
		next.codex.executable = "/new/codex";
		let settled = false;

		const pending = handlePostConfig(post(next)).then((response) => {
			settled = true;
			return response;
		});
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(settled).toBe(false);

		finishRuntimeSync(new Response());
		expect((await pending).status).toBe(200);
	});

	it("waits for ACP runtime synchronization when an agent is enabled", async () => {
		let finishRuntimeSync: (response: Response) => void = () => {};
		const runtimeSync = new Promise<Response>((resolve) => {
			finishRuntimeSync = resolve;
		});
		vi.mocked(dbFetch).mockImplementation((path) =>
			path === "/acp/sync" ? runtimeSync : Promise.resolve(new Response()),
		);
		const next = HlidConfigSchema.parse({
			acp_agents: [{ id: "opencode" }],
		});
		let settled = false;

		const pending = handlePostConfig(post(next)).then((response) => {
			settled = true;
			return response;
		});
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(settled).toBe(false);

		finishRuntimeSync(new Response());
		expect(await (await pending).json()).toEqual({
			ok: true,
			runtime_synced: true,
			acp_runtime_synced: true,
		});
	});

	it("synchronizes an enabled ACP runtime when its discovery workspace changes", async () => {
		const current = HlidConfigSchema.parse({
			vault: { path: "/old-vault" },
			acp_agents: [{ id: "opencode" }],
		});
		mockLoadConfig.mockReturnValue(current);
		vi.mocked(stat).mockResolvedValue({ isDirectory: () => true } as never);
		const next = structuredClone(current);
		next.vault.path = "/new-vault";

		const response = await handlePostConfig(post(next));

		expect(response.status).toBe(200);
		expect(dbFetch).toHaveBeenCalledWith("/acp/sync", { method: "POST" });
		expect(await response.json()).toEqual({
			ok: true,
			runtime_synced: true,
			acp_runtime_synced: true,
		});
	});

	it("reports ACP synchronization failures without rolling back the saved config", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		vi.mocked(dbFetch).mockImplementation((path) =>
			path === "/acp/sync"
				? Promise.reject(new Error("provider registry unavailable"))
				: Promise.resolve(new Response()),
		);
		const next = HlidConfigSchema.parse({
			acp_agents: [{ id: "opencode" }],
		});

		const response = await handlePostConfig(post(next));

		expect(await response.json()).toEqual({
			ok: true,
			runtime_synced: false,
			acp_runtime_synced: false,
			warning:
				"ACP runtime synchronization failed: provider registry unavailable.",
		});
		expect(writeConfig).toHaveBeenCalledWith(next);
		warn.mockRestore();
	});

	it("retries ACP synchronization for an identical persisted config after a transient failure", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const current = HlidConfigSchema.parse({});
		const next = HlidConfigSchema.parse({
			acp_agents: [{ id: "opencode" }],
		});
		mockLoadConfig.mockReturnValueOnce(current).mockReturnValue(next);
		let acpSyncAttempts = 0;
		vi.mocked(dbFetch).mockImplementation((path) => {
			if (path !== "/acp/sync") return Promise.resolve(new Response());
			acpSyncAttempts += 1;
			return acpSyncAttempts === 1
				? Promise.reject(new Error("provider registry unavailable"))
				: Promise.resolve(new Response());
		});

		const first = await handlePostConfig(post(next));
		expect(await first.json()).toMatchObject({
			ok: true,
			runtime_synced: false,
			acp_runtime_synced: false,
		});

		const retry = await handlePostConfig(post(next));

		expect(await retry.json()).toEqual({
			ok: true,
			runtime_synced: true,
			acp_runtime_synced: true,
		});
		expect(acpSyncAttempts).toBe(2);
		expect(writeConfig).toHaveBeenCalledTimes(2);
		warn.mockRestore();
	});

	it("includes an actionable ACP overlay error in the runtime warning", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		vi.mocked(dbFetch).mockImplementation((path) =>
			path === "/acp/sync"
				? Promise.resolve(
						Response.json(
							{
								error:
									"Cannot apply Hlid's OpenCode model filter: inline config conflict",
							},
							{ status: 409 },
						),
					)
				: Promise.resolve(new Response()),
		);
		const next = HlidConfigSchema.parse({
			acp_agents: [
				{
					id: "opencode",
					model_filter: { mode: "hide", models: ["opencode/model-a"] },
				},
			],
		});

		const response = await handlePostConfig(post(next));

		expect(await response.json()).toEqual({
			ok: true,
			runtime_synced: false,
			acp_runtime_synced: false,
			warning:
				"ACP runtime synchronization returned 409: Cannot apply Hlid's OpenCode model filter: inline config conflict.",
		});
		expect(writeConfig).toHaveBeenCalledWith(next);
		warn.mockRestore();
	});

	it("preflights the OpenCode overlay before writing config", async () => {
		const next = HlidConfigSchema.parse({
			acp_agents: [
				{
					id: "opencode",
					env: {
						OPENCODE_CONFIG_CONTENT: '{"secret":"must-not-leak",',
					},
					model_filter: { mode: "hide", models: ["opencode/model-a"] },
				},
			],
		});

		const response = await handlePostConfig(post(next));
		const body = (await response.json()) as { error: string };

		expect(response.status).toBe(400);
		expect(body.error).toContain("OPENCODE_CONFIG_CONTENT is invalid");
		expect(body.error).not.toContain("must-not-leak");
		expect(writeConfig).not.toHaveBeenCalled();
		expect(dbFetch).not.toHaveBeenCalled();
	});

	it("preflights the resolved ACP environment before writing config", async () => {
		vi.mocked(dbFetch).mockImplementation((path) =>
			path === "/acp/preflight"
				? Promise.resolve(
						Response.json(
							{
								error:
									"Cannot apply Hlid's OpenCode model filter: registry inline config is invalid.",
							},
							{ status: 409 },
						),
					)
				: Promise.resolve(new Response()),
		);
		const next = HlidConfigSchema.parse({
			acp_agents: [
				{
					id: "opencode",
					model_filter: { mode: "hide", models: ["opencode/model-a"] },
				},
			],
		});

		const response = await handlePostConfig(post(next));

		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({
			error:
				"Cannot apply Hlid's OpenCode model filter: registry inline config is invalid.",
		});
		expect(writeConfig).not.toHaveBeenCalled();
		expect(dbFetch).toHaveBeenCalledWith("/acp/preflight", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(next),
		});
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
