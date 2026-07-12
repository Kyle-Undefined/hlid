import { beforeEach, describe, expect, it, vi } from "vitest";
import { HlidConfigSchema } from "../config";
import { createAcpRouteHandler } from "./acpRoutes";

const enabledAgent = {
	id: "opencode",
	name: "OpenCode",
	version: "1",
	description: "Agent",
	distribution: {},
	providerId: "acp:opencode",
	enabled: true,
	available: true,
	command: "opencode",
	args: ["acp"],
	env: { BASE: "registry" },
	installGuidance: "install",
};

const catalog = vi.fn();
const loadConfig = vi.fn();
const inspectAgent = vi.fn();
const handle = createAcpRouteHandler({
	registry: { catalog },
	loadConfig,
	inspectAgent,
});

function request(path: string, method = "GET", body?: unknown): Request {
	return new Request(`http://localhost${path}`, {
		method,
		headers: body ? { "content-type": "application/json" } : undefined,
		body: body ? JSON.stringify(body) : undefined,
	});
}

beforeEach(() => {
	vi.clearAllMocks();
	loadConfig.mockReturnValue(
		HlidConfigSchema.parse({
			acp_agents: [
				{ id: "opencode", env: { BASE: "configured", TOKEN: "secret" } },
			],
		}),
	);
	catalog.mockResolvedValue([enabledAgent]);
	inspectAgent.mockResolvedValue({
		authMethods: [{ id: "login", name: "Login" }],
		agentInfo: { name: "OpenCode", version: "1" },
	});
});

describe("ACP internal HTTP routes", () => {
	it("lists the registry with an explicit refresh flag", async () => {
		const response = await handle(
			new URL("http://localhost/acp/registry?refresh=1"),
			request("/acp/registry?refresh=1"),
		);

		expect(response?.status).toBe(200);
		expect(catalog).toHaveBeenCalledWith(
			loadConfig.mock.results[0]?.value,
			true,
		);
		expect(await response?.json()).toEqual({ agents: [enabledAgent] });
	});

	it("validates authentication requests before inspecting an agent", async () => {
		expect(
			(
				await handle(
					new URL("http://localhost/acp/authenticate"),
					request("/acp/authenticate", "POST", {}),
				)
			)?.status,
		).toBe(400);
		expect(inspectAgent).not.toHaveBeenCalled();
	});

	it("distinguishes disabled and unavailable agents", async () => {
		catalog.mockResolvedValueOnce([]);
		expect(
			(
				await handle(
					new URL("http://localhost/acp/authenticate"),
					request("/acp/authenticate", "POST", { id: "missing" }),
				)
			)?.status,
		).toBe(404);

		catalog.mockResolvedValueOnce([
			{ ...enabledAgent, available: false, unavailableReason: "not installed" },
		]);
		expect(
			(
				await handle(
					new URL("http://localhost/acp/authenticate"),
					request("/acp/authenticate", "POST", { id: "opencode" }),
				)
			)?.status,
		).toBe(409);
	});

	it("uses one config snapshot and merges configured environment overrides", async () => {
		const response = await handle(
			new URL("http://localhost/acp/authenticate"),
			request("/acp/authenticate", "POST", {
				id: "opencode",
				methodId: "login",
			}),
		);

		expect(loadConfig).toHaveBeenCalledOnce();
		expect(inspectAgent).toHaveBeenCalledWith(
			expect.objectContaining({
				id: "acp:opencode",
				env: { BASE: "configured", TOKEN: "secret" },
			}),
			"login",
		);
		expect(await response?.json()).toEqual({
			authMethods: [{ id: "login", name: "Login" }],
			agentInfo: { name: "OpenCode", version: "1" },
		});
	});

	it("returns null for unrelated methods and paths", async () => {
		expect(
			await handle(
				new URL("http://localhost/acp/registry"),
				request("/acp/registry", "POST"),
			),
		).toBeNull();
		expect(
			await handle(new URL("http://localhost/other"), request("/other")),
		).toBeNull();
	});
});
