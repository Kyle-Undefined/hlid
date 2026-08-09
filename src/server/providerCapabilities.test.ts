import { describe, expect, it, vi } from "vitest";
import { discoverClaudeProviderCapabilities } from "./claudeCapabilityDiscovery";
import type { ClaudeWarmupSnapshot } from "./claudeWarmup";
import {
	discoverCodexProviderCapabilities,
	readCodexPermissionProfiles,
} from "./codexCapabilityDiscovery";
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
		expect(
			isProviderCapabilityDiscovery({
				observedAt: 1,
				permissionProfiles: [
					{ id: ":workspace", description: "Workspace", allowed: true },
				],
				evidence: [],
			}),
		).toBe(true);
		expect(
			isProviderCapabilityDiscovery({
				observedAt: 1,
				permissionProfiles: [
					{ id: ":workspace", description: "x".repeat(501), allowed: true },
				],
				evidence: [],
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
						{
							name: "guardian_approval",
							displayName: "Auto-review",
							stage: "stable",
							enabled: true,
						},
					],
					nextCursor: null,
				};
			}
			if (method === "permissionProfile/list") {
				return {
					data: [
						{
							id: ":workspace",
							description: "Workspace writes",
							allowed: true,
						},
						{
							id: "locked",
							description: "Blocked by requirements",
							allowed: false,
						},
					],
					nextCursor: null,
				};
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
		expect(discovery.permissionProfiles).toEqual([
			{
				id: ":workspace",
				description: "Workspace writes",
				allowed: true,
			},
			{
				id: "locked",
				description: "Blocked by requirements",
				allowed: false,
			},
		]);
		expect(discovery.issues).toBeUndefined();
		expect(
			discovery.evidence.find((item) => item.label === "Unified exec"),
		).toMatchObject({
			integration: "provider-native",
			readiness: "ready",
			maturity: "beta",
		});
		expect(
			discovery.evidence.find((item) => item.label === "Auto-review"),
		).toMatchObject({
			scope: "session",
			integration: "integrated",
			readiness: "ready",
			maturity: "stable",
			operations: ["inspect", "select"],
		});
		expect(
			discovery.evidence.find((item) => item.id.includes("permission-profile")),
		).toMatchObject({ integration: "integrated", readiness: "ready" });
		expect(
			discovery.evidence.find((item) => item.id.endsWith(":locked")),
		).toMatchObject({
			integration: "integrated",
			readiness: "unavailable",
			reason: expect.stringContaining("do not allow"),
		});
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

	it("reads every permission profile page for the exact cwd", async () => {
		const request = vi.fn(async (_method: string, params: unknown) => {
			const cursor = (params as { cursor?: string }).cursor;
			return cursor
				? {
						data: [
							{
								id: "locked",
								description: "Not permitted here",
								allowed: false,
							},
						],
						nextCursor: null,
					}
				: {
						data: [
							{
								id: ":workspace",
								description: null,
								allowed: true,
							},
						],
						nextCursor: "page-2",
					};
		});

		await expect(
			readCodexPermissionProfiles({ cwd: "/actual/work", request }),
		).resolves.toEqual([
			{ id: ":workspace", description: null, allowed: true },
			{
				id: "locked",
				description: "Not permitted here",
				allowed: false,
			},
		]);
		expect(request).toHaveBeenNthCalledWith(1, "permissionProfile/list", {
			cwd: "/actual/work",
			limit: 100,
		});
		expect(request).toHaveBeenNthCalledWith(2, "permissionProfile/list", {
			cwd: "/actual/work",
			limit: 100,
			cursor: "page-2",
		});
	});

	it.each([
		[
			"duplicate ids",
			async () => ({
				data: [
					{ id: "same", description: null, allowed: true },
					{ id: "same", description: null, allowed: true },
				],
				nextCursor: null,
			}),
			"duplicate profile same",
		],
		[
			"malformed cursors",
			async () => ({ data: [], nextCursor: 42 }),
			"malformed nextCursor",
		],
		[
			"malformed rows",
			async () => ({
				data: [{ id: "bad", description: null, allowed: "yes" }],
				nextCursor: null,
			}),
			"malformed profile",
		],
		[
			"missing page data",
			async () => ({ data: "not-an-array", nextCursor: null }),
			"returned no profile array",
		],
		[
			"oversized pages",
			async () => ({
				data: Array.from({ length: 101 }, (_, index) => ({
					id: `profile-${index}`,
					description: null,
					allowed: true,
				})),
				nextCursor: null,
			}),
			"more than 100 profiles",
		],
		[
			"repeated cursors",
			async () => ({ data: [], nextCursor: "same-page" }),
			"repeated its pagination cursor",
		],
	] as const)("fails closed on %s", async (_label, request, message) => {
		await expect(
			readCodexPermissionProfiles({ cwd: "/work", request }),
		).rejects.toThrow(message);
	});

	it("bounds the complete catalog and normalizes descriptions", async () => {
		let page = 0;
		const request = vi.fn(async () => {
			page += 1;
			return {
				data: [
					{
						id: `profile-${page}`,
						description: `  ${"x".repeat(600)}  `,
						allowed: true,
					},
				],
				nextCursor: `page-${page + 1}`,
			};
		});

		await expect(
			readCodexPermissionProfiles({ cwd: "/work", request }),
		).rejects.toThrow("exceeded 10 pages");
		expect(request).toHaveBeenCalledTimes(10);

		const [normalized] = await readCodexPermissionProfiles({
			cwd: "/work",
			request: async () => ({
				data: [
					{
						id: "profile",
						description: `  ${"x".repeat(600)}  `,
						allowed: true,
					},
				],
				nextCursor: null,
			}),
		});
		expect(normalized?.description).toHaveLength(500);
		expect(normalized?.description?.startsWith("xx")).toBe(true);
	});

	it("keeps a maximum valid profile catalog persistable with other evidence", async () => {
		const discovery = await discoverCodexProviderCapabilities({
			providerId: "codex",
			cwd: "/work",
			request: async (method, rawParams) => {
				if (method !== "permissionProfile/list") return { data: [] };
				const cursor = (rawParams as { cursor?: string }).cursor;
				const page = cursor ? Number(cursor.slice("page-".length)) : 0;
				return {
					data: Array.from({ length: 100 }, (_, index) => ({
						id: `profile-${page * 100 + index}`,
						description: null,
						allowed: true,
					})),
					nextCursor: page < 9 ? `page-${page + 1}` : null,
				};
			},
		});

		expect(discovery.permissionProfiles).toHaveLength(1_000);
		expect(discovery.evidence).toHaveLength(1_002);
		expect(isProviderCapabilityDiscovery(discovery)).toBe(true);
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
				"setMcpPermissionModeOverride",
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
			discovery.evidence.find((item) =>
				item.id.includes("setmcppermissionmodeoverride"),
			),
		).toMatchObject({
			integration: "integrated",
			readiness: "gated",
			maturity: "beta",
			operations: ["default", "auto", "clear"],
			reason: expect.stringContaining("tighten-only"),
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
