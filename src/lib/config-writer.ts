import { renameSync, rmSync, writeFileSync } from "node:fs";
import {
	DEFAULT_ATTACHMENTS_CONFIG,
	DEFAULT_VOICE_CONFIG,
	type HlidConfig,
} from "../config";
import { setConfigCache } from "../server/config";
import { syncWrappers } from "../server/wrappers";
import { CONFIG_PATH } from "./paths";

function tomlVal(value: unknown): string {
	if (typeof value === "string") return JSON.stringify(value);
	if (typeof value === "number" || typeof value === "boolean")
		return String(value);
	if (Array.isArray(value))
		return `[${value.map((v) => JSON.stringify(v)).join(", ")}]`;
	return JSON.stringify(value);
}

/** Serialize the complete public config schema to TOML. Kept pure so schema
 * round-trip tests can catch fields accidentally omitted by future changes. */
export function serializeConfig(config: HlidConfig): string {
	const lines: string[] = [];

	if (config.vault_provider && config.vault_provider !== "claude")
		lines.push(`vault_provider = ${tomlVal(config.vault_provider)}`);

	lines.push("[vault]");
	lines.push(`name = ${tomlVal(config.vault.name)}`);
	lines.push(`path = ${tomlVal(config.vault.path)}`);
	if (config.vault.style) lines.push(`style = ${tomlVal(config.vault.style)}`);
	if (config.vault.inbox) lines.push(`inbox = ${tomlVal(config.vault.inbox)}`);
	if (config.vault.projects)
		lines.push(`projects = ${tomlVal(config.vault.projects)}`);
	if (config.vault.areas) lines.push(`areas = ${tomlVal(config.vault.areas)}`);
	if (config.vault.resources)
		lines.push(`resources = ${tomlVal(config.vault.resources)}`);
	if (config.vault.archive)
		lines.push(`archive = ${tomlVal(config.vault.archive)}`);
	if (config.vault.raw) lines.push(`raw = ${tomlVal(config.vault.raw)}`);
	if (config.vault.wiki_folder)
		lines.push(`wiki_folder = ${tomlVal(config.vault.wiki_folder)}`);
	if (config.vault.skills)
		lines.push(`skills = ${tomlVal(config.vault.skills)}`);
	if (config.vault.memory)
		lines.push(`memory = ${tomlVal(config.vault.memory)}`);
	if (config.vault.outputs)
		lines.push(`outputs = ${tomlVal(config.vault.outputs)}`);
	lines.push(
		`delete_vault_attachments = ${tomlVal(config.vault.delete_vault_attachments)}`,
	);

	lines.push("");
	lines.push("[server]");
	lines.push(`port = ${tomlVal(config.server.port)}`);
	if (config.server.tls_cert_path)
		lines.push(`tls_cert_path = ${tomlVal(config.server.tls_cert_path)}`);
	if (config.server.tls_key_path)
		lines.push(`tls_key_path = ${tomlVal(config.server.tls_key_path)}`);
	if (config.server.tls_proxy_port !== undefined)
		lines.push(`tls_proxy_port = ${tomlVal(config.server.tls_proxy_port)}`);
	if (config.server.local_network_access)
		lines.push(`local_network_access = true`);
	if (config.server.allow_external_agents)
		lines.push(`allow_external_agents = true`);

	const voice = config.voice ?? DEFAULT_VOICE_CONFIG;
	lines.push("");
	lines.push("[voice]");
	lines.push(`enabled = ${tomlVal(voice.enabled)}`);
	lines.push(`model = ${tomlVal(voice.model)}`);
	lines.push(`language = ${tomlVal(voice.language)}`);
	lines.push(`auto_send = ${tomlVal(voice.auto_send)}`);
	lines.push(`hotkey = ${tomlVal(voice.hotkey)}`);
	lines.push(`max_recording_seconds = ${tomlVal(voice.max_recording_seconds)}`);

	lines.push("");
	lines.push("[claude]");
	lines.push(`model = ${tomlVal(config.claude.model)}`);
	lines.push(`effort = ${tomlVal(config.claude.effort)}`);
	lines.push(`permission_mode = ${tomlVal(config.claude.permission_mode)}`);
	lines.push(`turn_recaps = ${tomlVal(config.claude.turn_recaps)}`);
	if (config.claude.max_turns !== undefined)
		lines.push(`max_turns = ${tomlVal(config.claude.max_turns)}`);
	if (config.claude.recap_model)
		lines.push(`recap_model = ${tomlVal(config.claude.recap_model)}`);
	if (config.claude.interactive_mode) lines.push(`interactive_mode = true`);

	if (config.codex) {
		lines.push("");
		lines.push("[codex]");
		if (config.codex.model)
			lines.push(`model = ${tomlVal(config.codex.model)}`);
		lines.push(`effort = ${tomlVal(config.codex.effort)}`);
		lines.push(`permission_mode = ${tomlVal(config.codex.permission_mode)}`);
		lines.push(`turn_recaps = ${tomlVal(config.codex.turn_recaps)}`);
		if (config.codex.max_turns !== undefined)
			lines.push(`max_turns = ${tomlVal(config.codex.max_turns)}`);
		if (config.codex.recap_model)
			lines.push(`recap_model = ${tomlVal(config.codex.recap_model)}`);
		if (config.codex.executable)
			lines.push(`executable = ${tomlVal(config.codex.executable)}`);
	}

	lines.push("");
	lines.push("[ui]");
	lines.push(`enter_to_submit = ${tomlVal(config.ui.enter_to_submit)}`);
	lines.push(`hide_skills_index = ${tomlVal(config.ui.hide_skills_index)}`);
	lines.push(`theme = ${tomlVal(config.ui.theme)}`);
	if (config.ui.mobile_theme)
		lines.push(`mobile_theme = ${tomlVal(config.ui.mobile_theme)}`);

	lines.push("");
	lines.push("[status_vocabulary]");
	lines.push(`active = ${tomlVal(config.status_vocabulary.active)}`);
	lines.push(`planning = ${tomlVal(config.status_vocabulary.planning)}`);
	lines.push(`done = ${tomlVal(config.status_vocabulary.done)}`);

	const attachments = config.attachments ?? DEFAULT_ATTACHMENTS_CONFIG;
	lines.push("");
	lines.push("[attachments]");
	lines.push(`max_bytes = ${tomlVal(attachments.max_bytes)}`);
	lines.push(`allowed_mimes = ${tomlVal(attachments.allowed_mimes)}`);

	for (const agent of config.agents ?? []) {
		lines.push("");
		lines.push("[[agents]]");
		lines.push(`path = ${tomlVal(agent.path)}`);
		if (agent.name) lines.push(`name = ${tomlVal(agent.name)}`);
		if (agent.mode && agent.mode !== "cwd")
			lines.push(`mode = ${tomlVal(agent.mode)}`);
		if (agent.provider && agent.provider !== "claude")
			lines.push(`provider = ${tomlVal(agent.provider)}`);
		if (agent.model) lines.push(`model = ${tomlVal(agent.model)}`);
		if (agent.effort) lines.push(`effort = ${tomlVal(agent.effort)}`);
		if (agent.max_turns !== undefined)
			lines.push(`max_turns = ${tomlVal(agent.max_turns)}`);
		if (agent.permission_mode)
			lines.push(`permission_mode = ${tomlVal(agent.permission_mode)}`);
		if (agent.recap_model)
			lines.push(`recap_model = ${tomlVal(agent.recap_model)}`);
		if (agent.interactive_mode !== undefined)
			lines.push(`interactive_mode = ${tomlVal(agent.interactive_mode)}`);
	}

	return `${lines.join("\n")}\n`;
}

export function writeConfig(config: HlidConfig): void {
	const temporaryPath = `${CONFIG_PATH}.${process.pid}.${Date.now()}.tmp`;
	try {
		writeFileSync(temporaryPath, serializeConfig(config), {
			encoding: "utf-8",
			mode: 0o600,
		});
		renameSync(temporaryPath, CONFIG_PATH);
	} catch (error) {
		try {
			rmSync(temporaryPath, { force: true });
		} catch {
			// Preserve the original write/rename error.
		}
		throw error;
	}
	setConfigCache(config);
	syncWrappers(config.agents ?? []);
}
