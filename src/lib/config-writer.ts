import {
	DEFAULT_ATTACHMENTS_CONFIG,
	DEFAULT_AUTO_SLEEP_CONFIG,
	DEFAULT_CLIPROXY_CONFIG,
	DEFAULT_VOICE_CONFIG,
	type HlidConfig,
} from "../config";
import { setConfigCache } from "../server/config";
import { bumpDataRevision } from "../server/dataRevision";
import { syncWrappers } from "../server/wrappers";
import { writeFileAtomicSync } from "./atomicFile";
import { CONFIG_PATH } from "./paths";

function tomlVal(value: unknown): string {
	if (typeof value === "string") return JSON.stringify(value);
	if (typeof value === "number" || typeof value === "boolean")
		return String(value);
	if (Array.isArray(value))
		return `[${value.map((v) => JSON.stringify(v)).join(", ")}]`;
	return JSON.stringify(value);
}

function tomlInlineTable(value: Record<string, string>): string {
	return `{ ${Object.entries(value)
		.map(([key, item]) => `${JSON.stringify(key)} = ${tomlVal(item)}`)
		.join(", ")} }`;
}

function section(name: string, entries: string[]): string[] {
	return [`[${name}]`, ...entries];
}

function optionalEntry(
	key: string,
	value: unknown,
	include = value !== undefined && value !== "",
): string[] {
	return include ? [`${key} = ${tomlVal(value)}`] : [];
}

function serializeVault(config: HlidConfig["vault"]): string[] {
	return section("vault", [
		`name = ${tomlVal(config.name)}`,
		`path = ${tomlVal(config.path)}`,
		...optionalEntry("style", config.style),
		...optionalEntry("inbox", config.inbox),
		...optionalEntry("projects", config.projects),
		...optionalEntry("areas", config.areas),
		...optionalEntry("resources", config.resources),
		...optionalEntry("archive", config.archive),
		...optionalEntry("raw", config.raw),
		...optionalEntry("wiki_folder", config.wiki_folder),
		...optionalEntry("skills", config.skills),
		...optionalEntry("memory", config.memory),
		...optionalEntry("outputs", config.outputs),
		...optionalEntry(
			"save_to_obsidian_template",
			config.save_to_obsidian_template,
		),
		`delete_vault_attachments = ${tomlVal(config.delete_vault_attachments)}`,
	]);
}

function serializeServer(config: HlidConfig["server"]): string[] {
	return section("server", [
		`port = ${tomlVal(config.port)}`,
		...optionalEntry("tls_cert_path", config.tls_cert_path),
		...optionalEntry("tls_key_path", config.tls_key_path),
		...optionalEntry("tls_proxy_port", config.tls_proxy_port),
		...optionalEntry("local_network_access", true, config.local_network_access),
		...optionalEntry(
			"allow_external_agents",
			true,
			config.allow_external_agents,
		),
	]);
}

function serializeVoice(config: HlidConfig["voice"]): string[] {
	const voice = config ?? DEFAULT_VOICE_CONFIG;
	return section("voice", [
		`enabled = ${tomlVal(voice.enabled)}`,
		`model = ${tomlVal(voice.model)}`,
		`language = ${tomlVal(voice.language)}`,
		`auto_send = ${tomlVal(voice.auto_send)}`,
		`read_aloud_provider = ${tomlVal(voice.read_aloud_provider)}`,
		`read_aloud_voice = ${tomlVal(voice.read_aloud_voice)}`,
		`read_aloud_rate = ${tomlVal(voice.read_aloud_rate)}`,
		`hotkey = ${tomlVal(voice.hotkey)}`,
		`max_recording_seconds = ${tomlVal(voice.max_recording_seconds)}`,
		`threads = ${tomlVal(voice.threads)}`,
		`vocabulary = ${tomlVal(voice.vocabulary)}`,
	]);
}

function serializeUmbod(config: HlidConfig["umbod"]): string[] {
	const value = config ?? { enabled: false, manifest_path: "umbod.toml" };
	return section("umbod", [
		`enabled = ${tomlVal(value.enabled)}`,
		`manifest_path = ${tomlVal(value.manifest_path)}`,
	]);
}

function serializeAutoSleep(config: HlidConfig["auto_sleep"]): string[] {
	const value = config ?? DEFAULT_AUTO_SLEEP_CONFIG;
	return section("auto_sleep", [
		`enabled = ${tomlVal(value.enabled)}`,
		`threshold = ${tomlVal(value.threshold)}`,
		`max_sleep_minutes = ${tomlVal(value.max_sleep_minutes)}`,
		`resume_buffer_seconds = ${tomlVal(value.resume_buffer_seconds)}`,
	]);
}

function serializeClaude(config: HlidConfig["claude"]): string[] {
	return section("claude", [
		`model = ${tomlVal(config.model)}`,
		`effort = ${tomlVal(config.effort)}`,
		`permission_mode = ${tomlVal(config.permission_mode)}`,
		`turn_recaps = ${tomlVal(config.turn_recaps)}`,
		...optionalEntry("max_turns", config.max_turns),
		...optionalEntry("recap_model", config.recap_model),
		...optionalEntry("interactive_mode", true, config.interactive_mode),
	]);
}

function serializeCliProxy(config: HlidConfig["cliproxy"]): string[] {
	return section("cliproxy", [
		`enabled = ${tomlVal(config.enabled)}`,
		`mode = ${tomlVal(config.mode)}`,
		`base_url = ${tomlVal(config.base_url)}`,
		`api_key = ${tomlVal(config.api_key)}`,
		`model = ${tomlVal(config.model)}`,
		`effort = ${tomlVal(config.effort)}`,
		`permission_mode = ${tomlVal(config.permission_mode)}`,
		`turn_recaps = ${tomlVal(config.turn_recaps)}`,
		...optionalEntry("max_turns", config.max_turns),
		...optionalEntry("recap_model", config.recap_model),
	]);
}

function serializeCodex(config: NonNullable<HlidConfig["codex"]>): string[] {
	return section("codex", [
		...optionalEntry("model", config.model),
		`effort = ${tomlVal(config.effort)}`,
		`permission_mode = ${tomlVal(config.permission_mode)}`,
		`turn_recaps = ${tomlVal(config.turn_recaps)}`,
		...optionalEntry("max_turns", config.max_turns),
		...optionalEntry("recap_model", config.recap_model),
		...optionalEntry("executable", config.executable),
	]);
}

function serializeWindowsComputerUse(
	config: NonNullable<HlidConfig["codex"]>["windows_computer_use"],
): string[] {
	return section("codex.windows_computer_use", [
		`model = ${tomlVal(config.model)}`,
		`effort = ${tomlVal(config.effort)}`,
	]);
}

function serializeUi(config: HlidConfig["ui"]): string[] {
	return section("ui", [
		`enter_to_submit = ${tomlVal(config.enter_to_submit)}`,
		`hide_skills_index = ${tomlVal(config.hide_skills_index)}`,
		`show_provider_entries = ${tomlVal(config.show_provider_entries)}`,
		`html_plans = ${tomlVal(config.html_plans)}`,
		`theme = ${tomlVal(config.theme)}`,
		...optionalEntry("mobile_theme", config.mobile_theme),
	]);
}

function serializeThemePalette(
	name: "ui.custom_theme" | "ui.mobile_custom_theme",
	palette: HlidConfig["ui"]["custom_theme"],
): string[] {
	if (!palette) return [];
	return section(
		name,
		Object.entries(palette).map(([key, value]) => `${key} = ${tomlVal(value)}`),
	);
}

function serializeStatusVocabulary(
	config: HlidConfig["status_vocabulary"],
): string[] {
	return section("status_vocabulary", [
		`active = ${tomlVal(config.active)}`,
		`planning = ${tomlVal(config.planning)}`,
		`done = ${tomlVal(config.done)}`,
	]);
}

function serializeAttachments(config: HlidConfig["attachments"]): string[] {
	const attachments = config ?? DEFAULT_ATTACHMENTS_CONFIG;
	return section("attachments", [
		`max_bytes = ${tomlVal(attachments.max_bytes)}`,
		`allowed_mimes = ${tomlVal(attachments.allowed_mimes)}`,
	]);
}

function serializeAgent(
	agent: NonNullable<HlidConfig["agents"]>[number],
): string[] {
	return [
		"[[agents]]",
		`path = ${tomlVal(agent.path)}`,
		...optionalEntry("name", agent.name),
		...optionalEntry(
			"mode",
			agent.mode,
			agent.mode !== undefined && agent.mode !== "cwd",
		),
		...optionalEntry(
			"provider",
			agent.provider,
			agent.provider !== undefined && agent.provider !== "claude",
		),
		...optionalEntry("model", agent.model),
		...optionalEntry("effort", agent.effort),
		...optionalEntry("max_turns", agent.max_turns),
		...optionalEntry("permission_mode", agent.permission_mode),
		...optionalEntry("recap_model", agent.recap_model),
		...optionalEntry(
			"interactive_mode",
			agent.interactive_mode,
			agent.interactive_mode !== undefined,
		),
	];
}

function serializeAcpAgent(
	agent: NonNullable<HlidConfig["acp_agents"]>[number],
): string[] {
	return [
		"[[acp_agents]]",
		`id = ${tomlVal(agent.id)}`,
		...optionalEntry("executable", agent.executable),
		...optionalEntry("args", agent.args),
		...(agent.env ? [`env = ${tomlInlineTable(agent.env)}`] : []),
	];
}

/** Serialize the complete public config schema to TOML. Kept pure so schema
 * round-trip tests can catch fields accidentally omitted by future changes. */
export function serializeConfig(config: HlidConfig): string {
	const lines = [
		...optionalEntry(
			"vault_provider",
			config.vault_provider,
			config.vault_provider !== undefined && config.vault_provider !== "claude",
		),
		...serializeVault(config.vault),
		"",
		...serializeServer(config.server),
		"",
		...serializeVoice(config.voice),
		"",
		...serializeUmbod(config.umbod),
		"",
		...serializeAutoSleep(config.auto_sleep),
		"",
		...serializeClaude(config.claude),
		"",
		...serializeCliProxy(config.cliproxy ?? DEFAULT_CLIPROXY_CONFIG),
		...(config.codex
			? [
					"",
					...serializeCodex(config.codex),
					"",
					...serializeWindowsComputerUse(config.codex.windows_computer_use),
				]
			: []),
		"",
		...serializeUi(config.ui),
		...(config.ui.custom_theme
			? [
					"",
					...serializeThemePalette("ui.custom_theme", config.ui.custom_theme),
				]
			: []),
		...(config.ui.mobile_custom_theme
			? [
					"",
					...serializeThemePalette(
						"ui.mobile_custom_theme",
						config.ui.mobile_custom_theme,
					),
				]
			: []),
		"",
		...serializeStatusVocabulary(config.status_vocabulary),
		"",
		...serializeAttachments(config.attachments),
	];

	for (const agent of config.agents ?? [])
		lines.push("", ...serializeAgent(agent));
	for (const agent of config.acp_agents ?? [])
		lines.push("", ...serializeAcpAgent(agent));

	return `${lines.join("\n")}\n`;
}

export function writeConfig(config: HlidConfig): void {
	writeFileAtomicSync(CONFIG_PATH, serializeConfig(config), {
		encoding: "utf-8",
		mode: 0o600,
	});
	setConfigCache(config);
	bumpDataRevision("config", "vault", "providers", "mcp");
	syncWrappers(config.agents ?? []);
}
