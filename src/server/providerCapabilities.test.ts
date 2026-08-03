import { describe, expect, it, vi } from "vitest";
import { discoverClaudeProviderCapabilities } from "./claudeCapabilityDiscovery";
import type { ClaudeWarmupSnapshot } from "./claudeWarmup";
import { discoverCodexProviderCapabilities } from "./codexCapabilityDiscovery";
import {
	buildProviderCapabilitySnapshot,
	isProviderCapabilityDiscovery,
	providerCapabilityId,
} from "./providerCapabilities";

describe("provider capability resolution", () => {
	it("keeps upstream support separate from Hlid integration", () => {
		const snapshot = buildProviderCapabilitySnapshot({
			providerId: "claude",
			providerAvailable: true,
			models: [{ value: "sonnet", label: "Sonnet" }],
			discoverySource: "live",
			discoveryCwd: "/work/project",
			discovery: {
				observedAt: 100,
				evidence: [
					{
						id: providerCapabilityId("claude", "sdk-control", "rewindFiles"),
						label: "SDK control: rewind files",
						scope: "session",
						support: "advertised",
						integration: "not-integrated",
						readiness: "ready",
						source: "provider-sdk",
					},
				],
			},
		});

		expect(snapshot).toMatchObject({
			status: "current",
			source: "live",
			observedAt: 100,
			context: { cwd: "/work/project" },
		});
		expect(
			snapshot.capabilities.find(
				(item) => item.label === "SDK control: rewind files",
			),
		).toMatchObject({
			support: "advertised",
			integration: "not-integrated",
			readiness: "ready",
			availability: "unavailable",
			reason: expect.stringContaining("does not integrate"),
		});
	});

	it("keeps revisions stable when only observation time changes", () => {
		const make = (observedAt: number) =>
			buildProviderCapabilitySnapshot({
				providerId: "codex",
				providerAvailable: true,
				models: [],
				discoverySource: "live",
				discovery: { observedAt, evidence: [] },
			});

		expect(make(1).revision).toBe(make(2).revision);
	});

	it("publishes integrated background activity as a live-session gate", () => {
		const snapshot = buildProviderCapabilitySnapshot({
			providerId: "codex",
			providerAvailable: true,
			models: [],
			capabilities: {
				backgroundActivities: {
					maturity: "experimental",
					operations: ["list", "terminate", "clean"],
				},
			},
		});

		expect(
			snapshot.capabilities.find((item) =>
				item.id.includes("background-activity"),
			),
		).toMatchObject({
			integration: "integrated",
			readiness: "gated",
			availability: "conditional",
			maturity: "experimental",
			operations: ["clean", "list", "terminate"],
		});
	});

	it("publishes generated media persistence as a provider-gated integration", () => {
		const snapshot = buildProviderCapabilitySnapshot({
			providerId: "codex",
			providerAvailable: true,
			models: [],
			capabilities: {
				generatedMedia: {
					maturity: "stable",
					operations: ["persist", "preview", "download"],
				},
			},
		});

		expect(
			snapshot.capabilities.find((item) => item.id.includes("generated-media")),
		).toMatchObject({
			integration: "integrated",
			readiness: "gated",
			availability: "conditional",
			maturity: "stable",
			operations: ["download", "persist", "preview"],
			reason: expect.stringContaining("provider, model, and backend"),
		});
	});

	it("uses the provider-effective workspace and revisions it independently", () => {
		const make = (cwd: string) =>
			buildProviderCapabilitySnapshot({
				providerId: "codex",
				providerAvailable: true,
				models: [],
				discoverySource: "live",
				discoveryCwd: "\\\\wsl.localhost\\Ubuntu-24.04\\home\\kyle\\hlid",
				discovery: {
					observedAt: 1,
					context: { cwd },
					evidence: [],
				},
			});
		const wsl = make("/home/kyle/hlid");
		const other = make("/home/kyle/other");

		expect(wsl.context).toEqual({ cwd: "/home/kyle/hlid" });
		expect(wsl.revision).not.toBe(other.revision);
	});

	it("marks persisted and failed provider evidence honestly", () => {
		const stale = buildProviderCapabilitySnapshot({
			providerId: "codex",
			providerAvailable: true,
			models: [],
			discoverySource: "persisted",
			discovery: { observedAt: 1, evidence: [] },
		});
		const partial = buildProviderCapabilitySnapshot({
			providerId: "codex",
			providerAvailable: true,
			models: [],
			discoverySource: "fallback",
			discovery: { observedAt: 0, evidence: [], issues: ["probe failed"] },
		});

		expect(stale.status).toBe("stale");
		expect(partial).toMatchObject({
			status: "partial",
			issues: ["probe failed"],
		});
	});

	it("validates persisted discovery envelopes", () => {
		expect(isProviderCapabilityDiscovery({ observedAt: 1, evidence: [] })).toBe(
			true,
		);
		expect(
			isProviderCapabilityDiscovery({ observedAt: "now", evidence: [] }),
		).toBe(false);
		expect(
			isProviderCapabilityDiscovery({
				observedAt: 1,
				context: { cwd: "/work/project" },
				evidence: [],
			}),
		).toBe(true);
		expect(
			isProviderCapabilityDiscovery({
				observedAt: 1,
				context: { cwd: 42 },
				evidence: [],
			}),
		).toBe(false);
		expect(
			isProviderCapabilityDiscovery({
				observedAt: 1,
				evidence: [
					{
						id: "bad",
						label: "Bad",
						scope: "everywhere",
						support: "advertised",
						integration: "integrated",
						readiness: "ready",
						source: "provider-runtime",
					},
				],
			}),
		).toBe(false);
	});
});

describe("Codex capability discovery", () => {
	it("maps bounded runtime catalogs and recognizes wired collaboration modes", async () => {
		const request = vi.fn(async (method: string) => {
			if (method === "experimentalFeature/list") {
				return {
					data: [
						{
							name: "unified_exec",
							displayName: "Unified exec",
							stage: "beta",
							enabled: true,
						},
					],
					nextCursor: null,
				};
			}
			if (method === "permissionProfile/list") {
				return { data: [{ id: ":workspace", allowed: true }] };
			}
			if (method === "collaborationMode/list") {
				return {
					data: [
						{ name: "Default" },
						{ name: "Plan" },
						{ name: "Pair programming" },
					],
				};
			}
			if (method === "app/list") {
				return {
					data: [
						{
							id: "github",
							name: "GitHub",
							installUrl: "https://example.test/connect",
						},
					],
					nextCursor: "next",
				};
			}
			if (method === "app/installed") {
				return { apps: [{ id: "github", callable: true }] };
			}
			if (method === "mcpServerStatus/list") {
				return { data: [{ name: "codex_apps", authStatus: "bearerToken" }] };
			}
			return { data: [{ cwd: "/work", hooks: [{ name: "lint" }] }] };
		});

		const discovery = await discoverCodexProviderCapabilities({
			providerId: "codex",
			cwd: "/work",
			request,
		});

		expect(request).toHaveBeenCalledTimes(5);
		expect(request).not.toHaveBeenCalledWith("app/list", expect.anything());
		expect(request).not.toHaveBeenCalledWith(
			"app/installed",
			expect.anything(),
		);
		expect(discovery.context).toEqual({ cwd: "/work" });
		expect(discovery.issues).toBeUndefined();
		expect(
			discovery.evidence.find((item) => item.label === "Unified exec"),
		).toMatchObject({
			integration: "provider-native",
			readiness: "ready",
			maturity: "beta",
		});
		expect(
			discovery.evidence.find((item) => item.id.includes("permission-profile")),
		).toMatchObject({ integration: "not-integrated" });
		const collaborationModes = discovery.evidence.filter((item) =>
			item.id.includes("collaboration-mode"),
		);
		expect(collaborationModes).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					label: "Default",
					integration: "integrated",
					readiness: "ready",
				}),
				expect.objectContaining({
					label: "Plan",
					integration: "integrated",
					readiness: "ready",
				}),
				expect.objectContaining({
					label: "Pair programming",
					integration: "not-integrated",
				}),
			]),
		);
		expect(
			discovery.evidence.find((item) => item.id.includes("hook-catalog")),
		).toMatchObject({ label: "Hook catalog (1)" });
		expect(
			discovery.evidence.find((item) => item.id.includes("connector-health")),
		).toMatchObject({ label: "MCP connector health (1; 0 need auth)" });
	});

	it("keeps successful evidence when one optional endpoint is unavailable", async () => {
		const discovery = await discoverCodexProviderCapabilities({
			providerId: "codex",
			cwd: "/work",
			request: async (method) => {
				if (method === "permissionProfile/list")
					throw new Error("not supported");
				return { data: [] };
			},
		});

		expect(discovery.evidence).toContainEqual(
			expect.objectContaining({ label: "Hook catalog (0)" }),
		);
		expect(discovery.issues?.[0]).toContain(
			"permissionProfile/list unavailable",
		);
	});
});

describe("Claude capability discovery", () => {
	it("maps runtime SDK controls to explicit integration states", () => {
		const snapshot: ClaudeWarmupSnapshot = {
			commands: [{ name: "review", description: "Review", argumentHint: "" }],
			agents: [{ name: "reviewer" }],
			mcpServers: [{ name: "github", status: "connected" }],
			modelCount: 2,
			controlMethods: [
				"interrupt",
				"reconnectMcpServer",
				"toggleMcpServer",
				"setMcpServers",
				"reloadSkills",
				"rewindFiles",
				"backgroundTasks",
			],
			cwd: "/work",
			warmedAt: 123,
			durationMs: 10,
		};
		const discovery = discoverClaudeProviderCapabilities({
			providerId: "claude",
			cwd: "/work/project",
			snapshot,
		});

		expect(discovery.observedAt).toBe(123);
		expect(discovery.context).toEqual({ cwd: "/work/project" });
		expect(
			discovery.evidence.find((item) => item.operations?.includes("interrupt")),
		).toMatchObject({ integration: "integrated" });
		expect(
			discovery.evidence.find((item) =>
				item.operations?.includes("reloadSkills"),
			),
		).toMatchObject({ integration: "integrated", readiness: "ready" });
		expect(
			discovery.evidence.find((item) =>
				item.operations?.includes("reconnectMcpServer"),
			),
		).toMatchObject({ integration: "integrated", readiness: "ready" });
		expect(
			discovery.evidence.find((item) =>
				item.operations?.includes("toggleMcpServer"),
			),
		).toMatchObject({ integration: "integrated", readiness: "ready" });
		expect(
			discovery.evidence.find((item) =>
				item.operations?.includes("setMcpServers"),
			),
		).toMatchObject({
			integration: "integrated",
			readiness: "ready",
			maturity: "beta",
			reason: expect.stringContaining("canonical workspace MCP configuration"),
		});
		expect(
			discovery.evidence.find((item) => item.id.includes("rewindfiles")),
		).toMatchObject({
			integration: "integrated",
			readiness: "gated",
			maturity: "beta",
			operations: ["preview", "rewind"],
		});
		expect(
			discovery.evidence.find((item) =>
				item.operations?.includes("backgroundTasks"),
			),
		).toMatchObject({ integration: "integrated", readiness: "ready" });
		expect(
			discovery.evidence.find((item) => item.id.includes("mcp-elicitation")),
		).toMatchObject({
			integration: "integrated",
			readiness: "ready",
			operations: ["form", "respond", "cancel"],
		});
		expect(
			discovery.evidence.find((item) =>
				item.id.includes("mcp-url-elicitation"),
			),
		).toMatchObject({
			support: "not-advertised",
			integration: "integrated",
			readiness: "unavailable",
			maturity: "experimental",
			operations: ["url", "respond", "cancel"],
			reason: expect.stringContaining("does not advertise URL elicitation"),
		});
		expect(
			discovery.evidence.find((item) => item.id.includes("host-dialog")),
		).toMatchObject({
			integration: "integrated",
			operations: ["refusal_fallback_prompt", "respond", "cancel"],
		});
	});
});
