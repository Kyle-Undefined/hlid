import { z } from "zod";
import { configuredObsidianCapture } from "#/lib/obsidianCapture";
import { parseObsidianTemplateNames } from "#/lib/obsidianTemplates";
import { loadConfig } from "./config";
import { captureObsidianNote } from "./obsidianCaptureNote";
import {
	createObsidianBaseItem,
	createObsidianNote,
	executeObsidianCommand,
	listObsidianCommands,
	listObsidianTemplates,
	MAX_OBSIDIAN_AGENT_OUTPUT_CHARS,
	MAX_OBSIDIAN_APPEND_CHARS,
	MAX_OBSIDIAN_CREATE_CHARS,
	moveObsidianFile,
	mutateObsidianNote,
	openObsidianDailyNote,
	queryObsidianBase,
	queryObsidianCurrentNote,
	queryObsidianHistory,
	queryObsidianLinks,
	queryObsidianProperties,
	queryObsidianSearch,
	queryObsidianTasks,
	queryObsidianVaultInfo,
	readObsidianDailyNote,
	readObsidianNote,
	readObsidianTemplate,
	removeObsidianProperty,
	renameObsidianFile,
	setObsidianProperty,
	updateObsidianTask,
} from "./obsidianCli";

export const OBSIDIAN_AGENT_NAMESPACE = "hlid_obsidian";
export const OBSIDIAN_AGENT_NAMESPACE_DESCRIPTION =
	"First-class Obsidian access to Hlid's configured vault from every provider, working directory, Windows host, or WSL agent. Use these tools instead of shell or filesystem operations whenever they support a vault task. Reads use Obsidian's index and vault semantics. Writes use curated note operations and follow the active agent permission policy. Hlid @ references select exact notes only; never expand their links, backlinks, embeds, or related notes unless the user asks.";

const vaultPath = z.string().trim().min(1).max(4_096);
const DEFAULT_RESULT_LIMIT = 50;
const resultLimit = z.number().int().min(1).max(200).optional();
const countOnly = z.boolean().optional();

export const obsidianAgentSchemas = {
	vault_info: z.object({}),
	search: z.object({
		query: z.string().trim().min(1).max(4_096),
		path: vaultPath.optional(),
		caseSensitive: z.boolean().optional(),
		context: z.boolean().optional(),
		includeGraph: z.boolean().optional(),
		limit: resultLimit,
		countOnly,
	}),
	read_note: z.object({
		path: vaultPath,
		startLine: z.number().int().min(1).max(1_000_000).optional(),
		limit: resultLimit,
		countOnly,
	}),
	current_note: z.object({
		action: z.enum(["read", "outline", "info"]),
		limit: resultLimit,
		countOnly,
	}),
	daily_note: z.object({
		limit: resultLimit,
		countOnly,
	}),
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
		limit: resultLimit,
		countOnly,
	}),
	tasks: z.object({
		path: vaultPath.optional(),
		state: z.enum(["all", "todo", "done"]).optional(),
		status: z.string().min(1).max(1).optional(),
		source: z.enum(["vault", "active", "daily"]).optional(),
		limit: resultLimit,
		countOnly,
	}),
	properties: z.object({
		path: vaultPath.optional(),
		name: z.string().trim().min(1).max(256).optional(),
		active: z.boolean().optional(),
		limit: resultLimit,
		countOnly,
	}),
	base_query: z.object({
		path: vaultPath,
		view: z.string().trim().min(1).max(256).optional(),
		limit: resultLimit,
		countOnly,
	}),
	history: z.object({
		action: z.enum(["versions", "files", "read", "diff"]),
		path: vaultPath.optional(),
		version: z.number().int().positive().max(100_000).optional(),
		from: z.number().int().positive().max(100_000).optional(),
		to: z.number().int().positive().max(100_000).optional(),
		filter: z.enum(["all", "local", "sync"]).optional(),
		limit: resultLimit,
		countOnly,
	}),
	list_templates: z.object({
		limit: resultLimit,
		countOnly,
	}),
	list_commands: z.object({
		query: z.string().trim().min(1).max(512).optional(),
		limit: resultLimit,
		countOnly,
	}),
	read_template: z.object({
		name: z.string().trim().min(1).max(256),
		resolve: z.boolean().optional(),
		title: z.string().trim().min(1).max(512).optional(),
		limit: resultLimit,
	}),
	create_note: z.object({
		path: vaultPath,
		template: z.string().trim().min(1).max(256).optional(),
		content: z.string().max(MAX_OBSIDIAN_CREATE_CHARS).optional(),
		open: z.boolean().optional(),
	}),
	capture_note: z.object({
		content: z.string().min(1).max(MAX_OBSIDIAN_CREATE_CHARS),
		open: z.boolean().optional(),
	}),
	open_daily_note: z.object({}),
	base_create: z.object({
		path: vaultPath,
		view: z.string().trim().min(1).max(256).optional(),
		name: z.string().trim().min(1).max(255),
		content: z.string().max(MAX_OBSIDIAN_CREATE_CHARS).optional(),
		open: z.boolean().optional(),
	}),
	append_note: z.object({
		target: z.enum(["active", "daily", "path"]),
		path: vaultPath.optional(),
		content: z.string().min(1).max(MAX_OBSIDIAN_APPEND_CHARS),
		open: z.boolean().optional(),
	}),
	prepend_note: z.object({
		target: z.enum(["active", "daily", "path"]),
		path: vaultPath.optional(),
		content: z.string().min(1).max(MAX_OBSIDIAN_APPEND_CHARS),
		open: z.boolean().optional(),
	}),
	task_update: z.object({
		path: vaultPath,
		line: z.number().int().min(1).max(1_000_000),
		action: z.enum(["toggle", "done", "todo", "status"]),
		status: z.string().min(1).max(1).optional(),
	}),
	property_set: z.object({
		path: vaultPath,
		name: z.string().trim().min(1).max(256),
		type: z.enum(["text", "list", "number", "checkbox", "date", "datetime"]),
		value: z.union([
			z.string(),
			z.number(),
			z.boolean(),
			z.array(z.string()).max(100),
		]),
	}),
	property_remove: z.object({
		path: vaultPath,
		name: z.string().trim().min(1).max(256),
	}),
	move_file: z.object({
		path: vaultPath,
		to: vaultPath,
	}),
	rename_file: z.object({
		path: vaultPath,
		name: z.string().trim().min(1).max(255),
	}),
	run_command: z.object({
		id: z.string().trim().min(1).max(512),
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
	readOnly: boolean;
};

const budgetSchemaProperties: Record<string, JsonValue> = {
	limit: {
		type: "integer",
		minimum: 1,
		maximum: 200,
		description:
			"Maximum results or text lines to return. Defaults to 50. Use a smaller value for broad vault queries.",
	},
	countOnly: {
		type: "boolean",
		description:
			"Return only the matching total. Obsidian uses its native total query when available.",
	},
};

export const OBSIDIAN_AGENT_TOOL_SPECS: ObsidianAgentToolSpec[] = [
	{
		name: "vault_info",
		description:
			"Confirm the configured Obsidian vault connection and return its name, Obsidian version, active note when available, Hlid's native vault capabilities, and remembered command approvals. The agent never needs the vault's absolute Windows or WSL filesystem path.",
		readOnly: true,
		inputSchema: {
			type: "object",
			properties: {},
			additionalProperties: false,
		},
	},
	{
		name: "search",
		description:
			"Search the configured Obsidian vault by indexed content and matching Markdown paths. Use this instead of shell or filesystem search for vault queries. When the user explicitly asks for related notes, connections, or graph-aware results, set includeGraph to combine direct content and filename matches with their backlinks and outgoing links in one ranked result. A direct result reports graphUnavailable when part of its graph could not be read, while the remaining results still return. Leave includeGraph off for ordinary searches and exact Hlid @ references. Can otherwise return matching content lines with context or only the indexed-content count. Returns a bounded JSON envelope.",
		readOnly: true,
		inputSchema: {
			type: "object",
			properties: {
				query: {
					type: "string",
					description: "Obsidian search query.",
				},
				path: {
					type: "string",
					description: "Optional vault-relative folder to search within.",
				},
				caseSensitive: {
					type: "boolean",
					description: "Match letter case exactly.",
				},
				context: {
					type: "boolean",
					description:
						"Include matching line numbers and text instead of returning only note paths.",
				},
				includeGraph: {
					type: "boolean",
					description:
						"Include one-hop backlinks and outgoing links around direct content and filename matches. Use only when the user asks for related or connected notes; cannot be combined with context or countOnly.",
				},
				...budgetSchemaProperties,
			},
			required: ["query"],
			additionalProperties: false,
		},
	},
	{
		name: "read_note",
		description:
			"Read one exact vault-relative note through Obsidian. This never searches for related notes or expands links, backlinks, embeds, or attachments. Use the path returned by search or supplied by an exact Hlid @ reference.",
		readOnly: true,
		inputSchema: {
			type: "object",
			properties: {
				path: {
					type: "string",
					description: "Exact vault-relative note path.",
				},
				startLine: {
					type: "integer",
					minimum: 1,
					maximum: 1_000_000,
					description: "First one-based line to return. Defaults to 1.",
				},
				...budgetSchemaProperties,
			},
			required: ["path"],
			additionalProperties: false,
		},
	},
	{
		name: "current_note",
		description:
			"Inspect the note currently active in Obsidian. Read its content, return its heading outline, or show file metadata. Returns a bounded JSON envelope.",
		readOnly: true,
		inputSchema: {
			type: "object",
			properties: {
				action: {
					type: "string",
					enum: ["read", "outline", "info"],
				},
				...budgetSchemaProperties,
			},
			required: ["action"],
			additionalProperties: false,
		},
	},
	{
		name: "daily_note",
		description:
			"Read today's daily note through Obsidian and return its exact vault-relative path with bounded content. Use this instead of guessing the daily-note folder or filename.",
		readOnly: true,
		inputSchema: {
			type: "object",
			properties: { ...budgetSchemaProperties },
			additionalProperties: false,
		},
	},
	{
		name: "links",
		description:
			"Read Obsidian's link graph for the configured vault. Supports backlinks, outgoing links, unresolved links, orphan notes, and dead-end notes. Returns a bounded JSON envelope with total, returned, and truncated metadata.",
		readOnly: true,
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
				...budgetSchemaProperties,
			},
			required: ["kind"],
			additionalProperties: false,
		},
	},
	{
		name: "tasks",
		description:
			"Read tasks known to Obsidian, including task status, source note, and line information. Returns a bounded JSON envelope with total, returned, and truncated metadata.",
		readOnly: true,
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
				...budgetSchemaProperties,
			},
			additionalProperties: false,
		},
	},
	{
		name: "properties",
		description:
			"Read Obsidian properties from one note, the active note, or the configured vault. Returns a bounded JSON envelope with total, returned, and truncated metadata.",
		readOnly: true,
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
				...budgetSchemaProperties,
			},
			additionalProperties: false,
		},
	},
	{
		name: "base_query",
		description:
			"Run a read-only Obsidian Bases query. Returns a bounded JSON envelope with total, returned, and truncated metadata.",
		readOnly: true,
		inputSchema: {
			type: "object",
			properties: {
				path: {
					type: "string",
					description: "Exact vault-relative path to a .base file.",
				},
				view: { type: "string", description: "Optional Base view name." },
				...budgetSchemaProperties,
			},
			required: ["path"],
			additionalProperties: false,
		},
	},
	{
		name: "history",
		description:
			"Read Obsidian local file history or compare historical versions. Returns a bounded JSON envelope and cannot restore or modify a note.",
		readOnly: true,
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
				...budgetSchemaProperties,
			},
			required: ["action"],
			additionalProperties: false,
		},
	},
	{
		name: "list_templates",
		description:
			"List templates available to Obsidian in the configured vault. Use this before choosing a template for note creation. Returns a bounded JSON envelope.",
		readOnly: true,
		inputSchema: {
			type: "object",
			properties: { ...budgetSchemaProperties },
			additionalProperties: false,
		},
	},
	{
		name: "list_commands",
		description:
			"Discover Obsidian core and plugin command IDs available in the configured vault. Use query to search the live inventory before run_command. This is read-only and returns a bounded JSON envelope.",
		readOnly: true,
		inputSchema: {
			type: "object",
			properties: {
				query: {
					type: "string",
					description:
						"Optional case-insensitive text to match against command IDs.",
				},
				...budgetSchemaProperties,
			},
			additionalProperties: false,
		},
	},
	{
		name: "read_template",
		description:
			"Read an Obsidian template before using it. Core template variables can be resolved for a prospective title; Templater syntax is returned as source. Returns a bounded JSON envelope.",
		readOnly: true,
		inputSchema: {
			type: "object",
			properties: {
				name: { type: "string", description: "Exact template name." },
				resolve: {
					type: "boolean",
					description:
						"Resolve core Templates variables such as date, time, and title.",
				},
				title: {
					type: "string",
					description:
						"Prospective note title used for core variable resolution.",
				},
				limit: budgetSchemaProperties.limit,
			},
			required: ["name"],
			additionalProperties: false,
		},
	},
	{
		name: "create_note",
		description:
			"Create a Markdown note through Obsidian, optionally using a named core Templates or Templater template. Templater routing runs inside Obsidian and the result reports the final path. Interactive Templater prompts are rejected. Existing notes are never overwritten.",
		readOnly: false,
		inputSchema: {
			type: "object",
			properties: {
				path: {
					type: "string",
					description:
						"Requested vault-relative .md path. A Templater template may route the finished note elsewhere.",
				},
				template: {
					type: "string",
					description: "Exact template name returned by list_templates.",
				},
				content: {
					type: "string",
					description: "Optional content appended after the template runs.",
				},
				open: {
					type: "boolean",
					description: "Open the finished note in Obsidian.",
				},
			},
			required: ["path"],
			additionalProperties: false,
		},
	},
	{
		name: "capture_note",
		description:
			"Create a Markdown note in this workspace's configured Obsidian Inbox or Raw folder. Hlid chooses the configured destination, workspace template, and collision-safe timestamped filename; the agent supplies only the content and whether to open it.",
		readOnly: false,
		inputSchema: {
			type: "object",
			properties: {
				content: { type: "string" },
				open: {
					type: "boolean",
					description: "Open the captured note in Obsidian.",
				},
			},
			required: ["content"],
			additionalProperties: false,
		},
	},
	{
		name: "open_daily_note",
		description:
			"Create today's daily note if needed and open it in Obsidian. Obsidian applies the vault's Daily notes folder, format, and template settings.",
		readOnly: false,
		inputSchema: {
			type: "object",
			properties: {},
			additionalProperties: false,
		},
	},
	{
		name: "base_create",
		description:
			"Create a new note through an exact Obsidian Base and optional view. Obsidian applies the Base's configured item location and properties. This does not edit the Base schema or views.",
		readOnly: false,
		inputSchema: {
			type: "object",
			properties: {
				path: {
					type: "string",
					description: "Exact vault-relative path to a .base file.",
				},
				view: { type: "string", description: "Optional Base view name." },
				name: {
					type: "string",
					description: "Filename for the new Base item.",
				},
				content: { type: "string", description: "Optional initial content." },
				open: {
					type: "boolean",
					description: "Open the created item in Obsidian.",
				},
			},
			required: ["path", "name"],
			additionalProperties: false,
		},
	},
	...(["append_note", "prepend_note"] as const).map(
		(name): ObsidianAgentToolSpec => ({
			name,
			description: `${name === "append_note" ? "Append" : "Prepend"} content through Obsidian to the active note, daily note, or an exact vault-relative note path. The result reports the updated path.`,
			readOnly: false,
			inputSchema: {
				type: "object",
				properties: {
					target: {
						type: "string",
						enum: ["active", "daily", "path"],
					},
					path: {
						type: "string",
						description: "Required when target is path.",
					},
					content: { type: "string" },
					open: {
						type: "boolean",
						description: "Open the updated note in Obsidian.",
					},
				},
				required: ["target", "content"],
				additionalProperties: false,
			},
		}),
	),
	{
		name: "task_update",
		description:
			"Update one exact Obsidian task by vault-relative note path and one-based line number returned by tasks. Toggle it, mark it done or todo, or set one custom status character.",
		readOnly: false,
		inputSchema: {
			type: "object",
			properties: {
				path: { type: "string", description: "Exact task note path." },
				line: {
					type: "integer",
					minimum: 1,
					maximum: 1_000_000,
					description: "One-based task line number returned by tasks.",
				},
				action: {
					type: "string",
					enum: ["toggle", "done", "todo", "status"],
				},
				status: {
					type: "string",
					minLength: 1,
					maxLength: 1,
					description: "Required only when action is status.",
				},
			},
			required: ["path", "line", "action"],
			additionalProperties: false,
		},
	},
	{
		name: "property_set",
		description:
			"Set one typed Obsidian property on an exact note. Use a string for text, date, or datetime; an array of strings for list; a number for number; and a boolean for checkbox.",
		readOnly: false,
		inputSchema: {
			type: "object",
			properties: {
				path: { type: "string", description: "Exact note path." },
				name: { type: "string", description: "Exact property name." },
				type: {
					type: "string",
					enum: ["text", "list", "number", "checkbox", "date", "datetime"],
				},
				value: {
					oneOf: [
						{ type: "string" },
						{ type: "number" },
						{ type: "boolean" },
						{ type: "array", items: { type: "string" }, maxItems: 100 },
					],
				},
			},
			required: ["path", "name", "type", "value"],
			additionalProperties: false,
		},
	},
	{
		name: "property_remove",
		description: "Remove one exact Obsidian property from an exact note.",
		readOnly: false,
		inputSchema: {
			type: "object",
			properties: {
				path: { type: "string", description: "Exact note path." },
				name: { type: "string", description: "Exact property name." },
			},
			required: ["path", "name"],
			additionalProperties: false,
		},
	},
	{
		name: "move_file",
		description:
			"Move one exact vault file through Obsidian so Obsidian can update links. The destination must be the exact desired vault-relative path.",
		readOnly: false,
		inputSchema: {
			type: "object",
			properties: {
				path: { type: "string", description: "Current exact vault path." },
				to: { type: "string", description: "New exact vault path." },
			},
			required: ["path", "to"],
			additionalProperties: false,
		},
	},
	{
		name: "rename_file",
		description:
			"Rename one exact vault file through Obsidian so Obsidian can update links. The name is a filename only, not a path.",
		readOnly: false,
		inputSchema: {
			type: "object",
			properties: {
				path: { type: "string", description: "Current exact vault path." },
				name: { type: "string", description: "New filename." },
			},
			required: ["path", "name"],
			additionalProperties: false,
		},
	},
	{
		name: "run_command",
		description:
			"Run one exact command ID returned by list_commands. This is a mutation and follows the active Hlid approval policy. Commands remembered with Always are trusted only for this configured vault.",
		readOnly: false,
		inputSchema: {
			type: "object",
			properties: {
				id: {
					type: "string",
					description: "Exact command ID returned by list_commands.",
				},
			},
			required: ["id"],
			additionalProperties: false,
		},
	},
];

export function isObsidianAgentToolReadOnly(name: string): boolean {
	return (
		OBSIDIAN_AGENT_TOOL_SPECS.find((spec) => spec.name === name)?.readOnly ??
		true
	);
}

type BudgetOptions = {
	limit?: number;
	startLine?: number;
	countOnly?: boolean;
	expectedJson: boolean;
	nativeCountOnly?: boolean;
};

type ResultEnvelope = {
	sourceFormat: "json" | "text";
	total: number;
	returned: number;
	truncated: boolean;
	countOnly: boolean;
	data?: unknown;
	notice?: string;
};

function serializeEnvelope(
	envelope: ResultEnvelope,
	removeOne: () => boolean,
): string {
	let serialized = JSON.stringify(envelope);
	while (serialized.length > MAX_OBSIDIAN_AGENT_OUTPUT_CHARS && removeOne()) {
		envelope.returned--;
		envelope.truncated = true;
		envelope.notice =
			"One or more Obsidian results exceeded Hlid's output budget. Narrow the query by path, status, view, or version.";
		serialized = JSON.stringify(envelope);
	}
	if (serialized.length <= MAX_OBSIDIAN_AGENT_OUTPUT_CHARS) return serialized;
	return JSON.stringify({
		sourceFormat: envelope.sourceFormat,
		total: envelope.total,
		returned: 0,
		truncated: envelope.total > 0,
		countOnly: envelope.countOnly,
		data: envelope.sourceFormat === "json" ? [] : [],
		notice:
			"The first Obsidian result exceeded Hlid's output budget. Narrow the query by path, status, view, or version.",
	});
}

function collectionEnvelope(data: unknown[], options: BudgetOptions): string {
	const total = data.length;
	if (options.countOnly) {
		return JSON.stringify({
			sourceFormat: "json",
			total,
			returned: 0,
			truncated: false,
			countOnly: true,
		} satisfies ResultEnvelope);
	}
	const selected = data.slice(0, options.limit ?? DEFAULT_RESULT_LIMIT);
	const envelope: ResultEnvelope = {
		sourceFormat: "json",
		total,
		returned: selected.length,
		truncated: selected.length < total,
		countOnly: false,
		data: selected,
	};
	return serializeEnvelope(envelope, () => selected.pop() !== undefined);
}

function objectEnvelope(
	data: Record<string, unknown>,
	options: BudgetOptions,
): string {
	const entries = Object.entries(data);
	const total = entries.length;
	if (options.countOnly) {
		return JSON.stringify({
			sourceFormat: "json",
			total,
			returned: 0,
			truncated: false,
			countOnly: true,
		} satisfies ResultEnvelope);
	}
	const selected = entries.slice(0, options.limit ?? DEFAULT_RESULT_LIMIT);
	const selectedObject = Object.fromEntries(selected);
	const envelope: ResultEnvelope = {
		sourceFormat: "json",
		total,
		returned: selected.length,
		truncated: selected.length < total,
		countOnly: false,
		data: selectedObject,
	};
	return serializeEnvelope(envelope, () => {
		const removed = selected.pop();
		if (!removed) return false;
		delete selectedObject[removed[0]];
		return true;
	});
}

function textEnvelope(output: string, options: BudgetOptions): string {
	const lines = output ? output.split(/\r?\n/) : [];
	const total = lines.length;
	if (options.countOnly) {
		const nativeTotal = options.nativeCountOnly
			? Number(output.trim())
			: Number.NaN;
		return JSON.stringify({
			sourceFormat: "text",
			total:
				Number.isInteger(nativeTotal) && nativeTotal >= 0 ? nativeTotal : total,
			returned: 0,
			truncated: false,
			countOnly: true,
		} satisfies ResultEnvelope);
	}
	const offset = Math.min(Math.max((options.startLine ?? 1) - 1, 0), total);
	const selected = lines.slice(
		offset,
		offset + (options.limit ?? DEFAULT_RESULT_LIMIT),
	);
	const envelope: ResultEnvelope = {
		sourceFormat: "text",
		total,
		returned: selected.length,
		truncated: offset > 0 || offset + selected.length < total,
		countOnly: false,
		data: selected,
	};
	return serializeEnvelope(envelope, () => selected.pop() !== undefined);
}

function budgetObsidianAgentOutput(
	output: string,
	options: BudgetOptions,
): string {
	const trimmed = output.trim();
	if (!trimmed) return textEnvelope("", options);
	if (options.countOnly && options.nativeCountOnly && /^\d+$/.test(trimmed)) {
		return textEnvelope(trimmed, options);
	}
	try {
		const parsed: unknown = JSON.parse(trimmed);
		if (Array.isArray(parsed)) return collectionEnvelope(parsed, options);
		if (parsed && typeof parsed === "object") {
			return objectEnvelope(parsed as Record<string, unknown>, options);
		}
		return collectionEnvelope([parsed], options);
	} catch {
		if (options.expectedJson) {
			throw new Error(
				"Obsidian returned incomplete structured output. Narrow the query by path, status, view, or version.",
			);
		}
		return textEnvelope(trimmed, options);
	}
}

export async function executeObsidianAgentTool(
	name: string,
	input: unknown,
): Promise<string> {
	const config = loadConfig();
	const vaultName = config.vault.name;
	switch (name as ObsidianAgentToolName) {
		case "vault_info": {
			obsidianAgentSchemas.vault_info.parse(input);
			const capture = configuredObsidianCapture(config.vault);
			return JSON.stringify({
				...(await queryObsidianVaultInfo(vaultName)),
				capabilities: OBSIDIAN_AGENT_TOOL_SPECS.map((tool) => tool.name),
				rememberedCommands: config.vault.obsidian_command_allowlist ?? [],
				commandDiscovery: "list_commands",
				capture: capture
					? {
							label: capture.label,
							folder: capture.folder,
							template: capture.template,
						}
					: null,
			});
		}
		case "links": {
			const parsed = obsidianAgentSchemas.links.parse(input);
			return budgetObsidianAgentOutput(
				await queryObsidianLinks(vaultName, parsed),
				{
					...parsed,
					nativeCountOnly: parsed.countOnly,
					expectedJson:
						!parsed.countOnly &&
						(parsed.kind === "backlinks" || parsed.kind === "unresolved"),
				},
			);
		}
		case "search": {
			const parsed = obsidianAgentSchemas.search.parse(input);
			return budgetObsidianAgentOutput(
				await queryObsidianSearch(vaultName, parsed),
				{
					...parsed,
					nativeCountOnly: parsed.countOnly,
					expectedJson: !parsed.context && !parsed.countOnly,
				},
			);
		}
		case "read_note": {
			const parsed = obsidianAgentSchemas.read_note.parse(input);
			return budgetObsidianAgentOutput(
				await readObsidianNote(vaultName, parsed.path),
				{ ...parsed, expectedJson: false },
			);
		}
		case "current_note": {
			const parsed = obsidianAgentSchemas.current_note.parse(input);
			return budgetObsidianAgentOutput(
				await queryObsidianCurrentNote(vaultName, parsed),
				{
					...parsed,
					nativeCountOnly: parsed.countOnly && parsed.action === "outline",
					expectedJson: parsed.action === "outline" && !parsed.countOnly,
				},
			);
		}
		case "daily_note": {
			const parsed = obsidianAgentSchemas.daily_note.parse(input);
			const daily = await readObsidianDailyNote(vaultName);
			const bounded = JSON.parse(
				budgetObsidianAgentOutput(daily.content, {
					...parsed,
					expectedJson: false,
				}),
			) as Record<string, unknown>;
			return JSON.stringify({ ...bounded, path: daily.path });
		}
		case "tasks": {
			const parsed = obsidianAgentSchemas.tasks.parse(input);
			return budgetObsidianAgentOutput(
				await queryObsidianTasks(vaultName, parsed),
				{
					...parsed,
					expectedJson: !parsed.countOnly,
					nativeCountOnly: parsed.countOnly,
				},
			);
		}
		case "properties": {
			const parsed = obsidianAgentSchemas.properties.parse(input);
			return budgetObsidianAgentOutput(
				await queryObsidianProperties(vaultName, parsed),
				{
					...parsed,
					expectedJson: !parsed.countOnly,
					nativeCountOnly: parsed.countOnly,
				},
			);
		}
		case "base_query": {
			const parsed = obsidianAgentSchemas.base_query.parse(input);
			return budgetObsidianAgentOutput(
				await queryObsidianBase(vaultName, parsed.path, parsed.view),
				{ ...parsed, expectedJson: true },
			);
		}
		case "history": {
			const parsed = obsidianAgentSchemas.history.parse(input);
			return budgetObsidianAgentOutput(
				await queryObsidianHistory(vaultName, parsed),
				{ ...parsed, expectedJson: false },
			);
		}
		case "list_templates": {
			const parsed = obsidianAgentSchemas.list_templates.parse(input);
			return budgetObsidianAgentOutput(
				await listObsidianTemplates(vaultName, parsed.countOnly === true),
				{
					...parsed,
					expectedJson: false,
					nativeCountOnly: parsed.countOnly,
				},
			);
		}
		case "list_commands": {
			const parsed = obsidianAgentSchemas.list_commands.parse(input);
			const commands = parseObsidianTemplateNames(
				await listObsidianCommands(vaultName),
			);
			const query = parsed.query?.toLocaleLowerCase();
			const matching = query
				? commands.filter((command) =>
						command.toLocaleLowerCase().includes(query),
					)
				: commands;
			return collectionEnvelope(matching, {
				limit: parsed.limit,
				countOnly: parsed.countOnly,
				expectedJson: false,
			});
		}
		case "read_template": {
			const parsed = obsidianAgentSchemas.read_template.parse(input);
			return budgetObsidianAgentOutput(
				await readObsidianTemplate(vaultName, parsed),
				{ limit: parsed.limit, expectedJson: false },
			);
		}
		case "create_note": {
			const parsed = obsidianAgentSchemas.create_note.parse(input);
			return JSON.stringify(await createObsidianNote(vaultName, parsed));
		}
		case "capture_note": {
			const parsed = obsidianAgentSchemas.capture_note.parse(input);
			return JSON.stringify(await captureObsidianNote(config.vault, parsed));
		}
		case "open_daily_note": {
			obsidianAgentSchemas.open_daily_note.parse(input);
			return JSON.stringify(await openObsidianDailyNote(vaultName));
		}
		case "base_create": {
			const parsed = obsidianAgentSchemas.base_create.parse(input);
			return JSON.stringify(await createObsidianBaseItem(vaultName, parsed));
		}
		case "append_note": {
			const parsed = obsidianAgentSchemas.append_note.parse(input);
			return JSON.stringify(
				await mutateObsidianNote(vaultName, "append", parsed),
			);
		}
		case "prepend_note": {
			const parsed = obsidianAgentSchemas.prepend_note.parse(input);
			return JSON.stringify(
				await mutateObsidianNote(vaultName, "prepend", parsed),
			);
		}
		case "task_update": {
			const parsed = obsidianAgentSchemas.task_update.parse(input);
			return JSON.stringify(await updateObsidianTask(vaultName, parsed));
		}
		case "property_set": {
			const parsed = obsidianAgentSchemas.property_set.parse(input);
			return JSON.stringify(await setObsidianProperty(vaultName, parsed));
		}
		case "property_remove": {
			const parsed = obsidianAgentSchemas.property_remove.parse(input);
			return JSON.stringify(await removeObsidianProperty(vaultName, parsed));
		}
		case "move_file": {
			const parsed = obsidianAgentSchemas.move_file.parse(input);
			return JSON.stringify(await moveObsidianFile(vaultName, parsed));
		}
		case "rename_file": {
			const parsed = obsidianAgentSchemas.rename_file.parse(input);
			return JSON.stringify(await renameObsidianFile(vaultName, parsed));
		}
		case "run_command": {
			const parsed = obsidianAgentSchemas.run_command.parse(input);
			await executeObsidianCommand(vaultName, parsed.id);
			return JSON.stringify({ ok: true, id: parsed.id });
		}
		default:
			throw new Error(`Unknown Hlid Obsidian tool: ${name}`);
	}
}
