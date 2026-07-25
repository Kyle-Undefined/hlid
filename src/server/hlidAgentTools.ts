import { z } from "zod";
import { dbFetch, requireDbOk } from "#/lib/dbClient";
import type { AgentToolPayload } from "./agentToolResult";

export const HLID_AGENT_NAMESPACE = "hlid";
export const HLID_AGENT_NAMESPACE_DESCRIPTION =
	"Curated Hlid host capabilities. Publish a generated report or other durable deliverable to Relics, or start, manage, visually inspect, and interact with a session-scoped Project Preview when developing a web project from its repository.";
export const MAX_HLID_INLINE_RELIC_CHARS = 2_000_000;

export const hlidAgentSchemas = {
	publish_relic: z.object({
		source_path: z.string().trim().min(1).max(4_096).optional(),
		filename: z.string().trim().min(1).max(255).optional(),
		content: z.string().max(MAX_HLID_INLINE_RELIC_CHARS).optional(),
		mime: z.string().trim().min(1).max(255).optional(),
		category: z.enum(["report", "other"]).optional(),
	}),
	start_project_preview: z.object({
		command: z.string().trim().min(1).max(4_096),
		port: z.number().int().min(1).max(65_535),
		path: z.string().trim().max(2_048).optional(),
		working_directory: z.string().trim().max(1_024).optional(),
		label: z.string().trim().min(1).max(100).optional(),
		present: z.boolean().optional(),
		replace_existing: z.boolean().optional(),
		readiness_timeout_seconds: z.number().int().min(1).max(120).optional(),
	}),
	inspect_project_preview: z.object({
		preview_id: z.string().uuid().optional(),
	}),
	capture_project_preview: z.object({
		preview_id: z.string().uuid().optional(),
		path: z.string().trim().max(2_048).optional(),
		viewport: z.enum(["desktop", "tablet", "mobile"]).optional(),
		full_page: z.boolean().optional(),
	}),
	control_project_preview: z.object({
		preview_id: z.string().uuid().optional(),
		action: z.enum([
			"click",
			"type",
			"key",
			"scroll",
			"navigate",
			"reload",
			"viewport",
		]),
		frame_id: z.string().uuid().optional(),
		ref: z
			.string()
			.regex(/^e[1-9][0-9]{0,2}$/)
			.optional(),
		x: z.number().finite().min(0).max(10_000).optional(),
		y: z.number().finite().min(0).max(10_000).optional(),
		text: z.string().max(100_000).optional(),
		key: z.string().trim().min(1).max(100).optional(),
		delta_x: z.number().finite().min(-5_000).max(5_000).optional(),
		delta_y: z.number().finite().min(-5_000).max(5_000).optional(),
		path: z.string().trim().max(2_048).optional(),
		viewport: z.enum(["desktop", "tablet", "mobile"]).optional(),
	}),
	stop_project_preview: z.object({
		preview_id: z.string().uuid().optional(),
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
	searchHint: string;
	approvalTitle?: string;
};

export const HLID_AGENT_TOOL_SPECS: HlidAgentToolSpec[] = [
	{
		name: "publish_relic",
		description:
			"Publish an agent-generated deliverable into Hlid Relics without entering plan mode. Use source_path for an existing HTML, PDF, image, or other generated workspace file. For simple HTML or text, provide content and filename instead. Exactly one of source_path or content is required. The result includes an authenticated app-relative open_url that can be shown to the user. Do not use this for ordinary source files or HTML plan proposals.",
		readOnly: false,
		deferLoading: true,
		searchHint: "publish generated report HTML PDF image Relic",
		approvalTitle: "Hlid publish Relic",
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
	{
		name: "start_project_preview",
		description:
			"Start a web development server from the active repository and present it as a Hlid Project Preview. Hlid owns the child process, authenticated relay, readiness check, logs, four-hour safety lifetime, and cleanup. Pass the exact command and the port it will listen on. working_directory, when needed, must be relative to the active workspace. No project-side preview configuration is required.",
		readOnly: false,
		deferLoading: true,
		searchHint: "start web dev server project preview browser app",
		approvalTitle: "Hlid start Project Preview",
		inputSchema: {
			type: "object",
			properties: {
				command: {
					type: "string",
					description:
						"Exact development-server command, including host and port flags. Bind to 127.0.0.1; Hlid's authenticated relay provides mobile and remote access.",
				},
				port: {
					type: "number",
					description: "Loopback port the development server will listen on.",
				},
				path: {
					type: "string",
					description: "Initial URL path. Defaults to /.",
				},
				working_directory: {
					type: "string",
					description:
						"Optional directory relative to the active workspace. Absolute paths and parent traversal outside the workspace are rejected.",
				},
				label: {
					type: "string",
					description: "Short user-facing preview label.",
				},
				present: {
					type: "boolean",
					description: "Open the preview surface when ready. Defaults to true.",
				},
				replace_existing: {
					type: "boolean",
					description:
						"Stop and replace this session's current preview. Defaults to false.",
				},
				readiness_timeout_seconds: {
					type: "number",
					description:
						"Readiness timeout from 1 to 120 seconds. Defaults to 30.",
				},
			},
			additionalProperties: false,
		},
	},
	{
		name: "inspect_project_preview",
		description:
			"Inspect the current session's Hlid-owned Project Preview, including readiness, URL, command, working directory, exit state, errors, and recent logs.",
		readOnly: true,
		deferLoading: true,
		searchHint: "inspect project preview status logs dev server",
		inputSchema: {
			type: "object",
			properties: {
				preview_id: {
					type: "string",
					description:
						"Optional preview ID. Omit to inspect the current preview for this session.",
				},
			},
			additionalProperties: false,
		},
	},
	{
		name: "capture_project_preview",
		description:
			"Observe the persistent Hlid-owned agent browser for a Project Preview and return its PNG plus a bounded semantic element snapshot, route, title, console errors, and failed requests. Omit preview_id to use the current Preview for this session. Use a named desktop, tablet, or mobile viewport and optionally request a bounded full-page capture. This is read-only and does not publish a Relic.",
		readOnly: true,
		deferLoading: true,
		searchHint:
			"capture screenshot inspect rendered project preview browser visual",
		inputSchema: {
			type: "object",
			properties: {
				preview_id: {
					type: "string",
					description:
						"Optional Preview ID. Omit to capture the current Preview for this session.",
				},
				path: {
					type: "string",
					description:
						"Optional Preview-local route beginning with /. Defaults to the Preview's configured path.",
				},
				viewport: {
					type: "string",
					enum: ["desktop", "tablet", "mobile"],
					description: "Named capture viewport. Defaults to desktop.",
				},
				full_page: {
					type: "boolean",
					description:
						"Capture the bounded full page instead of only the viewport. Defaults to false.",
				},
			},
			additionalProperties: false,
		},
	},
	{
		name: "control_project_preview",
		description:
			"Interact with the persistent Hlid-owned agent browser for the current Project Preview, then receive an updated screenshot and semantic snapshot. Supported actions are click, type, key, scroll, navigate, reload, and viewport. Click and type must use the frame_id returned by the latest capture or control result; prefer semantic element refs and use coordinates only as a fallback. Navigation remains on the exact Preview-local route. This changes browser and application state but cannot access arbitrary URLs, raw CDP, downloads, files, clipboard, or device permissions.",
		readOnly: false,
		deferLoading: true,
		searchHint:
			"control interact click type scroll navigate browser project preview",
		approvalTitle: "Hlid control Project Preview",
		inputSchema: {
			type: "object",
			properties: {
				preview_id: {
					type: "string",
					description:
						"Optional Preview ID. Omit to control the current Preview for this session.",
				},
				action: {
					type: "string",
					enum: [
						"click",
						"type",
						"key",
						"scroll",
						"navigate",
						"reload",
						"viewport",
					],
					description: "Bounded browser action to perform.",
				},
				frame_id: {
					type: "string",
					description:
						"Latest frame ID. Required for click and type so stale targets fail closed.",
				},
				ref: {
					type: "string",
					description:
						"Semantic element reference from the latest frame. Preferred for click and required for type.",
				},
				x: {
					type: "number",
					description:
						"Viewport x coordinate for click when no semantic ref is available.",
				},
				y: {
					type: "number",
					description:
						"Viewport y coordinate for click when no semantic ref is available.",
				},
				text: {
					type: "string",
					description: "Replacement text for the type action.",
				},
				key: {
					type: "string",
					description:
						"Supported key or bounded modifier combination for the key action.",
				},
				delta_x: {
					type: "number",
					description: "Horizontal scroll delta, bounded to 5000 pixels.",
				},
				delta_y: {
					type: "number",
					description: "Vertical scroll delta, bounded to 5000 pixels.",
				},
				path: {
					type: "string",
					description: "Preview-local route beginning with / for navigate.",
				},
				viewport: {
					type: "string",
					enum: ["desktop", "tablet", "mobile"],
					description: "Named viewport for the viewport action.",
				},
			},
			additionalProperties: false,
		},
	},
	{
		name: "stop_project_preview",
		description:
			"Stop the current session's Hlid-owned Project Preview and its process tree. Use this when preview work is complete or the user asks to stop it.",
		readOnly: false,
		deferLoading: true,
		searchHint: "stop project preview dev server",
		approvalTitle: "Hlid stop Project Preview",
		inputSchema: {
			type: "object",
			properties: {
				preview_id: {
					type: "string",
					description:
						"Optional preview ID. Omit to stop the current preview for this session.",
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

const captureResultSchema = z.object({
	preview_id: z.string(),
	session_id: z.string(),
	path: z.string(),
	viewport: z.enum(["desktop", "tablet", "mobile"]),
	width: z.number().int().positive(),
	height: z.number().int().positive(),
	full_page: z.boolean(),
	captured_at: z.number().int().positive(),
	mime: z.literal("image/png"),
	size_bytes: z.number().int().positive(),
	image_base64: z.string().min(1),
	frame_id: z.string().uuid().optional(),
	title: z.string().optional(),
	elements: z
		.array(
			z.object({
				ref: z.string(),
				role: z.string(),
				name: z.string(),
				tag: z.string(),
				type: z.string().optional(),
				disabled: z.boolean().optional(),
				x: z.number(),
				y: z.number(),
				width: z.number(),
				height: z.number(),
			}),
		)
		.optional(),
	console_messages: z.array(z.string()).optional(),
	failed_requests: z.array(z.string()).optional(),
	last_action: z
		.enum(["click", "type", "key", "scroll", "navigate", "reload", "viewport"])
		.optional(),
});

type CaptureResult = z.infer<typeof captureResultSchema>;

async function requestProjectPreviewCapture(
	input: unknown,
	context: HlidAgentToolContext,
): Promise<CaptureResult> {
	if (!context.sessionId) {
		throw new Error("Hlid could not resolve the active session.");
	}
	const parsed = hlidAgentSchemas.capture_project_preview.parse(input);
	const previewPath = parsed.preview_id
		? `/api/project-previews/${encodeURIComponent(parsed.preview_id)}`
		: "/api/project-previews/session";
	const response = await dbFetch(`${previewPath}/capture`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			session_id: context.sessionId,
			...(parsed.path ? { path: parsed.path } : {}),
			...(parsed.viewport ? { viewport: parsed.viewport } : {}),
			...(parsed.full_page !== undefined
				? { full_page: parsed.full_page }
				: {}),
		}),
	});
	await requireDbOk(response, "Capture Project Preview");
	return captureResultSchema.parse(await response.json());
}

async function requestProjectPreviewControl(
	input: unknown,
	context: HlidAgentToolContext,
): Promise<CaptureResult> {
	if (!context.sessionId) {
		throw new Error("Hlid could not resolve the active session.");
	}
	const parsed = hlidAgentSchemas.control_project_preview.parse(input);
	const previewPath = parsed.preview_id
		? `/api/project-previews/${encodeURIComponent(parsed.preview_id)}`
		: "/api/project-previews/session";
	const response = await dbFetch(`${previewPath}/control`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			session_id: context.sessionId,
			...parsed,
			preview_id: undefined,
		}),
	});
	await requireDbOk(response, "Control Project Preview");
	return captureResultSchema.parse(await response.json());
}

function captureMetadata(
	result: CaptureResult,
): Omit<CaptureResult, "image_base64"> {
	const { image_base64: _image, ...metadata } = result;
	return metadata;
}

export async function executeHlidAgentTool(
	name: string,
	input: unknown,
	context: HlidAgentToolContext = {},
): Promise<string> {
	if (!(name in hlidAgentSchemas))
		throw new Error(`Unknown Hlid tool: ${name}`);
	const toolName = name as HlidAgentToolName;
	if (toolName === "start_project_preview") {
		const parsed = hlidAgentSchemas.start_project_preview.parse(input);
		if (!context.runtimeCwd || !context.sessionId) {
			throw new Error(
				"Hlid could not resolve the active session and provider working directory.",
			);
		}
		const response = await dbFetch("/api/project-previews/start", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				...parsed,
				runtime_cwd: context.runtimeCwd,
				session_id: context.sessionId,
			}),
		});
		await requireDbOk(response, "Start Project Preview");
		return JSON.stringify(await response.json());
	}
	if (
		toolName === "inspect_project_preview" ||
		toolName === "stop_project_preview"
	) {
		if (!context.sessionId) {
			throw new Error("Hlid could not resolve the active session.");
		}
		const schema =
			toolName === "inspect_project_preview"
				? hlidAgentSchemas.inspect_project_preview
				: hlidAgentSchemas.stop_project_preview;
		const parsed = schema.parse(input);
		const previewId = parsed.preview_id;
		const path = previewId
			? `/api/project-previews/${encodeURIComponent(previewId)}`
			: "/api/project-previews/session";
		const response =
			toolName === "inspect_project_preview"
				? await dbFetch(
						`${path}?session_id=${encodeURIComponent(context.sessionId)}`,
					)
				: await dbFetch(`${path}/stop`, {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ session_id: context.sessionId }),
					});
		await requireDbOk(
			response,
			toolName === "inspect_project_preview"
				? "Inspect Project Preview"
				: "Stop Project Preview",
		);
		return JSON.stringify(await response.json());
	}
	if (toolName === "capture_project_preview") {
		return JSON.stringify(
			captureMetadata(await requestProjectPreviewCapture(input, context)),
		);
	}
	if (toolName === "control_project_preview") {
		return JSON.stringify(
			captureMetadata(await requestProjectPreviewControl(input, context)),
		);
	}

	const parsed = hlidAgentSchemas.publish_relic.parse(input);
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

export async function executeHlidAgentToolRich(
	name: string,
	input: unknown,
	context: HlidAgentToolContext = {},
): Promise<AgentToolPayload> {
	if (
		name !== "capture_project_preview" &&
		name !== "control_project_preview"
	) {
		return { text: await executeHlidAgentTool(name, input, context) };
	}
	const result =
		name === "capture_project_preview"
			? await requestProjectPreviewCapture(input, context)
			: await requestProjectPreviewControl(input, context);
	return {
		text: JSON.stringify(captureMetadata(result)),
		images: [{ data: result.image_base64, mimeType: result.mime }],
	};
}
