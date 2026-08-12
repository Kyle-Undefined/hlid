import { describe, expect, it } from "vitest";
import { HlidConfigSchema } from "#/config";
import {
	applyAgentFormPatch,
	buildSettingsConfig,
	createSettingsForms,
} from "./settingsForm";

describe("settings form conversion", () => {
	it("creates editable string forms from persisted config", () => {
		const initial = HlidConfigSchema.parse({
			vault_provider: "codex",
			vault: {
				save_to_obsidian_template: "Quick Capture",
				obsidian_command_allowlist: ["templater-obsidian:insert-templater"],
			},
			claude: {
				max_turns: 12,
				agent_progress_summaries: true,
				interactive_mode: true,
				peer_inbox: true,
			},
			codex: {
				max_turns: 8,
				permission_profile: "workspace-safe",
				windows_computer_use: { model: "gpt-5.5", effort: "inherit" },
			},
			project_preview: { use_real_browser_profile: true },
			server: { port: 4000, tls_proxy_port: 4443 },
			status_vocabulary: { active: ["Doing"], planning: [], done: ["Done"] },
			ui: {
				html_plans: true,
				show_provider_entries: true,
				navigation_names: {
					preset: "plain",
					labels: { einherjar: "Team Space" },
				},
			},
		});
		const forms = createSettingsForms(initial);

		expect(forms.claude).toMatchObject({
			maxTurns: "12",
			vaultProvider: "codex",
			agentProgressSummaries: true,
			interactiveMode: true,
			peerInbox: true,
		});
		expect(forms.codex.maxTurns).toBe("8");
		expect(forms.codex.permissionProfile).toBe("workspace-safe");
		expect(forms.vault.saveToObsidianTemplate).toBe("Quick Capture");
		expect(forms.vault.obsidianCommandAllowlist).toEqual([
			"templater-obsidian:insert-templater",
		]);
		expect(forms.codex.windowsComputerUseModel).toBe("gpt-5.5");
		expect(forms.codex.windowsComputerUseEffort).toBe("inherit");
		expect(forms.projectPreview.useRealBrowserProfile).toBe(true);
		expect(forms.server).toMatchObject({ port: "4000", tlsProxyPort: "4443" });
		expect(forms.ui.htmlPlans).toBe(true);
		expect(forms.ui.showProviderEntries).toBe(true);
		expect(forms.ui.liveSessionsHotkey).toBe("Alt+Shift+KeyS");
		expect(forms.ui.navigationNames).toEqual({
			preset: "plain",
			labels: { einherjar: "Team Space" },
		});
		expect(forms.vocab).toEqual({
			active: "Doing",
			planning: "",
			done: "Done",
		});
	});

	it("round-trips navigation names without sharing the persisted labels object", () => {
		const initial = HlidConfigSchema.parse({
			ui: {
				navigation_names: {
					preset: "plain",
					labels: { einherjar: "Team Space" },
				},
			},
		});
		const forms = createSettingsForms(initial);
		forms.ui.navigationNames.labels.forge = "Workshop";

		expect(initial.ui.navigation_names.labels).toEqual({
			einherjar: "Team Space",
		});
		expect(
			buildSettingsConfig(initial, forms, false).ui.navigation_names,
		).toEqual({
			preset: "plain",
			labels: { einherjar: "Team Space", forge: "Workshop" },
		});
	});

	it("round-trips the optional Codex permission profile", () => {
		const initial = HlidConfigSchema.parse({
			codex: { permission_profile: "workspace-safe" },
		});
		const forms = createSettingsForms(initial);
		expect(forms.codex.permissionProfile).toBe("workspace-safe");
		expect(
			buildSettingsConfig(initial, forms, false).codex.permission_profile,
		).toBe("workspace-safe");

		forms.codex = { ...forms.codex, permissionProfile: "" };
		expect(
			buildSettingsConfig(initial, forms, false).codex.permission_profile,
		).toBeUndefined();
	});

	it("resets OpenCode agent defaults excluded by a staged model filter", () => {
		const initial = HlidConfigSchema.parse({
			agents: [
				{
					path: "/hidden",
					provider: "acp:opencode",
					model: "opencode/model-hidden",
					recap_model: "opencode/recap-hidden",
				},
				{
					path: "/allowed",
					provider: "acp:opencode",
					model: "opencode/model-allowed",
				},
				{
					path: "/native",
					provider: "claude",
					model: "custom-model",
				},
			],
		});
		const forms = createSettingsForms(initial);
		forms.acpAgents = [
			{
				id: "opencode",
				model_filter: {
					mode: "hide",
					models: ["opencode/model-hidden", "opencode/recap-hidden"],
				},
			},
		];

		const config = buildSettingsConfig(initial, forms, false);

		expect(config.agents).toEqual([
			{
				...initial.agents[0],
				model: undefined,
				recap_model: undefined,
			},
			initial.agents[1],
			initial.agents[2],
		]);
		expect(HlidConfigSchema.safeParse(config).success).toBe(true);
	});

	it("defaults the Claude peer inbox off and persists an explicit opt-in", () => {
		const initial = HlidConfigSchema.parse({});
		expect(initial.claude.peer_inbox).toBe(false);
		const forms = createSettingsForms(initial);
		expect(forms.claude.peerInbox).toBe(false);

		forms.claude = { ...forms.claude, peerInbox: true };
		expect(buildSettingsConfig(initial, forms, false).claude.peer_inbox).toBe(
			true,
		);
	});

	it("defaults Claude AI subagent summaries off and persists an explicit opt-in", () => {
		const initial = HlidConfigSchema.parse({});
		expect(initial.claude.agent_progress_summaries).toBe(false);
		const forms = createSettingsForms(initial);
		expect(forms.claude.agentProgressSummaries).toBe(false);

		forms.claude = { ...forms.claude, agentProgressSummaries: true };
		expect(
			buildSettingsConfig(initial, forms, false).claude
				.agent_progress_summaries,
		).toBe(true);
	});

	it("round-trips an empty workspace Obsidian template selection", () => {
		const initial = HlidConfigSchema.parse({});
		const forms = createSettingsForms(initial);
		expect(forms.vault.saveToObsidianTemplate).toBe("");
		expect(
			buildSettingsConfig(initial, forms, false).vault
				.save_to_obsidian_template,
		).toBeUndefined();
	});

	it("keeps persisted network values for auto-save and commits them explicitly", () => {
		const initial = HlidConfigSchema.parse({ server: { port: 3000 } });
		const forms = createSettingsForms(initial);
		forms.server = {
			...forms.server,
			port: "4100",
			tlsProxyPort: "4555",
			localNetworkAccess: true,
		};

		expect(buildSettingsConfig(initial, forms, false).server).toEqual(
			initial.server,
		);
		expect(buildSettingsConfig(initial, forms, true).server).toMatchObject({
			port: 4100,
			tls_proxy_port: 4555,
			local_network_access: true,
		});
	});

	it("normalizes max turns, vocabulary, and same-theme values", () => {
		const initial = HlidConfigSchema.parse({});
		const forms = createSettingsForms(initial);
		forms.claude = { ...forms.claude, maxTurns: "not-a-number" };
		forms.codex = { ...forms.codex, maxTurns: "9" };
		forms.vocab = {
			active: " Active, Doing, ",
			planning: "Planning",
			done: "Done, Complete",
		};
		forms.ui = { ...forms.ui, mobileTheme: "same", htmlPlans: true };

		const config = buildSettingsConfig(initial, forms, false);
		expect(config.claude.max_turns).toBeUndefined();
		expect(config.codex.max_turns).toBe(9);
		expect(config.codex.windows_computer_use).toEqual({
			model: "inherit",
			effort: "medium",
		});
		expect(config.project_preview.use_real_browser_profile).toBe(false);
		expect(config.status_vocabulary).toEqual({
			active: ["Active", "Doing"],
			planning: ["Planning"],
			done: ["Done", "Complete"],
		});
		expect(config.ui.mobile_theme).toBeUndefined();
		expect(config.ui.html_plans).toBe(true);
		expect(config.ui.live_sessions_hotkey).toBe("Alt+Shift+KeyS");
	});

	it("defaults HTML plans off when the setting is absent", () => {
		const forms = createSettingsForms(HlidConfigSchema.parse({}));
		expect(forms.ui.htmlPlans).toBe(false);
		expect(forms.ui.showProviderEntries).toBe(false);
		expect(forms.ui.liveSessionsHotkey).toBe("Alt+Shift+KeyS");
		expect(forms.ui.navigationNames).toEqual({ preset: "plain", labels: {} });
	});

	it("copies the selected built-in into new desktop and mobile custom palettes", () => {
		const forms = createSettingsForms(
			HlidConfigSchema.parse({
				ui: { theme: "dark", mobile_theme: "tan" },
			}),
		);
		expect(forms.ui.customTheme.background).toBe("#0f0f12");
		expect(forms.ui.mobileCustomTheme.background).toBe("#f0e6d3");

		forms.ui.theme = "custom";
		forms.ui.mobileTheme = "custom";
		const config = buildSettingsConfig(
			HlidConfigSchema.parse({}),
			forms,
			false,
		);
		expect(config.ui.custom_theme).toEqual(forms.ui.customTheme);
		expect(config.ui.mobile_custom_theme).toEqual(forms.ui.mobileCustomTheme);
	});

	it("round-trips auto-sleep through the percent form", () => {
		const initial = HlidConfigSchema.parse({
			auto_sleep: { enabled: true, threshold: 0.4, max_sleep_minutes: 120 },
		});
		const forms = createSettingsForms(initial);
		expect(forms.autoSleep).toEqual({
			enabled: true,
			thresholdPercent: "40",
			maxSleepMinutes: "120",
			resumeBufferSeconds: "60",
		});

		expect(buildSettingsConfig(initial, forms, false).auto_sleep).toEqual(
			initial.auto_sleep,
		);
	});

	it("clamps and defaults invalid auto-sleep values", () => {
		const initial = HlidConfigSchema.parse({});
		const forms = createSettingsForms(initial);
		forms.autoSleep = {
			enabled: true,
			thresholdPercent: "250",
			maxSleepMinutes: "not-a-number",
			resumeBufferSeconds: "",
		};

		expect(buildSettingsConfig(initial, forms, false).auto_sleep).toEqual({
			enabled: true,
			threshold: 1,
			max_sleep_minutes: 360,
			resume_buffer_seconds: 60,
		});
	});
});

describe("agent form routing", () => {
	it("routes provider selection to Claude and model fields to the active provider", () => {
		const forms = createSettingsForms(HlidConfigSchema.parse({}));
		const selected = applyAgentFormPatch(
			forms.claude,
			forms.codex,
			forms.cliproxy,
			forms.acpAgents,
			{ vaultProvider: "codex" },
		);
		expect(selected.claude.vaultProvider).toBe("codex");

		const edited = applyAgentFormPatch(
			selected.claude,
			selected.codex,
			selected.cliproxy,
			selected.acpAgents,
			{
				model: "gpt-5.5",
				effort: "high",
				maxTurns: "15",
				permissionProfile: "workspace-safe",
			},
		);
		expect(edited.codex).toMatchObject({
			model: "gpt-5.5",
			effort: "high",
			maxTurns: "15",
			permissionProfile: "workspace-safe",
		});
		expect(edited.claude.model).toBe(forms.claude.model);

		const selectedProxy = applyAgentFormPatch(
			edited.claude,
			edited.codex,
			edited.cliproxy,
			edited.acpAgents,
			{ vaultProvider: "cliproxy-codex" },
		);
		const editedProxy = applyAgentFormPatch(
			selectedProxy.claude,
			selectedProxy.codex,
			selectedProxy.cliproxy,
			selectedProxy.acpAgents,
			{ model: "gpt-5.6-sol", effort: "xhigh" },
		);
		expect(editedProxy.cliproxy).toMatchObject({
			model: "gpt-5.6-sol",
			effort: "xhigh",
		});
		expect(editedProxy.codex.model).toBe("gpt-5.5");
	});

	it("routes ACP defaults into that agent instead of Claude or CLIProxy", () => {
		const forms = createSettingsForms(
			HlidConfigSchema.parse({ acp_agents: [{ id: "opencode" }] }),
		);
		const selected = applyAgentFormPatch(
			forms.claude,
			forms.codex,
			forms.cliproxy,
			forms.acpAgents,
			{ vaultProvider: "acp:opencode" },
		);
		const edited = applyAgentFormPatch(
			selected.claude,
			selected.codex,
			selected.cliproxy,
			selected.acpAgents,
			{
				model: "anthropic/claude-sonnet-4-6",
				effort: "high",
				maxTurns: "18",
				permissionMode: "bypassPermissions",
				turnRecaps: false,
			},
		);

		expect(edited.acpAgents).toEqual([
			expect.objectContaining({
				id: "opencode",
				model: "anthropic/claude-sonnet-4-6",
				effort: "high",
				permission_mode: "bypassPermissions",
				turn_recaps: false,
			}),
		]);
		expect(edited.acpAgents[0]).not.toHaveProperty("max_turns");
		expect(edited.claude.model).toBe(forms.claude.model);
		expect(edited.cliproxy.model).toBe(forms.cliproxy.model);
	});
});
