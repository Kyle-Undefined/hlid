import { describe, expect, it } from "vitest";
import {
	buildHlidCapabilityManifest,
	buildHlidHelpResponse,
	buildHlidOperatingBriefResult,
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
			registeredHlidTools: ["hlid_api", "publish_relic"],
			providerSnapshot: {
				id: "codex",
				label: "Codex",
				available: true,
				capabilities: {
					goalControl: true,
					structuredActivities: ["compact", "review"],
					realtime: true,
				},
			},
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
		).toMatchObject({
			availability: "provider-native",
			providerGuidance: {
				providerId: "codex",
				source: "provider-capability-catalog",
			},
		});
		expect(
			manifest.capabilities.find((item) => item.id === "workflows"),
		).toMatchObject({ availability: "unavailable" });
		expect(manifest.registry).toMatchObject({
			providerSnapshot: "current",
			hlidTools: ["hlid_api", "publish_relic"],
			commandActions: expect.arrayContaining(["goal", "compact", "review"]),
		});
		expect(manifest.registry.revision).toMatch(/^v1-[0-9a-f]{8}$/);
	});

	it("reports Claude workflows as provider-native and goals as unavailable", () => {
		const manifest = buildHlidCapabilityManifest({
			providerId: "claude",
			runtimeCwd: "/work/hlid",
			sessionId: "session-1",
			providerSnapshot: {
				id: "claude",
				label: "Claude",
				available: true,
				capabilities: { workflowCatalog: true },
			},
		});

		expect(
			manifest.capabilities.find((item) => item.id === "workflows"),
		).toMatchObject({
			owner: "provider",
			availability: "provider-native",
			providerGuidance: {
				providerId: "claude",
				source: "provider-command-catalog",
			},
		});
		expect(
			manifest.capabilities.find((item) => item.id === "goals"),
		).toMatchObject({ owner: "provider", availability: "unavailable" });
	});

	it("derives Computer Use and realtime audio from live host, feature, model, and backend evidence", () => {
		const context = {
			providerId: "codex",
			model: "gpt-audio",
			sessionId: "session-1",
			codexRealtimeEnabled: true,
			codexRealtimeBackendAvailable: true,
			voiceSnapshot: { state: "ready" as const, model: "base" },
			providerSnapshot: {
				id: "codex",
				label: "Codex",
				available: true,
				models: [
					{
						value: "gpt-audio",
						label: "Audio",
						inputModalities: ["text", "audio"] as Array<
							"text" | "image" | "audio"
						>,
					},
				],
				capabilities: {
					goalControl: true,
					structuredActivities: ["compact", "review"] as Array<
						"compact" | "review"
					>,
					realtime: true,
				},
				hostCapabilities: {
					windowsComputerUse: {
						label: "Windows Computer Use",
						available: true,
					},
				},
			},
		};
		const manifest = buildHlidCapabilityManifest(context);

		expect(
			manifest.capabilities.find((item) => item.id === "computer_use"),
		).toMatchObject({ owner: "hlid", availability: "available" });
		expect(
			manifest.capabilities.find((item) => item.id === "voice_audio"),
		).toMatchObject({
			owner: "hlid",
			availability: "available",
			modes: {
				local_dictation: { availability: "available" },
				native_audio_input: {
					availability: "provider-native",
					providerGuidance: {
						providerId: "codex",
						source: "provider-model-catalog",
					},
				},
				raven_live: { availability: "provider-native" },
			},
		});
		expect(manifest.registry.commandActions).toContain("computer-use");

		const disabled = buildHlidCapabilityManifest({
			...context,
			codexRealtimeEnabled: false,
			codexRealtimeBackendAvailable: false,
			providerSnapshot: {
				...context.providerSnapshot,
				hostCapabilities: {
					windowsComputerUse: {
						label: "Windows Computer Use",
						available: false,
						reason: "plugin not installed",
					},
				},
			},
		});
		expect(
			disabled.capabilities.find((item) => item.id === "computer_use"),
		).toMatchObject({ availability: "unavailable" });
		expect(
			disabled.capabilities.find((item) => item.id === "voice_audio"),
		).toMatchObject({
			availability: "available",
			modes: {
				local_dictation: { availability: "available" },
				native_audio_input: { availability: "provider-native" },
				raven_live: { availability: "unavailable" },
			},
		});
		expect(disabled.registry.revision).not.toBe(manifest.registry.revision);
	});

	it("keeps realtime conditional until the backend accepts a session", () => {
		const manifest = buildHlidCapabilityManifest({
			providerId: "codex",
			model: "gpt-audio",
			codexRealtimeEnabled: true,
			providerSnapshot: {
				id: "codex",
				label: "Codex",
				available: true,
				models: [
					{
						value: "gpt-audio",
						label: "Audio",
						inputModalities: ["text", "audio"],
					},
				],
				capabilities: { realtime: true },
			},
		});
		expect(
			manifest.capabilities.find((item) => item.id === "voice_audio"),
		).toMatchObject({
			availability: "available",
			modes: {
				native_audio_input: { availability: "provider-native" },
				raven_live: { availability: "conditional" },
			},
		});
	});

	it("keeps registry revisions stable across equivalent input ordering", () => {
		const baseProvider = {
			id: "codex",
			label: "Codex",
			available: true,
			models: [
				{
					value: "gpt-audio",
					label: "Audio",
					inputModalities: ["audio", "text"] as Array<
						"text" | "image" | "audio"
					>,
				},
			],
			capabilities: {
				realtime: true,
				structuredActivities: ["review", "compact"] as Array<
					"compact" | "review"
				>,
			},
			hostCapabilities: {
				windowsComputerUse: {
					label: "Windows Computer Use",
					available: true,
				},
				diagnostics: { label: "Diagnostics", available: false },
			},
		};
		const first = buildHlidCapabilityManifest({
			providerId: "codex",
			model: "gpt-audio",
			registeredHlidTools: ["publish_relic", "hlid_api"],
			providerSnapshot: baseProvider,
		});
		const second = buildHlidCapabilityManifest({
			providerId: "codex",
			model: "gpt-audio",
			registeredHlidTools: ["hlid_api", "publish_relic"],
			providerSnapshot: {
				...baseProvider,
				models: [
					{
						...baseProvider.models[0],
						inputModalities: ["text", "audio"],
					},
				],
				capabilities: {
					structuredActivities: ["compact", "review"],
					realtime: true,
				},
				hostCapabilities: {
					diagnostics: { label: "Diagnostics", available: false },
					windowsComputerUse: {
						label: "Windows Computer Use",
						available: true,
					},
				},
			},
		});

		expect(second.registry.revision).toBe(first.registry.revision);
	});

	it("bounds provider-owned reason text in focused help", () => {
		const response = buildHlidHelpResponse("computer_use", {
			providerId: "codex",
			providerSnapshot: {
				id: "codex",
				label: "Codex",
				available: true,
				hostCapabilities: {
					windowsComputerUse: {
						label: "Windows Computer Use",
						available: false,
						reason: `unavailable-${"x".repeat(50_000)}`,
					},
				},
			},
		});
		const parsed = JSON.parse(response);

		expect(response.length).toBeLessThanOrEqual(MAX_HLID_HELP_RESPONSE_CHARS);
		expect(parsed.capabilities[0].summary.length).toBeLessThan(400);
		expect(parsed.capabilities[0].summary).not.toContain("x".repeat(1_000));
	});

	it("does not infer provider-native features from the provider name alone", () => {
		const manifest = buildHlidCapabilityManifest({
			providerId: "codex",
			sessionId: "session-1",
		});
		expect(
			manifest.capabilities.find((item) => item.id === "goals"),
		).toMatchObject({ availability: "unavailable" });
		expect(
			manifest.capabilities.find((item) => item.id === "computer_use"),
		).toMatchObject({ availability: "conditional" });
		expect(manifest.registry.providerSnapshot).toBe("unavailable");
	});

	it("removes provider-owned actions when the live provider is unavailable", () => {
		const manifest = buildHlidCapabilityManifest({
			providerId: "codex",
			sessionId: "session-1",
			providerSnapshot: {
				id: "codex",
				label: "Codex",
				available: false,
				unavailableReason: "Codex CLI not found",
				capabilities: {
					goalControl: true,
					structuredActivities: ["compact", "review"],
				},
			},
		});
		expect(manifest.registry.commandActions).not.toContain("goal");
		expect(manifest.registry.commandActions).not.toContain("review");
		expect(manifest.registry.commandActions).toContain("context");
		expect(
			manifest.capabilities.find((item) => item.id === "goals"),
		).toMatchObject({ availability: "unavailable" });
		expect(
			manifest.capabilities.find((item) => item.id === "providers"),
		).toMatchObject({ availability: "unavailable" });
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
		const result = buildHlidOperatingBriefResult({
			providerId: `provider-${"x".repeat(1_000)}`,
			permissionMode: `permission-${"y".repeat(1_000)}`,
			runtimeCwd: "/work/hlid",
			sessionId: "session-1",
			vaultName: `vault-${"z".repeat(1_000)}`,
		});
		const brief = result.text;

		expect(brief.length).toBeLessThanOrEqual(MAX_HLID_OPERATING_BRIEF_CHARS);
		expect(Math.ceil(brief.length / 4)).toBeLessThanOrEqual(175);
		expect(result.revision).toMatch(/^v1-[0-9a-f]{8}$/);
		expect(brief).toContain("Use hlid_help");
		expect(brief).toContain("exact selections");
		expect(brief).not.toContain("permission-");
		expect(brief).not.toContain("environment");
		expect(brief).not.toContain("HTML plan");
		expect(brief).not.toContain("managed skills");
	});

	it("keeps the once-only brief stable when mutable runtime state changes", () => {
		const first = buildHlidOperatingBriefResult({
			providerId: "codex",
			permissionMode: "default",
			runtimeCwd: "/work/one",
			vaultName: "Fornbok",
		});
		const second = buildHlidOperatingBriefResult({
			providerId: "claude",
			permissionMode: "bypassPermissions",
			runtimeCwd: "C:\\work\\two",
			vaultName: "Fornbok",
		});

		expect(second).toEqual(first);
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
		"computer_use",
		"voice_audio",
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
			codexRealtimeEnabled: true,
			registeredHlidTools: [
				"hlid_help",
				"hlid_api",
				"publish_relic",
				"start_project_preview",
				"inspect_project_preview",
				"capture_project_preview",
				"control_project_preview",
				"stop_project_preview",
			],
			providerSnapshot: {
				id: "codex",
				label: "Codex",
				available: true,
				models: [
					{
						value: "gpt-5.6-sol",
						label: "GPT",
						inputModalities: ["text", "audio"],
					},
				],
				capabilities: {
					goalControl: true,
					structuredActivities: ["compact", "review"],
					realtime: true,
				},
				hostCapabilities: {
					windowsComputerUse: {
						label: "Windows Computer Use",
						available: true,
					},
				},
			},
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
