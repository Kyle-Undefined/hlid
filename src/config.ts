import { z } from "zod";
import { AcpExecutionTargetSchema } from "./lib/acpExecutionTarget";
import {
	DEFAULT_NAVIGATION_NAMES_CONFIG,
	duplicateEffectiveNavigationLabelIds,
	hasForbiddenNavigationLabelCharacters,
	hasVisibleNavigationLabelCharacters,
	NAVIGATION_IDS,
	NAVIGATION_LABEL_MAX_GRAPHEMES,
	type NavigationNamesConfig,
	navigationLabelGraphemeCount,
	normalizeNavigationLabel,
} from "./lib/navigationNames";
import {
	DEFAULT_OLLAMA_KEEP_WARM_POLICY,
	OLLAMA_KEEP_WARM_POLICIES,
	ollamaModelNameHasWhitespaceOrControl,
} from "./lib/ollama";
import {
	MAX_SPEECH_PRONUNCIATION_FIELD_CHARS,
	MAX_SPEECH_PRONUNCIATIONS,
	normalizeSpeechPronunciations,
	type SpeechPronunciation,
} from "./lib/speechPronunciations";
import { parseWslUncSyntax } from "./lib/wslPathSyntax";

const HexColorSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/);
const ThemePaletteSchema = z
	.object({
		color_scheme: z.enum(["dark", "light"]),
		background: HexColorSchema,
		foreground: HexColorSchema,
		card: HexColorSchema,
		card_foreground: HexColorSchema,
		popover: HexColorSchema,
		popover_foreground: HexColorSchema,
		primary: HexColorSchema,
		primary_foreground: HexColorSchema,
		secondary: HexColorSchema,
		secondary_foreground: HexColorSchema,
		muted: HexColorSchema,
		muted_foreground: HexColorSchema,
		accent: HexColorSchema,
		accent_foreground: HexColorSchema,
		destructive: HexColorSchema,
		destructive_foreground: HexColorSchema,
		border: HexColorSchema,
		input: HexColorSchema,
		ring: HexColorSchema,
		sidebar: HexColorSchema,
		sidebar_foreground: HexColorSchema,
		sidebar_primary: HexColorSchema,
		sidebar_primary_foreground: HexColorSchema,
		sidebar_accent: HexColorSchema,
		sidebar_accent_foreground: HexColorSchema,
		sidebar_border: HexColorSchema,
		sidebar_ring: HexColorSchema,
		data: HexColorSchema,
		chart_error: HexColorSchema,
		token_input: HexColorSchema.optional(),
		token_output: HexColorSchema.optional(),
		cache_read: HexColorSchema.optional(),
		cache_write: HexColorSchema.optional(),
		status_success: HexColorSchema,
		status_warning: HexColorSchema,
		status_info: HexColorSchema.optional(),
		tool_panel: HexColorSchema,
		tool_panel_border: HexColorSchema,
		user_msg: HexColorSchema,
		agent_msg: HexColorSchema,
	})
	.transform((palette) => ({
		...palette,
		token_input: palette.token_input ?? palette.primary,
		token_output: palette.token_output ?? "#ca8a04",
		cache_read: palette.cache_read ?? "#16a34a",
		cache_write: palette.cache_write ?? "#ea580c",
		status_info: palette.status_info ?? palette.primary,
	}));

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
	save_to_obsidian_template: z.string().optional(),
	obsidian_command_allowlist: z.array(z.string()).optional(),
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

const DiagnosticsSchema = z.object({
	/** Persist bounded runtime diagnostics in the Event Log. */
	event_log: z.boolean().default(true),
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
	/** Ask Claude to periodically summarize each running SDK subagent. */
	agent_progress_summaries: z.boolean().default(false),
	/** When true, Raven spawns the Claude CLI in a PTY instead of using the SDK. */
	interactive_mode: z.boolean().default(false),
	/** When true, Raven can hold inbound Claude peer messages for explicit review. */
	peer_inbox: z.boolean().default(false),
});

export const DEFAULT_CLIPROXY_CONFIG = {
	enabled: false,
	mode: "external" as const,
	base_url: "http://127.0.0.1:8317",
	api_key: "",
	model: "gpt-5.6-sol",
	effort: "xhigh",
	permission_mode: "default" as const,
	turn_recaps: true,
};

const CliProxySchema = z
	.object({
		enabled: z.boolean().default(false),
		mode: z.enum(["managed", "external"]).default("external"),
		base_url: z.string().url().default("http://127.0.0.1:8317"),
		api_key: z.string().default(""),
		model: z.string().default("gpt-5.6-sol"),
		effort: z.string().default("xhigh"),
		max_turns: z.number().int().positive().optional(),
		permission_mode: z
			.enum(["default", "acceptEdits", "bypassPermissions", "plan"])
			.default("default"),
		turn_recaps: z.boolean().default(true),
		recap_model: z.string().optional(),
	})
	.superRefine((value, ctx) => {
		if (
			value.enabled &&
			value.mode === "external" &&
			value.api_key.trim() === ""
		) {
			ctx.addIssue({
				code: "custom",
				path: ["api_key"],
				message: "api_key is required when CLIProxy is enabled",
			});
		}
		if (!value.enabled) return;
		const hostname = new URL(value.base_url).hostname.toLowerCase();
		if (!["127.0.0.1", "localhost", "::1"].includes(hostname)) {
			ctx.addIssue({
				code: "custom",
				path: ["base_url"],
				message: "CLIProxy must use a loopback URL",
			});
		}
	});

const WindowsComputerUseSchema = z.object({
	/** "inherit" follows the active Hlid Codex session model. */
	model: z.string().default("inherit"),
	/** Medium is the conservative default; "inherit" follows the session effort. */
	effort: z.string().default("medium"),
});

const ProjectPreviewSchema = z.object({
	/**
	 * Attach Preview control to the user's consented Chromium profile instead
	 * of launching Hlid's isolated temporary profile.
	 */
	use_real_browser_profile: z.boolean().default(false),
});

const CodexSchema = z.object({
	model: z.string().default(""),
	effort: z.string().default("medium"),
	max_turns: z.number().int().positive().optional(),
	permission_mode: z
		.enum(["default", "acceptEdits", "bypassPermissions", "plan"])
		.default("default"),
	/** Optional Codex-native named sandbox profile. Hlid still owns approvals. */
	permission_profile: z.string().trim().min(1).max(500).optional(),
	turn_recaps: z.boolean().default(true),
	recap_model: z.string().optional(),
	executable: z.string().optional(),
	windows_computer_use: WindowsComputerUseSchema.default(() => ({
		model: "inherit",
		effort: "medium",
	})),
});

const NavigationLabelSchema = z
	.string()
	.superRefine((label, context) => {
		if (hasForbiddenNavigationLabelCharacters(label)) {
			context.addIssue({
				code: "custom",
				message: "Navigation labels cannot contain control or bidi characters",
			});
			return;
		}
		const normalized = normalizeNavigationLabel(label);
		if (!hasVisibleNavigationLabelCharacters(normalized)) {
			context.addIssue({
				code: "custom",
				message: "Navigation labels cannot be blank",
			});
			return;
		}
		if (
			navigationLabelGraphemeCount(normalized) > NAVIGATION_LABEL_MAX_GRAPHEMES
		) {
			context.addIssue({
				code: "custom",
				message: `Navigation labels cannot exceed ${NAVIGATION_LABEL_MAX_GRAPHEMES} characters`,
			});
		}
	})
	.transform(normalizeNavigationLabel);

/** An explicit object strips unknown keys while preserving stable labels. */
const NavigationLabelsSchema = z.object({
	watch: NavigationLabelSchema.optional(),
	vault: NavigationLabelSchema.optional(),
	relics: NavigationLabelSchema.optional(),
	raven: NavigationLabelSchema.optional(),
	einherjar: NavigationLabelSchema.optional(),
	ledger: NavigationLabelSchema.optional(),
	forge: NavigationLabelSchema.optional(),
});

const NavigationNamesSchema = z
	.object({
		preset: z
			.enum(["hlid", "plain"])
			.default(DEFAULT_NAVIGATION_NAMES_CONFIG.preset),
		labels: NavigationLabelsSchema.default({}),
		watch: NavigationLabelSchema.optional(),
		vault: NavigationLabelSchema.optional(),
		relics: NavigationLabelSchema.optional(),
		raven: NavigationLabelSchema.optional(),
		einherjar: NavigationLabelSchema.optional(),
		ledger: NavigationLabelSchema.optional(),
		forge: NavigationLabelSchema.optional(),
	})
	.transform((navigationNames): NavigationNamesConfig => {
		const directLabels: NavigationNamesConfig["labels"] = {};
		for (const id of NAVIGATION_IDS) {
			const label = navigationNames[id];
			if (label !== undefined) directLabels[id] = label;
		}
		return {
			preset: navigationNames.preset,
			labels: { ...navigationNames.labels, ...directLabels },
		};
	})
	.superRefine((navigationNames, context) => {
		for (const id of duplicateEffectiveNavigationLabelIds(navigationNames)) {
			context.addIssue({
				code: "custom",
				path: ["labels", id],
				message: "Navigation labels must be unique",
			});
		}
	});

const UiSchema = z.object({
	enter_to_submit: z.boolean().default(true),
	live_sessions_hotkey: z.string().default("Alt+Shift+KeyS"),
	hide_skills_index: z.boolean().default(true),
	/** Include provider-owned skills, commands, and plugin entries in the picker. */
	show_provider_entries: z.boolean().default(false),
	theme: z.enum(["dark", "tan", "custom"]).default("tan"),
	mobile_theme: z.enum(["dark", "tan", "custom"]).optional(),
	custom_theme: ThemePaletteSchema.optional(),
	mobile_custom_theme: ThemePaletteSchema.optional(),
	/** Default for the per-session HTML-plans toggle in plan mode. */
	html_plans: z.boolean().default(false),
	navigation_names: NavigationNamesSchema.default(() => ({
		preset: DEFAULT_NAVIGATION_NAMES_CONFIG.preset,
		labels: { ...DEFAULT_NAVIGATION_NAMES_CONFIG.labels },
	})),
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
	"audio/wav",
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

export const MAX_VOICE_PRONUNCIATIONS = MAX_SPEECH_PRONUNCIATIONS;
export const MAX_VOICE_PRONUNCIATION_LENGTH =
	MAX_SPEECH_PRONUNCIATION_FIELD_CHARS;

export const VoicePronunciationSchema = z.object({
	written: z.string().trim().min(1).max(MAX_VOICE_PRONUNCIATION_LENGTH),
	spoken: z.string().trim().min(1).max(MAX_VOICE_PRONUNCIATION_LENGTH),
});

export type VoicePronunciation = SpeechPronunciation;

export const DEFAULT_VOICE_CONFIG = {
	enabled: false,
	input_provider: "local" as const,
	model: "",
	language: "auto",
	auto_send: false,
	read_aloud_provider: "device" as const,
	read_aloud_voice: "",
	read_aloud_rate: 1,
	tts_model: "",
	tts_voice: "expr-voice-2-f",
	tts_acceleration: "auto" as const,
	tts_threads: 4,
	local_conversation_mode: false,
	codex_voice: "marin" as const,
	codex_live_mode: false,
	hotkey: "Alt+Shift+KeyV",
	max_recording_seconds: 300,
	acceleration: "auto" as const,
	threads: 4,
	pronunciations: [] as VoicePronunciation[],
	vocabulary: [
		"Claude",
		"Codex",
		"Hlið",
		"Raven",
		"Forge",
		"Umbod",
		"MCP",
		"Anthropic",
		"OpenAI",
		"TypeScript",
		"GitHub",
		"Bun",
	],
};

const VoiceSchema = z.object({
	enabled: z.boolean().default(DEFAULT_VOICE_CONFIG.enabled),
	input_provider: z
		.enum(["local", "codex_dictation", "codex"])
		.default(DEFAULT_VOICE_CONFIG.input_provider),
	model: z.string().default(DEFAULT_VOICE_CONFIG.model),
	language: z.string().min(1).default(DEFAULT_VOICE_CONFIG.language),
	auto_send: z.boolean().default(DEFAULT_VOICE_CONFIG.auto_send),
	read_aloud_provider: z
		.enum(["device", "microsoft", "neural", "codex"])
		.transform((provider): "device" | "microsoft" | "neural" | "codex" =>
			provider === "codex" ? "device" : provider,
		)
		.default(DEFAULT_VOICE_CONFIG.read_aloud_provider),
	read_aloud_voice: z.string().default(DEFAULT_VOICE_CONFIG.read_aloud_voice),
	read_aloud_rate: z
		.number()
		.min(0.5)
		.max(2)
		.default(DEFAULT_VOICE_CONFIG.read_aloud_rate),
	tts_model: z.string().default(DEFAULT_VOICE_CONFIG.tts_model),
	tts_voice: z.string().min(1).default(DEFAULT_VOICE_CONFIG.tts_voice),
	tts_acceleration: z
		.enum(["auto", "cpu"])
		.default(DEFAULT_VOICE_CONFIG.tts_acceleration),
	tts_threads: z
		.number()
		.int()
		.min(1)
		.max(32)
		.default(DEFAULT_VOICE_CONFIG.tts_threads),
	local_conversation_mode: z
		.boolean()
		.default(DEFAULT_VOICE_CONFIG.local_conversation_mode),
	codex_voice: z
		.enum([
			"alloy",
			"arbor",
			"ash",
			"ballad",
			"breeze",
			"cedar",
			"coral",
			"cove",
			"echo",
			"ember",
			"juniper",
			"maple",
			"marin",
			"sage",
			"shimmer",
			"sol",
			"spruce",
			"vale",
			"verse",
		])
		.default(DEFAULT_VOICE_CONFIG.codex_voice),
	codex_live_mode: z.boolean().default(DEFAULT_VOICE_CONFIG.codex_live_mode),
	hotkey: z.string().default(DEFAULT_VOICE_CONFIG.hotkey),
	max_recording_seconds: z
		.number()
		.int()
		.min(1)
		.max(1800)
		.default(DEFAULT_VOICE_CONFIG.max_recording_seconds),
	acceleration: z
		.enum(["auto", "cpu"])
		.default(DEFAULT_VOICE_CONFIG.acceleration),
	threads: z
		.number()
		.int()
		.min(1)
		.max(32)
		.default(DEFAULT_VOICE_CONFIG.threads),
	pronunciations: z
		.array(VoicePronunciationSchema)
		.max(MAX_VOICE_PRONUNCIATIONS)
		.transform((pronunciations) =>
			normalizeSpeechPronunciations(pronunciations),
		)
		.default(DEFAULT_VOICE_CONFIG.pronunciations),
	vocabulary: z
		.array(z.string().trim().min(1).max(80))
		.max(50)
		.default(DEFAULT_VOICE_CONFIG.vocabulary),
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
	/** Preferred-window utilization at/above which sessions sleep until reset. */
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

const PROTOTYPE_SPECIAL_ACP_MODEL_PROVIDER_IDS = new Set([
	"__proto__",
	"constructor",
	"prototype",
]);

const AcpModelIdSchema = z
	.string()
	.trim()
	.min(3)
	.max(256)
	.refine(
		(value) => {
			const separator = value.indexOf("/");
			return separator > 0 && separator < value.length - 1;
		},
		{ message: "ACP model IDs must include a provider and model" },
	)
	.refine(
		(value) => {
			const separator = value.indexOf("/");
			if (separator <= 0) return true;
			return !PROTOTYPE_SPECIAL_ACP_MODEL_PROVIDER_IDS.has(
				value.slice(0, separator),
			);
		},
		{
			message: "ACP model IDs cannot use a prototype-special provider ID",
		},
	);

const OllamaModelNameSchema = z
	.string()
	.trim()
	.min(1)
	.max(256)
	.refine((value) => !ollamaModelNameHasWhitespaceOrControl(value), {
		message:
			"Ollama model names cannot contain whitespace or control characters",
	});

const OllamaSchema = z
	.object({
		/** Exact Windows-hosted Ollama models Hlid publishes to configured consumers. */
		models: z.array(OllamaModelNameSchema).min(1).max(64),
		/** How long Hlid keeps an OpenCode model resident after inference. */
		keep_warm: z
			.enum(OLLAMA_KEEP_WARM_POLICIES)
			.default(DEFAULT_OLLAMA_KEEP_WARM_POLICY),
	})
	.superRefine((value, context) => {
		if (new Set(value.models).size !== value.models.length) {
			context.addIssue({
				code: "custom",
				path: ["models"],
				message: "Ollama models cannot contain duplicates",
			});
		}
	});

export const AcpModelFilterSchema = z
	.discriminatedUnion("mode", [
		z.object({
			mode: z.literal("hide"),
			models: z.array(AcpModelIdSchema).min(1).max(256),
		}),
		z.object({
			mode: z.literal("only"),
			models: z.array(AcpModelIdSchema).min(1).max(256),
		}),
	])
	.superRefine((filter, context) => {
		if (new Set(filter.models).size !== filter.models.length) {
			context.addIssue({
				code: "custom",
				path: ["models"],
				message: "ACP model filters cannot contain duplicate model IDs",
			});
		}
	});

const AcpAgentSchema = z
	.object({
		id: z.string().min(1),
		target: AcpExecutionTargetSchema.optional(),
		executable: z.string().optional(),
		args: z.array(z.string()).optional(),
		env: z.record(z.string(), z.string()).optional(),
		/** Dedicated secret used only for display-only OpenCode Go telemetry. */
		opencode_go_usage: z
			.object({ api_key: z.string().trim().min(1).max(4_096) })
			.optional(),
		/** Legacy input only. Canonical config stores this at top-level `ollama`. */
		ollama: OllamaSchema.optional(),
		/** Hlid-only OpenCode model visibility. Absence leaves native config alone. */
		model_filter: AcpModelFilterSchema.optional(),
		/** Vault-chat defaults for this ACP provider. Empty/absent values defer to the agent. */
		model: z.string().optional(),
		effort: z.string().optional(),
		permission_mode: z
			.enum(["default", "acceptEdits", "bypassPermissions", "plan"])
			.optional(),
		turn_recaps: z.boolean().optional(),
		recap_model: z.string().optional(),
	})
	.superRefine((agent, context) => {
		if (agent.opencode_go_usage && agent.id !== "opencode") {
			context.addIssue({
				code: "custom",
				path: ["opencode_go_usage"],
				message:
					"opencode_go_usage is supported only for the OpenCode ACP agent",
			});
		}
		if (agent.model_filter && agent.id !== "opencode") {
			context.addIssue({
				code: "custom",
				path: ["model_filter"],
				message: "model_filter is supported only for the OpenCode ACP agent",
			});
		}
		if (agent.ollama && agent.id !== "opencode") {
			context.addIssue({
				code: "custom",
				path: ["ollama"],
				message: "ollama is supported only for the OpenCode ACP agent",
			});
		}
		if (agent.model_filter) {
			for (const [key, label] of [
				["model", "default model"],
				["recap_model", "recap model"],
			] as const) {
				const model = agent[key];
				if (!model) continue;
				const included = agent.model_filter.models.includes(model);
				if (agent.model_filter.mode === "hide" ? included : !included) {
					context.addIssue({
						code: "custom",
						path: [key],
						message:
							agent.model_filter.mode === "hide"
								? `The configured ${label} cannot be hidden`
								: `The configured ${label} must be included in the filter`,
					});
				}
			}
		}
	});

export type Agent = z.infer<typeof AgentSchema>;

const HlidConfigBaseSchema = z.object({
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
	diagnostics: DiagnosticsSchema.default(() => ({ event_log: true })),
	claude: ClaudeSchema.default(() => ({
		model: "claude-sonnet-4-6",
		effort: "high" as const,
		permission_mode: "default" as const,
		turn_recaps: true,
		agent_progress_summaries: false,
		interactive_mode: false,
		peer_inbox: false,
	})),
	cliproxy: CliProxySchema.default(() => ({ ...DEFAULT_CLIPROXY_CONFIG })),
	codex: CodexSchema.default(() => ({
		model: "",
		effort: "medium" as const,
		permission_mode: "default" as const,
		turn_recaps: true,
		windows_computer_use: { model: "inherit", effort: "medium" },
	})),
	project_preview: ProjectPreviewSchema.default(() => ({
		use_real_browser_profile: false,
	})),
	ui: UiSchema.default(() => ({
		enter_to_submit: true,
		live_sessions_hotkey: "Alt+Shift+KeyS",
		hide_skills_index: true,
		show_provider_entries: false,
		theme: "tan" as const,
		html_plans: false,
		navigation_names: {
			preset: DEFAULT_NAVIGATION_NAMES_CONFIG.preset,
			labels: { ...DEFAULT_NAVIGATION_NAMES_CONFIG.labels },
		},
	})),
	status_vocabulary: StatusVocabularySchema.default(() => ({
		active: ["Active", "In Progress"],
		planning: ["Planning", "Ideas"],
		done: ["Done", "Complete", "Archived"],
	})),
	attachments: AttachmentsSchema.default(DEFAULT_ATTACHMENTS_CONFIG),
	voice: VoiceSchema.default(DEFAULT_VOICE_CONFIG),
	/** Windows-hosted Ollama integration shared by configured consumers. */
	ollama: OllamaSchema.optional(),
	umbod: UmbodSchema.default(() => ({
		enabled: false,
		manifest_path: "umbod.toml",
	})),
	auto_sleep: AutoSleepSchema.default(DEFAULT_AUTO_SLEEP_CONFIG),
	agents: z.array(AgentSchema).default([]),
	acp_agents: z.array(AcpAgentSchema).optional(),
	vault_provider: z.string().default("claude"),
});

function sameOllamaModelSet(
	left: NonNullable<z.input<typeof OllamaSchema>>,
	right: NonNullable<z.input<typeof OllamaSchema>>,
): boolean {
	if (
		(left.keep_warm ?? DEFAULT_OLLAMA_KEEP_WARM_POLICY) !==
		(right.keep_warm ?? DEFAULT_OLLAMA_KEEP_WARM_POLICY)
	) {
		return false;
	}
	if (left.models.length !== right.models.length) return false;
	const rightModels = new Set(right.models);
	return left.models.every((model) => rightModels.has(model));
}

const HlidConfigInputSchema = HlidConfigBaseSchema.superRefine(
	(config, context) => {
		const configuredWslDistros = new Set(
			[config.vault.path, ...config.agents.map((agent) => agent.path)]
				.map((path) => parseWslUncSyntax(path)?.distro.toLowerCase())
				.filter((distro): distro is string => Boolean(distro)),
		);
		const seenAcpAgents = new Set<string>();
		config.acp_agents?.forEach((agent, index) => {
			if (seenAcpAgents.has(agent.id)) {
				context.addIssue({
					code: "custom",
					path: ["acp_agents", index, "id"],
					message: `ACP agent ${JSON.stringify(agent.id)} is configured more than once`,
				});
			}
			if (
				agent.target?.kind === "wsl" &&
				!configuredWslDistros.has(agent.target.distro.toLowerCase())
			) {
				context.addIssue({
					code: "custom",
					path: ["acp_agents", index, "target"],
					message: `ACP WSL target ${JSON.stringify(agent.target.distro)} must match the configured vault or an exact agent workspace`,
				});
			}
			seenAcpAgents.add(agent.id);
		});
		const openCodeIndex =
			config.acp_agents?.findIndex((agent) => agent.id === "opencode") ?? -1;
		const openCode =
			openCodeIndex >= 0 ? config.acp_agents?.[openCodeIndex] : undefined;
		const legacyOllama = openCode?.ollama;
		if (
			config.ollama &&
			legacyOllama &&
			!sameOllamaModelSet(config.ollama, legacyOllama)
		) {
			context.addIssue({
				code: "custom",
				path: ["ollama", "models"],
				message:
					"Top-level Ollama models conflict with the legacy OpenCode Ollama selection",
			});
		}
		const ollama = config.ollama ?? legacyOllama;
		const selectedOllamaModels = new Set(ollama?.models ?? []);
		for (const [key, label] of [
			["model", "default model"],
			["recap_model", "recap model"],
		] as const) {
			const model = openCode?.[key];
			if (!model?.startsWith("hlid-ollama/")) continue;
			if (!selectedOllamaModels.has(model.slice("hlid-ollama/".length))) {
				context.addIssue({
					code: "custom",
					path: ["acp_agents", openCodeIndex, key],
					message: `The configured ${label} must be selected in Windows Ollama models`,
				});
			}
		}
		const filter = openCode?.model_filter;
		if (filter) {
			for (const [index, modelId] of filter.models.entries()) {
				if (!modelId.startsWith("hlid-ollama/")) continue;
				if (selectedOllamaModels.has(modelId.slice("hlid-ollama/".length)))
					continue;
				context.addIssue({
					code: "custom",
					path: ["acp_agents", openCodeIndex, "model_filter", "models", index],
					message:
						"An Ollama model in the OpenCode model filter must be selected in the Ollama integration",
				});
			}
			for (const [index, model] of (ollama?.models ?? []).entries()) {
				const modelId = `hlid-ollama/${model}`;
				const included = filter.models.includes(modelId);
				if (filter.mode === "hide" ? included : !included) {
					context.addIssue({
						code: "custom",
						path: ["ollama", "models", index],
						message:
							filter.mode === "hide"
								? "A selected Ollama model cannot be hidden from OpenCode"
								: "A selected Ollama model must be included in the OpenCode model filter",
					});
				}
			}
		}
		config.agents.forEach((agent, index) => {
			if (agent.provider !== "acp:opencode") return;
			for (const [key, label] of [
				["model", "model"],
				["recap_model", "recap model"],
			] as const) {
				const model = agent[key];
				if (!model) continue;
				if (
					model.startsWith("hlid-ollama/") &&
					!selectedOllamaModels.has(model.slice("hlid-ollama/".length))
				) {
					context.addIssue({
						code: "custom",
						path: ["agents", index, key],
						message: `The OpenCode agent ${label} must be selected in Windows Ollama models`,
					});
				}
				if (!filter) continue;
				const included = filter.models.includes(model);
				if (filter.mode === "hide" ? included : !included) {
					context.addIssue({
						code: "custom",
						path: ["agents", index, key],
						message:
							filter.mode === "hide"
								? `The OpenCode agent ${label} cannot be hidden`
								: `The OpenCode agent ${label} must be included in the filter`,
					});
				}
			}
		});
	},
);

/**
 * Accept the short-lived nested development shape once, then expose only the
 * canonical top-level Ollama integration to every runtime and writer.
 */
export const HlidConfigSchema = HlidConfigInputSchema.transform((config) => {
	const legacyOllama = config.acp_agents?.find(
		(agent) => agent.id === "opencode",
	)?.ollama;
	const canonicalOllama = config.ollama ?? legacyOllama;
	const canonicalAcpAgents = config.acp_agents?.map(
		({ ollama: _legacyOllama, ...agent }) => agent,
	);
	const { ollama: _inputOllama, acp_agents: _inputAcpAgents, ...base } = config;
	return {
		...base,
		...(canonicalOllama ? { ollama: canonicalOllama } : {}),
		...(canonicalAcpAgents ? { acp_agents: canonicalAcpAgents } : {}),
	};
});

export type HlidConfig = z.infer<typeof HlidConfigSchema>;
