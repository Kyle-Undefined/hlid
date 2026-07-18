import { beforeEach, describe, expect, it, vi } from "vitest";

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
		const catalog = await new AcpRegistry(async () => registry).catalog(
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
});

describe("resolveAcpInvocation", () => {
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
});
