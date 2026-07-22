import { z } from "zod";
import { dbFetch, requireDbOk } from "#/lib/dbClient";

export const HLID_AGENT_NAMESPACE = "hlid";
export const HLID_AGENT_NAMESPACE_DESCRIPTION =
	"Curated Hlid host capabilities. Use publish_relic when the user asks for a generated report, HTML document, PDF, image, or other deliverable they should be able to open later in Relics. Publishing is additive, uses the existing Relics viewer, and does not require plan mode.";
export const MAX_HLID_INLINE_RELIC_CHARS = 2_000_000;

export const hlidAgentSchemas = {
	publish_relic: z.object({
		source_path: z.string().trim().min(1).max(4_096).optional(),
		filename: z.string().trim().min(1).max(255).optional(),
		content: z.string().max(MAX_HLID_INLINE_RELIC_CHARS).optional(),
		mime: z.string().trim().min(1).max(255).optional(),
		category: z.enum(["report", "other"]).optional(),
	}),
} as const;

export type HlidAgentToolName = keyof typeof hlidAgentSchemas;

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
	additionalProperties: false;
};

export type HlidAgentToolSpec = {
	name: HlidAgentToolName;
	description: string;
	inputSchema: JsonSchema;
	readOnly: boolean;
	deferLoading: boolean;
};

export const HLID_AGENT_TOOL_SPECS: HlidAgentToolSpec[] = [
	{
		name: "publish_relic",
		description:
			"Publish an agent-generated deliverable into Hlid Relics without entering plan mode. Use source_path for an existing HTML, PDF, image, or other generated workspace file. For simple HTML or text, provide content and filename instead. Exactly one of source_path or content is required. The result includes an authenticated app-relative open_url that can be shown to the user. Do not use this for ordinary source files or HTML plan proposals.",
		readOnly: false,
		deferLoading: true,
		inputSchema: {
			type: "object",
			properties: {
				source_path: {
					type: "string",
					description:
						"Provider-visible absolute or workspace-relative path to a generated file. Hlid translates Windows and WSL paths and copies the file into managed Relics.",
				},
				filename: {
					type: "string",
					description:
						"Display filename. Required with content; optional override with source_path.",
				},
				content: {
					type: "string",
					description:
						"Direct UTF-8 content for a generated HTML or text Relic. Use source_path for binary files and large deliverables.",
				},
				mime: {
					type: "string",
					description:
						"Optional MIME type. Hlid normally infers this from the filename and validates known binary formats.",
				},
				category: {
					type: "string",
					enum: ["report", "other"],
					description: "Relics category. Defaults to report.",
				},
			},
			additionalProperties: false,
		},
	},
];

export type HlidAgentToolContext = {
	runtimeCwd?: string;
	sessionId?: string;
};

export async function executeHlidAgentTool(
	name: string,
	input: unknown,
	context: HlidAgentToolContext = {},
): Promise<string> {
	if (!(name in hlidAgentSchemas))
		throw new Error(`Unknown Hlid tool: ${name}`);
	const toolName = name as HlidAgentToolName;
	const parsed = hlidAgentSchemas[toolName].parse(input);
	const hasSource = typeof parsed.source_path === "string";
	const hasContent = typeof parsed.content === "string";
	if (hasSource === hasContent) {
		throw new Error("Provide exactly one of source_path or content.");
	}
	if (hasContent && !parsed.filename) {
		throw new Error("filename is required when publishing direct content.");
	}
	if (hasSource && !context.runtimeCwd) {
		throw new Error("Hlid could not resolve the provider working directory.");
	}

	const response = await dbFetch("/api/relics/publish", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			...parsed,
			...(context.runtimeCwd ? { runtime_cwd: context.runtimeCwd } : {}),
			...(context.sessionId ? { session_id: context.sessionId } : {}),
		}),
	});
	await requireDbOk(response, "Publish Relic");
	return JSON.stringify(await response.json());
}
