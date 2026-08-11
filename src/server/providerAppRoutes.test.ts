import { afterEach, describe, expect, it, vi } from "vitest";
import type { HlidConfig } from "../config";
import type { ProviderAppCatalogPage } from "../lib/providerAppTypes";
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

function catalog(observedAt = 1): ProviderAppCatalogPage {
	return {
		contractVersion: 1,
		providerId: "codex",
		status: "current",
		observedAt,
		scope: {
			providerId: "codex",
			account: "active-provider-account",
			host: "current-hlid-host",
			workspace: "/work/project",
			sessionId: null,
		},
		apps: [],
		connectors: [],
		installedCount: 0,
		usableCount: 0,
		missingAuthenticationCount: 0,
		returned: 0,
		nextCursor: null,
		truncated: false,
	};
}

function catalogWithApp(observedAt = 1): ProviderAppCatalogPage {
	return {
		...catalog(observedAt),
		apps: [
			{
				id: "github",
				name: "GitHub",
				available: true,
				installed: true,
				configured: true,
				authentication: "ready",
				usable: true,
				readiness: "usable",
				canAuthenticate: false,
				oauthState: "idle",
			},
		],
		installedCount: 1,
		usableCount: 1,
		returned: 1,
	};
}

function deferred<T>(): {
	promise: Promise<T>;
	resolve: (value: T) => void;
	reject: (reason: unknown) => void;
} {
	let resolve!: (value: T) => void;
	let reject!: (reason: unknown) => void;
	return {
		promise: new Promise<T>((settle, fail) => {
			resolve = settle;
			reject = fail;
		}),
		resolve,
		reject,
	};
}

describe("provider Apps routes", () => {
	afterEach(() => vi.useRealTimers());

	it("returns one bounded provider-scoped catalog page", async () => {
		const listApps = vi.fn().mockResolvedValue(catalog());
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

	it("returns a truthful pending page and deduplicates a cold provider load", async () => {
		const pending = deferred<ProviderAppCatalogPage>();
		const listApps = vi.fn().mockReturnValue(pending.promise);
		const handle = createProviderAppRouteHandler({
			getProvider: () => provider({ listApps }),
			loadConfig: config,
		});
		const url = new URL(
			"http://localhost/provider-apps?provider_id=codex&limit=50",
		);

		const first = await handle(
			url,
			new Request("http://localhost/provider-apps"),
		);
		expect(await first?.json()).toMatchObject({
			status: "partial",
			refreshing: true,
			observedAt: 0,
		});

		const second = await handle(
			url,
			new Request("http://localhost/provider-apps"),
		);
		expect(await second?.json()).toMatchObject({ refreshing: true });
		expect(listApps).toHaveBeenCalledOnce();

		pending.resolve(catalog(2));
		await pending.promise;
		await vi.waitFor(async () => {
			const response = await handle(
				url,
				new Request("http://localhost/provider-apps"),
			);
			expect(await response?.json()).toMatchObject({
				status: "current",
				observedAt: 2,
			});
		});
		expect(listApps).toHaveBeenCalledOnce();
	});

	it("keeps cached data visible while one explicit refresh runs", async () => {
		const refresh = deferred<ProviderAppCatalogPage>();
		const listApps = vi
			.fn()
			.mockResolvedValueOnce(catalog(1))
			.mockReturnValueOnce(refresh.promise);
		const handle = createProviderAppRouteHandler({
			getProvider: () => provider({ listApps }),
			loadConfig: config,
		});
		const readUrl = new URL(
			"http://localhost/provider-apps?provider_id=codex&limit=50",
		);
		await handle(readUrl, new Request("http://localhost/provider-apps"));
		await vi.waitFor(async () => {
			const response = await handle(
				readUrl,
				new Request("http://localhost/provider-apps"),
			);
			expect(await response?.json()).toMatchObject({ observedAt: 1 });
		});

		const refreshing = await handle(
			new URL(
				"http://localhost/provider-apps?provider_id=codex&limit=50&refresh=1",
			),
			new Request("http://localhost/provider-apps"),
		);
		expect(await refreshing?.json()).toMatchObject({
			observedAt: 1,
			refreshing: true,
		});
		expect(listApps).toHaveBeenLastCalledWith({
			cwd: "/work/project",
			limit: 50,
			refresh: true,
		});

		const duplicate = await handle(
			readUrl,
			new Request("http://localhost/provider-apps"),
		);
		expect(await duplicate?.json()).toMatchObject({ refreshing: true });
		expect(listApps).toHaveBeenCalledTimes(2);

		refresh.resolve(catalog(2));
		await refresh.promise;
		await vi.waitFor(async () => {
			const response = await handle(
				readUrl,
				new Request("http://localhost/provider-apps"),
			);
			expect(await response?.json()).toMatchObject({ observedAt: 2 });
		});
		expect(listApps).toHaveBeenCalledTimes(2);
	});

	it("keeps a successful catalog cached until an explicit refresh", async () => {
		vi.useFakeTimers();
		const partialCatalog = {
			...catalogWithApp(1),
			status: "partial" as const,
			issues: [
				"Available app discovery could not be checked in the active provider runtime.",
			],
		};
		const listApps = vi
			.fn()
			.mockResolvedValueOnce(partialCatalog)
			.mockResolvedValueOnce(catalogWithApp(2));
		const handle = createProviderAppRouteHandler({
			getProvider: () => provider({ listApps }),
			loadConfig: config,
		});
		const readUrl = new URL(
			"http://localhost/provider-apps?provider_id=codex&limit=50",
		);

		await handle(readUrl, new Request("http://localhost/provider-apps"));
		await vi.advanceTimersByTimeAsync(0);
		const loaded = await handle(
			readUrl,
			new Request("http://localhost/provider-apps"),
		);
		expect(await loaded?.json()).toMatchObject({
			status: "partial",
			observedAt: 1,
			apps: [{ id: "github" }],
		});

		await vi.advanceTimersByTimeAsync(10 * 60_000);
		const revisited = await handle(
			readUrl,
			new Request("http://localhost/provider-apps"),
		);
		expect(await revisited?.json()).toMatchObject({
			status: "partial",
			observedAt: 1,
			apps: [{ id: "github" }],
		});
		expect(listApps).toHaveBeenCalledOnce();

		await handle(
			new URL(
				"http://localhost/provider-apps?provider_id=codex&limit=50&refresh=1",
			),
			new Request("http://localhost/provider-apps"),
		);
		await vi.advanceTimersByTimeAsync(0);
		expect(listApps).toHaveBeenCalledTimes(2);
	});

	it("preserves stale data and reports a failed warm refresh", async () => {
		const refresh = deferred<ProviderAppCatalogPage>();
		const listApps = vi
			.fn()
			.mockResolvedValueOnce({
				...catalogWithApp(1),
				status: "partial",
				issues: ["Available app discovery could not be checked."],
				issueSeverity: "info",
			})
			.mockReturnValueOnce(refresh.promise);
		const handle = createProviderAppRouteHandler({
			getProvider: () => provider({ listApps }),
			loadConfig: config,
		});
		const readUrl = new URL(
			"http://localhost/provider-apps?provider_id=codex&limit=50",
		);
		await handle(readUrl, new Request("http://localhost/provider-apps"));
		await vi.waitFor(async () => {
			const response = await handle(
				readUrl,
				new Request("http://localhost/provider-apps"),
			);
			expect(await response?.json()).toMatchObject({ observedAt: 1 });
		});
		await handle(
			new URL(
				"http://localhost/provider-apps?provider_id=codex&limit=50&refresh=1",
			),
			new Request("http://localhost/provider-apps"),
		);

		refresh.reject(new Error("refresh failed"));
		await refresh.promise.catch(() => undefined);
		await vi.waitFor(async () => {
			const response = await handle(
				readUrl,
				new Request("http://localhost/provider-apps"),
			);
			expect(await response?.json()).toMatchObject({
				status: "partial",
				issueSeverity: "warning",
				observedAt: 1,
				apps: [{ id: "github" }],
				issues: [
					"Available app discovery could not be checked.",
					"Provider app inventory refresh failed. Showing the most recently loaded data.",
				],
			});
		});
	});

	it("queues one forced refresh behind a normal in-flight load", async () => {
		const normal = deferred<ProviderAppCatalogPage>();
		const forced = deferred<ProviderAppCatalogPage>();
		const listApps = vi
			.fn()
			.mockReturnValueOnce(normal.promise)
			.mockReturnValueOnce(forced.promise);
		const handle = createProviderAppRouteHandler({
			getProvider: () => provider({ listApps }),
			loadConfig: config,
		});
		const readUrl = new URL(
			"http://localhost/provider-apps?provider_id=codex&limit=50",
		);
		await handle(readUrl, new Request("http://localhost/provider-apps"));

		for (let index = 0; index < 3; index++) {
			const response = await handle(
				new URL(
					"http://localhost/provider-apps?provider_id=codex&limit=50&refresh=1",
				),
				new Request("http://localhost/provider-apps"),
			);
			expect(await response?.json()).toMatchObject({ refreshing: true });
		}
		expect(listApps).toHaveBeenCalledOnce();

		normal.resolve(catalog(1));
		await normal.promise;
		await vi.waitFor(() => expect(listApps).toHaveBeenCalledTimes(2));
		expect(listApps).toHaveBeenLastCalledWith({
			cwd: "/work/project",
			limit: 50,
			refresh: true,
		});
		const refreshing = await handle(
			readUrl,
			new Request("http://localhost/provider-apps"),
		);
		expect(await refreshing?.json()).toMatchObject({
			observedAt: 1,
			refreshing: true,
		});

		forced.resolve(catalog(2));
		await forced.promise;
		await vi.waitFor(async () => {
			const response = await handle(
				readUrl,
				new Request("http://localhost/provider-apps"),
			);
			expect(await response?.json()).toMatchObject({ observedAt: 2 });
		});
		expect(listApps).toHaveBeenCalledTimes(2);
	});

	it("refuses new scopes when all bounded cache entries are in flight", async () => {
		const listApps = vi
			.fn()
			.mockReturnValue(new Promise<ProviderAppCatalogPage>(() => {}));
		const handle = createProviderAppRouteHandler({
			getProvider: () => provider({ listApps }),
			loadConfig: config,
		});

		for (let index = 0; index < 100; index++) {
			const response = await handle(
				new URL(
					`http://localhost/provider-apps?provider_id=codex&session_id=scope-${index}`,
				),
				new Request("http://localhost/provider-apps"),
			);
			expect(response?.status).toBe(200);
		}
		expect(listApps).toHaveBeenCalledTimes(100);

		const overflow = await handle(
			new URL(
				"http://localhost/provider-apps?provider_id=codex&session_id=overflow",
			),
			new Request("http://localhost/provider-apps"),
		);
		expect(overflow?.status).toBe(409);
		expect(await overflow?.json()).toEqual({
			error: "Provider app inventory is busy. Try again shortly.",
		});

		const original = await handle(
			new URL(
				"http://localhost/provider-apps?provider_id=codex&session_id=scope-0",
			),
			new Request("http://localhost/provider-apps"),
		);
		expect(await original?.json()).toMatchObject({ refreshing: true });
		expect(listApps).toHaveBeenCalledTimes(100);
	});

	it("recovers from a failed cold load when the user refreshes", async () => {
		const listApps = vi
			.fn()
			.mockRejectedValueOnce(new Error("provider startup failed"))
			.mockResolvedValueOnce(catalog(2));
		const handle = createProviderAppRouteHandler({
			getProvider: () => provider({ listApps }),
			loadConfig: config,
		});
		const readUrl = new URL(
			"http://localhost/provider-apps?provider_id=codex&limit=50",
		);

		expect(
			await (
				await handle(readUrl, new Request("http://localhost/provider-apps"))
			)?.json(),
		).toMatchObject({ refreshing: true });
		await vi.waitFor(async () => {
			const response = await handle(
				readUrl,
				new Request("http://localhost/provider-apps"),
			);
			expect(response?.status).toBe(409);
		});

		const retry = await handle(
			new URL(
				"http://localhost/provider-apps?provider_id=codex&limit=50&refresh=1",
			),
			new Request("http://localhost/provider-apps"),
		);
		expect(await retry?.json()).toMatchObject({ refreshing: true });
		await vi.waitFor(async () => {
			const response = await handle(
				readUrl,
				new Request("http://localhost/provider-apps"),
			);
			expect(await response?.json()).toMatchObject({
				status: "current",
				observedAt: 2,
			});
		});
		expect(listApps).toHaveBeenCalledTimes(2);
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

	it("invalidates the provider catalog after authentication starts", async () => {
		const listApps = vi.fn().mockResolvedValue(catalog());
		const startAppAuthentication = vi.fn().mockResolvedValue({ opened: true });
		const handle = createProviderAppRouteHandler({
			getProvider: () => provider({ listApps, startAppAuthentication }),
			loadConfig: config,
		});
		const readUrl = new URL(
			"http://localhost/provider-apps?provider_id=codex&limit=50",
		);
		await handle(readUrl, new Request("http://localhost/provider-apps"));
		await vi.waitFor(async () => {
			const response = await handle(
				readUrl,
				new Request("http://localhost/provider-apps"),
			);
			expect(await response?.json()).toMatchObject({ status: "current" });
		});
		expect(listApps).toHaveBeenCalledOnce();

		await handle(
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

		const reloading = await handle(
			readUrl,
			new Request("http://localhost/provider-apps"),
		);
		expect(await reloading?.json()).toMatchObject({ refreshing: true });
		expect(listApps).toHaveBeenCalledTimes(2);
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
