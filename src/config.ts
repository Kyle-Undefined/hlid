import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createServerFn } from "@tanstack/react-start";
import { parse } from "smol-toml";
import { z } from "zod";

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
});

const ServerSchema = z.object({
	port: z.number().default(3000),
	host: z.string().default("0.0.0.0"),
	tls_cert_path: z.string().optional(),
	tls_key_path: z.string().optional(),
	tls_proxy_port: z.number().default(3443),
	local_network_access: z.boolean().default(false),
});

const ClaudeSchema = z.object({
	model: z.string().default("claude-sonnet-4-6"),
	effort: z.enum(["low", "medium", "high", "xhigh", "max"]).default("high"),
	max_turns: z.number().int().positive().optional(),
	permission_mode: z
		.enum(["default", "acceptEdits", "bypassPermissions"])
		.default("default"),
	executable: z.string().optional(),
});

const UiSchema = z.object({
	enter_to_submit: z.boolean().default(true),
	hide_skills_index: z.boolean().default(true),
	theme: z.enum(["dark", "tan"]).default("tan"),
	mobile_theme: z.enum(["dark", "tan"]).optional(),
});

const StatusVocabularySchema = z.object({
	active: z.array(z.string()).default(["Active", "In Progress", "Doing"]),
	planning: z
		.array(z.string())
		.default(["Planning", "Ideas", "Backlog", "On Hold"]),
	done: z.array(z.string()).default(["Done", "Complete", "Archived"]),
});

export const DEFAULT_ATTACHMENT_MIMES = [
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

const AgentSchema = z.object({
	path: z.string(),
	name: z.string().optional(),
});

export type Agent = z.infer<typeof AgentSchema>;

export const HlidConfigSchema = z.object({
	vault: VaultSchema.default(() => ({ name: "Vault", path: "" })),
	server: ServerSchema.default(() => ({
		port: 3000,
		host: "0.0.0.0",
		tls_proxy_port: 3443,
		local_network_access: false,
	})),
	claude: ClaudeSchema.default(() => ({
		model: "claude-sonnet-4-6",
		effort: "high" as const,
		permission_mode: "default" as const,
	})),
	ui: UiSchema.default(() => ({
		enter_to_submit: true,
		hide_skills_index: true,
		theme: "tan" as const,
	})),
	status_vocabulary: StatusVocabularySchema.default(() => ({
		active: ["Active", "In Progress"],
		planning: ["Planning", "Ideas"],
		done: ["Done", "Complete", "Archived"],
	})),
	attachments: AttachmentsSchema.default(DEFAULT_ATTACHMENTS_CONFIG),
	agents: z.array(AgentSchema).default([]),
});

export type HlidConfig = z.infer<typeof HlidConfigSchema>;

const CONFIG_PATH = resolve(process.cwd(), "hlid.config.toml");

function loadFromDisk(): HlidConfig {
	try {
		const raw = readFileSync(CONFIG_PATH, "utf-8");
		const parsed = parse(raw);
		return HlidConfigSchema.parse(parsed);
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") {
			return HlidConfigSchema.parse({});
		}
		throw err;
	}
}

export const getConfig = createServerFn({ method: "GET" }).handler(() => {
	return loadFromDisk();
});
