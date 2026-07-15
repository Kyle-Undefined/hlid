import { readFileSync } from "node:fs";
import { createServerFn } from "@tanstack/react-start";
import { parse, TomlError } from "smol-toml";
import { z } from "zod";
import { CONFIG_PATH } from "./lib/paths";

const VaultSchema = z.object({
	name: z.string().default("Vault"),
	path: z.string().default(""),
	style: z.enum(["para", "wiki"]).optional(),
	inbox: z.string().optional(),
	projects: z.string().optional(),
	areas: z.string().optional(),
	resources: z.string().optional(),
	archive: z.string().optional(),
	raw: z.string().optional(),
	wiki_folder: z.string().optional(),
	skills: z.string().optional(),
	memory: z.string().optional(),
	outputs: z.string().optional(),
	// When true, deleting a vault attachment from Relics also removes the file
	// from disk. Default false — vault files are owned by the vault, not hlid.
	delete_vault_attachments: z.boolean().default(false),
});

const ServerSchema = z.object({
	port: z.number().default(3000),
	tls_cert_path: z.string().optional(),
	tls_key_path: z.string().optional(),
	tls_proxy_port: z.number().default(3443),
	local_network_access: z.boolean().default(false),
	allow_external_agents: z.boolean().default(false),
});

const ClaudeSchema = z.object({
	model: z.string().default("claude-sonnet-4-6"),
	effort: z.string().default("high"),
	max_turns: z.number().int().positive().optional(),
	permission_mode: z
		.enum(["default", "acceptEdits", "bypassPermissions", "plan"])
		.default("default"),
	turn_recaps: z.boolean().default(true),
	recap_model: z.string().optional(),
	/** When true, Raven spawns the Claude CLI in a PTY instead of using the SDK. */
	interactive_mode: z.boolean().default(false),
});

const WindowsComputerUseSchema = z.object({
	/** "inherit" follows the active Hlid Codex session model. */
	model: z.string().default("inherit"),
	/** Medium is the conservative default; "inherit" follows the session effort. */
	effort: z.string().default("medium"),
});

const CodexSchema = z.object({
	model: z.string().default(""),
	effort: z.string().default("medium"),
	max_turns: z.number().int().positive().optional(),
	permission_mode: z
		.enum(["default", "acceptEdits", "bypassPermissions", "plan"])
		.default("default"),
	turn_recaps: z.boolean().default(true),
	recap_model: z.string().optional(),
	executable: z.string().optional(),
	windows_computer_use: WindowsComputerUseSchema.default(() => ({
		model: "inherit",
		effort: "medium",
	})),
});

const UiSchema = z.object({
	enter_to_submit: z.boolean().default(true),
	hide_skills_index: z.boolean().default(true),
	theme: z.enum(["dark", "tan"]).default("tan"),
	mobile_theme: z.enum(["dark", "tan"]).optional(),
	/** Default for the per-session HTML-plans toggle in plan mode. */
	html_plans: z.boolean().default(false),
});

const StatusVocabularySchema = z.object({
	active: z.array(z.string()).default(["Active", "In Progress", "Doing"]),
	planning: z
		.array(z.string())
		.default(["Planning", "Ideas", "Backlog", "On Hold"]),
	done: z.array(z.string()).default(["Done", "Complete", "Archived"]),
});

const DEFAULT_ATTACHMENT_MIMES = [
	"image/png",
	"image/jpeg",
	"image/gif",
	"image/webp",
	"application/pdf",
	"text/plain",
	"text/markdown",
	"text/csv",
	"application/json",
];

export const DEFAULT_ATTACHMENTS_CONFIG = {
	max_bytes: 25 * 1024 * 1024,
	allowed_mimes: DEFAULT_ATTACHMENT_MIMES,
};

const AttachmentsSchema = z.object({
	max_bytes: z
		.number()
		.int()
		.positive()
		.default(DEFAULT_ATTACHMENTS_CONFIG.max_bytes),
	allowed_mimes: z
		.array(z.string())
		.default(DEFAULT_ATTACHMENTS_CONFIG.allowed_mimes),
});

export const DEFAULT_VOICE_CONFIG = {
	enabled: false,
	model: "",
	language: "auto",
	auto_send: false,
	hotkey: "Alt+Shift+KeyV",
	max_recording_seconds: 300,
};

const VoiceSchema = z.object({
	enabled: z.boolean().default(DEFAULT_VOICE_CONFIG.enabled),
	model: z.string().default(DEFAULT_VOICE_CONFIG.model),
	language: z.string().min(1).default(DEFAULT_VOICE_CONFIG.language),
	auto_send: z.boolean().default(DEFAULT_VOICE_CONFIG.auto_send),
	hotkey: z.string().default(DEFAULT_VOICE_CONFIG.hotkey),
	max_recording_seconds: z
		.number()
		.int()
		.min(1)
		.max(1800)
		.default(DEFAULT_VOICE_CONFIG.max_recording_seconds),
});

const UmbodSchema = z.object({
	enabled: z.boolean().default(false),
	manifest_path: z.string().default("umbod.toml"),
});

export const DEFAULT_AUTO_SLEEP_CONFIG = {
	enabled: false,
	threshold: 0.95,
	max_sleep_minutes: 360,
	resume_buffer_seconds: 60,
};

const AutoSleepSchema = z.object({
	enabled: z.boolean().default(DEFAULT_AUTO_SLEEP_CONFIG.enabled),
	/** five_hour utilization at/above which sessions sleep until reset. */
	threshold: z
		.number()
		.min(0.01)
		.max(1)
		.default(DEFAULT_AUTO_SLEEP_CONFIG.threshold),
	/** Hard cap on a single sleep; past it the session proceeds anyway. */
	max_sleep_minutes: z
		.number()
		.int()
		.min(1)
		.max(1440)
		.default(DEFAULT_AUTO_SLEEP_CONFIG.max_sleep_minutes),
	/** Clock-skew pad added past resetsAt before resuming. */
	resume_buffer_seconds: z
		.number()
		.int()
		.min(0)
		.max(600)
		.default(DEFAULT_AUTO_SLEEP_CONFIG.resume_buffer_seconds),
});

export type AutoSleepConfig = z.infer<typeof AutoSleepSchema>;

export const AgentSchema = z.object({
	path: z.string(),
	name: z.string().optional(),
	mode: z.enum(["cwd", "context"]).default("cwd"),
	provider: z.string().optional().default("claude"),
	model: z.string().optional(),
	effort: z.string().optional(),
	max_turns: z.number().int().positive().optional(),
	permission_mode: z
		.enum(["default", "acceptEdits", "bypassPermissions", "plan"])
		.optional(),
	recap_model: z.string().optional(),
	/** Override vault-level interactive_mode for this specific agent. */
	interactive_mode: z.boolean().optional(),
});

const AcpAgentSchema = z.object({
	id: z.string().min(1),
	executable: z.string().optional(),
	args: z.array(z.string()).optional(),
	env: z.record(z.string(), z.string()).optional(),
});

export type Agent = z.infer<typeof AgentSchema>;

export const HlidConfigSchema = z.object({
	vault: VaultSchema.default(() => ({
		name: "Vault",
		path: "",
		delete_vault_attachments: false,
	})),
	server: ServerSchema.default(() => ({
		port: 3000,
		tls_proxy_port: 3443,
		local_network_access: false,
		allow_external_agents: false,
	})),
	claude: ClaudeSchema.default(() => ({
		model: "claude-sonnet-4-6",
		effort: "high" as const,
		permission_mode: "default" as const,
		turn_recaps: true,
		interactive_mode: false,
	})),
	codex: CodexSchema.default(() => ({
		model: "",
		effort: "medium" as const,
		permission_mode: "default" as const,
		turn_recaps: true,
		windows_computer_use: { model: "inherit", effort: "medium" },
	})),
	ui: UiSchema.default(() => ({
		enter_to_submit: true,
		hide_skills_index: true,
		theme: "tan" as const,
		html_plans: false,
	})),
	status_vocabulary: StatusVocabularySchema.default(() => ({
		active: ["Active", "In Progress"],
		planning: ["Planning", "Ideas"],
		done: ["Done", "Complete", "Archived"],
	})),
	attachments: AttachmentsSchema.default(DEFAULT_ATTACHMENTS_CONFIG),
	voice: VoiceSchema.default(DEFAULT_VOICE_CONFIG),
	umbod: UmbodSchema.default(() => ({
		enabled: false,
		manifest_path: "umbod.toml",
	})),
	auto_sleep: AutoSleepSchema.default(DEFAULT_AUTO_SLEEP_CONFIG),
	agents: z.array(AgentSchema).default([]),
	acp_agents: z.array(AcpAgentSchema).optional(),
	vault_provider: z.string().default("claude"),
});

export type HlidConfig = z.infer<typeof HlidConfigSchema>;

function loadFromDisk(): HlidConfig {
	let raw: string;
	try {
		raw = readFileSync(CONFIG_PATH, "utf-8");
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") {
			return HlidConfigSchema.parse({});
		}
		throw err;
	}
	try {
		return HlidConfigSchema.parse(parse(raw));
	} catch (err) {
		if (err instanceof z.ZodError) {
			throw new Error(
				`Invalid config at ${CONFIG_PATH}:\n${z.prettifyError(err)}`,
			);
		}
		if (err instanceof TomlError) {
			throw new Error(`Invalid TOML in ${CONFIG_PATH}:\n${err.message}`);
		}
		throw err;
	}
}

export const getConfig = createServerFn({ method: "GET" }).handler(() => {
	return loadFromDisk();
});
