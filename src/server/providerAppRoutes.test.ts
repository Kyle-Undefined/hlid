import { describe, expect, it, vi } from "vitest";
import type { HlidConfig } from "../config";
import type { AgentProvider } from "./agentProvider";
import { createProviderAppRouteHandler } from "./providerAppRoutes";

function config(): HlidConfig {
	return { vault: { path: "/work/project" } } as HlidConfig;
}

function provider(overrides: Partial<AgentProvider> = {}): AgentProvider {
	return {
		providerId: "codex",
		query: vi.fn() as AgentProvider["query"],
		...overrides,
	};
}

describe("provider Apps routes", () => {
	it("returns one bounded provider-scoped catalog page", async () => {
		const listApps = vi.fn().mockResolvedValue({
			contractVersion: 1,
			providerId: "codex",
			status: "current",
			apps: [],
			connectors: [],
		});
		const codex = provider({ listApps });
		const handle = createProviderAppRouteHandler({
			getProvider: () => codex,
			loadConfig: config,
		});

		const response = await handle(
			new URL(
				"http://localhost/provider-apps?provider_id=codex&session_id=raven-1&cursor=next&limit=25&refresh=1",
			),
			new Request("http://localhost/provider-apps"),
		);

		expect(response?.status).toBe(200);
		expect(listApps).toHaveBeenCalledWith({
			cwd: "/work/project",
			sessionId: "raven-1",
			cursor: "next",
			limit: 25,
			refresh: true,
		});
	});

	it("gates providers that do not integrate an Apps catalog", async () => {
		const handle = createProviderAppRouteHandler({
			getProvider: () => provider(),
			loadConfig: config,
		});
		const response = await handle(
			new URL("http://localhost/provider-apps?provider_id=claude"),
			new Request("http://localhost/provider-apps"),
		);
		expect(response?.status).toBe(409);
	});

	it("starts authentication without returning an authorization URL", async () => {
		const startAppAuthentication = vi.fn().mockResolvedValue({ opened: true });
		const changed = vi.fn();
		const handle = createProviderAppRouteHandler({
			getProvider: () => provider({ startAppAuthentication }),
			loadConfig: config,
			onAuthenticationStarted: changed,
		});
		const response = await handle(
			new URL("http://localhost/provider-apps/authenticate"),
			new Request("http://localhost/provider-apps/authenticate", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					providerId: "codex",
					kind: "app",
					id: "github",
				}),
			}),
		);

		expect(startAppAuthentication).toHaveBeenCalledWith({
			cwd: "/work/project",
			target: { kind: "app", id: "github" },
		});
		expect(await response?.json()).toEqual({ ok: true });
		expect(changed).toHaveBeenCalledOnce();
	});

	it("rejects relative workspaces before touching the provider", async () => {
		const listApps = vi.fn();
		const handle = createProviderAppRouteHandler({
			getProvider: () => provider({ listApps }),
			loadConfig: config,
		});
		const response = await handle(
			new URL(
				"http://localhost/provider-apps?provider_id=codex&cwd=relative/path",
			),
			new Request("http://localhost/provider-apps"),
		);
		expect(response?.status).toBe(400);
		expect(listApps).not.toHaveBeenCalled();
	});
});
