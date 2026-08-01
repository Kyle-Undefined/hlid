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
	it("maps bounded runtime catalogs without claiming Hlid integration", async () => {
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
				return { data: [{ name: "plan" }] };
			}
			return { data: [{ cwd: "/work", hooks: [{ name: "lint" }] }] };
		});

		const discovery = await discoverCodexProviderCapabilities({
			providerId: "codex",
			cwd: "/work",
			request,
		});

		expect(request).toHaveBeenCalledTimes(4);
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
		expect(
			discovery.evidence.find((item) => item.id.includes("collaboration-mode")),
		).toMatchObject({ integration: "not-integrated" });
		expect(
			discovery.evidence.find((item) => item.id.includes("hook-catalog")),
		).toMatchObject({ label: "Hook catalog (1)" });
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
			controlMethods: ["interrupt", "rewindFiles", "backgroundTasks"],
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
				item.operations?.includes("rewindFiles"),
			),
		).toMatchObject({ integration: "not-integrated" });
		expect(
			discovery.evidence.find((item) =>
				item.operations?.includes("backgroundTasks"),
			),
		).toMatchObject({ integration: "not-integrated" });
	});
});
