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
			claude: { max_turns: 12, interactive_mode: true },
			codex: { max_turns: 8 },
			server: { port: 4000, tls_proxy_port: 4443 },
			status_vocabulary: { active: ["Doing"], planning: [], done: ["Done"] },
			ui: { html_plans: true },
		});
		const forms = createSettingsForms(initial);

		expect(forms.claude).toMatchObject({
			maxTurns: "12",
			vaultProvider: "codex",
			interactiveMode: true,
		});
		expect(forms.codex.maxTurns).toBe("8");
		expect(forms.server).toMatchObject({ port: "4000", tlsProxyPort: "4443" });
		expect(forms.ui.htmlPlans).toBe(true);
		expect(forms.vocab).toEqual({
			active: "Doing",
			planning: "",
			done: "Done",
		});
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
		expect(config.status_vocabulary).toEqual({
			active: ["Active", "Doing"],
			planning: ["Planning"],
			done: ["Done", "Complete"],
		});
		expect(config.ui.mobile_theme).toBeUndefined();
		expect(config.ui.html_plans).toBe(true);
	});

	it("defaults HTML plans off when the setting is absent", () => {
		const forms = createSettingsForms(HlidConfigSchema.parse({}));
		expect(forms.ui.htmlPlans).toBe(false);
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
		const selected = applyAgentFormPatch(forms.claude, forms.codex, {
			vaultProvider: "codex",
		});
		expect(selected.claude.vaultProvider).toBe("codex");

		const edited = applyAgentFormPatch(selected.claude, selected.codex, {
			model: "gpt-5.5",
			effort: "high",
			maxTurns: "15",
		});
		expect(edited.codex).toMatchObject({
			model: "gpt-5.5",
			effort: "high",
			maxTurns: "15",
		});
		expect(edited.claude.model).toBe(forms.claude.model);
	});
});
