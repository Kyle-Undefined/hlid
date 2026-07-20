import { z } from "zod";
import { loadConfig } from "./config";
import {
	MAX_OBSIDIAN_AGENT_OUTPUT_CHARS,
	queryObsidianBase,
	queryObsidianHistory,
	queryObsidianLinks,
	queryObsidianProperties,
	queryObsidianTasks,
} from "./obsidianCli";

export const OBSIDIAN_AGENT_NAMESPACE = "hlid_obsidian";

const vaultPath = z.string().trim().min(1).max(4_096);
const resultLimit = z.number().int().min(1).max(200).optional();
const countOnly = z.boolean().optional();

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
		name: "links",
		description:
			"Read Obsidian's link graph for the configured vault. Supports backlinks, outgoing links, unresolved links, orphan notes, and dead-end notes. Returns a bounded JSON envelope with total, returned, and truncated metadata.",
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
];

type BudgetOptions = {
	limit?: number;
	countOnly?: boolean;
	expectedJson: boolean;
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
		const nativeTotal = Number(output.trim());
		return JSON.stringify({
			sourceFormat: "text",
			total:
				Number.isInteger(nativeTotal) && nativeTotal >= 0 ? nativeTotal : total,
			returned: 0,
			truncated: false,
			countOnly: true,
		} satisfies ResultEnvelope);
	}
	const selected = lines.slice(0, options.limit ?? 50);
	const envelope: ResultEnvelope = {
		sourceFormat: "text",
		total,
		returned: selected.length,
		truncated: selected.length < total,
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
	if (options.countOnly && /^\d+$/.test(trimmed)) {
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
		case "links": {
			const parsed = obsidianAgentSchemas.links.parse(input);
			return budgetObsidianAgentOutput(
				await queryObsidianLinks(vaultName, parsed),
				{
					...parsed,
					expectedJson:
						!parsed.countOnly &&
						(parsed.kind === "backlinks" || parsed.kind === "unresolved"),
				},
			);
		}
		case "tasks": {
			const parsed = obsidianAgentSchemas.tasks.parse(input);
			return budgetObsidianAgentOutput(
				await queryObsidianTasks(vaultName, parsed),
				{ ...parsed, expectedJson: !parsed.countOnly },
			);
		}
		case "properties": {
			const parsed = obsidianAgentSchemas.properties.parse(input);
			return budgetObsidianAgentOutput(
				await queryObsidianProperties(vaultName, parsed),
				{ ...parsed, expectedJson: !parsed.countOnly },
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
		default:
			throw new Error(`Unknown Hlid Obsidian tool: ${name}`);
	}
}
