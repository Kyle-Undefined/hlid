import { describe, expect, it } from "vitest";
import {
	buildHlidCapabilityManifest,
	buildHlidHelpResponse,
	buildHlidOperatingBrief,
	HLID_OPERATING_CONTRACT_VERSION,
	MAX_HLID_HELP_RESPONSE_CHARS,
	MAX_HLID_OPERATING_BRIEF_CHARS,
} from "./hlidHelp";

describe("Hlid operating guidance", () => {
	it("builds a live Codex capability manifest without claiming Claude workflows", () => {
		const manifest = buildHlidCapabilityManifest({
			providerId: "codex",
			model: "gpt-5.6-sol",
			effort: "high",
			permissionMode: "default",
			policyEnforced: true,
			runtimeCwd: "/work/hlid",
			sessionId: "session-1",
			vaultName: "Fornbok",
			agentMode: "cwd",
		});

		expect(manifest).toMatchObject({
			contractVersion: HLID_OPERATING_CONTRACT_VERSION,
			runtime: {
				providerId: "codex",
				providerRuntime: "codex",
				model: "gpt-5.6-sol",
				effort: "high",
				sessionScoped: true,
			},
			permissions: {
				mode: "default",
				policyEnforced: true,
				owner: "hlid-and-provider",
			},
			references: {
				vaultConfigured: true,
				workspaceAvailable: true,
				exactSelections: true,
				relatedExpansion: "only-when-requested",
			},
		});
		expect(
			manifest.capabilities.find((item) => item.id === "goals"),
		).toMatchObject({ availability: "provider-native" });
		expect(
			manifest.capabilities.find((item) => item.id === "workflows"),
		).toMatchObject({ availability: "unavailable" });
	});

	it("reports Claude workflows as provider-native and goals as unavailable", () => {
		const manifest = buildHlidCapabilityManifest({
			providerId: "claude",
			runtimeCwd: "/work/hlid",
			sessionId: "session-1",
		});

		expect(
			manifest.capabilities.find((item) => item.id === "workflows"),
		).toMatchObject({ owner: "provider", availability: "provider-native" });
		expect(
			manifest.capabilities.find((item) => item.id === "goals"),
		).toMatchObject({ owner: "provider", availability: "unavailable" });
	});

	it("gates session-owned context and plan help without hiding package guidance", () => {
		const detached = buildHlidCapabilityManifest({
			providerId: "external",
		});
		expect(
			detached.capabilities.find((item) => item.id === "context"),
		).toMatchObject({ owner: "hlid", availability: "conditional" });
		expect(
			detached.capabilities.find((item) => item.id === "plans_review"),
		).toMatchObject({ owner: "hlid", availability: "conditional" });
		expect(
			detached.capabilities.find((item) => item.id === "skills_extensions"),
		).toMatchObject({ owner: "hlid", availability: "available" });

		const session = buildHlidCapabilityManifest({
			providerId: "codex",
			sessionId: "session-1",
		});
		expect(
			session.capabilities.find((item) => item.id === "context"),
		).toMatchObject({ availability: "available" });
		expect(
			session.capabilities.find((item) => item.id === "plans_review"),
		).toMatchObject({ availability: "available" });
	});

	it("keeps the startup brief small even with oversized labels", () => {
		const brief = buildHlidOperatingBrief({
			providerId: `provider-${"x".repeat(1_000)}`,
			permissionMode: `permission-${"y".repeat(1_000)}`,
			runtimeCwd: "/work/hlid",
			sessionId: "session-1",
			vaultName: `vault-${"z".repeat(1_000)}`,
		});

		expect(brief.length).toBeLessThanOrEqual(MAX_HLID_OPERATING_BRIEF_CHARS);
		expect(Math.ceil(brief.length / 4)).toBeLessThanOrEqual(175);
		expect(brief).toContain("Use hlid_help");
		expect(brief).toContain("exact selections");
		expect(brief).not.toContain("HTML plan");
		expect(brief).not.toContain("managed skills");
	});

	it("loads detailed context and provider handoff guidance only in focused help", () => {
		const context = JSON.parse(
			buildHlidHelpResponse("context", {
				providerId: "codex",
				sessionId: "session-1",
				runtimeCwd: "/work/hlid",
			}),
		);
		expect(context.guidance.join(" ")).toContain("Raven /context");
		expect(context.guidance.join(" ")).toContain("provider handoff size");

		const providers = JSON.parse(
			buildHlidHelpResponse("providers", {
				providerId: "codex",
				sessionId: "session-1",
			}),
		);
		expect(providers.guidance.join(" ")).toContain(
			"bounded visible-transcript handoff",
		);
		expect(providers.guidance.join(" ")).toContain(
			"Native hidden context does not cross",
		);
	});

	it.each([
		"overview",
		"references",
		"permissions",
		"sessions",
		"context",
		"plans_review",
		"workflows",
		"goals",
		"relics",
		"project_preview",
		"mcp",
		"skills_extensions",
		"api",
		"providers",
	] as const)("keeps %s help within the hard response budget", (topic) => {
		const response = buildHlidHelpResponse(topic, {
			providerId: "codex",
			model: "gpt-5.6-sol",
			effort: "high",
			permissionMode: "default",
			runtimeCwd: "/work/hlid",
			sessionId: "session-1",
			vaultName: "Fornbok",
		});

		expect(response.length).toBeLessThanOrEqual(MAX_HLID_HELP_RESPONSE_CHARS);
		expect(JSON.parse(response)).toMatchObject({
			contractVersion: HLID_OPERATING_CONTRACT_VERSION,
			topic,
		});
	});

	it("bounds live provider selections before serializing help", () => {
		const response = buildHlidHelpResponse("overview", {
			providerId: `codex-${"p".repeat(10_000)}`,
			model: `model-${"m".repeat(10_000)}`,
			effort: `effort-${"e".repeat(10_000)}`,
			permissionMode: `permission-${"r".repeat(10_000)}`,
			runtimeCwd: "/work/hlid",
			sessionId: "session-1",
		});
		const parsed = JSON.parse(response);

		expect(response.length).toBeLessThanOrEqual(MAX_HLID_HELP_RESPONSE_CHARS);
		expect(parsed.runtime.providerId.length).toBeLessThanOrEqual(120);
		expect(parsed.runtime.model.length).toBeLessThanOrEqual(200);
		expect(parsed.permissions.mode.length).toBeLessThanOrEqual(80);
	});
});
