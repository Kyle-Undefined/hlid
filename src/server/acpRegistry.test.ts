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
		}).catalog(HlidConfigSchema.parse({}));
		expect(catalog.slice(0, 2).map((item) => item.id)).toEqual([
			"opencode",
			"pi-acp",
		]);
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
