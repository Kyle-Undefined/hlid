import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { getSetting, saveSetting } = vi.hoisted(() => ({
	getSetting: vi.fn(),
	saveSetting: vi.fn(),
}));

vi.mock("../db", () => ({ getSetting, saveSetting }));

import { HlidConfigSchema } from "../config";
import { AcpRegistry, resolveAcpInvocation } from "./acpRegistry";
import { acpExecutionTargetId } from "./acpTargets";

const registry = {
	version: "1",
	agents: [
		{
			id: "other",
			name: "Other",
			version: "1.0.0",
			description: "Other agent",
			distribution: { npx: { package: "other-acp@1.0.0" } },
		},
		{
			id: "opencode",
			name: "OpenCode",
			version: "1.0.0",
			description: "Open agent",
			distribution: { npx: { package: "opencode-ai@1.0.0", args: ["acp"] } },
		},
	],
};
const temporaryDirectories: string[] = [];

function deferred<T>(): {
	promise: Promise<T>;
	resolve: (value: T) => void;
} {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((resolvePromise) => {
		resolve = resolvePromise;
	});
	return { promise, resolve };
}

afterEach(async () => {
	await Promise.all(
		temporaryDirectories
			.splice(0)
			.map((path) => rm(path, { recursive: true, force: true })),
	);
});

beforeEach(() => {
	vi.clearAllMocks();
	getSetting.mockResolvedValue(null);
	saveSetting.mockResolvedValue(undefined);
	globalThis.Bun = {
		which: vi.fn((command: string) =>
			command === "custom-open" ? "/bin/custom-open" : null,
		),
	} as unknown as typeof Bun;
});

describe("AcpRegistry", () => {
	it("validates, persists, and features OpenCode", async () => {
		const catalog = await new AcpRegistry(async () => registry).catalog(
			HlidConfigSchema.parse({}),
			true,
		);
		expect(catalog.map((item) => item.id)).toEqual(["opencode", "other"]);
		expect(saveSetting).toHaveBeenCalledWith(
			"acp_registry_catalog",
			JSON.stringify(registry),
		);
	});

	it("uses saved executable and argument overrides", async () => {
		const catalog = await new AcpRegistry(async () => registry, undefined, {
			which: (command) =>
				command === "custom-open" ? "/bin/custom-open" : null,
		}).catalog(
			HlidConfigSchema.parse({
				acp_agents: [
					{ id: "opencode", executable: "custom-open", args: ["serve"] },
				],
			}),
			true,
		);
		expect(catalog[0]).toMatchObject({
			enabled: true,
			available: true,
			resolvedExecutable: "/bin/custom-open",
			command: "custom-open",
			args: ["serve"],
			providerId: "acp:opencode",
		});
	});

	it("falls back to bundled OpenCode and Pi when fetch and persistence fail", async () => {
		getSetting.mockRejectedValue(new Error("offline"));
		const catalog = await new AcpRegistry(async () => {
			throw new Error("offline");
		}).catalog(HlidConfigSchema.parse({}), true);
		expect(catalog.slice(0, 2).map((item) => item.id)).toEqual([
			"opencode",
			"pi-acp",
		]);
	});

	it("serves the persisted snapshot while refreshing normal reads", async () => {
		getSetting.mockResolvedValue(JSON.stringify(registry));
		let resolveFetch!: (value: typeof registry) => void;
		const fetcher = vi.fn(
			() =>
				new Promise<typeof registry>((resolve) => {
					resolveFetch = resolve;
				}),
		);
		const onChange = vi.fn();
		const instance = new AcpRegistry(fetcher, onChange);

		const catalog = await instance.catalog(HlidConfigSchema.parse({}));

		expect(catalog.map((item) => item.id)).toEqual(["opencode", "other"]);
		expect(fetcher).toHaveBeenCalledOnce();
		expect(onChange).not.toHaveBeenCalled();

		resolveFetch({
			...registry,
			version: "2",
			agents: registry.agents.map((agent) => ({ ...agent, version: "2.0.0" })),
		});
		await vi.waitFor(() => expect(onChange).toHaveBeenCalledOnce());
		expect(
			(await instance.catalog(HlidConfigSchema.parse({})))[0]?.version,
		).toBe("2.0.0");
	});

	it("waits for live discovery only on an explicit refresh", async () => {
		getSetting.mockResolvedValue(JSON.stringify(registry));
		const refreshed = {
			...registry,
			version: "2",
			agents: registry.agents.map((agent) => ({ ...agent, version: "2.0.0" })),
		};
		const instance = new AcpRegistry(async () => refreshed);

		const catalog = await instance.catalog(HlidConfigSchema.parse({}), true);

		expect(catalog[0]?.version).toBe("2.0.0");
	});

	it("caches the materialized availability scan until its inputs change", async () => {
		const which = vi.fn((command: string) =>
			command === "custom-open" ? "/bin/custom-open" : null,
		);
		const instance = new AcpRegistry(async () => registry, undefined, {
			which,
		});
		const baseConfig = HlidConfigSchema.parse({
			acp_agents: [{ id: "opencode" }],
		});

		await instance.catalog(baseConfig, true);
		await instance.catalog(baseConfig);
		expect(which).toHaveBeenCalledOnce();

		await instance.catalog(
			HlidConfigSchema.parse({
				acp_agents: [{ id: "opencode", executable: "custom-open" }],
			}),
		);
		expect(which).toHaveBeenCalledTimes(2);
	});

	it("warns only when a full availability scan reaches one second", async () => {
		let now = 0;
		const performanceNow = vi
			.spyOn(performance, "now")
			.mockImplementation(() => now);
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			const scanAt = async (elapsedMs: number) => {
				const instance = new AcpRegistry(async () => registry, undefined, {
					which: async () => {
						now = elapsedMs;
						return null;
					},
				});
				await instance.catalog(
					HlidConfigSchema.parse({ acp_agents: [{ id: "opencode" }] }),
					true,
				);
			};

			await scanAt(999);
			expect(warn).not.toHaveBeenCalled();

			now = 0;
			await scanAt(1_000);
			expect(warn).toHaveBeenCalledWith(
				"[acp registry] availability scan for configured ACP agents took 1000ms",
			);
		} finally {
			performanceNow.mockRestore();
			warn.mockRestore();
		}
	});

	it("keeps targeted availability scans on the fast-path warning threshold", async () => {
		let now = 0;
		const performanceNow = vi
			.spyOn(performance, "now")
			.mockImplementation(() => now);
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			const scanAt = async (elapsedMs: number) => {
				const instance = new AcpRegistry(async () => registry, undefined, {
					which: async () => {
						now = elapsedMs;
						return null;
					},
				});
				await instance.catalog(
					HlidConfigSchema.parse({ acp_agents: [{ id: "opencode" }] }),
					true,
					false,
					{ agentIds: ["opencode"] },
				);
			};

			await scanAt(249);
			expect(warn).not.toHaveBeenCalled();

			now = 0;
			await scanAt(250);
			expect(warn).toHaveBeenCalledWith(
				"[acp registry] availability scan for configured ACP agents took 250ms",
			);
		} finally {
			performanceNow.mockRestore();
			warn.mockRestore();
		}
	});

	it("allows bounded WSL platform discovery teardown before warning", async () => {
		let now = 0;
		const performanceNow = vi
			.spyOn(performance, "now")
			.mockImplementation(() => now);
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const config = HlidConfigSchema.parse({
			vault: {
				path: "\\\\wsl.localhost\\Ubuntu-24.04\\home\\kyle\\vault",
			},
		});
		const platformWarnings = () =>
			warn.mock.calls
				.map(([message]) => String(message))
				.filter((message) => message.startsWith("[acp registry platform]"));
		try {
			const discoverAt = async (elapsedMs: number) => {
				const instance = new AcpRegistry(async () => registry, undefined, {
					platform: "win32",
					architecture: "x64",
					which: () => null,
					adapterFactory: (target) =>
						({
							target: target ?? { kind: "host" },
							key: target?.kind === "wsl" ? `wsl:${target.distro}` : "host",
							registryPlatform: async () => {
								now = elapsedMs;
								return {
									platform: "linux" as const,
									architecture: "x64" as const,
								};
							},
							providerPath: (_cwd: string, path: string) => path,
							pathAccessible: () => true,
							resolveExecutable: vi.fn(async () => null),
							start: vi.fn(),
							adaptMcpServer: <T>(server: T) => server,
						}) as never,
				});
				await instance.catalog(config, false, false, {
					agentIds: ["opencode"],
				});
			};

			await discoverAt(2_999);
			expect(platformWarnings()).toEqual([]);

			now = 0;
			await discoverAt(3_000);
			expect(platformWarnings()).toEqual([
				"[acp registry platform] platform discovery for WSL · Ubuntu-24.04 took 3000ms",
			]);
		} finally {
			performanceNow.mockRestore();
			warn.mockRestore();
		}
	});

	it("single-flights concurrent materialization for the same exact inputs", async () => {
		getSetting.mockResolvedValue(JSON.stringify(registry));
		const executable = deferred<string | null>();
		const which = vi.fn(() => executable.promise);
		const instance = new AcpRegistry(() => new Promise(() => {}), undefined, {
			which,
		});
		const config = HlidConfigSchema.parse({
			acp_agents: [{ id: "opencode" }],
		});
		const options = { agentIds: ["opencode"] };

		const first = instance.catalog(config, false, false, options);
		const second = instance.catalog(config, false, false, options);
		await vi.waitFor(() => expect(which).toHaveBeenCalledOnce());

		executable.resolve("/bin/opencode");
		const [firstCatalog, secondCatalog] = await Promise.all([first, second]);

		expect(firstCatalog[0]?.resolvedExecutable).toBe("/bin/opencode");
		expect(secondCatalog[0]?.resolvedExecutable).toBe("/bin/opencode");
		expect(which).toHaveBeenCalledOnce();
	});

	it("does not let an older materialization overwrite an explicit refresh", async () => {
		const staleExecutable = deferred<string | null>();
		const freshExecutable = deferred<string | null>();
		let probe = 0;
		const which = vi.fn(() => {
			probe += 1;
			return probe === 1 ? staleExecutable.promise : freshExecutable.promise;
		});
		const instance = new AcpRegistry(async () => registry, undefined, {
			which,
		});
		const config = HlidConfigSchema.parse({
			acp_agents: [{ id: "opencode" }],
		});
		const options = { agentIds: ["opencode"] };

		const stale = instance.catalog(config, true, false, options);
		await vi.waitFor(() => expect(which).toHaveBeenCalledTimes(1));
		const fresh = instance.catalog(config, true, false, options);
		await vi.waitFor(() => expect(which).toHaveBeenCalledTimes(2));

		freshExecutable.resolve("/bin/fresh-opencode");
		expect((await fresh)[0]?.resolvedExecutable).toBe("/bin/fresh-opencode");
		staleExecutable.resolve("/bin/stale-opencode");
		expect((await stale)[0]?.resolvedExecutable).toBe("/bin/stale-opencode");

		const cached = await instance.catalog(config, false, false, options);
		expect(cached[0]?.resolvedExecutable).toBe("/bin/fresh-opencode");
		expect(which).toHaveBeenCalledTimes(2);
	});

	it("materializes runtime agent scopes without replacing the full catalog cache", async () => {
		const which = vi.fn(async (command: string) => `/bin/${command}`);
		const instance = new AcpRegistry(async () => registry, undefined, {
			which,
		});
		const config = HlidConfigSchema.parse({
			acp_agents: [{ id: "opencode" }, { id: "other" }],
		});

		const scoped = await instance.catalog(config, true, false, {
			agentIds: ["opencode"],
		});
		const cachedScoped = await instance.catalog(config, false, false, {
			agentIds: ["opencode"],
		});
		const complete = await instance.catalog(config);
		const cachedComplete = await instance.catalog(config);

		expect(scoped.map((item) => item.id)).toEqual(["opencode"]);
		expect(cachedScoped.map((item) => item.id)).toEqual(["opencode"]);
		expect(complete.map((item) => item.id)).toEqual(["opencode", "other"]);
		expect(cachedComplete.map((item) => item.id)).toEqual([
			"opencode",
			"other",
		]);
		expect(which).toHaveBeenCalledTimes(3);
	});

	it("does not probe execution targets for an empty runtime scope", async () => {
		const adapterFactory = vi.fn();
		const instance = new AcpRegistry(async () => registry, undefined, {
			platform: "win32",
			adapterFactory,
		});

		const catalog = await instance.catalog(
			HlidConfigSchema.parse({
				vault: {
					path: "\\\\wsl.localhost\\Ubuntu-24.04\\home\\kyle\\vault",
				},
			}),
			true,
			false,
			{ agentIds: [] },
		);

		expect(catalog).toEqual([]);
		expect(adapterFactory).not.toHaveBeenCalled();
	});

	it("does not retain materialized cache entries for unknown agent scopes", async () => {
		const instance = new AcpRegistry(async () => registry);
		const config = HlidConfigSchema.parse({});

		for (let index = 0; index < 200; index += 1) {
			await expect(
				instance.catalog(config, false, false, {
					agentIds: [`unknown-${index}`],
				}),
			).resolves.toEqual([]);
		}

		const materializedCatalogs = (
			instance as unknown as {
				materializedCatalogs: Map<string, unknown>;
			}
		).materializedCatalogs;
		expect(materializedCatalogs.size).toBe(0);
	});

	it("does not probe unconfigured catalog commands", async () => {
		const which = vi.fn(
			async (
				_command: string,
				_options?: { cwd?: string; env?: Record<string, string | undefined> },
			) => "/bin/shared-acp",
		);
		const sharedRegistry = {
			version: "1",
			agents: ["first", "second"].map((id) => ({
				id,
				name: id,
				version: "1.0.0",
				description: "Shared launcher",
				distribution: { npx: { package: "shared-acp@1.0.0" } },
			})),
		};
		const instance = new AcpRegistry(async () => sharedRegistry, undefined, {
			which,
		});

		const catalog = await instance.catalog(HlidConfigSchema.parse({}), true);

		expect(catalog).toHaveLength(2);
		expect(which).not.toHaveBeenCalled();
		expect(catalog.every((item) => item.available === false)).toBe(true);
	});

	it("probes only the configured host harness", async () => {
		const resolveExecutable = vi.fn(
			async (command: string) => `/host/${command}`,
		);
		const instance = new AcpRegistry(async () => registry, undefined, {
			which: resolveExecutable,
			adapterFactory: (target) =>
				({
					target: target ?? { kind: "host" },
					key: "host",
					registryPlatform: async () => ({
						platform: process.platform,
						architecture: process.arch,
					}),
					providerPath: (_cwd: string, path: string) => path,
					pathAccessible: () => true,
					resolveExecutable,
					start: vi.fn(),
					adaptMcpServer: <T>(server: T) => server,
				}) as never,
		});

		const catalog = await instance.catalog(
			HlidConfigSchema.parse({ acp_agents: [{ id: "opencode" }] }),
			true,
		);

		expect(resolveExecutable).toHaveBeenCalledOnce();
		expect(resolveExecutable).toHaveBeenCalledWith(
			"opencode-ai",
			expect.any(Object),
		);
		expect(catalog.find((item) => item.id === "opencode")?.available).toBe(
			true,
		);
		expect(catalog.find((item) => item.id === "other")?.available).toBe(false);
	});

	it("keeps executable probes separate when their exact environments differ", async () => {
		const which = vi.fn(
			async (
				_command: string,
				_options?: { cwd?: string; env?: Record<string, string | undefined> },
			) => "/bin/shared-acp",
		);
		const sharedRegistry = {
			version: "1",
			agents: ["first", "second"].map((id, index) => ({
				id,
				name: id,
				version: "1.0.0",
				description: "Shared launcher",
				distribution: {
					npx: {
						package: "shared-acp@1.0.0",
						env: { ACP_ENV: index === 0 ? "one" : "two" },
					},
				},
			})),
		};
		const instance = new AcpRegistry(async () => sharedRegistry, undefined, {
			which,
		});

		await instance.catalog(
			HlidConfigSchema.parse({
				acp_agents: [{ id: "first" }, { id: "second" }],
			}),
			true,
		);

		expect(which).toHaveBeenCalledTimes(2);
		expect(
			which.mock.calls.map(([, options]) => options?.env?.ACP_ENV),
		).toEqual(["one", "two"]);
	});

	it("checks WSL liveness without probing unconfigured catalog commands", async () => {
		const resolveExecutable = vi.fn(async () => null);
		const registryPlatform = vi.fn(async () => ({
			platform: "linux" as const,
			architecture: "x64" as const,
		}));
		const instance = new AcpRegistry(async () => registry, undefined, {
			platform: "win32",
			architecture: "x64",
			which: () => null,
			adapterFactory: (target) =>
				({
					target: target ?? { kind: "host" },
					key: target?.kind === "wsl" ? `wsl:${target.distro}` : "host",
					registryPlatform,
					providerPath: (_cwd: string, path: string) => path,
					pathAccessible: () => true,
					resolveExecutable,
					start: vi.fn(),
					adaptMcpServer: <T>(server: T) => server,
				}) as never,
		});

		const catalog = await instance.catalog(
			HlidConfigSchema.parse({
				vault: {
					path: "\\\\wsl.localhost\\Ubuntu-24.04\\home\\kyle\\vault",
				},
			}),
			true,
		);

		expect(resolveExecutable).not.toHaveBeenCalled();
		expect(registryPlatform).toHaveBeenCalledOnce();
		expect(
			catalog.every(
				(item) =>
					item.targets.find((target) => target.target.kind === "wsl")
						?.available === false,
			),
		).toBe(true);
	});

	it("reuses one exact-target WSL platform discovery across catalog scopes", async () => {
		const registryPlatform = vi.fn(async () => ({
			platform: "linux" as const,
			architecture: "x64" as const,
		}));
		const instance = new AcpRegistry(async () => registry, undefined, {
			platform: "win32",
			architecture: "x64",
			which: () => null,
			adapterFactory: (target) =>
				({
					target: target ?? { kind: "host" },
					key: target?.kind === "wsl" ? `wsl:${target.distro}` : "host",
					registryPlatform,
					providerPath: (_cwd: string, path: string) => path,
					pathAccessible: () => true,
					resolveExecutable: vi.fn(async () => null),
					start: vi.fn(),
					adaptMcpServer: <T>(server: T) => server,
				}) as never,
		});
		const config = HlidConfigSchema.parse({
			vault: {
				path: "\\\\wsl.localhost\\Ubuntu-24.04\\home\\kyle\\vault",
			},
		});

		await instance.catalog(config, false, false, { agentIds: ["opencode"] });
		await instance.catalog(config);

		expect(registryPlatform).toHaveBeenCalledOnce();
	});

	it("retries a failed WSL platform discovery after the short failure TTL", async () => {
		let now = 1_000;
		const registryPlatform = vi
			.fn()
			.mockRejectedValueOnce(new Error("WSL is starting"))
			.mockResolvedValue({ platform: "linux", architecture: "x64" });
		const instance = new AcpRegistry(async () => registry, undefined, {
			now: () => now,
			platform: "win32",
			platformFailureTtlMs: 10,
			which: () => null,
			adapterFactory: (target) =>
				({
					target: target ?? { kind: "host" },
					key: target?.kind === "wsl" ? `wsl:${target.distro}` : "host",
					registryPlatform,
					providerPath: (_cwd: string, path: string) => path,
					pathAccessible: () => true,
					resolveExecutable: vi.fn(async () => null),
					start: vi.fn(),
					adaptMcpServer: <T>(server: T) => server,
				}) as never,
		});
		const config = HlidConfigSchema.parse({
			vault: {
				path: "\\\\wsl.localhost\\Ubuntu-24.04\\home\\kyle\\vault",
			},
		});
		const first = await instance.catalog(config, false, false, {
			agentIds: ["opencode"],
		});
		expect(
			first[0]?.targets.find((target) => target.target.kind === "wsl"),
		).toMatchObject({ platformTarget: "linux-unknown" });
		now += 11;
		const second = await instance.catalog(config, false, false, {
			agentIds: ["other"],
		});

		expect(registryPlatform).toHaveBeenCalledTimes(2);
		expect(
			second[0]?.targets.find((target) => target.target.kind === "wsl"),
		).toMatchObject({ platformTarget: "linux-x86_64" });
	});

	it("preserves last-good WSL platform evidence after a forced retry fails", async () => {
		const target = { kind: "wsl" as const, distro: "Ubuntu-24.04" };
		const resolveExecutable = vi.fn(async () => "/usr/bin/opencode");
		const registryPlatform = vi
			.fn()
			.mockResolvedValueOnce({ platform: "linux", architecture: "x64" })
			.mockRejectedValueOnce(new Error("WSL timed out"));
		const instance = new AcpRegistry(async () => registry, undefined, {
			platform: "win32",
			which: () => null,
			managed: {
				managedRecord: () => null,
				resolveManagedInvocation: () => null,
				targetState: () => ({}),
				installSupport: () => ({ supported: true }),
			},
			adapterFactory: (target) =>
				({
					target: target ?? { kind: "host" },
					key: target?.kind === "wsl" ? `wsl:${target.distro}` : "host",
					registryPlatform,
					providerPath: (_cwd: string, path: string) => path,
					pathAccessible: () => true,
					resolveExecutable,
					start: vi.fn(),
					adaptMcpServer: <T>(server: T) => server,
				}) as never,
		});
		const config = HlidConfigSchema.parse({
			vault: {
				path: "\\\\wsl.localhost\\Ubuntu-24.04\\home\\kyle\\vault",
			},
			acp_agents: [{ id: "opencode", target }],
		});

		await instance.catalog(config, false, false, { agentIds: ["opencode"] });
		const refreshed = await instance.catalog(config, true, true, {
			agentIds: ["other"],
		});
		await vi.waitFor(() => expect(registryPlatform).toHaveBeenCalledTimes(2));

		expect(
			refreshed[0]?.targets.find((target) => target.target.kind === "wsl"),
		).toMatchObject({ platformTarget: "linux-x86_64" });

		const afterFailure = await instance.catalog(config, false, false, {
			agentIds: ["opencode"],
		});
		expect(
			afterFailure[0]?.targets.find((target) => target.target.kind === "wsl"),
		).toMatchObject({
			platformTarget: "linux-x86_64",
			available: true,
			canEnable: true,
			canUpdate: false,
			blockedReason: undefined,
		});
	});

	it("returns last-good platform evidence while one forced refresh runs", async () => {
		const background = deferred<{
			platform: "linux";
			architecture: "arm64";
		}>();
		const registryPlatform = vi
			.fn()
			.mockResolvedValueOnce({ platform: "linux", architecture: "x64" })
			.mockImplementation(() => background.promise);
		const instance = new AcpRegistry(async () => registry, undefined, {
			platform: "win32",
			which: () => null,
			adapterFactory: (target) =>
				({
					target: target ?? { kind: "host" },
					key: target?.kind === "wsl" ? `wsl:${target.distro}` : "host",
					registryPlatform,
					providerPath: (_cwd: string, path: string) => path,
					pathAccessible: () => true,
					resolveExecutable: vi.fn(async () => null),
					start: vi.fn(),
					adaptMcpServer: <T>(server: T) => server,
				}) as never,
		});
		const config = HlidConfigSchema.parse({
			vault: {
				path: "\\\\wsl.localhost\\Ubuntu-24.04\\home\\kyle\\vault",
			},
		});

		await instance.catalog(config, false, false, { agentIds: ["opencode"] });
		const firstRefresh = instance.catalog(config, true, true, {
			agentIds: ["other"],
		});
		const secondRefresh = instance.catalog(config, true, true, {
			agentIds: ["other"],
		});
		const [first, second] = await Promise.all([firstRefresh, secondRefresh]);

		expect(registryPlatform).toHaveBeenCalledTimes(2);
		expect(
			first[0]?.targets.find((target) => target.target.kind === "wsl"),
		).toMatchObject({ platformTarget: "linux-x86_64" });
		expect(
			second[0]?.targets.find((target) => target.target.kind === "wsl"),
		).toMatchObject({ platformTarget: "linux-x86_64" });

		background.resolve({ platform: "linux", architecture: "arm64" });
		await vi.waitFor(async () => {
			const next = await instance.catalog(config, false, false, {
				agentIds: ["opencode"],
			});
			expect(
				next[0]?.targets.find((target) => target.target.kind === "wsl"),
			).toMatchObject({ platformTarget: "linux-aarch64" });
		});
	});

	it("hydrates persisted WSL platform evidence without a second startup probe", async () => {
		const target = { kind: "wsl" as const, distro: "Ubuntu-24.04" };
		const targetKey = "wsl:ubuntu-24.04";
		const targetId = acpExecutionTargetId(target);
		const hydration = deferred<{
			targetKey: string;
			targetId: string;
			platform: "linux";
			architecture: "x64";
			observedAt: number;
		} | null>();
		const load = vi.fn(() => hydration.promise);
		const save = vi.fn(async () => {});
		const onPlatformChange = vi.fn();
		const registryPlatform = vi.fn(async () => ({
			platform: "linux" as const,
			architecture: "arm64" as const,
		}));
		const instance = new AcpRegistry(async () => registry, undefined, {
			platform: "win32",
			which: () => null,
			platformEvidence: { load, save },
			onPlatformChange,
			adapterFactory: (adapterTarget) =>
				({
					target: adapterTarget ?? { kind: "host" },
					key:
						adapterTarget?.kind === "wsl"
							? `wsl:${adapterTarget.distro}`
							: "host",
					registryPlatform,
					providerPath: (_cwd: string, path: string) => path,
					pathAccessible: () => true,
					resolveExecutable: vi.fn(async () => null),
					start: vi.fn(),
					adaptMcpServer: <T>(server: T) => server,
				}) as never,
		});
		const config = HlidConfigSchema.parse({
			vault: {
				path: "\\\\wsl.localhost\\Ubuntu-24.04\\home\\kyle\\vault",
			},
		});
		await instance.snapshot(true);

		const first = instance.catalog(config, false, false, {
			agentIds: ["opencode"],
		});
		const second = instance.catalog(config, false, false, {
			agentIds: ["other"],
		});
		await vi.waitFor(() => expect(load).toHaveBeenCalledOnce());
		hydration.resolve({
			targetKey,
			targetId,
			platform: "linux",
			architecture: "x64",
			observedAt: 1,
		});
		const catalogs = await Promise.all([first, second]);

		expect(registryPlatform).not.toHaveBeenCalled();
		expect(
			catalogs.map((catalog) =>
				catalog.map((item) => ({
					id: item.id,
					platformTargets: item.targets.map((status) => status.platformTarget),
				})),
			),
		).toEqual([
			[{ id: "opencode", platformTargets: ["windows-x86_64", "linux-x86_64"] }],
			[{ id: "other", platformTargets: ["windows-x86_64", "linux-x86_64"] }],
		]);
		expect(save).not.toHaveBeenCalled();
		expect(
			catalogs[0]?.[0]?.targets.find((status) => status.target.kind === "wsl"),
		).toMatchObject({
			available: false,
			canEnable: false,
			canInstall: false,
			canUpdate: false,
			blockedReason: "Managed ACP installation is unavailable",
		});
		expect(onPlatformChange).not.toHaveBeenCalled();
	});

	it("keeps persisted WSL evidence after a failed background refresh", async () => {
		const target = { kind: "wsl" as const, distro: "Ubuntu-24.04" };
		const targetId = acpExecutionTargetId(target);
		const registryPlatform = vi.fn(async () => {
			throw new Error("WSL timed out");
		});
		const onPlatformChange = vi.fn();
		const instance = new AcpRegistry(async () => registry, undefined, {
			platform: "win32",
			which: () => null,
			platformEvidence: {
				load: vi.fn(async () => ({
					targetKey: "wsl:ubuntu-24.04",
					targetId,
					platform: "linux" as const,
					architecture: "x64" as const,
					observedAt: 1,
				})),
				save: vi.fn(async () => {
					throw new Error("storage unavailable");
				}),
			},
			onPlatformChange,
			adapterFactory: (adapterTarget) =>
				({
					target: adapterTarget ?? { kind: "host" },
					key:
						adapterTarget?.kind === "wsl"
							? `wsl:${adapterTarget.distro}`
							: "host",
					registryPlatform,
					providerPath: (_cwd: string, path: string) => path,
					pathAccessible: () => true,
					resolveExecutable: vi.fn(async () => null),
					start: vi.fn(),
					adaptMcpServer: <T>(server: T) => server,
				}) as never,
		});
		const config = HlidConfigSchema.parse({
			vault: {
				path: "\\\\wsl.localhost\\Ubuntu-24.04\\home\\kyle\\vault",
			},
		});
		await instance.snapshot(true);

		const first = await instance.catalog(config, false, false, {
			agentIds: ["opencode"],
		});
		expect(
			first[0]?.targets.find((status) => status.target.kind === "wsl"),
		).toMatchObject({
			platformTarget: "linux-x86_64",
			available: false,
			canEnable: false,
			blockedReason: "Managed ACP installation is unavailable",
		});
		await instance.catalog(config, false, true, {
			agentIds: ["other"],
		});
		await vi.waitFor(() => expect(registryPlatform).toHaveBeenCalledOnce());
		await vi.waitFor(async () => {
			const afterFailure = await instance.catalog(config, false, false, {
				agentIds: ["other"],
			});
			expect(
				afterFailure[0]?.targets.find((status) => status.target.kind === "wsl"),
			).toMatchObject({
				platformTarget: "linux-x86_64",
				available: false,
				blockedReason: "Managed ACP installation is unavailable",
			});
		});
		expect(onPlatformChange).not.toHaveBeenCalled();
	});

	it("probes only configured WSL harnesses with their exact environments", async () => {
		const resolveExecutable = vi.fn(
			async (
				command: string,
				_options: {
					env: Record<string, string | undefined>;
					forwardedEnvNames?: string[];
				},
			) => `/usr/bin/${command}`,
		);
		const instance = new AcpRegistry(async () => registry, undefined, {
			platform: "win32",
			which: () => null,
			adapterFactory: (target) =>
				({
					target: target ?? { kind: "host" },
					key: target?.kind === "wsl" ? `wsl:${target.distro}` : "host",
					registryPlatform: async () => ({
						platform: target?.kind === "wsl" ? "linux" : "win32",
						architecture: "x64",
					}),
					providerPath: (_cwd: string, path: string) => path,
					pathAccessible: () => true,
					resolveExecutable,
					start: vi.fn(),
					adaptMcpServer: <T>(server: T) => server,
				}) as never,
		});
		const target = { kind: "wsl" as const, distro: "Ubuntu-24.04" };

		await instance.catalog(
			HlidConfigSchema.parse({
				vault: {
					path: "\\\\wsl.localhost\\Ubuntu-24.04\\home\\kyle\\vault",
				},
				acp_agents: [
					{ id: "other", target, env: { AGENT_TOKEN: "one" } },
					{ id: "opencode", target, env: { AGENT_TOKEN: "two" } },
				],
			}),
			true,
		);

		expect(
			resolveExecutable.mock.calls.map(([command, options]) => ({
				command,
				token: options.env.AGENT_TOKEN,
				forwardedEnvNames: options.forwardedEnvNames,
			})),
		).toEqual([
			{
				command: "other-acp",
				token: "one",
				forwardedEnvNames: ["AGENT_TOKEN"],
			},
			{
				command: "opencode-ai",
				token: "two",
				forwardedEnvNames: ["AGENT_TOKEN"],
			},
		]);
	});

	it("refreshes local executable evidence without refreshing registry metadata", async () => {
		const root = await mkdtemp(join(tmpdir(), "hlid-acp-evidence-"));
		temporaryDirectories.push(root);
		const launcher = join(root, "other-acp");
		await writeFile(launcher, "one");
		const fetcher = vi.fn(async () => registry);
		const instance = new AcpRegistry(fetcher, undefined, {
			which: (command) => (command === "other-acp" ? launcher : null),
		});
		const runtimeConfig = HlidConfigSchema.parse({
			acp_agents: [{ id: "other" }],
		});

		const first = await instance.catalog(runtimeConfig, true);
		const firstEvidence = first.find(
			(entry) => entry.id === "other",
		)?.runtimeExecutableEvidence;
		await writeFile(launcher, "changed executable bytes");
		const second = await instance.catalog(runtimeConfig, false, true);
		const secondEvidence = second.find(
			(entry) => entry.id === "other",
		)?.runtimeExecutableEvidence;

		expect(firstEvidence?.launcher.pathKey).toBe(
			secondEvidence?.launcher.pathKey,
		);
		expect(firstEvidence?.launcher.size).not.toBe(
			secondEvidence?.launcher.size,
		);
		expect(fetcher).toHaveBeenCalledOnce();
	});

	it("detects OpenCode package changes behind a stable launcher shim", async () => {
		const root = await mkdtemp(join(tmpdir(), "hlid-opencode-evidence-"));
		temporaryDirectories.push(root);
		const launcher = join(root, "opencode");
		const manifest = join(root, "node_modules", "opencode-ai", "package.json");
		await mkdir(join(root, "node_modules", "opencode-ai"), { recursive: true });
		await writeFile(launcher, "stable shim");
		await writeFile(manifest, '{"version":"1.0.0"}');
		const fetcher = vi.fn(async () => registry);
		const instance = new AcpRegistry(fetcher, undefined, {
			which: (command) => (command === "opencode-ai" ? launcher : null),
		});
		const runtimeConfig = HlidConfigSchema.parse({
			acp_agents: [{ id: "opencode" }],
		});

		const first = await instance.catalog(runtimeConfig, true);
		await writeFile(manifest, '{"version":"22.0.0","updated":true}');
		const second = await instance.catalog(runtimeConfig, false, true);

		expect(
			first.find((entry) => entry.id === "opencode")?.runtimeExecutableEvidence
				?.launcher,
		).toEqual(
			second.find((entry) => entry.id === "opencode")?.runtimeExecutableEvidence
				?.launcher,
		);
		expect(
			first.find((entry) => entry.id === "opencode")?.runtimeExecutableEvidence
				?.packageManifest?.size,
		).not.toBe(
			second.find((entry) => entry.id === "opencode")?.runtimeExecutableEvidence
				?.packageManifest?.size,
		);
		expect(fetcher).toHaveBeenCalledOnce();
	});

	it("bounds a nonresponsive executable availability resolver", async () => {
		const instance = new AcpRegistry(async () => registry, undefined, {
			which: () => new Promise(() => {}),
			availabilityProbeTimeoutMs: 20,
		});

		const catalog = await instance.catalog(HlidConfigSchema.parse({}), true);

		expect(catalog.every((item) => item.available === false)).toBe(true);
	});

	it("resolves configured commands relative to the vault workspace", async () => {
		const which = vi.fn(() => null);
		const instance = new AcpRegistry(async () => registry, undefined, {
			which,
		});

		await instance.catalog(
			HlidConfigSchema.parse({
				vault: { path: "/vault/workspace" },
				acp_agents: [{ id: "opencode" }],
			}),
			true,
		);

		expect(which).toHaveBeenCalledWith(
			expect.any(String),
			expect.objectContaining({ cwd: "/vault/workspace" }),
		);
	});

	it.each([
		{
			case: "missing",
			resolvedExecutable: null,
			config: {},
			provenance: "missing",
			canInstall: true,
			blockedReason: undefined,
		},
		{
			case: "externally discovered",
			resolvedExecutable: "C:\\Tools\\opencode.exe",
			config: { acp_agents: [{ id: "opencode" }] },
			provenance: "external",
			canInstall: true,
			blockedReason: undefined,
		},
		{
			case: "configured with a custom executable",
			resolvedExecutable: "C:\\Tools\\custom-opencode.exe",
			config: {
				acp_agents: [
					{ id: "opencode", executable: "C:\\Tools\\custom-opencode.exe" },
				],
			},
			provenance: "external",
			canInstall: false,
			blockedReason:
				"Clear the custom executable override before moving this target under Hlid management",
		},
	])("derives managed installation availability for a $case Windows host binary", async ({
		resolvedExecutable,
		config,
		provenance,
		canInstall,
		blockedReason,
	}) => {
		const instance = new AcpRegistry(
			async () => ({
				version: "1",
				agents: [
					{
						id: "opencode",
						name: "OpenCode",
						version: "1.18.16",
						description: "Open agent",
						distribution: {
							binary: {
								"windows-x86_64": {
									cmd: "./opencode.exe",
									args: ["acp"],
									archive: "https://example.com/opencode.zip",
									sha256: "a".repeat(64),
								},
							},
						},
					},
				],
			}),
			undefined,
			{
				platform: "win32",
				architecture: "x64",
				which: () => resolvedExecutable,
				managed: {
					managedRecord: () => null,
					resolveManagedInvocation: () => null,
					targetState: () => ({}),
					installSupport: () => ({ supported: true }),
				},
			},
		);

		const [item] = await instance.catalog(HlidConfigSchema.parse(config), true);
		expect(
			item?.targets.find((target) => target.targetId === "host"),
		).toMatchObject({
			target: { kind: "host" },
			label: "Windows",
			platformTarget: "windows-x86_64",
			provenance,
			canInstall,
			canUpdate: false,
			canRemove: false,
			blockedReason,
		});
	});

	it("keeps a managed Windows receipt authoritative over an executable override", async () => {
		const target = { kind: "host" as const };
		const managedRecord = {
			target,
			command: "C:\\Hlid\\integrations\\acp\\opencode.exe",
			args: ["acp"],
			env: {},
			installedVersion: "1.0.0",
			observedVersion: "1.0.0",
			usable: true,
		};
		const instance = new AcpRegistry(
			async () => ({
				version: "1",
				agents: [
					{
						id: "opencode",
						name: "OpenCode",
						version: "1.1.0",
						description: "Open agent",
						distribution: {
							binary: {
								"windows-x86_64": {
									cmd: "./opencode.exe",
									archive: "https://example.com/opencode.zip",
									sha256: "a".repeat(64),
								},
							},
						},
					},
				],
			}),
			undefined,
			{
				platform: "win32",
				architecture: "x64",
				which: (command) =>
					command === managedRecord.command ? managedRecord.command : null,
				managed: {
					managedRecord: () => managedRecord,
					resolveManagedInvocation: () => managedRecord,
					targetState: () => ({}),
					installSupport: () => ({
						supported: true,
						updateAvailable: true,
					}),
				},
			},
		);

		const [item] = await instance.catalog(
			HlidConfigSchema.parse({
				acp_agents: [{ id: "opencode", executable: "external-open.exe" }],
			}),
			true,
		);
		const selected = item?.targets.find((target) => target.selected);
		expect(selected).toMatchObject({
			target,
			provenance: "managed",
			command: managedRecord.command,
			canInstall: false,
			canUpdate: false,
			canRemove: true,
			blockedReason:
				"Remove this Hlid-managed installation before switching to a custom executable",
		});
	});

	it("trusts a validated managed Windows receipt without a fallible PATH probe", async () => {
		const target = { kind: "host" as const };
		const managedRecord = {
			target,
			command: "C:\\Hlid\\integrations\\acp\\opencode.exe",
			args: ["acp"],
			env: {},
			installedVersion: "1.0.0",
			usable: true,
		};
		const which = vi.fn(() => new Promise<null>(() => {}));
		const instance = new AcpRegistry(async () => registry, undefined, {
			platform: "win32",
			architecture: "x64",
			availabilityProbeTimeoutMs: 5,
			which,
			managed: {
				managedRecord: (agentId) =>
					agentId === "opencode" ? managedRecord : null,
				resolveManagedInvocation: (agentId) =>
					agentId === "opencode" ? managedRecord : null,
				targetState: () => ({}),
				installSupport: () => ({ supported: true }),
			},
		});

		const catalog = await instance.catalog(
			HlidConfigSchema.parse({ acp_agents: [{ id: "opencode" }] }),
			true,
		);

		expect(catalog[0]).toMatchObject({
			id: "opencode",
			available: true,
			resolvedExecutable: managedRecord.command,
		});
		expect(
			catalog[0]?.targets.find((status) => status.target.kind === "host"),
		).toMatchObject({
			provenance: "managed",
			available: true,
			resolvedExecutable: managedRecord.command,
		});
		expect(which).not.toHaveBeenCalled();
	});

	it("trusts a validated managed WSL receipt after exact-target liveness succeeds", async () => {
		const target = { kind: "wsl" as const, distro: "Ubuntu-24.04" };
		const managedRecord = {
			target,
			command: "/mnt/c/Hlid/integrations/acp/opencode",
			args: ["acp"],
			env: {},
			installedVersion: "1.0.0",
			usable: true,
		};
		const resolveExecutable = vi.fn(async () => {
			throw new Error("managed WSL receipts must not use a second probe");
		});
		const instance = new AcpRegistry(async () => registry, undefined, {
			platform: "win32",
			architecture: "x64",
			which: () => null,
			adapterFactory: (adapterTarget) =>
				({
					target: adapterTarget ?? { kind: "host" },
					key:
						adapterTarget?.kind === "wsl"
							? `wsl:${adapterTarget.distro}`
							: "host",
					registryPlatform: async () => ({
						platform: "linux",
						architecture: "x64",
					}),
					providerPath: (_cwd: string, path: string) => path,
					pathAccessible: () => true,
					resolveExecutable,
					start: vi.fn(),
					adaptMcpServer: <T>(server: T) => server,
				}) as never,
			managed: {
				managedRecord: (agentId, managedTarget) =>
					agentId === "opencode" && managedTarget.kind === "wsl"
						? managedRecord
						: null,
				resolveManagedInvocation: (agentId, managedTarget) =>
					agentId === "opencode" && managedTarget.kind === "wsl"
						? managedRecord
						: null,
				targetState: () => ({}),
				installSupport: () => ({ supported: true }),
			},
		});

		const [item] = await instance.catalog(
			HlidConfigSchema.parse({
				vault: {
					path: "\\\\wsl.localhost\\Ubuntu-24.04\\home\\kyle\\vault",
				},
				acp_agents: [{ id: "opencode", target }],
			}),
			true,
		);

		expect(item).toMatchObject({
			available: true,
			resolvedExecutable: managedRecord.command,
			unavailableReason: undefined,
		});
		expect(item?.targets.find((status) => status.selected)).toMatchObject({
			provenance: "managed",
			available: true,
			canEnable: true,
			resolvedExecutable: managedRecord.command,
		});
		expect(resolveExecutable).not.toHaveBeenCalled();
	});

	it("binds managed confirmation to the exact target working directory", async () => {
		const instance = new AcpRegistry(async () => registry, undefined, {
			platform: "win32",
			architecture: "x64",
			which: () => null,
			managed: {
				managedRecord: () => null,
				resolveManagedInvocation: () => null,
				targetState: () => ({}),
				installSupport: () => ({ supported: true }),
			},
		});
		const first = await instance.catalog(
			HlidConfigSchema.parse({ vault: { path: "C:\\first" } }),
			true,
		);
		const second = await instance.catalog(
			HlidConfigSchema.parse({ vault: { path: "C:\\second" } }),
		);
		expect(first[0]?.targets[0]?.mutationRevision).not.toBe(
			second[0]?.targets[0]?.mutationRevision,
		);
	});

	it("recommends the exact configured WSL distro without selecting it prematurely", async () => {
		const instance = new AcpRegistry(async () => registry, undefined, {
			platform: "win32",
			architecture: "x64",
			which: () => null,
			adapterFactory: (target) =>
				({
					target: target ?? { kind: "host" },
					key: target?.kind === "wsl" ? `wsl:${target.distro}` : "host",
					registryPlatform: async () => ({
						platform: target?.kind === "wsl" ? "linux" : "win32",
						architecture: "x64",
					}),
					providerPath: (_cwd: string, path: string) => path,
					pathAccessible: () => true,
					resolveExecutable: async () => null,
					start: vi.fn(),
					adaptMcpServer: <T>(server: T) => server,
				}) as never,
		});

		const [item] = await instance.catalog(
			HlidConfigSchema.parse({
				vault: {
					path: "\\\\wsl.localhost\\Ubuntu-24.04\\home\\kyle\\vault",
				},
			}),
			true,
		);
		const wsl = item?.targets.find((target) => target.target.kind === "wsl");
		expect(wsl).toMatchObject({
			label: "WSL · Ubuntu-24.04",
			recommended: true,
			selected: false,
			platformTarget: "linux-x86_64",
		});
	});

	it("resolves and selects a configured ACP inside the same WSL distro", async () => {
		const binaryRegistry = {
			version: "1",
			agents: [
				{
					id: "opencode",
					name: "OpenCode",
					version: "1.0.0",
					description: "Open agent",
					distribution: {
						binary: {
							"linux-x86_64": { cmd: "./opencode", args: ["acp"] },
						},
					},
				},
			],
		};
		const instance = new AcpRegistry(async () => binaryRegistry, undefined, {
			platform: "win32",
			architecture: "x64",
			which: () => null,
			adapterFactory: (target) =>
				({
					target: target ?? { kind: "host" },
					key: target?.kind === "wsl" ? `wsl:${target.distro}` : "host",
					registryPlatform: async () => ({
						platform: target?.kind === "wsl" ? "linux" : "win32",
						architecture: "x64",
					}),
					providerPath: (_cwd: string, path: string) => path,
					pathAccessible: () => true,
					resolveExecutable: async (command: string) =>
						target?.kind === "wsl" && command === "opencode"
							? "/usr/local/bin/opencode"
							: null,
					start: vi.fn(),
					adaptMcpServer: <T>(server: T) => server,
				}) as never,
		});
		const config = HlidConfigSchema.parse({
			vault: {
				path: "\\\\wsl.localhost\\Ubuntu-24.04\\home\\kyle\\vault",
			},
			acp_agents: [
				{
					id: "opencode",
					target: { kind: "wsl", distro: "Ubuntu-24.04" },
				},
			],
		});

		const [item] = await instance.catalog(config, true);
		expect(item).toMatchObject({
			enabled: true,
			available: true,
			command: "opencode",
			args: ["acp"],
			resolvedExecutable: "/usr/local/bin/opencode",
		});
		expect(item?.targets.find((target) => target.selected)).toMatchObject({
			target: { kind: "wsl", distro: "Ubuntu-24.04" },
			provenance: "external",
		});
	});

	it("keeps an invalid managed installation removable without probing it", async () => {
		const target = { kind: "wsl" as const, distro: "Ubuntu-24.04" };
		const resolveExecutable = vi.fn(async () => "/managed/opencode");
		const managedRecord = {
			target,
			command: "/mnt/c/hlid/acp/opencode",
			args: ["acp"],
			env: {},
			installedVersion: "0.9.0",
			usable: false,
			error: "Managed ACP files are missing or failed validation",
		};
		const instance = new AcpRegistry(
			async () => ({
				version: "1",
				agents: [
					{
						id: "opencode",
						name: "OpenCode",
						version: "1.0.0",
						description: "Open agent",
						distribution: {
							binary: {
								"linux-x86_64": {
									cmd: "./opencode",
									archive: "https://example.com/opencode.tar.gz",
									sha256: "a".repeat(64),
								},
							},
						},
					},
				],
			}),
			undefined,
			{
				platform: "win32",
				architecture: "x64",
				which: () => null,
				adapterFactory: () =>
					({
						target,
						key: "wsl:Ubuntu-24.04",
						registryPlatform: async () => ({
							platform: "linux",
							architecture: "x64",
						}),
						providerPath: (_cwd: string, path: string) => path,
						pathAccessible: () => true,
						resolveExecutable,
						start: vi.fn(),
						adaptMcpServer: <T>(server: T) => server,
					}) as never,
				managed: {
					managedRecord: () => managedRecord,
					resolveManagedInvocation: () => null,
					targetState: () => ({ error: managedRecord.error }),
					installSupport: () => ({ supported: true }),
				},
			},
		);

		const [item] = await instance.catalog(
			HlidConfigSchema.parse({
				vault: {
					path: "\\\\wsl.localhost\\Ubuntu-24.04\\home\\kyle\\vault",
				},
				acp_agents: [{ id: "opencode", target }],
			}),
			true,
		);
		const selected = item?.targets.find((status) => status.selected);
		expect(selected).toMatchObject({
			provenance: "managed",
			available: false,
			canEnable: false,
			canRemove: true,
			installedVersion: "0.9.0",
			command: "/mnt/c/hlid/acp/opencode",
			error: managedRecord.error,
		});
		expect(resolveExecutable).not.toHaveBeenCalled();
	});

	it("surfaces receipt-backed cleanup after a WSL workspace is removed without probing that distro", async () => {
		const target = { kind: "wsl" as const, distro: "Ubuntu-24.04" };
		const targetId = acpExecutionTargetId(target);
		const claim = {
			agentId: "other",
			target,
			targetId,
			hostCwd: "\\\\wsl.localhost\\Ubuntu-24.04\\home\\kyle\\removed",
		};
		const record = {
			target,
			command: "/mnt/c/Hlid/managed-other",
			args: [],
			env: {},
			installedVersion: "1.0.0",
			usable: true,
		};
		const registryPlatform = vi.fn(async () => ({
			platform: "linux" as const,
			architecture: "x64" as const,
		}));
		const resolveExecutable = vi.fn(async () => record.command);
		const instance = new AcpRegistry(async () => registry, undefined, {
			platform: "win32",
			architecture: "x64",
			which: () => null,
			adapterFactory: (adapterTarget) =>
				({
					target: adapterTarget ?? { kind: "host" },
					key:
						adapterTarget?.kind === "wsl"
							? `wsl:${adapterTarget.distro}`
							: "host",
					registryPlatform,
					providerPath: (_cwd: string, path: string) => path,
					pathAccessible: () => true,
					resolveExecutable,
					start: vi.fn(),
					adaptMcpServer: <T>(server: T) => server,
				}) as never,
			managed: {
				claimedTargets: () => [claim],
				managedRecord: (agentId, managedTarget) =>
					agentId === claim.agentId &&
					JSON.stringify(managedTarget) === JSON.stringify(target)
						? record
						: null,
				resolveManagedInvocation: () => record,
				targetState: () => ({}),
				installSupport: () => ({ supported: true }),
			},
		});

		const catalog = await instance.catalog(HlidConfigSchema.parse({}), true);
		const cleanup = catalog
			.find((item) => item.id === "other")
			?.targets.find((status) => status.targetId === targetId);
		expect(cleanup).toMatchObject({
			target,
			cleanupOnly: true,
			provenance: "managed",
			available: false,
			canEnable: false,
			canInstall: false,
			canUpdate: false,
			canRemove: true,
			installedVersion: "1.0.0",
		});
		expect(registryPlatform).not.toHaveBeenCalled();
		expect(resolveExecutable).not.toHaveBeenCalled();

		const restored = await instance.catalog(
			HlidConfigSchema.parse({
				vault: {
					path: "\\\\wsl.localhost\\Ubuntu-24.04\\home\\kyle\\restored",
				},
			}),
		);
		const matching = restored
			.find((item) => item.id === "other")
			?.targets.filter((status) => status.targetId === targetId);
		expect(matching).toHaveLength(1);
		expect(matching?.[0]?.cleanupOnly).toBeUndefined();
		expect(registryPlatform).toHaveBeenCalledOnce();
	});

	it("groups every remove-only target after an agent disappears from the registry", async () => {
		const targets = [
			{ kind: "wsl" as const, distro: "Ubuntu-24.04" },
			{ kind: "wsl" as const, distro: "Debian" },
		];
		const claims = targets.map((target) => ({
			agentId: "retired-agent",
			target,
			targetId: acpExecutionTargetId(target),
			hostCwd: `\\\\wsl.localhost\\${target.distro}\\home\\kyle\\removed`,
		}));
		const managedRecord = (target: (typeof targets)[number]) => ({
			target,
			command: `/mnt/c/Hlid/retired-agent-${target.distro}`,
			args: ["acp"],
			env: {},
			installedVersion: "2.0.0",
			usable: true,
		});
		const registryPlatform = vi.fn();
		const instance = new AcpRegistry(
			async () => ({ version: "1", agents: [] }),
			undefined,
			{
				platform: "win32",
				architecture: "x64",
				which: () => null,
				adapterFactory: (adapterTarget) =>
					({
						target: adapterTarget ?? { kind: "host" },
						key: "host",
						registryPlatform,
						providerPath: (_cwd: string, path: string) => path,
						pathAccessible: () => true,
						resolveExecutable: vi.fn(),
						start: vi.fn(),
						adaptMcpServer: <T>(server: T) => server,
					}) as never,
				managed: {
					claimedTargets: () => claims,
					managedRecord: (_agentId, target) =>
						target.kind === "wsl" ? managedRecord(target) : null,
					resolveManagedInvocation: (_agentId, target) =>
						target.kind === "wsl" ? managedRecord(target) : null,
					targetState: () => ({}),
					installSupport: () => ({ supported: false }),
				},
			},
		);

		const catalog = await instance.catalog(HlidConfigSchema.parse({}), true);
		expect(catalog).toEqual([
			expect.objectContaining({
				id: "retired-agent",
				enabled: false,
				available: false,
				targets: [
					expect.objectContaining({
						target: targets[0],
						cleanupOnly: true,
						canRemove: true,
						installedVersion: "2.0.0",
					}),
					expect.objectContaining({
						target: targets[1],
						cleanupOnly: true,
						canRemove: true,
						installedVersion: "2.0.0",
					}),
				],
			}),
		]);
		expect(registryPlatform).not.toHaveBeenCalled();
	});

	it("blocks install and update when the exact WSL runtime probe fails", async () => {
		const target = { kind: "wsl" as const, distro: "Ubuntu-24.04" };
		const resolveExecutable = vi.fn(async () => "/managed/opencode");
		const managedRecord = {
			target,
			command: "/mnt/c/hlid/acp/opencode",
			args: ["acp"],
			env: {},
			installedVersion: "0.9.0",
			usable: true,
		};
		const instance = new AcpRegistry(
			async () => ({
				version: "1",
				agents: [
					{
						id: "opencode",
						name: "OpenCode",
						version: "1.0.0",
						description: "Open agent",
						distribution: {
							binary: {
								"linux-x86_64": {
									cmd: "./opencode",
									archive: "https://example.com/opencode.tar.gz",
									sha256: "a".repeat(64),
								},
							},
						},
					},
				],
			}),
			undefined,
			{
				platform: "win32",
				architecture: "x64",
				which: () => null,
				adapterFactory: () =>
					({
						target,
						key: "wsl:Ubuntu-24.04",
						registryPlatform: async () => {
							throw new Error("WSL distro Ubuntu-24.04 is unavailable");
						},
						providerPath: (_cwd: string, path: string) => path,
						pathAccessible: () => true,
						resolveExecutable,
						start: vi.fn(),
						adaptMcpServer: <T>(server: T) => server,
					}) as never,
				managed: {
					managedRecord: () => managedRecord,
					resolveManagedInvocation: () => managedRecord,
					targetState: () => ({}),
					installSupport: () => ({
						supported: true,
						updateAvailable: true,
					}),
				},
			},
		);

		const [item] = await instance.catalog(
			HlidConfigSchema.parse({
				vault: {
					path: "\\\\wsl.localhost\\Ubuntu-24.04\\home\\kyle\\vault",
				},
				acp_agents: [{ id: "opencode", target }],
			}),
			true,
		);
		const selected = item?.targets.find((status) => status.selected);
		expect(selected).toMatchObject({
			provenance: "managed",
			available: false,
			canInstall: false,
			canUpdate: false,
			canRemove: true,
			blockedReason: "WSL distro Ubuntu-24.04 is unavailable",
		});
		expect(resolveExecutable).not.toHaveBeenCalled();
	});
});

describe("resolveAcpInvocation", () => {
	it("uses a logical Windows command stem for registry binaries", () => {
		const agent = {
			id: "windows-agent",
			name: "Windows agent",
			version: "1",
			description: "",
			distribution: {
				binary: {
					"windows-x86_64": {
						cmd: "opencode.exe",
						args: ["acp"],
						archive: "https://example.com/opencode.exe",
					},
				},
			},
		};
		expect(
			resolveAcpInvocation(agent, undefined, {
				platform: "win32",
				architecture: "x64",
			}),
		).toEqual({
			command: "opencode",
			args: ["acp"],
			env: {},
			installGuidance:
				"Download and place https://example.com/opencode.exe on PATH as opencode.exe",
		});
		expect(
			resolveAcpInvocation(
				agent,
				{ id: "windows-agent", executable: "opencode.exe" },
				{ platform: "win32", architecture: "x64" },
			).command,
		).toBe("opencode.exe");
	});

	it("turns an npx distribution into an installed global command and guidance", () => {
		expect(resolveAcpInvocation(registry.agents[0])).toEqual({
			command: "other-acp",
			args: [],
			env: {},
			installGuidance: "bun add --global other-acp@1.0.0",
		});
	});

	it("supports installed uv tool distributions", () => {
		expect(
			resolveAcpInvocation({
				id: "fast-agent",
				name: "fast-agent",
				version: "1",
				description: "",
				distribution: {
					uvx: { package: "fast-agent-acp==1.0.0", args: ["-x"] },
				},
			}),
		).toEqual({
			command: "fast-agent-acp",
			args: ["-x"],
			env: {},
			installGuidance: "uv tool install fast-agent-acp==1.0.0",
		});
	});

	it("preserves binary distribution environment and applies overrides", () => {
		const os = process.platform === "win32" ? "windows" : process.platform;
		const arch = process.arch === "arm64" ? "aarch64" : "x86_64";
		expect(
			resolveAcpInvocation(
				{
					id: "binary-agent",
					name: "Binary agent",
					version: "1",
					description: "",
					distribution: {
						binary: {
							[`${os}-${arch}`]: {
								cmd: "binary-agent",
								env: { FROM_BINARY: "yes", SHARED: "binary" },
							},
						},
					},
				},
				{
					id: "binary-agent",
					env: { SHARED: "override" },
				},
			),
		).toMatchObject({
			env: { FROM_BINARY: "yes", SHARED: "override" },
		});
	});
});
