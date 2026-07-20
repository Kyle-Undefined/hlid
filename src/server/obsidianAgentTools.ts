import { z } from "zod";
import { loadConfig } from "./config";
import {
	queryObsidianBase,
	queryObsidianHistory,
	queryObsidianLinks,
	queryObsidianProperties,
	queryObsidianTasks,
} from "./obsidianCli";

export const OBSIDIAN_AGENT_NAMESPACE = "hlid_obsidian";

const vaultPath = z.string().trim().min(1).max(4_096);

export const obsidianAgentSchemas = {
	links: z.object({
		kind: z.enum([
			"backlinks",
			"outgoing",
			"unresolved",
			"orphans",
			"deadends",
		]),
		path: vaultPath.optional(),
		counts: z.boolean().optional(),
	}),
	tasks: z.object({
		path: vaultPath.optional(),
		state: z.enum(["all", "todo", "done"]).optional(),
		status: z.string().min(1).max(1).optional(),
		source: z.enum(["vault", "active", "daily"]).optional(),
	}),
	properties: z.object({
		path: vaultPath.optional(),
		name: z.string().trim().min(1).max(256).optional(),
		active: z.boolean().optional(),
	}),
	base_query: z.object({
		path: vaultPath,
		view: z.string().trim().min(1).max(256).optional(),
	}),
	history: z.object({
		action: z.enum(["versions", "files", "read", "diff"]),
		path: vaultPath.optional(),
		version: z.number().int().positive().max(100_000).optional(),
		from: z.number().int().positive().max(100_000).optional(),
		to: z.number().int().positive().max(100_000).optional(),
		filter: z.enum(["all", "local", "sync"]).optional(),
	}),
} as const;

export type ObsidianAgentToolName = keyof typeof obsidianAgentSchemas;

type JsonValue =
	| null
	| boolean
	| number
	| string
	| JsonValue[]
	| { [key: string]: JsonValue };

type JsonSchema = {
	type: "object";
	properties: Record<string, JsonValue>;
	required?: string[];
	additionalProperties: false;
};

export type ObsidianAgentToolSpec = {
	name: ObsidianAgentToolName;
	description: string;
	inputSchema: JsonSchema;
};

export const OBSIDIAN_AGENT_TOOL_SPECS: ObsidianAgentToolSpec[] = [
	{
		name: "links",
		description:
			"Read Obsidian's link graph for the configured vault. Supports backlinks, outgoing links, unresolved links, orphan notes, and dead-end notes.",
		inputSchema: {
			type: "object",
			properties: {
				kind: {
					type: "string",
					enum: ["backlinks", "outgoing", "unresolved", "orphans", "deadends"],
				},
				path: {
					type: "string",
					description:
						"Exact vault-relative note path. Used by backlinks and outgoing links; omit to use Obsidian's active note.",
				},
				counts: {
					type: "boolean",
					description: "Include link counts when the query supports them.",
				},
			},
			required: ["kind"],
			additionalProperties: false,
		},
	},
	{
		name: "tasks",
		description:
			"Read tasks known to Obsidian, including task status, source note, and line information.",
		inputSchema: {
			type: "object",
			properties: {
				path: {
					type: "string",
					description: "Exact vault-relative note path.",
				},
				state: { type: "string", enum: ["all", "todo", "done"] },
				status: {
					type: "string",
					minLength: 1,
					maxLength: 1,
					description: "Optional custom task status character.",
				},
				source: { type: "string", enum: ["vault", "active", "daily"] },
			},
			additionalProperties: false,
		},
	},
	{
		name: "properties",
		description:
			"Read Obsidian properties from one note, the active note, or the configured vault.",
		inputSchema: {
			type: "object",
			properties: {
				path: {
					type: "string",
					description: "Exact vault-relative note path.",
				},
				name: { type: "string", description: "Optional property name." },
				active: {
					type: "boolean",
					description: "Read properties from Obsidian's active note.",
				},
			},
			additionalProperties: false,
		},
	},
	{
		name: "base_query",
		description:
			"Run a read-only Obsidian Bases query and return the selected view as JSON.",
		inputSchema: {
			type: "object",
			properties: {
				path: {
					type: "string",
					description: "Exact vault-relative path to a .base file.",
				},
				view: { type: "string", description: "Optional Base view name." },
			},
			required: ["path"],
			additionalProperties: false,
		},
	},
	{
		name: "history",
		description:
			"Read Obsidian local file history or compare historical versions. This tool cannot restore or modify a note.",
		inputSchema: {
			type: "object",
			properties: {
				action: {
					type: "string",
					enum: ["versions", "files", "read", "diff"],
				},
				path: {
					type: "string",
					description: "Exact vault-relative note path.",
				},
				version: { type: "integer", minimum: 1 },
				from: { type: "integer", minimum: 1 },
				to: { type: "integer", minimum: 1 },
				filter: { type: "string", enum: ["all", "local", "sync"] },
			},
			required: ["action"],
			additionalProperties: false,
		},
	},
];

function toolOutput(output: string): string {
	return output || "No matching Obsidian data was found.";
}

export async function executeObsidianAgentTool(
	name: string,
	input: unknown,
): Promise<string> {
	const vaultName = loadConfig().vault.name;
	switch (name as ObsidianAgentToolName) {
		case "links":
			return toolOutput(
				await queryObsidianLinks(
					vaultName,
					obsidianAgentSchemas.links.parse(input),
				),
			);
		case "tasks":
			return toolOutput(
				await queryObsidianTasks(
					vaultName,
					obsidianAgentSchemas.tasks.parse(input),
				),
			);
		case "properties":
			return toolOutput(
				await queryObsidianProperties(
					vaultName,
					obsidianAgentSchemas.properties.parse(input),
				),
			);
		case "base_query": {
			const parsed = obsidianAgentSchemas.base_query.parse(input);
			return toolOutput(
				await queryObsidianBase(vaultName, parsed.path, parsed.view),
			);
		}
		case "history":
			return toolOutput(
				await queryObsidianHistory(
					vaultName,
					obsidianAgentSchemas.history.parse(input),
				),
			);
		default:
			throw new Error(`Unknown Hlid Obsidian tool: ${name}`);
	}
}
