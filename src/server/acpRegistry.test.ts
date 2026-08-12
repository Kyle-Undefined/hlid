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
		const baseConfig = HlidConfigSchema.parse({});

		await instance.catalog(baseConfig, true);
		await instance.catalog(baseConfig);
		expect(which).toHaveBeenCalledTimes(registry.agents.length);

		await instance.catalog(
			HlidConfigSchema.parse({
				acp_agents: [{ id: "opencode", executable: "custom-open" }],
			}),
		);
		expect(which).toHaveBeenCalledTimes(registry.agents.length * 2);
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
			HlidConfigSchema.parse({ vault: { path: "/vault/workspace" } }),
			true,
		);

		expect(which).toHaveBeenCalledWith(
			expect.any(String),
			expect.objectContaining({ cwd: "/vault/workspace" }),
		);
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
