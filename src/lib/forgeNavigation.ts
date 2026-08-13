import { normalizeSearchText } from "#/lib/search";

export const FORGE_CATEGORY_IDS = [
	"overview",
	"workspace",
	"agents",
	"access",
	"experience",
	"integrations",
	"extensions",
	"developer",
	"advanced",
] as const;

export type ForgeCategoryId = (typeof FORGE_CATEGORY_IDS)[number];
export type ForgeCategoryGroup = "primary" | "secondary";
export type ForgeView =
	| "events"
	| "api"
	| "pricing"
	| "apps"
	| "umbod"
	| "acp"
	| "theme";
export type ForgeThemeTarget = "desktop" | "mobile";

export interface ForgeNavigationState {
	category: ForgeCategoryId;
	section?: string;
	setting?: string;
	view?: ForgeView;
	target?: ForgeThemeTarget;
}

/** Browser-history intent for a Forge navigation transition. */
export interface ForgeNavigationOptions {
	replace?: boolean;
}

export type ForgeRouteSearch = Partial<ForgeNavigationState>;

export interface ForgeSectionDefinition {
	id: string;
	label: string;
	description: string;
	view?: ForgeView;
	keywords?: readonly string[];
}

export interface ForgeCategoryDefinition {
	id: ForgeCategoryId;
	label: string;
	description: string;
	group: ForgeCategoryGroup;
	keywords: readonly string[];
	sections: readonly ForgeSectionDefinition[];
}

export interface ForgeSearchDestination {
	id: string;
	kind: "category" | "section" | "setting";
	label: string;
	description: string;
	breadcrumbs: readonly string[];
	anchorId: string;
	focusId?: string;
	navigation: ForgeNavigationState;
}

export const FORGE_CATEGORIES: readonly ForgeCategoryDefinition[] = [
	{
		id: "overview",
		label: "Overview",
		description: "Updates, installation, startup, and storage",
		group: "primary",
		keywords: ["version", "install", "launch", "login", "storage"],
		sections: [
			{
				id: "updates",
				label: "Updates",
				description: "Version checks, downloads, and installed integrations.",
				keywords: ["version", "download", "installer"],
			},
			{
				id: "installation-startup",
				label: "Installation and startup",
				description: "Install location and launch-on-login behavior.",
				keywords: ["install", "startup", "login", "location"],
			},
			{
				id: "storage-summary",
				label: "Storage summary",
				description: "Database, write-ahead log, and library size.",
				keywords: ["database", "wal", "library", "relics"],
			},
		],
	},
	{
		id: "workspace",
		label: "Workspace",
		description: "Vault identity, folders, and status vocabulary",
		group: "primary",
		keywords: ["vault", "folder", "obsidian", "status", "template"],
		sections: [
			{
				id: "vault",
				label: "Vault",
				description: "Vault identity, note template, and folder mappings.",
				keywords: ["name", "path", "folders", "template"],
			},
			{
				id: "obsidian-desktop",
				label: "Obsidian desktop",
				description: "Obsidian CLI, configured vault, and agent access.",
				keywords: ["cli", "configured vault", "commands", "approvals"],
			},
			{
				id: "status-vocabulary",
				label: "Status vocabulary",
				description: "Labels used for active, planning, and completed work.",
				keywords: ["active", "planning", "done"],
			},
		],
	},
	{
		id: "agents",
		label: "Agents",
		description: "Provider, model, permissions, limits, and recaps",
		group: "primary",
		keywords: [
			"provider",
			"model",
			"permissions",
			"turns",
			"recaps",
			"browser",
			"computer use",
		],
		sections: [
			{
				id: "vault-agent",
				label: "Vault Agent",
				description: "Provider, model, permissions, recaps, and collaboration.",
				keywords: ["provider", "model", "permission", "interactive", "peer"],
			},
			{
				id: "agent-instructions",
				label: "Agent Instructions",
				description: "Provider instruction files applied to vault sessions.",
				keywords: ["agents.md", "claude.md", "instructions"],
			},
			{
				id: "browser-profile",
				label: "Browser profile",
				description: "Browser profile and storage used by Project Preview.",
				keywords: ["cookies", "storage", "project preview"],
			},
			{
				id: "computer-use",
				label: "Computer Use",
				description: "Windows desktop model and capability settings.",
				keywords: ["windows", "desktop", "vision"],
			},
			{
				id: "auto-sleep",
				label: "Auto-sleep on usage limit",
				description: "Pause and resume sessions around provider usage limits.",
				keywords: ["usage", "limit", "rate", "resume", "sleep"],
			},
		],
	},
	{
		id: "access",
		label: "Access",
		description: "Network, TLS, passwords, and trusted devices",
		group: "primary",
		keywords: ["network", "tailscale", "tls", "password", "devices"],
		sections: [
			{
				id: "network",
				label: "Network",
				description: "Port, network exposure, external agents, and TLS.",
				keywords: ["port", "tailscale", "tls", "external agents"],
			},
			{
				id: "app-password",
				label: "App Password",
				description: "Change the password used to unlock Hlid.",
				keywords: ["password", "login", "unlock"],
			},
			{
				id: "trusted-devices",
				label: "Trusted Devices",
				description: "Inspect this device or revoke every trusted device.",
				keywords: ["revoke", "lock", "logout", "sign out"],
			},
		],
	},
	{
		id: "experience",
		label: "Experience",
		description: "Navigation names, themes, notifications, voice, and privacy",
		group: "primary",
		keywords: [
			"theme",
			"input",
			"notifications",
			"alerts",
			"voice",
			"whisper",
			"privacy",
			"speech",
		],
		sections: [
			{
				id: "ui",
				label: "UI",
				description: "Theme, submit behavior, hotkeys, and plan presentation.",
				keywords: ["enter", "hotkey", "skills", "html plans"],
			},
			{
				id: "navigation-names",
				label: "Navigation names",
				description: "Choose Hlið, plain-language, or custom menu names.",
				keywords: [
					"menu",
					"labels",
					"terminology",
					"plain language",
					"einherjar",
				],
			},
			{
				id: "custom-theme",
				label: "Custom theme",
				description: "Edit the desktop or mobile custom color palette.",
				keywords: ["palette", "colors", "appearance", "mobile"],
			},
			{
				id: "notifications",
				label: "Notifications",
				description:
					"Device opt-in, attention and completion alerts, and Lock Screen wording.",
				keywords: [
					"push",
					"alerts",
					"attention",
					"work finished",
					"lock screen",
					"pwa",
				],
			},
			{
				id: "read-aloud",
				label: "Read aloud",
				description: "Speech provider, voice, neural model, and playback.",
				keywords: ["tts", "speech", "neural", "voice", "speaker"],
			},
			{
				id: "realtime-voice",
				label: "Realtime voice",
				description: "Codex realtime and Raven Live voice behavior.",
				keywords: ["codex realtime", "raven live", "microphone"],
			},
			{
				id: "voice-input",
				label: "Voice input",
				description: "Recording, transcription, hotkey, and Whisper runtime.",
				keywords: ["dictation", "recording", "whisper", "threads", "hotkey"],
			},
			{
				id: "voice-models",
				label: "Voice models",
				description: "Installed neural speech and Whisper models.",
				keywords: ["neural", "whisper", "download", "model"],
			},
			{
				id: "privacy",
				label: "Privacy",
				description: "Control whether session activity is shown live.",
				keywords: ["privacy mode", "session"],
			},
		],
	},
	{
		id: "integrations",
		label: "Integrations",
		description: "OpenCode, MCP servers, apps, and external agents",
		group: "secondary",
		keywords: ["opencode", "acp", "mcp", "apps", "connectors", "umbod"],
		sections: [
			{
				id: "apps-connectors",
				label: "Apps and Connectors",
				description: "Provider-native apps, authentication, and MCP health.",
				keywords: ["catalog", "apps", "connectors", "authentication"],
			},
			{
				id: "mcp",
				label: "MCP",
				description: "Hlid and agent Model Context Protocol servers.",
				keywords: ["servers", "tools", "model context protocol"],
			},
			{
				id: "cli-proxy",
				label: "CLIProxyAPI",
				description: "CLI proxy installation and saved provider accounts.",
				keywords: ["cliproxy", "codex", "claude", "oauth"],
			},
			{
				id: "umbod",
				label: "Umbod policy and activity",
				description: "Approval policy, generated hooks, activity, and calls.",
				keywords: ["policy", "approval", "hooks", "activity", "calls"],
			},
			{
				id: "opencode-acp",
				label: "OpenCode and ACP agents",
				description: "Configure OpenCode or another ACP integration.",
				keywords: ["agent client protocol", "external agents", "catalog"],
			},
		],
	},
	{
		id: "extensions",
		label: "Extensions",
		description: "Installed Claude and Codex plugins and marketplaces",
		group: "secondary",
		keywords: ["plugins", "marketplaces", "skills", "hooks", "scripts"],
		sections: [
			{
				id: "provider-extensions",
				label: "Provider Extensions",
				description: "Installed provider packages and their capabilities.",
				keywords: ["claude", "codex", "plugins", "marketplaces"],
			},
		],
	},
	{
		id: "developer",
		label: "Developer",
		description: "Event log, API reference, and pricing catalog",
		group: "secondary",
		keywords: ["events", "logs", "api", "diagnostics", "pricing", "costs"],
		sections: [
			{
				id: "event-log",
				label: "Event Log",
				description: "Inspect and clear recorded runtime activity.",
				view: "events",
				keywords: ["events", "logs", "runtime", "diagnostics"],
			},
			{
				id: "api-reference",
				label: "API Reference",
				description: "Browse the local HTTP API and endpoint contracts.",
				view: "api",
				keywords: ["api", "http", "endpoints", "contracts"],
			},
			{
				id: "pricing",
				label: "Pricing",
				description: "Inspect catalog rates, aliases, and local overrides.",
				view: "pricing",
				keywords: ["cost", "rates", "models", "aliases", "overrides"],
			},
		],
	},
	{
		id: "advanced",
		label: "Advanced",
		description: "Maintenance and session lifecycle",
		group: "secondary",
		keywords: ["optimize", "database", "reload", "restart", "shutdown"],
		sections: [
			{
				id: "danger-zone",
				label: "Danger zone",
				description: "Optimize, reclaim, restart, or shut down Hlid.",
				keywords: ["optimize", "reclaim", "restart", "shutdown", "database"],
			},
			{
				id: "session-lifecycle",
				label: "Session lifecycle",
				description:
					"Reload the current session and inspect lifecycle controls.",
				keywords: ["reload", "session", "lifecycle"],
			},
		],
	},
] as const;

const CATEGORY_ID_SET = new Set<ForgeCategoryId>(FORGE_CATEGORY_IDS);
const VIEW_SET = new Set<ForgeView>([
	"events",
	"api",
	"pricing",
	"apps",
	"umbod",
	"acp",
	"theme",
]);
const TARGET_SET = new Set<ForgeThemeTarget>(["desktop", "mobile"]);
const ALLOWED_VIEWS: Record<ForgeCategoryId, readonly ForgeView[]> = {
	overview: [],
	workspace: [],
	agents: [],
	access: [],
	experience: ["theme"],
	integrations: ["apps", "umbod", "acp"],
	extensions: [],
	developer: ["events", "api", "pricing"],
	advanced: [],
};
const SECTION_BY_VIEW: Record<ForgeView, string> = {
	events: "event-log",
	api: "api-reference",
	pricing: "pricing",
	apps: "apps-connectors",
	umbod: "umbod",
	acp: "opencode-acp",
	theme: "custom-theme",
};

const CATEGORY_BY_ID = new Map(
	FORGE_CATEGORIES.map((category) => [category.id, category]),
);

function isCategory(value: unknown): value is ForgeCategoryId {
	return (
		typeof value === "string" && CATEGORY_ID_SET.has(value as ForgeCategoryId)
	);
}

function isView(value: unknown): value is ForgeView {
	return typeof value === "string" && VIEW_SET.has(value as ForgeView);
}

function isTarget(value: unknown): value is ForgeThemeTarget {
	return typeof value === "string" && TARGET_SET.has(value as ForgeThemeTarget);
}

function sectionFor(
	category: ForgeCategoryId,
	sectionId: unknown,
): ForgeSectionDefinition | undefined {
	if (typeof sectionId !== "string") return undefined;
	return CATEGORY_BY_ID.get(category)?.sections.find(
		(section) => section.id === sectionId,
	);
}

function settingFor(
	category: ForgeCategoryId,
	settingId: unknown,
): SettingDefinition | undefined {
	if (typeof settingId !== "string") return undefined;
	return SETTING_DESTINATIONS.find(
		(setting) => setting.category === category && setting.id === settingId,
	);
}

/**
 * Strip arbitrary route-search input down to Forge's recognized, compatible
 * navigation fields. Defaults remain implicit so URLs stay compact.
 */
type ForgeSearchInput = {
	category?: unknown;
	section?: unknown;
	setting?: unknown;
	view?: unknown;
	target?: unknown;
};

export function parseForgeSearch<T extends ForgeSearchInput>(
	input: T,
): ForgeRouteSearch {
	const category = isCategory(input.category) ? input.category : undefined;
	if (!category) return {};

	const setting = settingFor(category, input.setting);
	const requestedSection = sectionFor(category, input.section);
	const requestedView = isView(input.view) ? input.view : undefined;
	const compatibleRequestedView =
		!setting && requestedView && ALLOWED_VIEWS[category].includes(requestedView)
			? requestedView
			: undefined;
	const section = setting
		? sectionFor(category, setting.section)
		: compatibleRequestedView
			? sectionFor(category, SECTION_BY_VIEW[compatibleRequestedView])
			: requestedSection;
	const effectiveView =
		setting?.view ?? compatibleRequestedView ?? section?.view;
	const compatibleSection = section?.id;
	const target =
		effectiveView === "theme" && isTarget(input.target)
			? input.target
			: undefined;

	return {
		category,
		...(compatibleSection ? { section: compatibleSection } : {}),
		...(setting ? { setting: setting.id } : {}),
		...(effectiveView ? { view: effectiveView } : {}),
		...(target ? { target } : {}),
	};
}

/** Return a complete in-memory state with the Overview category as the default. */
export function normalizeForgeNavigation(
	input: ForgeSearchInput,
): ForgeNavigationState {
	return { category: "overview", ...parseForgeSearch(input) };
}

/**
 * Convert navigation state to URL search. A bare Overview category, the Event
 * Log default, and the desktop theme target are omitted when they can be
 * inferred. Overview remains explicit for section and setting deep links.
 */
export function serializeForgeNavigation(
	navigation: ForgeNavigationState,
): ForgeRouteSearch {
	const parsed = parseForgeSearch(navigation);
	if (
		parsed.category === "overview" &&
		!parsed.section &&
		!parsed.setting &&
		!parsed.view &&
		!parsed.target
	)
		return {};
	const result: ForgeRouteSearch = { category: parsed.category };
	if (parsed.setting) result.setting = parsed.setting;
	else if (
		parsed.section &&
		!(parsed.category === "developer" && parsed.view === "events")
	)
		result.section = parsed.section;
	if (parsed.view && parsed.view !== "events" && !parsed.setting)
		result.view = parsed.view;
	if (parsed.target && parsed.target !== "desktop")
		result.target = parsed.target;
	return result;
}

export const forgeSearchFromNavigation = serializeForgeNavigation;

interface SettingDefinition {
	id: string;
	label: string;
	description: string;
	category: ForgeCategoryId;
	section: string;
	keywords?: readonly string[];
	view?: ForgeView;
	target?: ForgeThemeTarget;
	focusId?: string;
}

type StaticSettingTuple = readonly [
	id: string,
	label: string,
	description: string,
	keywords?: readonly string[],
];

function staticSettings(
	category: ForgeCategoryId,
	section: string,
	controls: readonly StaticSettingTuple[],
	view?: ForgeView,
): SettingDefinition[] {
	return controls.map(([id, label, description, keywords]) => ({
		id,
		label,
		description,
		category,
		section,
		...(keywords ? { keywords } : {}),
		...(view ? { view } : {}),
	}));
}

const SETTING_DESTINATIONS: readonly SettingDefinition[] = [
	{
		id: "save-to-obsidian-template",
		label: "Save to Obsidian Template",
		description:
			"Choose an optional template for new notes saved to the vault.",
		category: "workspace",
		section: "vault",
		keywords: ["template", "new note", "inbox", "raw folder"],
		focusId: "forge-setting-save-to-obsidian-template",
	},
	{
		id: "interactive-mode",
		label: "Interactive mode",
		description: "Let the vault agent ask questions while it works.",
		category: "agents",
		section: "vault-agent",
		keywords: ["elicitation", "questions", "agent"],
	},
	{
		id: "claude-peer-inbox",
		label: "Claude peer inbox",
		description: "Allow Claude peers to exchange session messages.",
		category: "agents",
		section: "vault-agent",
		keywords: ["collaboration", "messages", "peer"],
	},
	{
		id: "allow-external-agents",
		label: "Allow External Agents",
		description: "Permit authenticated agents to connect over the network.",
		category: "access",
		section: "network",
		keywords: ["network", "remote", "acp"],
		focusId: "forge-setting-allow-external-agents",
	},
	{
		id: "tls-cert-path",
		label: "TLS Cert Path",
		description: "Set the certificate used for encrypted network access.",
		category: "access",
		section: "network",
		keywords: ["certificate", "tailscale", "https"],
		focusId: "forge-setting-tls-cert-path",
	},
	{
		id: "html-plans",
		label: "HTML plans",
		description: "Control how agent plans are presented for review.",
		category: "experience",
		section: "ui",
		keywords: ["plan", "approval", "artifact"],
		focusId: "forge-setting-html-plans",
	},
	{
		id: "navigation-names",
		label: "Navigation names",
		description:
			"Choose Hlið, plain-language, or custom names for the main menu.",
		category: "experience",
		section: "navigation-names",
		keywords: [
			"navigation",
			"menu",
			"labels",
			"terminology",
			"plain language",
			"einherjar",
		],
	},
	{
		id: "custom-theme",
		label: "Custom theme editor",
		description: "Edit desktop and mobile palette colors.",
		category: "experience",
		section: "custom-theme",
		view: "theme",
		keywords: ["appearance", "palette", "colors"],
	},
	{
		id: "copy-desktop-custom-theme",
		label: "Copy desktop custom theme",
		description: "Copy the desktop custom palette to mobile.",
		category: "experience",
		section: "custom-theme",
		view: "theme",
		target: "mobile",
	},
	{
		id: "neural-voice-model",
		label: "Neural voice model",
		description: "Install and select a local neural speech model.",
		category: "experience",
		section: "voice-models",
		keywords: ["neural", "tts", "read aloud", "speech"],
	},
	{
		id: "recording-hotkey",
		label: "Recording hotkey",
		description: "Choose the keyboard shortcut that starts voice recording.",
		category: "experience",
		section: "voice-input",
		keywords: ["voice recording hotkey", "shortcut", "dictation"],
		focusId: "forge-setting-recording-hotkey",
	},
	{
		id: "whisper-threads",
		label: "Whisper threads",
		description: "Set the CPU threads used for local Whisper transcription.",
		category: "experience",
		section: "voice-input",
		keywords: ["whisper", "cpu", "transcription", "voice input"],
	},
	{
		id: "privacy-mode",
		label: "Privacy mode",
		description: "Control whether session activity is visible live.",
		category: "experience",
		section: "privacy",
		keywords: ["privacy", "session", "activity"],
		focusId: "forge-setting-privacy-mode",
	},
	{
		id: "apps-connectors",
		label: "Apps and Connectors catalog",
		description: "Open the provider-native apps catalog.",
		category: "integrations",
		section: "apps-connectors",
		view: "apps",
		keywords: ["apps", "connectors", "catalog"],
	},
	{
		id: "mcp",
		label: "MCP servers",
		description: "Configure Hlid and agent MCP servers.",
		category: "integrations",
		section: "mcp",
		keywords: ["mcp", "model context protocol", "tools"],
	},
	{
		id: "umbod",
		label: "Umbod",
		description: "Open approval policy, generated hooks, activity, and calls.",
		category: "integrations",
		section: "umbod",
		view: "umbod",
		keywords: ["policy", "approval", "hooks"],
	},
	{
		id: "opencode-acp",
		label: "OpenCode and ACP catalog",
		description: "Configure OpenCode or another Agent Client Protocol agent.",
		category: "integrations",
		section: "opencode-acp",
		view: "acp",
		keywords: ["acp", "external agents", "agent client protocol"],
	},
	{
		id: "api-reference",
		label: "API Reference",
		description: "Browse Hlid's local HTTP API.",
		category: "developer",
		section: "api-reference",
		view: "api",
		keywords: ["api", "http", "endpoints"],
	},
	{
		id: "pricing",
		label: "Pricing",
		description: "Inspect model rates, aliases, and local pricing overrides.",
		category: "developer",
		section: "pricing",
		view: "pricing",
		keywords: ["cost", "rates", "catalog", "overrides"],
	},
	{
		id: "reclaim-database-space",
		label: "Reclaim database space",
		description: "Compact reusable database pages and remove free space.",
		category: "advanced",
		section: "danger-zone",
		keywords: ["reclaim", "vacuum", "storage", "database"],
		focusId: "forge-setting-reclaim-database-space",
	},
	{
		id: "restart",
		label: "Restart Hlid",
		description: "Restart Hlid and interrupt active work.",
		category: "advanced",
		section: "danger-zone",
		keywords: ["restart", "lifecycle", "reboot"],
		focusId: "forge-setting-restart",
	},
	...staticSettings("overview", "updates", [
		[
			"latest-changes",
			"Latest changes",
			"Read release notes from the latest published Hlid release.",
			["release notes", "changelog"],
		],
		[
			"version",
			"Version",
			"Inspect the installed Hlid version and update availability.",
			["current version", "update"],
		],
		[
			"check-for-updates",
			"Check for updates",
			"Refresh Hlid and provider CLI update status.",
			["refresh", "version", "provider cli"],
		],
		[
			"download-update",
			"Download update",
			"Fetch and verify the newest Hlid installer.",
			["installer", "upgrade"],
		],
		[
			"launch-installer",
			"Launch installer",
			"Open the verified Windows installer.",
			["windows", "upgrade", "smartscreen"],
		],
		[
			"hlid-mcp-claude-desktop",
			"Hlid MCP in Claude Desktop",
			"Register or remove Hlid's agent and vault tools in Claude Desktop.",
			["mcp", "register", "tools"],
		],
		[
			"provider-cli-updates",
			"Provider CLI updates",
			"Inspect and run update commands for detected provider CLIs.",
			["codex", "claude code", "terminal", "upgrade"],
		],
	]),
	...staticSettings("overview", "installation-startup", [
		[
			"install-location",
			"Install location",
			"Open the folder containing the installed Hlid application.",
			["installation", "folder", "windows"],
		],
		[
			"launch-on-login",
			"Launch on login",
			"Choose whether Hlid starts when Windows signs in.",
			["startup", "autostart", "sign in"],
		],
	]),
	...staticSettings("overview", "storage-summary", [
		[
			"database-storage",
			"Database storage",
			"Inspect session, message, usage, and database size totals.",
			["sqlite", "sessions", "messages", "usage"],
		],
		[
			"write-ahead-log",
			"Write-ahead log",
			"Inspect SQLite WAL and reusable page space.",
			["wal", "database", "reusable"],
		],
		[
			"hlid-library-storage",
			"Hlid library storage",
			"Inspect storage used by Relics, plans, uploads, reports, and skills.",
			["relics", "attachments", "files"],
		],
	]),
	...staticSettings("workspace", "vault", [
		[
			"vault-style",
			"Vault style",
			"Choose the PARA or LLM Wiki folder layout.",
			["para", "llm wiki", "folder structure"],
		],
		[
			"vault-name",
			"Vault name",
			"Set the display name for the configured vault.",
			["name", "identity"],
		],
		[
			"vault-path",
			"Vault path",
			"Set the filesystem path to the configured vault.",
			["path", "folder", "obsidian"],
		],
		[
			"inbox-folder",
			"Inbox folder",
			"Map quick captures and unprocessed notes.",
		],
		[
			"projects-folder",
			"Projects folder",
			"Map active work with a defined outcome.",
		],
		[
			"areas-folder",
			"Areas folder",
			"Map ongoing responsibilities with no end date.",
		],
		[
			"resources-folder",
			"Resources folder",
			"Map reference material organized by topic.",
		],
		[
			"archive-folder",
			"Archive folder",
			"Map completed or inactive projects and areas.",
		],
		[
			"raw-folder",
			"Raw folder",
			"Map unprocessed LLM Wiki notes and captures.",
		],
		[
			"wiki-folder",
			"Wiki folder",
			"Map curated LLM-maintained knowledge pages.",
		],
		[
			"outputs-folder",
			"Outputs folder",
			"Map generated content, posts, and essays.",
		],
		["skills-folder", "Skills folder", "Set the vault-relative skills folder."],
		["memory-folder", "Memory folder", "Set the vault-relative memory folder."],
	]),
	...staticSettings("workspace", "obsidian-desktop", [
		[
			"obsidian-cli-available",
			"Obsidian CLI available",
			"Inspect and recheck the Obsidian command-line integration.",
			["command line interface", "recheck"],
		],
		[
			"remembered-command-approvals",
			"Remembered command approvals",
			"Review or forget Obsidian commands trusted with Always.",
			["allowlist", "trusted commands", "forget"],
		],
		[
			"configured-obsidian-vault",
			"Configured Obsidian vault",
			"Inspect and test the live Obsidian vault connection.",
			["test connection", "desktop"],
		],
		[
			"obsidian-agent-access",
			"Obsidian agent access",
			"Inspect curated Obsidian tools available to Claude, Codex, and ACP agents.",
			["tools", "claude", "codex", "acp"],
		],
	]),
	...staticSettings("workspace", "status-vocabulary", [
		[
			"active-status-label",
			"Active status label",
			"Set the vocabulary used for active work.",
		],
		[
			"planning-status-label",
			"Planning status label",
			"Set the vocabulary used for planned work.",
		],
		[
			"done-status-label",
			"Done status label",
			"Set the vocabulary used for completed work.",
		],
	]),
	...staticSettings("agents", "vault-agent", [
		[
			"vault-agent-provider",
			"Vault Agent provider",
			"Choose the provider used for vault chat.",
			["provider", "claude", "codex", "acp"],
		],
		[
			"capability-snapshot",
			"Capability snapshot",
			"Inspect provider capabilities and the evidence Hlid resolved.",
			["provider evidence", "integrated", "native"],
		],
		[
			"vault-agent-model",
			"Vault Agent model",
			"Choose the model used for vault chat.",
			["model"],
		],
		[
			"vault-agent-effort",
			"Vault Agent effort",
			"Choose the provider reasoning effort for vault chat.",
			["effort", "reasoning"],
		],
		[
			"vault-agent-approvals",
			"Vault Agent approvals",
			"Choose the provider permission and approval mode.",
			["permission", "bypass", "default"],
		],
		[
			"permission-profile",
			"Permission profile",
			"Choose a Codex sandbox profile or Hlid sandbox policy.",
			["sandbox", "codex", "writable roots"],
		],
		["max-turns", "Max turns", "Limit how many turns the provider may run."],
		[
			"turn-recaps",
			"Turn recaps",
			"Generate a brief summary after turns with tool use.",
		],
		[
			"recap-model",
			"Recap model",
			"Choose the model used for turn recap summaries.",
		],
		[
			"subagent-progress-summaries",
			"AI subagent progress summaries",
			"Generate periodic model-written status text for Claude SDK subagents.",
			["progress", "subagents", "status"],
		],
	]),
	...staticSettings("agents", "agent-instructions", [
		[
			"instruction-files",
			"Instruction files",
			"Edit vault and user-level provider instructions.",
			["agents.md", "claude.md", "provider instructions"],
		],
	]),
	...staticSettings("agents", "browser-profile", [
		[
			"real-browser-profile",
			"Use real browser profile",
			"Use an existing browser profile for the next agent-controlled Preview session.",
			["project preview", "cookies", "storage"],
		],
	]),
	...staticSettings("agents", "computer-use", [
		[
			"computer-use-model",
			"Computer Use model",
			"Choose or inherit the model used by Windows-native Computer Use workers.",
			["windows", "desktop", "model"],
		],
		[
			"computer-use-effort",
			"Computer Use effort",
			"Choose or inherit reasoning effort for Computer Use workers.",
			["windows", "desktop", "reasoning"],
		],
	]),
	...staticSettings("agents", "auto-sleep", [
		[
			"auto-sleep-enabled",
			"Auto-sleep",
			"Pause sessions when a provider usage limit is reached.",
		],
		[
			"utilization-threshold",
			"Utilization threshold",
			"Choose the active-budget percentage that triggers sleep.",
			["usage limit", "budget"],
		],
		[
			"maximum-sleep",
			"Maximum sleep",
			"Cap how long Hlid waits for a provider reset.",
		],
		[
			"resume-buffer",
			"Resume buffer",
			"Wait a little beyond reset time to absorb clock skew.",
		],
	]),
	...staticSettings("access", "network", [
		["network-port", "Network port", "Set the Hlid UI server port.", ["port"]],
		[
			"local-network-access",
			"Local Network Access",
			"Expose Hlid to trusted LAN and Tailscale devices.",
			["lan", "tailscale", "bind", "0.0.0.0"],
		],
		[
			"tailscale-installed",
			"Tailscale installed",
			"Inspect whether Tailscale is installed.",
		],
		[
			"tailscale-authenticated",
			"Tailscale authenticated",
			"Inspect Tailscale authentication and MagicDNS reachability.",
		],
		[
			"tls-key-path",
			"TLS Key Path",
			"Set the private key used for encrypted network access.",
		],
		[
			"tls-proxy-port",
			"TLS Proxy Port",
			"Set the local port used by the TLS proxy.",
		],
		[
			"tailscale-setup-guide",
			"Tailscale setup guide",
			"Open a guided chat for Tailscale install, authentication, and certificate setup.",
			["tls", "cert", "magicdns"],
		],
	]),
	...staticSettings("access", "app-password", [
		[
			"current-password",
			"Current Password",
			"Enter the current Hlid app password.",
		],
		["new-password", "New Password", "Set a new Hlid app password."],
		[
			"confirm-new-password",
			"Confirm New Password",
			"Confirm the replacement Hlid app password.",
		],
		[
			"change-app-password",
			"Change app password",
			"Validate and save a new Hlid app password.",
		],
	]),
	...staticSettings("access", "trusted-devices", [
		[
			"lock-this-device",
			"Lock This Device",
			"Return this browser to the unlock screen.",
			["this device", "logout", "sign out"],
		],
		[
			"revoke-all-devices",
			"Revoke All Devices",
			"Delete every active trusted-device session.",
			["lock", "logout", "trusted devices"],
		],
	]),
	...staticSettings("experience", "ui", [
		[
			"desktop-theme",
			"Theme",
			"Choose the desktop Dark, Tan, or Custom theme.",
		],
		[
			"mobile-theme-override",
			"Mobile theme override",
			"Use the desktop theme or a separate mobile theme on touch devices.",
			["same", "dark", "tan", "custom"],
		],
		[
			"enter-to-submit",
			"Enter to submit",
			"Submit with Enter on desktop instead of inserting a newline.",
		],
		[
			"live-sessions-hotkey",
			"Live sessions hotkey",
			"Set the desktop shortcut for live sessions.",
		],
		[
			"hide-skills-index",
			"Hide skills index.md",
			"Hide the generated skills index note.",
		],
		[
			"show-provider-picker-entries",
			"Show provider entries in / picker",
			"Show or hide provider-badged skills, commands, and plugin entries.",
			["slash picker", "skills", "commands", "plugins"],
		],
	]),
	...staticSettings(
		"experience",
		"custom-theme",
		[
			[
				"custom-theme-target",
				"Custom theme target",
				"Switch the editor between desktop and mobile palettes.",
			],
			[
				"copy-active-theme",
				"Copy active theme",
				"Copy the active built-in or custom palette into the editor.",
			],
			[
				"copy-dark-theme",
				"Copy dark theme",
				"Start from Hlid's built-in dark palette.",
			],
			[
				"copy-tan-theme",
				"Copy tan theme",
				"Start from Hlid's built-in tan palette.",
			],
			[
				"native-control-style",
				"Native control style",
				"Choose light or dark browser-native menus, inputs, and scrollbars.",
			],
			[
				"theme-background",
				"Background color",
				"Edit the custom theme background color.",
			],
			[
				"theme-text",
				"Text color",
				"Edit the custom theme foreground text color.",
			],
			[
				"theme-cards",
				"Cards color",
				"Edit the custom theme card surface color.",
			],
			["theme-card-text", "Card text color", "Edit custom theme card text."],
			[
				"theme-primary-accent",
				"Primary accent color",
				"Edit the primary accent color.",
			],
			[
				"theme-primary-contrast",
				"Primary contrast color",
				"Edit text shown on the primary accent.",
			],
			["theme-borders", "Borders color", "Edit the custom theme border color."],
			[
				"theme-muted-text",
				"Muted text color",
				"Edit secondary and muted text.",
			],
			["theme-popovers", "Popovers color", "Edit popover surfaces."],
			[
				"theme-popover-text",
				"Popover text color",
				"Edit text shown in popovers.",
			],
			[
				"theme-secondary-surface",
				"Secondary surface color",
				"Edit secondary surfaces.",
			],
			[
				"theme-secondary-text",
				"Secondary text color",
				"Edit text on secondary surfaces.",
			],
			["theme-muted-surface", "Muted surface color", "Edit muted surfaces."],
			[
				"theme-hover-surface",
				"Hover surface color",
				"Edit hover and accent surfaces.",
			],
			["theme-hover-text", "Hover text color", "Edit text on hover surfaces."],
			["theme-inputs", "Inputs color", "Edit input backgrounds."],
			["theme-focus-ring", "Focus ring color", "Edit keyboard focus rings."],
			[
				"theme-destructive",
				"Destructive color",
				"Edit destructive actions and errors.",
			],
			[
				"theme-destructive-text",
				"Destructive text color",
				"Edit text on destructive surfaces.",
			],
			["theme-success", "Success color", "Edit success status indicators."],
			["theme-warning", "Warning color", "Edit warning status indicators."],
			[
				"theme-info-queued",
				"Info and queued color",
				"Edit informational and queued states.",
			],
			[
				"theme-charts-heatmap",
				"Charts and heatmap color",
				"Edit chart and heatmap data color.",
			],
			[
				"theme-tool-errors",
				"Tool errors color",
				"Edit tool-error chart color.",
			],
			[
				"theme-token-input",
				"Token input color",
				"Edit input-token chart color.",
			],
			[
				"theme-token-output",
				"Token output color",
				"Edit output-token chart color.",
			],
			["theme-cache-read", "Cache read color", "Edit cache-read chart color."],
			[
				"theme-cache-write",
				"Cache write color",
				"Edit cache-write chart color.",
			],
			[
				"theme-sidebar",
				"Sidebar color",
				"Edit the navigation sidebar surface.",
			],
			[
				"theme-sidebar-text",
				"Sidebar text color",
				"Edit navigation sidebar text.",
			],
			[
				"theme-sidebar-primary",
				"Sidebar primary color",
				"Edit the sidebar primary surface.",
			],
			[
				"theme-sidebar-primary-text",
				"Sidebar primary text color",
				"Edit text on the sidebar primary surface.",
			],
			[
				"theme-sidebar-hover",
				"Sidebar hover color",
				"Edit the sidebar hover surface.",
			],
			[
				"theme-sidebar-hover-text",
				"Sidebar hover text color",
				"Edit text on sidebar hover surfaces.",
			],
			["theme-sidebar-border", "Sidebar border color", "Edit sidebar borders."],
			[
				"theme-sidebar-focus",
				"Sidebar focus color",
				"Edit sidebar focus rings.",
			],
			[
				"theme-tool-panels",
				"Tool panels color",
				"Edit agent tool panel surfaces.",
			],
			[
				"theme-tool-panel-border",
				"Tool panel border color",
				"Edit agent tool panel borders.",
			],
			[
				"theme-user-messages",
				"User messages color",
				"Edit user message surfaces.",
			],
			[
				"theme-agent-messages",
				"Agent messages color",
				"Edit agent message surfaces.",
			],
		],
		"theme",
	),
	...staticSettings("experience", "notifications", [
		[
			"notifications-device",
			"This device",
			"Enable or disable background notifications on this device.",
			["push", "pwa", "permission", "opt in"],
		],
		[
			"notification-permission",
			"Notification permission",
			"Inspect whether this browser allows Hlid notifications.",
			["blocked", "allowed", "browser"],
		],
		[
			"notifications-requests",
			"Requests",
			"Alert for approvals, questions, plan reviews, and routines needing action.",
			["approval", "question", "plan", "routine", "decision"],
		],
		[
			"notifications-problems",
			"Problems",
			"Alert for blocked goals, errors, and failed background work.",
			["blocked", "error", "failed", "background"],
		],
		[
			"notifications-work-finished",
			"Work finished",
			"Alert when background work completes.",
			["done", "complete", "completion"],
		],
		[
			"notifications-completion-runtime",
			"Completion minimum runtime",
			"Skip completion alerts for quick work.",
			["threshold", "duration", "minute", "spam"],
		],
		[
			"notifications-lock-screen",
			"Lock Screen wording",
			"Choose generic or detailed notification text.",
			["privacy", "session name", "reason"],
		],
		[
			"notifications-pause",
			"Pause this device",
			"Temporarily silence session alerts without revoking this device.",
			["resume", "one hour", "8 am", "silence"],
		],
		[
			"notifications-test",
			"Test this device",
			"Send a real notification and inspect push-service acceptance.",
			["delivery", "health", "repair", "send test"],
		],
		[
			"notifications-devices",
			"Subscribed devices",
			"Rename or revoke browsers and installed PWAs.",
			["phone", "desktop", "rename", "revoke"],
		],
	]),
	...staticSettings("experience", "read-aloud", [
		[
			"speech-engine",
			"Speech engine",
			"Choose device, Microsoft, or local neural read-aloud speech.",
		],
		[
			"device-voice",
			"Device voice",
			"Choose a browser-provided voice for this device.",
		],
		[
			"microsoft-voice",
			"Microsoft voice",
			"Choose a Windows Microsoft speech voice.",
		],
		[
			"more-windows-voices",
			"More Windows voices",
			"Open Windows voice installation settings.",
		],
		["neural-voice", "Neural voice", "Choose an installed local neural voice."],
		[
			"speech-threads",
			"Speech threads",
			"Set CPU threads reserved for local neural speech.",
		],
		[
			"voice-preview",
			"Voice preview",
			"Play a fixed phrase with the saved neural voice.",
		],
		["reading-speed", "Reading speed", "Set the speech playback rate."],
	]),
	...staticSettings("experience", "realtime-voice", [
		[
			"codex-realtime-developer-preview",
			"Codex realtime Developer Preview",
			"Enable Codex dictation and Raven Live when supported.",
			["developer preview", "raven live", "dictation"],
		],
		[
			"codex-realtime-shared-voice",
			"Codex realtime shared voice",
			"Choose the voice shared by Codex dictation and Raven Live.",
		],
	]),
	...staticSettings("experience", "voice-input", [
		[
			"voice-enabled",
			"Voice input enabled",
			"Show microphone controls in Raven and Cockpit.",
			["voice"],
		],
		[
			"microphone-action",
			"Microphone action",
			"Choose editable dictation or Talk to Codex audio turns.",
			["dictation", "talk to codex"],
		],
		[
			"voice-runtime-status",
			"Voice runtime status",
			"Inspect local and Codex voice readiness.",
		],
		[
			"voice-language",
			"Voice input language",
			"Choose a transcription language or automatic detection.",
		],
		[
			"after-transcription",
			"After transcription",
			"Choose whether to review or submit transcribed text.",
		],
		[
			"whisper-acceleration",
			"Whisper acceleration",
			"Choose automatic GPU acceleration or CPU transcription.",
		],
		[
			"vocabulary-hints",
			"Vocabulary hints",
			"Provide preferred spellings for local transcription.",
		],
	]),
	...staticSettings("experience", "voice-models", [
		[
			"neural-model-actions",
			"Neural model actions",
			"Download, select, or delete a local neural speech model.",
			["tts", "install", "remove"],
		],
		[
			"whisper-models",
			"Whisper models",
			"Download, select, or delete local Whisper transcription models.",
			["voice model", "install", "remove"],
		],
	]),
	...staticSettings(
		"integrations",
		"apps-connectors",
		[
			[
				"apps-provider",
				"Apps provider",
				"Choose which provider-native Apps catalog to inspect.",
			],
			[
				"refresh-apps-catalog",
				"Refresh Apps catalog",
				"Reload provider-native app and connector readiness.",
			],
			[
				"installed-apps",
				"Installed apps",
				"Browse provider apps already installed for the workspace.",
			],
			[
				"available-apps",
				"Available apps",
				"Browse provider apps available to install.",
			],
			[
				"app-mcp-connectors",
				"App MCP connectors",
				"Browse provider-native MCP connectors and authentication state.",
			],
			[
				"filter-provider-integrations",
				"Filter loaded provider integrations",
				"Search installed apps, available apps, and connectors.",
				["search apps", "filter apps"],
			],
			[
				"authenticate-provider-app",
				"Authenticate provider app",
				"Start provider-native authentication for an app or connector.",
			],
			[
				"load-more-apps",
				"Load more available apps",
				"Load the next page of the provider Apps catalog.",
			],
		],
		"apps",
	),
	...staticSettings("integrations", "mcp", [
		[
			"agent-mcp-servers",
			"Agent MCP servers",
			"Review MCP servers configured for the current agent workspace.",
		],
		["add-mcp-server", "Add MCP server", "Add a vault or agent MCP server."],
		[
			"mcp-server-name",
			"MCP server name",
			"Set the unique name of a new MCP server.",
		],
		[
			"mcp-server-type",
			"MCP server type",
			"Choose stdio, HTTP, or SSE transport.",
		],
		[
			"mcp-command",
			"MCP command",
			"Set the executable for a stdio MCP server.",
		],
		[
			"mcp-arguments",
			"MCP arguments",
			"Set comma-separated arguments for a stdio MCP server.",
		],
		[
			"mcp-environment-variables",
			"MCP environment variables",
			"Set KEY=value environment variables for a stdio MCP server.",
		],
		["mcp-url", "MCP URL", "Set the endpoint for an HTTP or SSE MCP server."],
		[
			"mcp-headers",
			"MCP headers",
			"Set request headers for an HTTP or SSE MCP server.",
		],
		[
			"edit-mcp-server",
			"Edit MCP server",
			"Edit an existing MCP server transport and connection details.",
		],
		[
			"toggle-mcp-server",
			"Enable or disable MCP server",
			"Turn an MCP server on or off without deleting it.",
		],
		[
			"remove-mcp-server",
			"Remove MCP server",
			"Remove an existing MCP server configuration.",
		],
		[
			"check-mcp-servers",
			"Check MCPs",
			"Refresh active MCP status without starting an assistant turn.",
		],
	]),
	...staticSettings("integrations", "cli-proxy", [
		[
			"cliproxy-status",
			"CLIProxy status",
			"Inspect managed, external, running, and installed CLIProxy state.",
			["cliproxyapi", "version"],
		],
		[
			"cliproxy-install-managed",
			"Install managed CLIProxy",
			"Install Hlid's approved CLIProxy build.",
		],
		[
			"cliproxy-enable",
			"Enable CLIProxy",
			"Start the managed CLIProxy service.",
		],
		[
			"cliproxy-disable",
			"Disable CLIProxy",
			"Stop the managed CLIProxy service.",
		],
		[
			"cliproxy-openai-account",
			"Connect OpenAI Codex account",
			"Connect or reconnect an OpenAI Codex OAuth account.",
		],
		[
			"cliproxy-anthropic-account",
			"Connect Anthropic Claude account",
			"Connect or reconnect an Anthropic Claude OAuth account.",
		],
		[
			"cliproxy-antigravity-account",
			"Connect Google Antigravity account",
			"Connect or reconnect a Google Antigravity OAuth account.",
		],
		[
			"cliproxy-kimi-account",
			"Connect Moonshot Kimi account",
			"Connect or reconnect a Moonshot Kimi OAuth account.",
		],
		[
			"cliproxy-xai-account",
			"Connect xAI account",
			"Connect or reconnect an xAI OAuth account.",
		],
		[
			"cliproxy-repair",
			"Check or repair CLIProxy",
			"Update to the approved version, add WSL support, or repair the managed install.",
			["approved version", "update", "wsl"],
		],
		[
			"cliproxy-remove",
			"Remove CLIProxy and accounts",
			"Remove the managed CLIProxy install and its saved OAuth accounts.",
		],
		[
			"cliproxy-refresh",
			"Refresh CLIProxy",
			"Refresh CLIProxy lifecycle and account status.",
		],
		[
			"cliproxy-accounting",
			"CLIProxy accounting",
			"Inspect harness and model attribution used by Ledger.",
			["ledger", "pricing", "usage"],
		],
	]),
	...staticSettings(
		"integrations",
		"umbod",
		[
			[
				"umbod-policy-enabled",
				"Umbod policy enabled",
				"Enable or disable Umbod tool policy enforcement.",
			],
			[
				"umbod-manifest-path",
				"Umbod manifest path",
				"Set the Umbod policy manifest path.",
			],
			[
				"umbod-manifest-toml",
				"Umbod manifest TOML",
				"Edit Umbod tool policy rules.",
			],
			[
				"umbod-validate-save",
				"Validate and save Umbod policy",
				"Validate and save the policy manifest.",
			],
			[
				"umbod-reload-insights",
				"Reload Umbod insights",
				"Refresh policy and activity analytics.",
			],
			[
				"generate-agent-hooks",
				"Generate agent hooks",
				"Generate Umbod wrappers and settings fragments for Claude, Codex, Cursor, or Gemini.",
				["wsl", "windows", "wrapper"],
			],
			[
				"umbod-hook-target",
				"Umbod hook target",
				"Choose WSL or Windows for generated hooks.",
			],
			[
				"umbod-hook-agents",
				"Umbod hook agents",
				"Choose which provider hook artifacts to generate.",
			],
			[
				"copy-umbod-wrapper",
				"Copy Umbod wrapper",
				"Copy a generated Umbod hook wrapper.",
			],
			[
				"copy-umbod-settings",
				"Copy Umbod settings",
				"Copy a generated provider settings fragment.",
			],
			[
				"umbod-activity",
				"Umbod activity",
				"Inspect policy analytics and audited tool operations.",
			],
			[
				"umbod-tool-use",
				"Umbod tool use",
				"Inspect allow, review, and block decisions by tool.",
			],
			[
				"umbod-rule-analysis",
				"Umbod rule analysis",
				"Inspect match history and policy rule health.",
			],
			[
				"umbod-call-explorer",
				"Umbod call explorer",
				"Inspect concrete audited calls and policy context.",
			],
			[
				"search-umbod-commands",
				"Search Umbod commands",
				"Filter audited calls by command text.",
			],
			[
				"filter-umbod-tool",
				"Filter Umbod tool",
				"Filter audited calls by tool.",
			],
			[
				"filter-umbod-agent",
				"Filter Umbod agent",
				"Filter audited calls by agent.",
			],
			[
				"filter-umbod-classification",
				"Filter Umbod classification",
				"Filter audited calls by policy classification.",
			],
			[
				"filter-umbod-decision",
				"Filter Umbod decision",
				"Filter audited calls by allow, approve, or block decision.",
			],
			[
				"filter-umbod-project",
				"Filter Umbod project",
				"Filter audited calls by project.",
			],
			[
				"reset-umbod-filters",
				"Reset Umbod filters",
				"Clear every Call explorer filter.",
			],
		],
		"umbod",
	),
	...staticSettings(
		"integrations",
		"opencode-acp",
		[
			[
				"search-acp-agents",
				"Search ACP agents",
				"Filter the OpenCode and ACP integration catalog.",
			],
			[
				"refresh-acp-catalog",
				"Refresh ACP catalog",
				"Reload the Agent Client Protocol registry.",
			],
			[
				"enable-acp-agent",
				"Enable ACP agent",
				"Enable OpenCode or another ACP integration.",
			],
			[
				"disable-acp-agent",
				"Disable ACP agent",
				"Disable an enabled ACP integration.",
			],
			[
				"opencode-model-visibility",
				"OpenCode model visibility",
				"Show all models, hide selected models, or offer only selected models.",
				["use all", "hide selected", "only selected"],
			],
			[
				"refresh-opencode-model-list",
				"Refresh full OpenCode model list",
				"Discover every model advertised by OpenCode.",
			],
			[
				"search-opencode-models",
				"Search OpenCode models",
				"Filter models in the OpenCode visibility editor.",
			],
			[
				"apply-model-visibility",
				"Apply model visibility",
				"Save the OpenCode model visibility selection.",
			],
			[
				"acp-executable-override",
				"ACP executable override",
				"Override the executable used to launch an ACP agent.",
			],
			[
				"acp-arguments-override",
				"ACP arguments override",
				"Override arguments used to launch an ACP agent.",
			],
			[
				"verify-opencode-acp",
				"Verify OpenCode ACP",
				"Initialize and verify the saved OpenCode ACP connection.",
			],
			[
				"inspect-acp-agent",
				"Inspect ACP agent",
				"Initialize and inspect an enabled ACP integration.",
			],
			[
				"refresh-acp-options",
				"Refresh ACP options",
				"Refresh models, modes, and other options for the workspace.",
			],
			[
				"acp-credential-management",
				"ACP credential management",
				"Run credential actions advertised by an ACP agent.",
			],
		],
		"acp",
	),
	...staticSettings("extensions", "provider-extensions", [
		[
			"extension-provider",
			"Extension provider",
			"Switch between Claude and Codex native extension systems.",
			["plugins", "provider"],
		],
		[
			"installed-extensions",
			"Installed extensions",
			"Inspect installed provider extensions and bundled components.",
		],
		[
			"extension-marketplace",
			"Extension marketplace",
			"Browse provider-native marketplace package snapshots.",
		],
		[
			"filter-installed-extensions",
			"Filter installed extensions",
			"Search installed provider packages.",
		],
		[
			"search-extension-marketplaces",
			"Search marketplaces",
			"Search available provider extension packages.",
		],
		[
			"refresh-extension-inventory",
			"Refresh extension inventory",
			"Reinspect native plugin registries.",
		],
		[
			"marketplace-environment",
			"Marketplace environment",
			"Filter marketplace results by provider environment.",
		],
		[
			"marketplace-category",
			"Marketplace category",
			"Filter marketplace results by package category.",
		],
		[
			"add-marketplace-source",
			"Add marketplace source",
			"Add a Git repository or local path to the provider registry.",
		],
		[
			"marketplace-source",
			"Marketplace source",
			"Set the owner/repository, Git URL, or local marketplace path.",
		],
		[
			"marketplace-git-ref",
			"Marketplace Git ref",
			"Optionally pin a Codex marketplace source to a Git ref.",
		],
		[
			"marketplace-sparse-paths",
			"Marketplace sparse paths",
			"Optionally restrict a marketplace checkout to selected paths.",
		],
		[
			"update-marketplace-source",
			"Update marketplace source",
			"Refresh a configured provider marketplace source.",
		],
		[
			"remove-marketplace-source",
			"Remove marketplace source",
			"Remove a configured provider marketplace source.",
		],
		[
			"review-extension",
			"Review extension",
			"Review a provider extension manifest and trust signals before installation.",
		],
		[
			"install-extension",
			"Install extension",
			"Install a reviewed package through the provider CLI.",
		],
		[
			"remove-extension",
			"Remove extension",
			"Remove an installed provider extension through its native CLI.",
		],
	]),
	...staticSettings(
		"developer",
		"event-log",
		[
			[
				"event-log-level",
				"Event Log level",
				"Filter recorded runtime events by all, error, warning, or info.",
			],
			[
				"expand-log-details",
				"Expand log details",
				"Inspect structured details for one runtime log entry.",
			],
			[
				"clear-event-log",
				"Clear Event Log",
				"Delete every recorded runtime log entry.",
			],
			[
				"event-log-pagination",
				"Event Log pagination",
				"Move between pages of runtime log entries.",
			],
		],
		"events",
	),
	...staticSettings(
		"developer",
		"api-reference",
		[
			[
				"system-api",
				"System API",
				"Browse discovery, provider, auth, maintenance, lifecycle, logs, and health endpoints.",
			],
			[
				"session-api",
				"Session API",
				"Browse sessions, messages, usage, Relics, and live controls.",
			],
			[
				"config-pricing-api",
				"Config and Pricing API",
				"Browse configuration and pricing override endpoints.",
			],
			[
				"mcp-api",
				"MCP API",
				"Browse vault and agent MCP management endpoints.",
			],
			[
				"agent-api",
				"Agent API",
				"Browse registered agent and instruction endpoints.",
			],
			["vault-api", "Vault API", "Browse Hlid's curated vault data endpoints."],
			[
				"extensions-skills-api",
				"Extensions and Skills API",
				"Browse extension and skill package endpoints.",
			],
			[
				"build-api-skill",
				"Build API Skill",
				"Pre-fill Raven with a focused API skill prompt.",
			],
		],
		"api",
	),
	...staticSettings(
		"developer",
		"pricing",
		[
			[
				"pricing-model-rates",
				"Pricing model rates",
				"Inspect effective model input, cache, and output rates.",
			],
			[
				"pricing-alias-timeline",
				"Pricing alias timeline",
				"Inspect effective-dated model aliases.",
			],
			[
				"pricing-local-override-file",
				"Pricing local override file",
				"Edit local model rate and alias rules.",
			],
			[
				"pricing-overrides-toml",
				"Pricing overrides TOML",
				"Edit the local pricing override source.",
			],
			[
				"validate-save-pricing",
				"Validate and save pricing",
				"Validate and save local pricing overrides.",
			],
			[
				"discard-reload-pricing",
				"Discard and reload pricing",
				"Discard unsaved pricing edits and reload the file.",
			],
		],
		"pricing",
	),
	...staticSettings("advanced", "danger-zone", [
		[
			"optimize-database",
			"Optimize database",
			"Checkpoint the WAL and refresh SQLite query statistics.",
			["analyze", "sqlite", "maintenance"],
		],
		[
			"shutdown",
			"Shutdown Hlid",
			"Exit Hlid completely and interrupt active work.",
		],
	]),
	...staticSettings("advanced", "session-lifecycle", [
		[
			"reload-session",
			"Reload session",
			"Restart the session with current configuration and clear conversation history.",
			["session lifecycle", "config"],
		],
	]),
] as const;

function navigationForSection(
	category: ForgeCategoryDefinition,
	section: ForgeSectionDefinition,
): ForgeNavigationState {
	return {
		category: category.id,
		section: section.id,
		...(section.view ? { view: section.view } : {}),
	};
}

const SEARCH_DESTINATIONS: readonly (ForgeSearchDestination & {
	searchText: string;
})[] = [
	...FORGE_CATEGORIES.map((category) => ({
		id: `category:${category.id}`,
		kind: "category" as const,
		label: category.label,
		description: category.description,
		breadcrumbs: [category.label],
		anchorId: `forge-category-${category.id}`,
		navigation: { category: category.id },
		searchText: [
			category.label,
			category.description,
			...category.keywords,
		].join(" "),
	})),
	...FORGE_CATEGORIES.flatMap((category) =>
		category.sections.map((section) => ({
			id: `section:${category.id}:${section.id}`,
			kind: "section" as const,
			label: section.label,
			description: section.description,
			breadcrumbs: [category.label, section.label],
			anchorId: section.view
				? `forge-view-${section.view}`
				: `forge-section-${section.id}`,
			navigation: navigationForSection(category, section),
			searchText: [
				section.label,
				section.description,
				...(section.keywords ?? []),
				category.label,
			].join(" "),
		})),
	),
	...SETTING_DESTINATIONS.map((setting) => {
		const category = CATEGORY_BY_ID.get(setting.category);
		const section = sectionFor(setting.category, setting.section);
		if (!category || !section) {
			throw new Error(`Invalid Forge setting destination: ${setting.id}`);
		}
		return {
			id: `setting:${setting.id}`,
			kind: "setting" as const,
			label: setting.label,
			description: setting.description,
			breadcrumbs: [category.label, section.label, setting.label],
			anchorId:
				setting.focusId ??
				(setting.view
					? `forge-view-${setting.view}`
					: `forge-section-${setting.section}`),
			...(setting.focusId ? { focusId: setting.focusId } : {}),
			navigation: {
				category: setting.category,
				section: setting.section,
				setting: setting.id,
				...(setting.view ? { view: setting.view } : {}),
				...(setting.target ? { target: setting.target } : {}),
			},
			searchText: [
				setting.label,
				setting.description,
				...(setting.keywords ?? []),
				category.label,
				section.label,
			].join(" "),
		};
	}),
];

function matchScore(
	destination: (typeof SEARCH_DESTINATIONS)[number],
	query: string,
) {
	const label = normalizeSearchText(destination.label);
	const normalizedQuery = normalizeSearchText(query);
	if (label === normalizedQuery) return 0;
	if (label.startsWith(normalizedQuery)) return 10;
	if (label.includes(normalizedQuery)) return 20;
	if (normalizedQuery.split(/\s+/).some((token) => label === token)) return 21;
	return 30;
}

/** Search categories, section landings, and individual settings. */
export function searchForgeDestinations(
	query: string,
	limit = 12,
): ForgeSearchDestination[] {
	const normalizedQuery = normalizeSearchText(query.trim());
	if (!normalizedQuery || limit <= 0) return [];
	const tokens = normalizedQuery.split(/\s+/).filter(Boolean);

	const ranked = SEARCH_DESTINATIONS.filter((destination) => {
		const haystack = normalizeSearchText(destination.searchText);
		return tokens.every((token) => haystack.includes(token));
	}).sort((left, right) => {
		const score =
			matchScore(left, normalizedQuery) - matchScore(right, normalizedQuery);
		if (score !== 0) return score;
		if (left.kind !== right.kind) {
			return left.kind === "setting" ? -1 : right.kind === "setting" ? 1 : 0;
		}
		return left.label.localeCompare(right.label);
	});
	const seenLandings = new Set<string>();
	const results: ForgeSearchDestination[] = [];
	for (const { searchText: _searchText, ...destination } of ranked) {
		const landingKey = [
			normalizeSearchText(destination.label),
			destination.navigation.category,
			destination.navigation.section ?? "",
			destination.navigation.view ?? "",
		].join(":");
		if (seenLandings.has(landingKey)) continue;
		seenLandings.add(landingKey);
		results.push(destination);
		if (results.length === limit) break;
	}
	return results;
}

export function getForgeCategory(
	category: ForgeCategoryId,
): ForgeCategoryDefinition {
	const definition = CATEGORY_BY_ID.get(category);
	if (!definition) throw new Error(`Unknown Forge category: ${category}`);
	return definition;
}

/** Resolve a validated navigation state to the DOM target rendered by Forge. */
export function getForgeNavigationFocusId(
	navigation: ForgeNavigationState,
): string | undefined {
	const parsed = normalizeForgeNavigation(navigation);
	if (parsed.setting) {
		const setting = settingFor(parsed.category, parsed.setting);
		if (!setting) return undefined;
		if (setting.focusId) return setting.focusId;
		if (setting.view) return `forge-view-${setting.view}`;
		return `forge-section-${setting.section}`;
	}
	if (parsed.view) return `forge-view-${parsed.view}`;
	if (parsed.section) return `forge-section-${parsed.section}`;
	return `forge-category-${parsed.category}`;
}

/** Return the indexed setting label used to resolve a rendered control row. */
export function getForgeNavigationSettingLabel(
	navigation: ForgeNavigationState,
): string | undefined {
	const parsed = normalizeForgeNavigation(navigation);
	if (!parsed.setting) return undefined;
	return settingFor(parsed.category, parsed.setting)?.label;
}

/** Return the searchable landings and settings contained by one category. */
// fallow-ignore-next-line unused-export -- focused registry tests inspect each category's complete destination inventory.
export function forgeDestinationsForCategory(
	category: ForgeCategoryId,
): ForgeSearchDestination[] {
	return SEARCH_DESTINATIONS.filter(
		(destination) =>
			destination.navigation.category === category &&
			destination.kind !== "category",
	).map(({ searchText: _searchText, ...destination }) => destination);
}
