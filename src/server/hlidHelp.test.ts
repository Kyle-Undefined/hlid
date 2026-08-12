import { describe, expect, it } from "vitest";
import type {
	ProviderCapabilityDescriptor,
	ProviderCapabilitySnapshot,
} from "../lib/providerCapabilityTypes";
import { runtimeEnvironments } from "./hlidCapabilityManifest";
import {
	buildHlidCapabilityManifest,
	buildHlidHelpResponse,
	buildHlidOperatingBriefResult,
	HLID_HELP_TOPICS,
	HLID_OPERATING_CONTRACT_VERSION,
	type HlidOperatingContext,
	MAX_HLID_HELP_RESPONSE_CHARS,
	MAX_HLID_OPERATING_BRIEF_CHARS,
	MAX_HLID_ORCHESTRATION_TARGET_CATALOG_CHARS,
} from "./hlidHelp";

function providerCapability(
	overrides: Partial<ProviderCapabilityDescriptor> &
		Pick<ProviderCapabilityDescriptor, "id" | "label">,
): ProviderCapabilityDescriptor {
	return {
		scope: "session",
		support: "advertised",
		integration: "integrated",
		readiness: "ready",
		source: "provider-runtime",
		availability: "available",
		...overrides,
	};
}

function providerHelpContext(
	capabilities: ProviderCapabilityDescriptor[],
	revision = "v1-provider-test",
): HlidOperatingContext {
	return {
		providerId: "codex",
		sessionId: "session-1",
		providerSnapshot: {
			id: "codex",
			label: "Codex",
			available: true,
			capabilitySnapshot: {
				contractVersion: 1,
				providerId: "codex",
				status: "current",
				source: "live",
				revision,
				observedAt: 1,
				context: { cwd: "/work/project" },
				capabilities,
			},
		},
	};
}

function codexRealtimeFeatureSnapshot(
	enabled: boolean,
): ProviderCapabilitySnapshot {
	return {
		contractVersion: 1,
		providerId: "codex",
		status: "current",
		source: "live",
		revision: `v1-realtime-${enabled ? "enabled" : "disabled"}`,
		observedAt: 1,
		capabilities: [
			providerCapability({
				id: "codex:experimental-feature:realtime_conversation",
				label: "Realtime conversation",
				scope: "provider",
				integration: "provider-native",
				readiness: enabled ? "ready" : "unavailable",
				availability: enabled ? "provider-native" : "unavailable",
			}),
		],
	};
}

describe("Hlid operating guidance", () => {
	it.each([
		{
			name: "a WSL provider on a Windows host",
			runtimeCwd: "\\\\wsl.localhost\\Ubuntu-24.04\\home\\kyle\\hlid",
			platform: "win32",
			environment: {},
			expected: {
				hostEnvironment: "windows",
				providerEnvironment: "wsl",
			},
		},
		{
			name: "a Windows provider on a Windows host",
			runtimeCwd: "C:\\work\\hlid",
			platform: "win32",
			environment: {},
			expected: {
				hostEnvironment: "windows",
				providerEnvironment: "windows",
			},
		},
		{
			name: "a provider on a WSL host",
			runtimeCwd: "/home/kyle/hlid",
			platform: "linux",
			environment: { WSL_DISTRO_NAME: "Ubuntu-24.04" },
			expected: {
				hostEnvironment: "wsl",
				providerEnvironment: "wsl",
			},
		},
		{
			name: "a provider on a native host",
			runtimeCwd: "/srv/hlid",
			platform: "linux",
			environment: {},
			expected: {
				hostEnvironment: "host",
				providerEnvironment: "host",
			},
		},
		{
			name: "a missing provider working directory",
			runtimeCwd: undefined,
			platform: "win32",
			environment: {},
			expected: {
				hostEnvironment: "windows",
				providerEnvironment: "unknown",
			},
		},
	])("distinguishes $name", ({
		runtimeCwd,
		platform,
		environment,
		expected,
	}) => {
		expect(runtimeEnvironments(runtimeCwd, { platform, environment })).toEqual(
			expected,
		);
	});

	it("publishes the complete source topic registry through overview help", () => {
		const manifest = buildHlidCapabilityManifest({});
		const overview = JSON.parse(buildHlidHelpResponse("overview", {}));

		expect(manifest.helpTopics).toEqual(HLID_HELP_TOPICS);
		expect(overview.relatedTopics).toEqual(
			HLID_HELP_TOPICS.filter((topic) => topic !== "overview"),
		);
		expect(overview.relatedTopics).toContain("orchestration");
	});

	it("publishes each focused capability exactly once in topic order", () => {
		const manifest = buildHlidCapabilityManifest({});
		const capabilityIds = manifest.capabilities.map(({ id }) => id);

		expect(capabilityIds).toEqual(
			HLID_HELP_TOPICS.filter((topic) => topic !== "overview"),
		);
		expect(new Set(capabilityIds).size).toBe(capabilityIds.length);
	});

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
		expect(manifest.runtime.environment).toBe(
			manifest.runtime.providerEnvironment,
		);
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
		).toMatchObject({ availability: "conditional" });
		expect(manifest.registry).toMatchObject({
			providerSnapshot: "current",
			hlidTools: ["hlid_api", "publish_relic"],
			commandActions: expect.arrayContaining(["goal", "compact", "review"]),
		});
		expect(manifest.registry.revision).toMatch(/^v1-[0-9a-f]{8}$/);
	});

	it("reports Claude workflows as provider-native without inferring absent goals", () => {
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
		).toMatchObject({ owner: "provider", availability: "conditional" });
	});

	it("keeps agent maintenance available while reclaim remains Forge-only", () => {
		const focused = JSON.parse(
			buildHlidHelpResponse("maintenance", {
				providerId: "codex",
				sessionId: "session-1",
				registeredHlidTools: [
					"inspect_hlid_storage",
					"optimize_hlid_storage",
					"cleanup_hlid_sessions",
				],
			}),
		);

		expect(focused.capabilities).toEqual([
			expect.objectContaining({
				id: "maintenance",
				owner: "hlid",
				availability: "available",
				summary: expect.stringContaining("Forge-only"),
			}),
		]);
		expect(focused.guidance.join(" ")).toContain("inspect_hlid_storage first");
		expect(focused.guidance.join(" ")).toContain(
			"No Hlid agent tool exposes VACUUM",
		);
	});

	it("publishes Ledger, diagnostics, and Routines as focused Hlid-owned capabilities", () => {
		const context = {
			providerId: "codex",
			sessionId: "session-1",
			registeredHlidTools: [
				"inspect_hlid_ledger",
				"inspect_hlid_diagnostics",
				"list_hlid_routines",
				"inspect_hlid_routine",
				"preview_hlid_routine_schedule",
			],
		};
		const ledger = JSON.parse(buildHlidHelpResponse("ledger", context));
		const diagnostics = JSON.parse(
			buildHlidHelpResponse("diagnostics", context),
		);
		const routines = JSON.parse(buildHlidHelpResponse("routines", context));

		expect(ledger.capabilities).toEqual([
			expect.objectContaining({
				id: "ledger",
				owner: "hlid",
				availability: "available",
			}),
		]);
		expect(ledger.guidance.join(" ")).toContain("raw immutable usage rows");
		expect(diagnostics.capabilities).toEqual([
			expect.objectContaining({
				id: "diagnostics",
				owner: "hlid",
				availability: "available",
			}),
		]);
		expect(diagnostics.guidance.join(" ")).toContain(
			"not treat the result as a complete raw log export",
		);
		expect(routines.capabilities).toEqual([
			expect.objectContaining({
				id: "routines",
				owner: "hlid",
				availability: "available",
			}),
		]);
		expect(routines.guidance.join(" ")).toContain(
			"distinct from provider-native Dynamic Workflows",
		);
		expect(routines.guidance.join(" ")).toContain(
			"do not create, edit, archive, authorize, trigger, pause, resume",
		);
	});

	it("keeps Routines separate from provider-native workflows", () => {
		const workflows = JSON.parse(
			buildHlidHelpResponse("workflows", { providerId: "claude" }),
		);
		const incompleteRoutines = JSON.parse(
			buildHlidHelpResponse("routines", {
				registeredHlidTools: ["list_hlid_routines", "inspect_hlid_routine"],
			}),
		);

		expect(workflows.capabilities).toEqual([
			expect.objectContaining({ id: "workflows", owner: "provider" }),
		]);
		expect(workflows.guidance.join(" ")).not.toContain("Routine");
		expect(incompleteRoutines.capabilities).toEqual([
			expect.objectContaining({
				id: "routines",
				owner: "hlid",
				availability: "unavailable",
			}),
		]);
	});

	it("advertises orchestration only with a live workspace session and the complete lifecycle tools", () => {
		const available = buildHlidCapabilityManifest({
			providerId: "codex",
			runtimeCwd: "/work/hlid",
			sessionId: "session-1",
			providerCatalog: [
				{
					id: "codex",
					label: "Codex",
					available: true,
				},
			],
			registeredHlidTools: [
				"delegate_hlid_agent",
				"list_hlid_agents",
				"inspect_hlid_agent",
				"wait_hlid_agent",
				"steer_hlid_agent",
				"cancel_hlid_agent",
				"resume_hlid_agent",
			],
		});
		expect(
			available.capabilities.find((item) => item.id === "orchestration"),
		).toMatchObject({
			owner: "hlid",
			availability: "available",
		});

		const unknownTargets = buildHlidCapabilityManifest({
			providerId: "codex",
			runtimeCwd: "/work/hlid",
			sessionId: "session-1",
			registeredHlidTools: [
				"delegate_hlid_agent",
				"list_hlid_agents",
				"inspect_hlid_agent",
				"wait_hlid_agent",
				"steer_hlid_agent",
				"cancel_hlid_agent",
				"resume_hlid_agent",
			],
		});
		expect(
			unknownTargets.capabilities.find((item) => item.id === "orchestration"),
		).toMatchObject({ availability: "conditional" });

		const noAvailableTargets = buildHlidCapabilityManifest({
			providerId: "codex",
			runtimeCwd: "/work/hlid",
			sessionId: "session-1",
			providerCatalog: [],
			registeredHlidTools: [
				"delegate_hlid_agent",
				"list_hlid_agents",
				"inspect_hlid_agent",
				"wait_hlid_agent",
				"steer_hlid_agent",
				"cancel_hlid_agent",
				"resume_hlid_agent",
			],
		});
		expect(
			noAvailableTargets.capabilities.find(
				(item) => item.id === "orchestration",
			),
		).toMatchObject({ availability: "unavailable" });

		const detached = buildHlidCapabilityManifest({
			providerId: "codex",
			registeredHlidTools: [
				"delegate_hlid_agent",
				"list_hlid_agents",
				"inspect_hlid_agent",
				"wait_hlid_agent",
				"steer_hlid_agent",
				"cancel_hlid_agent",
				"resume_hlid_agent",
			],
		});
		expect(
			detached.capabilities.find((item) => item.id === "orchestration"),
		).toMatchObject({ availability: "conditional" });
	});

	it("exposes exact live target provider and model values only in focused orchestration help", () => {
		const providerCatalog = [
			{
				id: "codex",
				label: "Codex",
				available: true,
				effortLevels: [
					{ value: "medium", label: "Medium" },
					{ value: "high", label: "High" },
				],
				models: [
					{
						value: "gpt-5.6-sol",
						label: "GPT-5.6 Sol",
						isDefault: true,
						efforts: [
							{ value: "high", label: "High" },
							{ value: "xhigh", label: "Extra high" },
						],
						serviceTiers: [
							{ value: "fast", label: "Fast" },
							{ value: "flex", label: "Flex" },
						],
					},
					{
						value: "hidden-model",
						label: "Hidden",
						hidden: true,
					},
				],
			},
			{
				id: "acp:offline",
				label: "Offline ACP",
				available: false,
				unavailableReason: "Agent command is not configured.",
				models: [{ value: "acp-default", label: "ACP default" }],
			},
		];
		const focused = JSON.parse(
			buildHlidHelpResponse("orchestration", {
				providerId: "codex",
				runtimeCwd: "/work/hlid",
				sessionId: "session-1",
				providerCatalog,
				registeredHlidTools: [
					"delegate_hlid_agent",
					"list_hlid_agents",
					"inspect_hlid_agent",
					"wait_hlid_agent",
					"steer_hlid_agent",
					"cancel_hlid_agent",
					"resume_hlid_agent",
				],
			}),
		);

		expect(focused.orchestrationTargets).toMatchObject({
			source: "live-provider-catalog",
			snapshot: "current",
			totalProviders: 2,
			availableProviders: 1,
			returnedProviders: 2,
			truncated: false,
			providers: [
				{
					id: "codex",
					available: true,
					effortLevels: {
						total: 2,
						returned: 2,
						truncated: false,
						items: ["medium", "high"],
					},
					models: {
						total: 1,
						returned: 1,
						truncated: false,
						items: [
							{
								value: "gpt-5.6-sol",
								label: "GPT-5.6 Sol",
								isDefault: true,
								efforts: {
									total: 2,
									returned: 2,
									truncated: false,
									items: ["high", "xhigh"],
								},
								serviceTiers: {
									total: 2,
									returned: 2,
									truncated: false,
									items: ["fast", "flex"],
								},
							},
						],
					},
				},
				{
					id: "acp:offline",
					available: false,
					unavailableReason: "Agent command is not configured.",
				},
			],
		});
		expect(focused.capabilities[0]).toMatchObject({
			id: "orchestration",
			availability: "available",
		});
		expect(focused.guidance.join(" ")).toContain("bounded active progress");
		expect(focused.guidance.join(" ")).toContain("live running parent turn");
		expect(focused.guidance.join(" ")).toContain("active-capacity limits");
		expect(focused.guidance.join(" ")).toContain(
			"exact configured vault or a registered workspace",
		);
		expect(focused.guidance.join(" ")).toContain(
			"without using either as a lifecycle cap",
		);
		expect(focused.guidance.join(" ")).toContain("token_budget");
		expect(focused.guidance.join(" ")).toContain("cost_budget");
		expect(focused.guidance.join(" ")).toContain("budget_exhausted");
		expect(focused.guidance.join(" ")).toContain(
			"no elapsed-time or inactivity cap",
		);
		expect(focused.guidance.join(" ")).toContain(
			"cross-provider silence is not proof",
		);
		expect(focused.guidance.join(" ")).toContain(
			"Historical snapshots may retain inert timeout_seconds",
		);
		expect(focused.guidance.join(" ")).toContain(
			"Provider availability is checked before launch",
		);
		expect(focused.guidance).toContain(
			"For Codex user-input children, set permission_mode=plan: request_user_input is unavailable in default mode. A question-only turn does not enter plan review without a real plan.",
		);
		expect(focused.guidance.join(" ")).toContain(
			"Explicit cancel_hlid_agent is the way to stop work",
		);
		expect(focused.guidance.join(" ")).toContain(
			"Scheduled Routines may delegate",
		);
		expect(focused.guidance.join(" ")).toContain(
			"restart-interrupted non-Routine child",
		);
		expect(focused.guidance.join(" ")).toContain("retains provider control");
		expect(focused.guidance.join(" ")).toContain(
			"Closing that interrupted child from the live-session surface",
		);
		expect(focused.guidance.join(" ")).toContain(
			"until each provider turn settles",
		);

		const overview = JSON.parse(
			buildHlidHelpResponse("overview", {
				providerId: "codex",
				providerCatalog,
			}),
		);
		expect(overview.orchestrationTargets).toBeUndefined();
	});

	it("bounds oversized live orchestration catalogs and reports truncation", () => {
		const providerCatalog = Array.from({ length: 20 }, (_, providerIndex) => ({
			id: `provider-${providerIndex}-${"p".repeat(500)}`,
			label: `Provider ${providerIndex} ${"l".repeat(500)}`,
			available: true,
			models: Array.from({ length: 20 }, (_, modelIndex) => ({
				value: `model-${modelIndex}-${"m".repeat(500)}`,
				label: `Model ${modelIndex} ${"n".repeat(500)}`,
				efforts: Array.from({ length: 10 }, (_, effortIndex) => ({
					value: `effort-${effortIndex}-${"e".repeat(100)}`,
					label: `Effort ${effortIndex}`,
				})),
			})),
		}));
		const response = buildHlidHelpResponse("orchestration", {
			providerId: "codex",
			runtimeCwd: "/work/hlid",
			sessionId: "session-1",
			providerCatalog,
			registeredHlidTools: [
				"delegate_hlid_agent",
				"list_hlid_agents",
				"inspect_hlid_agent",
				"wait_hlid_agent",
				"steer_hlid_agent",
				"cancel_hlid_agent",
				"resume_hlid_agent",
			],
		});
		const parsed = JSON.parse(response);

		expect(response.length).toBeLessThanOrEqual(MAX_HLID_HELP_RESPONSE_CHARS);
		expect(
			JSON.stringify(parsed.orchestrationTargets).length,
		).toBeLessThanOrEqual(MAX_HLID_ORCHESTRATION_TARGET_CATALOG_CHARS);
		expect(parsed.orchestrationTargets).toMatchObject({
			totalProviders: 20,
			availableProviders: 20,
			truncated: true,
		});
		expect(parsed.orchestrationTargets.returnedProviders).toBeLessThan(20);
		expect(parsed.orchestrationTargets.providers[0].id).toBe(
			providerCatalog[0].id,
		);
		expect(
			parsed.orchestrationTargets.providers.some(
				(provider: { models: { truncated: boolean } }) =>
					provider.models.truncated,
			),
		).toBe(true);
	});

	it("fits a saturated live target projection inside the total help budget", () => {
		const providerCatalog = Array.from({ length: 100 }, (_, providerIndex) => ({
			id: `provider-${providerIndex}`,
			label: `Provider ${providerIndex}`,
			available: true,
			effortLevels: Array.from({ length: 4 }, (_, effortIndex) => ({
				value: `provider-effort-${effortIndex}`,
				label: `Provider effort ${effortIndex}`,
			})),
			models: Array.from({ length: 8 }, (_, modelIndex) => ({
				value: `model-${modelIndex}`,
				label: `Model ${modelIndex}`,
				efforts: Array.from({ length: 4 }, (_, effortIndex) => ({
					value: `model-effort-${effortIndex}`,
					label: `Model effort ${effortIndex}`,
				})),
				serviceTiers: Array.from({ length: 4 }, (_, tierIndex) => ({
					value: `tier-${tierIndex}`,
					label: `Tier ${tierIndex}`,
				})),
			})),
		}));
		const response = buildHlidHelpResponse("orchestration", {
			providerId: `codex-${"p".repeat(120)}`,
			model: `model-${"m".repeat(200)}`,
			effort: `effort-${"e".repeat(80)}`,
			permissionMode: `permission-${"r".repeat(80)}`,
			policyEnforced: true,
			runtimeCwd: "/work/hlid",
			sessionId: "session-1",
			vaultName: "Fornbok",
			agentMode: "cwd",
			codexRealtimeEnabled: true,
			codexRealtimeBackendAvailable: true,
			voiceSnapshot: { state: "ready", model: `voice-${"v".repeat(200)}` },
			ttsSnapshot: { state: "ready", model: `tts-${"t".repeat(200)}` },
			providerSnapshot: {
				id: "codex",
				label: "Codex",
				available: true,
				capabilities: {
					goalControl: true,
					structuredActivities: ["compact", "review"],
					realtime: true,
				},
				hostCapabilities: {
					windowsComputerUse: {
						label: "Windows Computer Use",
						available: true,
						reason: "r".repeat(300),
					},
				},
			},
			providerCatalog,
			registeredHlidTools: [
				"hlid_help",
				"hlid_api",
				"inspect_hlid_storage",
				"optimize_hlid_storage",
				"cleanup_hlid_sessions",
				"delegate_hlid_agent",
				"list_hlid_agents",
				"inspect_hlid_agent",
				"wait_hlid_agent",
				"steer_hlid_agent",
				"cancel_hlid_agent",
				"resume_hlid_agent",
				"publish_relic",
				"start_project_preview",
				"inspect_project_preview",
				"capture_project_preview",
				"control_project_preview",
				"stop_project_preview",
				"windows_computer_use",
			],
		});
		const parsed = JSON.parse(response);

		expect(response.length).toBeLessThanOrEqual(MAX_HLID_HELP_RESPONSE_CHARS);
		expect(
			JSON.stringify(parsed.orchestrationTargets).length,
		).toBeLessThanOrEqual(MAX_HLID_ORCHESTRATION_TARGET_CATALOG_CHARS);
		expect(parsed.orchestrationTargets).toMatchObject({
			totalProviders: 100,
			availableProviders: 100,
			truncated: true,
		});
		expect(parsed.orchestrationTargets.returnedProviders).toBeLessThan(100);
		expect(parsed.orchestrationTargets.providers[0].id).toBe("provider-0");
	});

	it("derives Computer Use and voice modes from live host, feature, model, and backend evidence", () => {
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
				capabilitySnapshot: codexRealtimeFeatureSnapshot(true),
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
				codex_dictation: { availability: "provider-native" },
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
				codex_dictation: { availability: "unavailable" },
				native_audio_input: { availability: "provider-native" },
				raven_live: { availability: "unavailable" },
			},
		});
		expect(disabled.registry.revision).not.toBe(manifest.registry.revision);
	});

	it("keeps coding-model audio separate from Raven Live readiness", () => {
		const context: HlidOperatingContext = {
			providerId: "codex",
			model: "gpt-text",
			codexRealtimeEnabled: true,
			providerSnapshot: {
				id: "codex",
				label: "Codex",
				available: true,
				models: [
					{
						value: "gpt-text",
						label: "Text and image",
						inputModalities: ["text", "image"],
					},
				],
				capabilities: { realtime: true },
				capabilitySnapshot: codexRealtimeFeatureSnapshot(true),
			},
		};
		const unknownBackend = buildHlidCapabilityManifest(context);

		expect(
			unknownBackend.capabilities.find((item) => item.id === "voice_audio"),
		).toMatchObject({
			modes: {
				native_audio_input: { availability: "unavailable" },
				codex_dictation: { availability: "conditional" },
				raven_live: { availability: "conditional" },
			},
		});

		const accepted = buildHlidCapabilityManifest({
			...context,
			codexRealtimeBackendAvailable: true,
		});
		expect(
			accepted.capabilities.find((item) => item.id === "voice_audio"),
		).toMatchObject({
			modes: {
				codex_dictation: { availability: "provider-native" },
				raven_live: { availability: "provider-native" },
			},
		});

		const providerSnapshot = context.providerSnapshot;
		if (!providerSnapshot) throw new Error("Codex provider fixture is missing");
		const featureDisabled = buildHlidCapabilityManifest({
			...context,
			providerSnapshot: {
				...providerSnapshot,
				capabilitySnapshot: codexRealtimeFeatureSnapshot(false),
			},
		});
		expect(
			featureDisabled.capabilities.find((item) => item.id === "voice_audio"),
		).toMatchObject({
			modes: {
				codex_dictation: { availability: "conditional" },
				raven_live: { availability: "unavailable" },
			},
		});

		const accountRejected = buildHlidCapabilityManifest({
			...context,
			codexRealtimeBackendAvailable: false,
			codexRealtimeBackendReason:
				"Codex realtime voice is not available for this ChatGPT account yet.",
		});
		expect(
			accountRejected.capabilities.find((item) => item.id === "voice_audio"),
		).toMatchObject({
			modes: {
				codex_dictation: {
					availability: "unavailable",
					summary:
						"Codex realtime voice is not available for this ChatGPT account yet.",
				},
				raven_live: {
					availability: "unavailable",
					summary:
						"Codex realtime voice is not available for this ChatGPT account yet.",
				},
			},
		});
		expect(accountRejected.registry.revision).not.toBe(
			unknownBackend.registry.revision,
		);
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
				capabilitySnapshot: codexRealtimeFeatureSnapshot(true),
			},
		});
		expect(
			manifest.capabilities.find((item) => item.id === "voice_audio"),
		).toMatchObject({
			availability: "available",
			modes: {
				native_audio_input: { availability: "provider-native" },
				codex_dictation: { availability: "conditional" },
				raven_live: { availability: "conditional" },
			},
		});
	});

	it("explains that dictation, Talk to Codex, and Raven Live have independent gates", () => {
		const response = JSON.parse(
			buildHlidHelpResponse("voice_audio", {
				providerId: "codex",
				codexRealtimeEnabled: true,
			}),
		) as { guidance: string[] };
		const guidance = response.guidance.join(" ");

		expect(guidance).toContain(
			"Codex realtime dictation is separate editable composer input.",
		);
		expect(guidance).toContain(
			"it does not require an audio-capable selected coding model",
		);
		expect(guidance).toContain(
			"Talk to Codex is a normal provider audio turn and requires an audio-capable selected coding model.",
		);
		expect(guidance).toContain(
			"Raven Live is an ongoing realtime conversation.",
		);
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
			codexRealtimeEnabled: true,
		});
		expect(
			manifest.capabilities.find((item) => item.id === "goals"),
		).toMatchObject({ availability: "conditional" });
		expect(
			manifest.capabilities.find((item) => item.id === "workflows"),
		).toMatchObject({ availability: "conditional" });
		expect(
			manifest.capabilities.find((item) => item.id === "computer_use"),
		).toMatchObject({ availability: "conditional" });
		expect(
			manifest.capabilities.find((item) => item.id === "voice_audio"),
		).toMatchObject({
			modes: {
				codex_dictation: { availability: "conditional" },
				raven_live: { availability: "conditional" },
			},
		});
		expect(manifest.registry.providerSnapshot).toBe("unavailable");
	});

	it("distinguishes captured provider evidence from a current live catalog", () => {
		const manifest = buildHlidCapabilityManifest({
			providerId: "codex",
			sessionId: "session-1",
			providerSnapshot: {
				id: "codex",
				label: "Codex",
				available: true,
				capabilities: { goalControl: true },
			},
			providerDiscovery: {
				status: "captured",
				source: "active-provider-context",
				retryable: true,
				reason: `provider route failed ${"x".repeat(5_000)}`,
			},
		});

		expect(manifest.registry).toMatchObject({
			providerSnapshot: "captured",
			providerDiscovery: {
				status: "captured",
				source: "active-provider-context",
				retryable: true,
			},
		});
		expect(manifest.registry.providerDiscovery?.reason?.length).toBeLessThan(
			400,
		);
		expect(
			manifest.capabilities.find((item) => item.id === "goals"),
		).toMatchObject({ availability: "provider-native" });
	});

	it("does not label captured provider capability data as a live catalog", () => {
		const context = {
			...providerHelpContext([
				providerCapability({
					id: "codex:goal-control",
					label: "Goal control",
					integration: "provider-native",
					availability: "provider-native",
				}),
			]),
			providerDiscovery: {
				status: "captured" as const,
				source: "active-provider-context" as const,
				retryable: true,
				reason: "Live provider discovery returned HTTP 503.",
			},
		};
		const response = JSON.parse(buildHlidHelpResponse("providers", context));

		expect(response.registry).toMatchObject({
			providerSnapshot: "captured",
			providerDiscovery: {
				status: "captured",
				source: "active-provider-context",
			},
		});
		expect(response.providerCapabilities).toMatchObject({
			source: "resolved-provider-capability-snapshot",
			snapshot: "current",
			items: [expect.objectContaining({ id: "codex:goal-control" })],
		});
	});

	it("returns a bounded focused provider capability inventory", () => {
		const response = JSON.parse(
			buildHlidHelpResponse("providers", {
				providerId: "claude",
				sessionId: "session-1",
				providerSnapshot: {
					id: "claude",
					label: "Claude",
					available: true,
					capabilitySnapshot: {
						contractVersion: 1,
						providerId: "claude",
						status: "current",
						source: "live",
						revision: "v1-provider-test",
						observedAt: 1,
						context: { cwd: "/work/project" },
						capabilities: [
							{
								id: "claude:sdk-control:interrupt",
								label: "SDK control: interrupt",
								scope: "session",
								support: "advertised",
								integration: "integrated",
								readiness: "ready",
								source: "provider-sdk",
								availability: "available",
							},
							{
								id: "claude:sdk-control:rewindfiles",
								label: "SDK control: rewind files",
								scope: "session",
								support: "advertised",
								integration: "not-integrated",
								readiness: "ready",
								source: "provider-sdk",
								availability: "unavailable",
								reason: "Hlid does not integrate it yet.",
							},
						],
					},
				},
			}),
		);

		expect(response.registry.providerCapabilities).toMatchObject({
			status: "current",
			total: 2,
			integrated: 1,
			notIntegrated: 1,
		});
		expect(response.providerCapabilities).toMatchObject({
			snapshot: "current",
			total: 2,
			returned: 2,
			context: { cwd: "/work/project" },
		});
		expect(response.providerCapabilities.items[0]).toMatchObject({
			integration: "not-integrated",
			availability: "unavailable",
		});
		expect(response.providerCapabilities.index).toMatchObject({
			actionableTotal: 2,
			providerNativeTotal: 0,
			notIntegrated: ["claude:sdk-control:rewindfiles"],
			integratedAvailable: ["claude:sdk-control:interrupt"],
		});
		expect(response.providerCapabilities.lookup.omission).toContain(
			"not evidence",
		);
	});

	it("indexes and retrieves a capability omitted from the default detail page", () => {
		const capabilities = [
			...Array.from({ length: 3 }, (_, index) =>
				providerCapability({
					id: `codex:not-integrated:${index}`,
					label: `Not integrated ${index}`,
					integration: "not-integrated",
					availability: "unavailable",
				}),
			),
			...Array.from({ length: 4 }, (_, index) =>
				providerCapability({
					id: `codex:conditional:${index}`,
					label: `Conditional ${index}`,
					readiness: "gated",
					availability: "conditional",
				}),
			),
			providerCapability({
				id: "codex:collaboration-mode:default",
				label: "Default",
			}),
			providerCapability({
				id: "codex:collaboration-mode:plan",
				label: "Plan",
				operations: ["select"],
			}),
		];
		const context = providerHelpContext(capabilities);
		const defaultPage = JSON.parse(buildHlidHelpResponse("providers", context));

		expect(defaultPage.providerCapabilities.total).toBe(9);
		expect(
			defaultPage.providerCapabilities.items.some(
				(item: { id: string }) => item.id === "codex:collaboration-mode:plan",
			),
		).toBe(false);
		expect(
			defaultPage.providerCapabilities.index.integratedAvailable,
		).toContain("codex:collaboration-mode:plan");
		expect(JSON.stringify(defaultPage).length).toBeLessThanOrEqual(
			MAX_HLID_HELP_RESPONSE_CHARS,
		);

		const search = JSON.parse(
			buildHlidHelpResponse("providers", context, {
				providerCapabilities: { query: "plan" },
			}),
		);
		expect(search.providerCapabilities).toMatchObject({
			total: 9,
			matched: 1,
			returned: 1,
			truncated: false,
		});
		expect(search.providerCapabilities.items[0]).toMatchObject({
			id: "codex:collaboration-mode:plan",
			integration: "integrated",
			availability: "available",
		});
		expect(search.providerCapabilities.index).toBeUndefined();

		const exact = JSON.parse(
			buildHlidHelpResponse("providers", context, {
				providerCapabilities: {
					capabilityId: "codex:collaboration-mode:plan",
				},
			}),
		);
		expect(exact.providerCapabilities.items).toEqual([
			expect.objectContaining({ label: "Plan" }),
		]);
	});

	it("pages filtered capabilities with a revision-bound self-contained cursor", () => {
		const capabilities = [
			providerCapability({ id: "codex:available:a", label: "Available A" }),
			providerCapability({ id: "codex:available:b", label: "Available B" }),
			providerCapability({ id: "codex:available:c", label: "Available C" }),
		];
		const context = providerHelpContext(capabilities, "v1-cursor-a");
		const first = JSON.parse(
			buildHlidHelpResponse("providers", context, {
				providerCapabilities: {
					integration: "integrated",
					availability: "available",
					limit: 1,
				},
			}),
		);
		expect(first.providerCapabilities).toMatchObject({
			matched: 3,
			returned: 1,
			offset: 0,
			truncated: true,
		});
		expect(first.providerCapabilities.nextCursor).toEqual(expect.any(String));

		const second = JSON.parse(
			buildHlidHelpResponse("providers", context, {
				providerCapabilities: {
					cursor: first.providerCapabilities.nextCursor,
					limit: 1,
				},
			}),
		);
		expect(second.providerCapabilities).toMatchObject({
			matched: 3,
			returned: 1,
			offset: 1,
			truncated: true,
		});
		expect(second.providerCapabilities.items[0].id).toBe("codex:available:b");
		expect(second.providerCapabilities.nextCursor).not.toBe(
			first.providerCapabilities.nextCursor,
		);

		expect(() =>
			buildHlidHelpResponse(
				"providers",
				providerHelpContext(capabilities, "v1-cursor-b"),
				{
					providerCapabilities: {
						cursor: first.providerCapabilities.nextCursor,
					},
				},
			),
		).toThrow(/catalog changed/i);
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

	it("uses resolved provider evidence before legacy command flags", () => {
		const manifest = buildHlidCapabilityManifest({
			providerId: "codex",
			sessionId: "session-1",
			providerSnapshot: {
				id: "codex",
				label: "Codex",
				available: true,
				capabilities: { goalControl: true },
				capabilitySnapshot: {
					contractVersion: 1,
					providerId: "codex",
					status: "current",
					source: "live",
					revision: "v1-goal-gated",
					observedAt: 1,
					capabilities: [
						{
							id: "codex:goal-control",
							label: "Durable goal control",
							scope: "session",
							support: "advertised",
							integration: "not-integrated",
							readiness: "ready",
							source: "provider-runtime",
							availability: "unavailable",
						},
					],
				},
			},
		});

		expect(manifest.registry.commandActions).not.toContain("goal");
		expect(
			manifest.capabilities.find((item) => item.id === "goals"),
		).toMatchObject({ availability: "unavailable" });
	});

	it("keeps conditional and non-current provider evidence conditional", () => {
		for (const [status, availability] of [
			["current", "conditional"],
			["stale", "unavailable"],
			["partial", "unavailable"],
		] as const) {
			const manifest = buildHlidCapabilityManifest({
				providerId: "codex",
				sessionId: "session-1",
				providerSnapshot: {
					id: "codex",
					label: "Codex",
					available: true,
					capabilities: { goalControl: true },
					capabilitySnapshot: {
						contractVersion: 1,
						providerId: "codex",
						status,
						source: status === "current" ? "live" : "memory",
						revision: `v1-goal-${status}`,
						observedAt: 1,
						capabilities: [
							{
								id: "codex:goal-control",
								label: "Durable goal control",
								scope: "session",
								support: "advertised",
								integration:
									availability === "unavailable"
										? "not-integrated"
										: "integrated",
								readiness:
									availability === "unavailable" ? "unavailable" : "gated",
								source: "provider-runtime",
								availability,
							},
						],
					},
				},
			});

			expect(manifest.registry.commandActions).not.toContain("goal");
			expect(
				manifest.capabilities.find((item) => item.id === "goals"),
			).toMatchObject({ availability: "conditional" });
		}
	});

	it("uses an explicit legacy false as negative provider evidence", () => {
		const manifest = buildHlidCapabilityManifest({
			providerId: "codex",
			sessionId: "session-1",
			providerSnapshot: {
				id: "codex",
				label: "Codex",
				available: true,
				capabilities: { goalControl: false },
				capabilitySnapshot: {
					contractVersion: 1,
					providerId: "codex",
					status: "stale",
					source: "memory",
					revision: "v1-goal-stale-with-explicit-negative",
					observedAt: 1,
					capabilities: [],
				},
			},
		});

		expect(manifest.registry.commandActions).not.toContain("goal");
		expect(
			manifest.capabilities.find((item) => item.id === "goals"),
		).toMatchObject({ availability: "unavailable" });
	});

	it("enables native goals from resolved provider evidence", () => {
		const manifest = buildHlidCapabilityManifest({
			providerId: "codex",
			sessionId: "session-1",
			providerSnapshot: {
				id: "codex",
				label: "Codex",
				available: true,
				capabilitySnapshot: {
					contractVersion: 1,
					providerId: "codex",
					status: "current",
					source: "live",
					revision: "v1-goal-current",
					observedAt: 1,
					capabilities: [
						{
							id: "codex:goal-control",
							label: "Durable goal control",
							scope: "session",
							support: "advertised",
							integration: "integrated",
							readiness: "ready",
							source: "provider-runtime",
							availability: "available",
						},
					],
				},
			},
		});

		expect(manifest.registry.commandActions).toContain("goal");
		expect(
			manifest.capabilities.find((item) => item.id === "goals"),
		).toMatchObject({ availability: "provider-native" });
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

	it.each(
		HLID_HELP_TOPICS,
	)("keeps %s help within the hard response budget", (topic) => {
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
				"inspect_hlid_storage",
				"optimize_hlid_storage",
				"cleanup_hlid_sessions",
				"delegate_hlid_agent",
				"list_hlid_agents",
				"inspect_hlid_agent",
				"wait_hlid_agent",
				"steer_hlid_agent",
				"cancel_hlid_agent",
				"resume_hlid_agent",
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
