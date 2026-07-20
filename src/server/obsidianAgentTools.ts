import { z } from "zod";
import { loadConfig } from "./config";
import {
	createObsidianNote,
	listObsidianTemplates,
	MAX_OBSIDIAN_AGENT_OUTPUT_CHARS,
	MAX_OBSIDIAN_APPEND_CHARS,
	MAX_OBSIDIAN_CREATE_CHARS,
	mutateObsidianNote,
	queryObsidianBase,
	queryObsidianCurrentNote,
	queryObsidianHistory,
	queryObsidianLinks,
	queryObsidianProperties,
	queryObsidianSearch,
	queryObsidianTasks,
	queryObsidianVaultInfo,
	readObsidianNote,
	readObsidianTemplate,
} from "./obsidianCli";

export const OBSIDIAN_AGENT_NAMESPACE = "hlid_obsidian";
export const OBSIDIAN_AGENT_NAMESPACE_DESCRIPTION =
	"First-class Obsidian access to Hlid's configured vault from every provider, working directory, Windows host, or WSL agent. Use these tools instead of shell or filesystem operations whenever they support a vault task. Reads use Obsidian's index and vault semantics. Writes use curated note operations and follow the active agent permission policy. Hlid @ references select exact notes only; never expand their links, backlinks, embeds, or related notes unless the user asks.";

const vaultPath = z.string().trim().min(1).max(4_096);
const resultLimit = z.number().int().min(1).max(200).optional();
const countOnly = z.boolean().optional();

export const obsidianAgentSchemas = {
	vault_info: z.object({}),
	search: z.object({
		query: z.string().trim().min(1).max(4_096),
		path: vaultPath.optional(),
		caseSensitive: z.boolean().optional(),
		context: z.boolean().optional(),
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
			"Confirm the configured Obsidian vault connection and return its name, Obsidian version, active note when available, and Hlid's native vault capabilities. The agent never needs the vault's absolute Windows or WSL filesystem path.",
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
			"Search the configured Obsidian vault by indexed text. Use this instead of shell or filesystem search for vault queries. Can return matching note paths, matching lines with context, or only the matching file count. Returns a bounded JSON envelope.",
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
	const selected = data.slice(0, options.limit ?? 50);
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
	const selected = entries.slice(0, options.limit ?? 50);
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
	const selected = lines.slice(offset, offset + (options.limit ?? 50));
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
	const vaultName = loadConfig().vault.name;
	switch (name as ObsidianAgentToolName) {
		case "vault_info": {
			obsidianAgentSchemas.vault_info.parse(input);
			return JSON.stringify({
				...(await queryObsidianVaultInfo(vaultName)),
				capabilities: OBSIDIAN_AGENT_TOOL_SPECS.map((tool) => tool.name),
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
		default:
			throw new Error(`Unknown Hlid Obsidian tool: ${name}`);
	}
}
