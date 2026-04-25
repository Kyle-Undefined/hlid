import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createServerFn } from "@tanstack/react-start";
import { parse } from "smol-toml";
import { z } from "zod";

const VaultSchema = z.object({
	name: z.string().default("Vault"),
	path: z.string().default(""),
	inbox: z.string().optional(),
	projects: z.string().optional(),
	areas: z.string().optional(),
	skills: z.string().optional(),
	memory: z.string().optional(),
});

const ServerSchema = z.object({
	port: z.number().default(3000),
	host: z.string().default("0.0.0.0"),
});

const ClaudeSchema = z.object({
	model: z.string().default("claude-sonnet-4-6"),
	effort: z.enum(["low", "medium", "high", "xhigh", "max"]).default("high"),
	max_turns: z.number().int().positive().optional(),
	permission_mode: z
		.enum(["default", "acceptEdits", "bypassPermissions"])
		.default("default"),
});

const StatusVocabularySchema = z.object({
	active: z.array(z.string()).default(["Active", "In Progress"]),
	planning: z.array(z.string()).default(["Planning", "Ideas"]),
	done: z.array(z.string()).default(["Done", "Complete", "Archived"]),
});

export const HlidConfigSchema = z.object({
	vault: VaultSchema.default(() => ({ name: "Vault", path: "" })),
	server: ServerSchema.default(() => ({ port: 3000, host: "0.0.0.0" })),
	claude: ClaudeSchema.default(() => ({
		model: "claude-sonnet-4-6",
		effort: "high" as const,
		permission_mode: "default" as const,
	})),
	status_vocabulary: StatusVocabularySchema.default(() => ({
		active: ["Active", "In Progress"],
		planning: ["Planning", "Ideas"],
		done: ["Done", "Complete", "Archived"],
	})),
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
