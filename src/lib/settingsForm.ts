import type { ClaudeForm } from "#/components/forge/ClaudeSection";
import type { ServerForm } from "#/components/forge/NetworkSection";
import type { UiForm } from "#/components/forge/UiSection";
import type { VaultForm } from "#/components/forge/VaultSection";
import type { VocabForm } from "#/components/forge/VocabSection";
import type { VoiceForm } from "#/components/forge/VoiceSection";
import type { HlidConfig } from "#/config";
import {
	DEFAULT_ATTACHMENTS_CONFIG,
	DEFAULT_AUTO_SLEEP_CONFIG,
} from "#/config";
import { buildVaultSection } from "#/lib/vaultConfig";

export type CodexForm = {
	model: string;
	effort: HlidConfig["codex"]["effort"];
	maxTurns: string;
	permissionMode: HlidConfig["codex"]["permission_mode"];
	turnRecaps: boolean;
	recapModel: string;
};

export type AutoSleepForm = {
	enabled: boolean;
	/** Percent 1–100; stored in config as a 0.01–1 fraction. */
	thresholdPercent: string;
	maxSleepMinutes: string;
	resumeBufferSeconds: string;
};

export type SettingsForms = {
	vault: VaultForm;
	claude: ClaudeForm;
	codex: CodexForm;
	voice: VoiceForm;
	server: ServerForm;
	ui: UiForm;
	vocab: VocabForm;
	acpAgents: NonNullable<HlidConfig["acp_agents"]>;
	umbod: HlidConfig["umbod"];
	autoSleep: AutoSleepForm;
};

export function applyAgentFormPatch(
	claude: ClaudeForm,
	codex: CodexForm,
	patch: Partial<ClaudeForm>,
): { claude: ClaudeForm; codex: CodexForm } {
	if (patch.vaultProvider) {
		return { claude: { ...claude, vaultProvider: patch.vaultProvider }, codex };
	}
	if (claude.vaultProvider !== "codex") {
		return { claude: { ...claude, ...patch }, codex };
	}
	return {
		claude,
		codex: {
			...codex,
			...(patch.model !== undefined ? { model: patch.model } : {}),
			...(patch.effort !== undefined
				? { effort: patch.effort as CodexForm["effort"] }
				: {}),
			...(patch.maxTurns !== undefined ? { maxTurns: patch.maxTurns } : {}),
			...(patch.permissionMode !== undefined
				? {
						permissionMode: patch.permissionMode as CodexForm["permissionMode"],
					}
				: {}),
			...(patch.turnRecaps !== undefined
				? { turnRecaps: patch.turnRecaps }
				: {}),
			...(patch.recapModel !== undefined
				? { recapModel: patch.recapModel }
				: {}),
		},
	};
}

function optionalNumber(value: number | undefined): string {
	return value === undefined ? "" : String(value);
}

function createVaultForm(initial: HlidConfig): VaultForm {
	return {
		style: initial.vault.style ?? "para",
		name: initial.vault.name,
		path: initial.vault.path,
		inbox: initial.vault.inbox ?? "",
		projects: initial.vault.projects ?? "",
		areas: initial.vault.areas ?? "",
		resources: initial.vault.resources ?? "",
		archive: initial.vault.archive ?? "",
		raw: initial.vault.raw ?? "",
		wikiFolder: initial.vault.wiki_folder ?? "",
		outputs: initial.vault.outputs ?? "",
		skills: initial.vault.skills ?? "",
		memory: initial.vault.memory ?? "",
	};
}

function createClaudeForm(initial: HlidConfig): ClaudeForm {
	return {
		model: initial.claude.model,
		effort: initial.claude.effort,
		maxTurns: optionalNumber(initial.claude.max_turns),
		permissionMode: initial.claude.permission_mode,
		turnRecaps: initial.claude.turn_recaps ?? true,
		recapModel: initial.claude.recap_model ?? "",
		vaultProvider: initial.vault_provider ?? "claude",
		interactiveMode: initial.claude.interactive_mode ?? false,
	};
}

function createCodexForm(initial: HlidConfig): CodexForm {
	return {
		model: initial.codex.model,
		effort: initial.codex.effort,
		maxTurns: optionalNumber(initial.codex.max_turns),
		permissionMode: initial.codex.permission_mode,
		turnRecaps: initial.codex.turn_recaps ?? true,
		recapModel: initial.codex.recap_model ?? "",
	};
}

function createServerForm(initial: HlidConfig): ServerForm {
	return {
		port: String(initial.server.port),
		tlsCertPath: initial.server.tls_cert_path ?? "",
		tlsKeyPath: initial.server.tls_key_path ?? "",
		tlsProxyPort:
			initial.server.tls_proxy_port == null
				? ""
				: String(initial.server.tls_proxy_port),
		localNetworkAccess: initial.server.local_network_access ?? false,
		allowExternalAgents: initial.server.allow_external_agents ?? false,
	};
}

function createUiForm(initial: HlidConfig): UiForm {
	return {
		theme: initial.ui.theme,
		mobileTheme: initial.ui.mobile_theme ?? "same",
		enterToSubmit: initial.ui.enter_to_submit,
		hideSkillsIndex: initial.ui.hide_skills_index,
		htmlPlans: initial.ui.html_plans ?? false,
	};
}

function createAutoSleepForm(initial: HlidConfig): AutoSleepForm {
	return {
		enabled: initial.auto_sleep.enabled,
		thresholdPercent: String(Math.round(initial.auto_sleep.threshold * 100)),
		maxSleepMinutes: String(initial.auto_sleep.max_sleep_minutes),
		resumeBufferSeconds: String(initial.auto_sleep.resume_buffer_seconds),
	};
}

function createVocabForm(initial: HlidConfig): VocabForm {
	return {
		active: initial.status_vocabulary.active.join(", "),
		planning: initial.status_vocabulary.planning.join(", "),
		done: initial.status_vocabulary.done.join(", "),
	};
}

export function createSettingsForms(initial: HlidConfig): SettingsForms {
	return {
		vault: createVaultForm(initial),
		claude: createClaudeForm(initial),
		codex: createCodexForm(initial),
		voice: initial.voice,
		acpAgents: initial.acp_agents ?? [],
		umbod: initial.umbod,
		autoSleep: createAutoSleepForm(initial),
		server: createServerForm(initial),
		ui: createUiForm(initial),
		vocab: createVocabForm(initial),
	};
}

function parsedMaxTurns(value: string): number | undefined {
	return value !== "" && !Number.isNaN(Number(value))
		? Number(value)
		: undefined;
}

function vocabularyValues(value: string): string[] {
	return value
		.split(",")
		.map((item) => item.trim())
		.filter(Boolean);
}

/** Parse to an integer clamped to [min, max]; fall back when not a number. */
function boundedInt(
	value: string,
	min: number,
	max: number,
	fallback: number,
): number {
	const parsed = Number(value);
	if (value.trim() === "" || !Number.isFinite(parsed)) return fallback;
	return Math.min(max, Math.max(min, Math.round(parsed)));
}

function autoSleepConfig(form: AutoSleepForm): HlidConfig["auto_sleep"] {
	return {
		enabled: form.enabled,
		threshold:
			boundedInt(
				form.thresholdPercent,
				1,
				100,
				DEFAULT_AUTO_SLEEP_CONFIG.threshold * 100,
			) / 100,
		max_sleep_minutes: boundedInt(
			form.maxSleepMinutes,
			1,
			1440,
			DEFAULT_AUTO_SLEEP_CONFIG.max_sleep_minutes,
		),
		resume_buffer_seconds: boundedInt(
			form.resumeBufferSeconds,
			0,
			600,
			DEFAULT_AUTO_SLEEP_CONFIG.resume_buffer_seconds,
		),
	};
}

function serverConfig(
	initial: HlidConfig,
	server: ServerForm,
	requiresRestart: boolean,
): HlidConfig["server"] {
	if (!requiresRestart) return initial.server;
	return {
		port: Number(server.port) || 3000,
		tls_cert_path: server.tlsCertPath || undefined,
		tls_key_path: server.tlsKeyPath || undefined,
		tls_proxy_port: Number(server.tlsProxyPort) || 3443,
		local_network_access: server.localNetworkAccess,
		allow_external_agents: server.allowExternalAgents,
	};
}

export function buildSettingsConfig(
	initial: HlidConfig,
	forms: SettingsForms,
	requiresRestart: boolean,
): HlidConfig {
	return {
		vault_provider: forms.claude.vaultProvider,
		vault: buildVaultSection(forms.vault),
		server: serverConfig(initial, forms.server, requiresRestart),
		claude: {
			model: forms.claude.model,
			effort: forms.claude.effort,
			max_turns: parsedMaxTurns(forms.claude.maxTurns),
			permission_mode: forms.claude.permissionMode,
			turn_recaps: forms.claude.turnRecaps,
			recap_model: forms.claude.recapModel || undefined,
			interactive_mode: forms.claude.interactiveMode,
		},
		codex: {
			model: forms.codex.model,
			effort: forms.codex.effort,
			max_turns: parsedMaxTurns(forms.codex.maxTurns),
			permission_mode: forms.codex.permissionMode,
			turn_recaps: forms.codex.turnRecaps,
			recap_model: forms.codex.recapModel || undefined,
			executable: initial.codex.executable,
		},
		ui: {
			enter_to_submit: forms.ui.enterToSubmit,
			hide_skills_index: forms.ui.hideSkillsIndex,
			theme: forms.ui.theme,
			mobile_theme:
				forms.ui.mobileTheme === "same" ? undefined : forms.ui.mobileTheme,
			html_plans: forms.ui.htmlPlans,
		},
		status_vocabulary: {
			active: vocabularyValues(forms.vocab.active),
			planning: vocabularyValues(forms.vocab.planning),
			done: vocabularyValues(forms.vocab.done),
		},
		attachments: initial.attachments ?? DEFAULT_ATTACHMENTS_CONFIG,
		voice: forms.voice,
		umbod: forms.umbod,
		auto_sleep: autoSleepConfig(forms.autoSleep),
		agents: initial.agents ?? [],
		acp_agents: forms.acpAgents,
	};
}
