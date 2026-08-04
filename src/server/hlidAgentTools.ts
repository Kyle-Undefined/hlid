import { randomUUID } from "node:crypto";
import { lstat, realpath, rename, rm, writeFile } from "node:fs/promises";
import {
	basename,
	dirname,
	isAbsolute,
	join,
	relative,
	resolve,
	sep,
	win32,
} from "node:path";
import { z } from "zod";
import type { SessionCleanupPreview } from "#/db/types";
import { dbFetch, requireDbOk } from "#/lib/dbClient";
import { parseHlidApiIndex } from "../lib/apiIndex";
import {
	HLID_CREATE_VISUALIZATION_TOOL,
	HLID_WINDOWS_COMPUTER_USE_TOOL,
} from "../lib/hlidContext";
import type { ProviderInfo } from "../lib/providerTypes";
import type { AgentToolPayload } from "./agentToolResult";
import { buildHlidApiDiscoveryResponse } from "./hlidApiDiscovery";
import {
	cancelHlidAgentSchema,
	delegateHlidAgentSchema,
	inspectHlidAgentSchema,
	listHlidAgentsSchema,
	resumeHlidAgentSchema,
	steerHlidAgentSchema,
	waitHlidAgentSchema,
} from "./hlidDelegationSchemas";
import {
	buildHlidHelpResponse,
	HLID_HELP_TOPICS,
	HLID_PROVIDER_CAPABILITY_AVAILABILITIES,
	HLID_PROVIDER_CAPABILITY_INTEGRATIONS,
	type HlidOperatingContext,
	MAX_HLID_PROVIDER_CAPABILITY_PAGE_SIZE,
} from "./hlidHelp";

export const HLID_AGENT_NAMESPACE = "hlid";
export const HLID_AGENT_NAMESPACE_DESCRIPTION =
	"Curated Hlid host capabilities. Discover the active operating contract and HTTP API, maintain Hlid storage, create durable Raven child sessions, publish deliverables to Relics, or run and inspect a session-scoped Project Preview.";
export const MAX_HLID_INLINE_RELIC_CHARS = 2_000_000;
const STORAGE_CLEANUP_PREVIEW_TTL_MS = 10 * 60 * 1_000;
const MAX_STORAGE_CLEANUP_PREVIEWS = 256;

type StorageCleanupPreviewReceipt = {
	sessionId: string;
	expiresAt: number;
	preview: SessionCleanupPreview;
};

const storageCleanupPreviews = new Map<string, StorageCleanupPreviewReceipt>();

/** Fields shared by every preview tool: which preview to address. */
const previewTarget = z.object({
	preview_id: z.string().uuid().optional(),
});
const previewPath = z.string().trim().max(2_048).optional();
const previewViewport = z.enum(["desktop", "tablet", "mobile"]).optional();
const previewCapture = previewTarget.extend({
	path: previewPath,
	viewport: previewViewport,
	full_page: z.boolean().optional(),
});

export const hlidAgentSchemas = {
	hlid_help: z
		.object({
			topic: z.enum(HLID_HELP_TOPICS).optional(),
			query: z.string().trim().min(1).max(200).optional(),
			capability_id: z.string().trim().min(1).max(240).optional(),
			integration: z.enum(HLID_PROVIDER_CAPABILITY_INTEGRATIONS).optional(),
			availability: z.enum(HLID_PROVIDER_CAPABILITY_AVAILABILITIES).optional(),
			limit: z
				.number()
				.int()
				.min(1)
				.max(MAX_HLID_PROVIDER_CAPABILITY_PAGE_SIZE)
				.optional(),
			cursor: z.string().trim().min(1).max(1_000).optional(),
		})
		.superRefine((value, context) => {
			const hasProviderLookup = Boolean(
				value.query ||
					value.capability_id ||
					value.integration ||
					value.availability ||
					value.limit ||
					value.cursor,
			);
			if (hasProviderLookup && value.topic !== "providers") {
				context.addIssue({
					code: "custom",
					message: "Provider capability lookup fields require topic=providers.",
				});
			}
		}),
	hlid_api: z.object({
		query: z.string().trim().max(200).optional(),
		method: z.enum(["GET", "POST", "PATCH", "DELETE"]).optional(),
		scope: z.enum(["data", "ui"]).optional(),
		limit: z.number().int().min(1).max(50).optional(),
	}),
	inspect_hlid_storage: z.object({
		cleanup_older_than_days: z.number().int().min(1).max(36_500).optional(),
	}),
	optimize_hlid_storage: z.object({}),
	cleanup_hlid_sessions: z.object({
		preview_id: z.string().uuid(),
	}),
	delegate_hlid_agent: delegateHlidAgentSchema,
	list_hlid_agents: listHlidAgentsSchema,
	inspect_hlid_agent: inspectHlidAgentSchema,
	wait_hlid_agent: waitHlidAgentSchema,
	steer_hlid_agent: steerHlidAgentSchema,
	cancel_hlid_agent: cancelHlidAgentSchema,
	resume_hlid_agent: resumeHlidAgentSchema,
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
		path: previewPath,
		working_directory: z.string().trim().max(1_024).optional(),
		label: z.string().trim().min(1).max(100).optional(),
		present: z.boolean().optional(),
		replace_existing: z.boolean().optional(),
		readiness_timeout_seconds: z.number().int().min(1).max(120).optional(),
	}),
	inspect_project_preview: previewTarget,
	capture_project_preview: previewCapture,
	export_project_preview_capture: previewCapture.extend({
		output_path: z
			.string()
			.trim()
			.min(1)
			.max(4_096)
			.regex(/\.png$/i, "output_path must end with .png"),
	}),
	control_project_preview: previewTarget.extend({
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
		path: previewPath,
		viewport: previewViewport,
	}),
	stop_project_preview: previewTarget,
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
	required?: string[];
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
		name: "hlid_help",
		description:
			"Return bounded, versioned operating guidance for the Hlid capabilities available in the active provider, environment, permission mode, workspace, and session. Omit topic for the live capability overview, or request one focused topic. Provider capability help supports exact lookup, search, status filters, and revision-bound pagination so a truncated page never has to be treated as the whole catalog. Use this instead of guessing cross-provider behavior or loading a static Hlid manual.",
		readOnly: true,
		deferLoading: true,
		searchHint:
			"Hlid help capabilities operating context references permissions sessions plans review workflows goals Relics Project Preview MCP skills extensions API Computer Use voice audio providers handoff",
		inputSchema: {
			type: "object",
			properties: {
				topic: {
					type: "string",
					enum: [...HLID_HELP_TOPICS],
					description:
						"Focused help topic. Omit for the current capability overview.",
				},
				query: {
					type: "string",
					description:
						"With topic=providers, search capability IDs, labels, operations, state, and reasons.",
				},
				capability_id: {
					type: "string",
					description:
						"With topic=providers, retrieve one exact capability ID from the full active-provider snapshot.",
				},
				integration: {
					type: "string",
					enum: [...HLID_PROVIDER_CAPABILITY_INTEGRATIONS],
					description:
						"With topic=providers, filter by Hlid integration state.",
				},
				availability: {
					type: "string",
					enum: [...HLID_PROVIDER_CAPABILITY_AVAILABILITIES],
					description:
						"With topic=providers, filter by resolved live availability.",
				},
				limit: {
					type: "number",
					description: `With topic=providers, request 1-${MAX_HLID_PROVIDER_CAPABILITY_PAGE_SIZE} matching rows. The response budget may return fewer.`,
				},
				cursor: {
					type: "string",
					description:
						"With topic=providers, continue from nextCursor. The cursor retains filters and fails if the catalog revision changes.",
				},
			},
			additionalProperties: false,
		},
	},
	{
		name: "hlid_api",
		description:
			"Search Hlid's live, curated HTTP API catalog. Filter by text, method, or data/UI listener and receive a bounded result with exact live base URLs, full matching total, returned count, and truncation state. Use this for direct Hlid integration without loading the full API reference.",
		readOnly: true,
		deferLoading: true,
		searchHint:
			"Hlid HTTP REST API endpoint route integration catalog discovery search",
		inputSchema: {
			type: "object",
			properties: {
				query: {
					type: "string",
					description:
						"Optional case-insensitive search across method, path, listener, and description.",
				},
				method: {
					type: "string",
					enum: ["GET", "POST", "PATCH", "DELETE"],
					description: "Optional exact HTTP method filter.",
				},
				scope: {
					type: "string",
					enum: ["data", "ui"],
					description:
						"Optional listener filter. data is the Hlid data/API port; ui is the application port.",
				},
				limit: {
					type: "number",
					description:
						"Maximum endpoints to return, from 1 to 50. Defaults to 20.",
				},
			},
			additionalProperties: false,
		},
	},
	{
		name: "inspect_hlid_storage",
		description:
			"Inspect Hlid's database, WAL, reusable pages, managed library, attachment, session, message, usage-query, pending-deletion, and available-disk totals without changing them. Optionally supply cleanup_older_than_days to preview guarded session cleanup and receive a short-lived, one-use preview_id required by cleanup_hlid_sessions. Cleanup previews exclude live, pinned, archived, imported, pending-turn, and protected delegation-lineage sessions.",
		readOnly: true,
		deferLoading: true,
		searchHint:
			"inspect Hlid storage database WAL library attachments cleanup preview maintenance disk usage",
		inputSchema: {
			type: "object",
			properties: {
				cleanup_older_than_days: {
					type: "number",
					description:
						"Optional whole-number age threshold from 1 to 36500 days. When present, return the current cleanup impact and a preview ID.",
				},
			},
			additionalProperties: false,
		},
	},
	{
		name: "optimize_hlid_storage",
		description:
			"Run Hlid's lightweight storage maintenance: retry pending managed-file deletions, perform a passive SQLite WAL checkpoint, and run PRAGMA optimize. Returns before-and-after storage totals. This does not VACUUM, physically rebuild the database, stop sessions, or perform Forge-only reclaim.",
		readOnly: false,
		deferLoading: true,
		searchHint:
			"optimize Hlid storage SQLite WAL checkpoint maintenance pending file deletion",
		approvalTitle: "Hlid optimize storage",
		inputSchema: {
			type: "object",
			properties: {},
			additionalProperties: false,
		},
	},
	{
		name: "cleanup_hlid_sessions",
		description:
			"Delete the eligible old sessions represented by a fresh preview_id from inspect_hlid_storage after reporting its deletion and preservation totals and receiving explicit user authorization. The preview is session-scoped, one-use, expires after ten minutes, and is rechecked immediately; changed impact is refused. Cleanup removes Hlid-owned linked Relics and preserves immutable Ledger usage totals while only detaching vault-owned files. Physical database reclaim remains Forge-only.",
		readOnly: false,
		deferLoading: true,
		searchHint:
			"clean delete old Hlid sessions linked Relics preserve Ledger usage storage maintenance",
		approvalTitle: "Hlid clean up sessions",
		inputSchema: {
			type: "object",
			properties: {
				preview_id: {
					type: "string",
					description:
						"Short-lived preview ID returned by inspect_hlid_storage for this Raven session.",
				},
			},
			required: ["preview_id"],
			additionalProperties: false,
		},
	},
	{
		name: "delegate_hlid_agent",
		description:
			"Create a durable Raven child session in the current workspace or an exact configured workspace using an explicitly selected provider, model, effort, and optional model service tier. Delegation is bounded to three levels, four active direct children per parent, and twelve active delegated children across Hlid. The child uses inherited or narrower permissions, appears independently in Raven and Ledger, and keeps its own provider-native transcript and passively recorded usage. Hlid imposes no elapsed-time or inactivity cap because cross-provider silence is not proof of failure. New runs do not accept a timeout input or transition automatically to timed_out. Provider availability is checked before launch, and native launch, transport, or process failures settle the child naturally. Use cancel_hlid_agent when the work should stop. Token and cost usage are observations rather than lifecycle caps. This returns immediately with a delegation ID and child-session link; call wait_hlid_agent or inspect_hlid_agent for its bounded result. Context, exact references, and Relics remain empty unless their handoff switches are explicitly selected. Scheduled Routines may delegate only in their approved workspace when the call is allowed by the Routine grant envelope and Umbod; every descendant shares the same per-run grant-use limits.",
		readOnly: false,
		deferLoading: true,
		searchHint:
			"delegate cross-provider cross-harness durable child Raven session agent orchestration",
		approvalTitle: "Hlid delegate child agent",
		inputSchema: {
			type: "object",
			properties: {
				task: {
					type: "string",
					description:
						"Self-contained task for the child. Explicitly include any context it needs; exact references are not inherited automatically.",
				},
				provider: {
					type: "string",
					description:
						"Exact registered provider ID for the durable child, such as claude or codex.",
				},
				model: {
					type: "string",
					description:
						"Optional exact model from the target provider's current catalog.",
				},
				effort: {
					type: "string",
					description:
						"Optional target-provider effort level. Same-provider children otherwise inherit the parent effort.",
				},
				service_tier: {
					type: "string",
					description:
						"Optional exact service tier from the selected model's current serviceTiers catalog.",
				},
				cwd: {
					type: "string",
					description:
						"Optional exact configured vault or registered workspace path. Defaults to the parent workspace. Routine children must stay in the Routine's approved workspace.",
				},
				permission_mode: {
					type: "string",
					enum: ["default", "acceptEdits", "bypassPermissions", "plan"],
					description:
						"Optional child permission mode. It must be equal to or narrower than the parent mode. Set plan explicitly when a Codex child must use native request_user_input; default mode does not expose that mechanism. A question-only plan turn does not enter plan review unless Codex emits a real plan.",
				},
				handoff: {
					type: "object",
					properties: {
						visible_transcript: {
							type: "boolean",
							description:
								"Include up to 40,000 characters of bounded visible parent transcript. Hidden provider state and partial assistant output are not copied.",
						},
						selected_skills: {
							type: "boolean",
							description:
								"Pass only the current turn's already-validated selected skill files.",
						},
						selected_relics: {
							type: "boolean",
							description:
								"Pass only durable Relics explicitly selected on the current parent turn. Ordinary uploads are never borrowed.",
						},
						exact_references: {
							type: "boolean",
							description:
								"Pass only the current turn's exact Vault and Workspace selections. Hlid revalidates them and never expands related content.",
						},
					},
					additionalProperties: false,
				},
			},
			required: ["task", "provider"],
			additionalProperties: false,
		},
	},
	{
		name: "list_hlid_agents",
		description:
			"List the current parent session's durable Hlid children, newest first. Returns compact lifecycle snapshots, task previews, child-session links, and result/error availability flags, including restart-interrupted children eligible for explicit continuation. Use inspect_hlid_agent for bounded result or error details.",
		readOnly: true,
		deferLoading: true,
		searchHint:
			"list delegated Hlid children orchestration status interrupted continuation",
		inputSchema: {
			type: "object",
			properties: {
				limit: {
					type: "number",
					description:
						"Maximum children to return, from 1 to 100. Defaults to 50.",
				},
			},
			required: [],
			additionalProperties: false,
		},
	},
	{
		name: "inspect_hlid_agent",
		description:
			"Inspect one durable Hlid child created by the current parent session. Returns lifecycle, provider selection, child-session link, bounded active progress, and any bounded terminal result or partial result plus error.",
		readOnly: true,
		deferLoading: true,
		searchHint:
			"inspect delegated Hlid child agent orchestration status result Raven session",
		inputSchema: {
			type: "object",
			properties: {
				id: {
					type: "string",
					description: "Delegation ID returned by delegate_hlid_agent.",
				},
			},
			required: ["id"],
			additionalProperties: false,
		},
	},
	{
		name: "wait_hlid_agent",
		description:
			"Wait up to 60 seconds for one durable Hlid child created by the current parent session, then return its latest lifecycle, bounded active progress, and any bounded terminal result or partial result plus error. A still-running child remains independent and can be waited on again.",
		readOnly: true,
		deferLoading: true,
		searchHint:
			"wait delegated Hlid child agent orchestration completion result",
		inputSchema: {
			type: "object",
			properties: {
				id: {
					type: "string",
					description: "Delegation ID returned by delegate_hlid_agent.",
				},
				wait_seconds: {
					type: "number",
					description: "Wait duration from 1 to 60 seconds. Defaults to 60.",
				},
			},
			required: ["id"],
			additionalProperties: false,
		},
	},
	{
		name: "steer_hlid_agent",
		description:
			"Steer one currently running child through that provider's native same-turn steering primitive. Codex and Claude expose native steering when active; providers without it return unavailable. Hlid never queues a fresh-turn fallback.",
		readOnly: false,
		deferLoading: true,
		searchHint:
			"steer active delegated Hlid child native provider same turn instruction",
		approvalTitle: "Hlid steer child agent",
		inputSchema: {
			type: "object",
			properties: {
				id: {
					type: "string",
					description: "Delegation ID returned by delegate_hlid_agent.",
				},
				instruction: {
					type: "string",
					description:
						"Instruction to append to the child's active provider turn.",
				},
			},
			required: ["id", "instruction"],
			additionalProperties: false,
		},
	},
	{
		name: "cancel_hlid_agent",
		description:
			"Request cancellation of the addressed durable Hlid child and all active nested descendants immediately. Hlid retains provider control, delegation ownership, and active capacity until each active provider turn settles, then persists terminal cancelled state. For a resumable restart-interrupted child with no active provider turn, cancellation explicitly abandons continuation and marks it cancelled immediately while retaining its Raven transcript and Ledger provenance. A terminal ancestor remains terminal while its active descendants stop. Cancellation is a Hlid-owned lifecycle action and remains distinct from provider-native steering.",
		readOnly: false,
		deferLoading: true,
		searchHint:
			"cancel stop delegated Hlid child orchestration nested descendants",
		approvalTitle: "Hlid cancel child agent",
		inputSchema: {
			type: "object",
			properties: {
				id: {
					type: "string",
					description: "Delegation ID returned by delegate_hlid_agent.",
				},
			},
			required: ["id"],
			additionalProperties: false,
		},
	},
	{
		name: "resume_hlid_agent",
		description:
			"Start an explicit new continuation turn in a restart-interrupted durable child with a remaining attempt. This requires a live running parent turn, revalidates the recorded configured workspace plus provider, model, effort, and service tier, and enforces inherited or narrower permissions plus the four-per-parent and twelve-global active limits. Hlid imposes no elapsed-time or inactivity cap because cross-provider silence is not proof of failure. Native launch, transport, or process failures settle the child naturally; use cancel_hlid_agent when the work should stop. Token and cost usage remain passive observations. The instruction remains the visible child message; Hlid also supplies bounded visible child transcript context. This never claims to resume the interrupted in-flight turn, inherits no references or Relics, and cannot continue a Routine-owned child outside its ended authorization envelope.",
		readOnly: false,
		deferLoading: true,
		searchHint:
			"resume continue restart interrupted delegated Hlid child explicit new turn",
		approvalTitle: "Hlid continue interrupted child",
		inputSchema: {
			type: "object",
			properties: {
				id: {
					type: "string",
					description: "Restart-interrupted delegation ID.",
				},
				instruction: {
					type: "string",
					description:
						"Required visible continuation instruction for the new child turn.",
				},
				permission_mode: {
					type: "string",
					enum: ["default", "acceptEdits", "bypassPermissions", "plan"],
					description:
						"Optional continuation permission mode, equal to or narrower than the current parent turn.",
				},
			},
			required: ["id", "instruction"],
			additionalProperties: false,
		},
	},
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
			"Start a web server from the active workspace and present it as a Hlid Project Preview. The workspace does not need to be a Git or development repository; any directory works as long as the command serves something over HTTP on the specified port. Hlid owns the child process, authenticated relay, Windows-to-WSL loopback bridge when needed, readiness check, logs, four-hour safety lifetime, and cleanup. Pass the exact command and the exact port it will listen on. working_directory, when needed, must be relative to the active workspace. No project-side preview configuration is required.",
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
						"Exact development-server command. Make its port match the port argument and bind to IPv4 127.0.0.1. In a WSL workspace, Hlid also supports a server's IPv4 wildcard default through a loopback-only managed bridge. Hlid owns authenticated mobile and remote access.",
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
			"Observe the persistent Hlid-owned agent browser for a Project Preview and return its lossless high-density PNG plus bitmap dimensions, effective pixel ratio, a bounded semantic element snapshot, route, title, console errors, and failed requests. Omit preview_id to use the current Preview for this session. Use a named desktop, tablet, or mobile viewport and optionally request a bounded full-page capture. This is read-only and does not save a workspace file or publish a Relic.",
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
		name: "export_project_preview_capture",
		description:
			"Capture the persistent Hlid-owned agent browser once and save that exact lossless PNG to a workspace-relative .png path for documentation or another generated asset. The existing parent directory must remain inside the active workspace. This is a permissioned workspace write; it does not publish a Relic. The result includes the workspace-relative saved_path, capture metadata, and the same image content.",
		readOnly: false,
		deferLoading: true,
		searchHint:
			"export save high quality screenshot project preview png docs workspace",
		approvalTitle: "Hlid export Project Preview capture",
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
				output_path: {
					type: "string",
					description:
						"Workspace-relative output path ending in .png. Its parent directory must already exist; absolute paths, parent traversal, and symlink escapes are rejected.",
				},
			},
			required: ["output_path"],
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

export type HlidAgentToolContext = HlidOperatingContext;

async function liveHlidOperatingContext(
	context: HlidAgentToolContext,
): Promise<HlidAgentToolContext> {
	let live: HlidAgentToolContext = {
		...context,
		registeredHlidTools: HLID_AGENT_TOOL_SPECS.map((spec) => spec.name),
	};
	if (context.sessionId) {
		try {
			const response = await dbFetch(
				`/db/session-row?id=${encodeURIComponent(context.sessionId)}`,
			);
			if (response.ok) {
				const row = (await response.json()) as {
					provider_id?: string | null;
					selected_model?: string | null;
					model?: string | null;
					selected_effort?: string | null;
					selected_permission_mode?: string | null;
					agent_cwd?: string | null;
				} | null;
				if (row) {
					live = {
						...live,
						providerId: row.provider_id ?? live.providerId,
						model: row.selected_model ?? row.model ?? live.model,
						effort: row.selected_effort ?? live.effort,
						permissionMode: row.selected_permission_mode ?? live.permissionMode,
						runtimeCwd: row.agent_cwd ?? live.runtimeCwd,
					};
				}
			}
		} catch {
			// Persisted selections are best-effort; provider context remains usable.
		}
	}
	const [providerCatalog, voiceSnapshot, ttsSnapshot] = await Promise.all([
		(async () => {
			try {
				const providerParams = new URLSearchParams({
					host_capabilities: "1",
					provider_capabilities: "1",
				});
				if (live.runtimeCwd) {
					providerParams.set("capability_cwd", live.runtimeCwd);
					providerParams.set("provider_capabilities_wait", "1");
				}
				const response = await dbFetch(
					`/providers?${providerParams.toString()}`,
				);
				if (!response.ok) return undefined;
				const body = (await response.json()) as { providers?: ProviderInfo[] };
				return body.providers;
			} catch {
				return undefined;
			}
		})(),
		(async () => {
			try {
				const response = await dbFetch("/voice");
				if (!response.ok) return undefined;
				const body = (await response.json()) as {
					status?: HlidOperatingContext["voiceSnapshot"];
				};
				return body.status;
			} catch {
				return undefined;
			}
		})(),
		(async () => {
			try {
				const response = await dbFetch("/tts");
				if (!response.ok) return undefined;
				const body = (await response.json()) as {
					status?: HlidOperatingContext["ttsSnapshot"];
				};
				return body.status;
			} catch {
				return undefined;
			}
		})(),
	]);
	const providerSnapshot = providerCatalog?.find(
		(provider) => provider.id === live.providerId,
	);
	return {
		...live,
		registeredHlidTools: [
			...HLID_AGENT_TOOL_SPECS.map((spec) => spec.name),
			...(providerSnapshot?.hostCapabilities?.windowsComputerUse?.available
				? [HLID_WINDOWS_COMPUTER_USE_TOOL]
				: []),
			...(providerSnapshot?.hostCapabilities?.windowsVisualize?.available
				? [HLID_CREATE_VISUALIZATION_TOOL]
				: []),
		],
		...(providerSnapshot ? { providerSnapshot } : {}),
		...(providerCatalog ? { providerCatalog } : {}),
		...(voiceSnapshot ? { voiceSnapshot } : {}),
		...(ttsSnapshot ? { ttsSnapshot } : {}),
	};
}

const captureResultSchema = z.object({
	preview_id: z.string(),
	session_id: z.string(),
	path: z.string(),
	viewport: z.enum(["desktop", "tablet", "mobile"]),
	width: z.number().int().positive(),
	height: z.number().int().positive(),
	pixel_width: z.number().int().positive().optional(),
	pixel_height: z.number().int().positive().optional(),
	device_scale_factor: z.number().positive().optional(),
	pixel_ratio: z.number().positive().optional(),
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

async function requestProjectPreviewAction(
	action: "capture" | "control",
	errorLabel: string,
	sessionId: string,
	previewId: string | undefined,
	body: Record<string, unknown>,
): Promise<CaptureResult> {
	const previewPath = previewId
		? `/api/project-previews/${encodeURIComponent(previewId)}`
		: "/api/project-previews/session";
	const response = await dbFetch(`${previewPath}/${action}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ session_id: sessionId, ...body }),
	});
	await requireDbOk(response, errorLabel);
	return captureResultSchema.parse(await response.json());
}

async function requestProjectPreviewCapture(
	input: unknown,
	context: HlidAgentToolContext,
): Promise<CaptureResult> {
	if (!context.sessionId) {
		throw new Error("Hlid could not resolve the active session.");
	}
	const parsed = hlidAgentSchemas.capture_project_preview.parse(input);
	return requestProjectPreviewAction(
		"capture",
		"Capture Project Preview",
		context.sessionId,
		parsed.preview_id,
		{
			...(parsed.path ? { path: parsed.path } : {}),
			...(parsed.viewport ? { viewport: parsed.viewport } : {}),
			...(parsed.full_page !== undefined
				? { full_page: parsed.full_page }
				: {}),
		},
	);
}

function isWithinDirectory(root: string, candidate: string): boolean {
	const offset = relative(root, candidate);
	return (
		offset === "" ||
		(!offset.startsWith(`..${sep}`) && offset !== ".." && !isAbsolute(offset))
	);
}

function hasParentTraversal(path: string): boolean {
	return path.split("/").some((segment) => segment === "..");
}

async function resolveProjectPreviewCaptureOutput(
	outputPath: string,
	runtimeCwd: string,
): Promise<string> {
	if (
		isAbsolute(outputPath) ||
		win32.isAbsolute(outputPath) ||
		outputPath.includes("\\") ||
		hasParentTraversal(outputPath)
	) {
		throw new Error(
			"Project Preview output_path must be a workspace-relative path without parent traversal.",
		);
	}
	const workspace = await realpath(runtimeCwd);
	const requested = resolve(workspace, outputPath);
	if (!isWithinDirectory(workspace, requested)) {
		throw new Error(
			"Project Preview output_path must remain inside the active workspace.",
		);
	}
	let parent: string;
	try {
		parent = await realpath(dirname(requested));
	} catch {
		throw new Error(
			"Project Preview output_path parent directory must already exist.",
		);
	}
	if (!isWithinDirectory(workspace, parent)) {
		throw new Error(
			"Project Preview output_path parent resolves outside the active workspace.",
		);
	}
	const savedPath = join(parent, basename(requested));
	try {
		if ((await lstat(savedPath)).isSymbolicLink()) {
			throw new Error(
				"Project Preview output_path cannot replace a symbolic link.",
			);
		}
	} catch (error) {
		if (
			typeof error !== "object" ||
			error === null ||
			!("code" in error) ||
			error.code !== "ENOENT"
		)
			throw error;
	}
	return savedPath;
}

async function saveProjectPreviewCapture(
	result: CaptureResult,
	savedPath: string,
): Promise<void> {
	const parent = dirname(savedPath);
	const temporaryPath = join(
		parent,
		`.${basename(savedPath)}.${crypto.randomUUID()}.hlid-tmp`,
	);
	try {
		await writeFile(temporaryPath, Buffer.from(result.image_base64, "base64"), {
			flag: "wx",
		});
		await rename(temporaryPath, savedPath);
	} finally {
		await rm(temporaryPath, { force: true }).catch(() => {});
	}
}

async function requestProjectPreviewExport(
	input: unknown,
	context: HlidAgentToolContext,
): Promise<{ result: CaptureResult; savedPath: string }> {
	if (!context.runtimeCwd) {
		throw new Error("Hlid could not resolve the provider working directory.");
	}
	const parsed = hlidAgentSchemas.export_project_preview_capture.parse(input);
	const savedPath = await resolveProjectPreviewCaptureOutput(
		parsed.output_path,
		context.runtimeCwd,
	);
	const result = await requestProjectPreviewCapture(parsed, context);
	await saveProjectPreviewCapture(result, savedPath);
	return { result, savedPath: parsed.output_path };
}

async function requestProjectPreviewControl(
	input: unknown,
	context: HlidAgentToolContext,
): Promise<CaptureResult> {
	if (!context.sessionId) {
		throw new Error("Hlid could not resolve the active session.");
	}
	const parsed = hlidAgentSchemas.control_project_preview.parse(input);
	const { preview_id: previewId, ...body } = parsed;
	return requestProjectPreviewAction(
		"control",
		"Control Project Preview",
		context.sessionId,
		previewId,
		body,
	);
}

function captureMetadata(
	result: CaptureResult,
): Omit<CaptureResult, "image_base64"> {
	const { image_base64: _image, ...metadata } = result;
	return metadata;
}

type HlidAgentToolHandler = (
	input: unknown,
	context: HlidAgentToolContext,
) => Promise<string>;

type DelegationToolName =
	| "delegate_hlid_agent"
	| "list_hlid_agents"
	| "inspect_hlid_agent"
	| "wait_hlid_agent"
	| "steer_hlid_agent"
	| "cancel_hlid_agent"
	| "resume_hlid_agent";

async function executeDelegationTool(
	toolName: DelegationToolName,
	input: unknown,
	context: HlidAgentToolContext,
): Promise<string> {
	if (!context.sessionId) {
		throw new Error("Hlid delegation requires an active parent Raven session.");
	}
	if (toolName === "delegate_hlid_agent") {
		const parsed = hlidAgentSchemas.delegate_hlid_agent.parse(input);
		const response = await dbFetch("/hlid-agents/delegate", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				...parsed,
				parent_session_id: context.sessionId,
			}),
		});
		await requireDbOk(response, "Delegate Hlid child agent");
		return JSON.stringify(await response.json());
	}
	if (toolName === "inspect_hlid_agent") {
		const parsed = hlidAgentSchemas.inspect_hlid_agent.parse(input);
		const response = await dbFetch(
			`/hlid-agents/${encodeURIComponent(parsed.id)}?parent_session_id=${encodeURIComponent(context.sessionId)}`,
		);
		await requireDbOk(response, "Inspect Hlid child agent");
		return JSON.stringify(await response.json());
	}
	if (toolName === "list_hlid_agents") {
		const parsed = hlidAgentSchemas.list_hlid_agents.parse(input);
		const search = new URLSearchParams({
			parent_session_id: context.sessionId,
			...(parsed.limit !== undefined ? { limit: String(parsed.limit) } : {}),
		});
		const response = await dbFetch(`/hlid-agents?${search.toString()}`);
		await requireDbOk(response, "List Hlid child agents");
		return JSON.stringify(await response.json());
	}
	if (toolName === "wait_hlid_agent") {
		const parsed = hlidAgentSchemas.wait_hlid_agent.parse(input);
		const response = await dbFetch(
			`/hlid-agents/${encodeURIComponent(parsed.id)}/wait`,
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					parent_session_id: context.sessionId,
					...(parsed.wait_seconds !== undefined
						? { wait_seconds: parsed.wait_seconds }
						: {}),
				}),
			},
		);
		await requireDbOk(response, "Wait for Hlid child agent");
		return JSON.stringify(await response.json());
	}
	const parsed =
		toolName === "steer_hlid_agent"
			? hlidAgentSchemas.steer_hlid_agent.parse(input)
			: toolName === "cancel_hlid_agent"
				? hlidAgentSchemas.cancel_hlid_agent.parse(input)
				: hlidAgentSchemas.resume_hlid_agent.parse(input);
	const action =
		toolName === "steer_hlid_agent"
			? "steer"
			: toolName === "cancel_hlid_agent"
				? "cancel"
				: "resume";
	const response = await dbFetch(
		`/hlid-agents/${encodeURIComponent(parsed.id)}/${action}`,
		{
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				...parsed,
				id: undefined,
				parent_session_id: context.sessionId,
			}),
		},
	);
	await requireDbOk(
		response,
		toolName === "steer_hlid_agent"
			? "Steer Hlid child agent"
			: toolName === "cancel_hlid_agent"
				? "Cancel Hlid child agent"
				: "Continue Hlid child agent",
	);
	return JSON.stringify(await response.json());
}

async function executeStartProjectPreview(
	input: unknown,
	context: HlidAgentToolContext,
): Promise<string> {
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

async function executeProjectPreviewReadOrStop(
	toolName: "inspect_project_preview" | "stop_project_preview",
	input: unknown,
	context: HlidAgentToolContext,
): Promise<string> {
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

async function executePublishRelic(
	input: unknown,
	context: HlidAgentToolContext,
): Promise<string> {
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

function pruneStorageCleanupPreviews(now = Date.now()): void {
	for (const [id, receipt] of storageCleanupPreviews) {
		if (receipt.expiresAt <= now) storageCleanupPreviews.delete(id);
	}
	while (storageCleanupPreviews.size >= MAX_STORAGE_CLEANUP_PREVIEWS) {
		const oldest = storageCleanupPreviews.keys().next().value;
		if (typeof oldest !== "string") break;
		storageCleanupPreviews.delete(oldest);
	}
}

function cleanupPreviewSignature(preview: SessionCleanupPreview): string {
	const { cutoff: _cutoff, ...stableImpact } = preview;
	return JSON.stringify(stableImpact);
}

async function readHlidStorage(): Promise<Record<string, unknown>> {
	const response = await dbFetch("/db/storage");
	await requireDbOk(response, "Inspect Hlid storage");
	return (await response.json()) as Record<string, unknown>;
}

async function readSessionCleanupPreview(
	days: number,
): Promise<SessionCleanupPreview> {
	const response = await dbFetch(
		`/db/sessions/cleanup/preview?older_than_days=${days}`,
	);
	await requireDbOk(response, "Preview Hlid session cleanup");
	return (await response.json()) as SessionCleanupPreview;
}

async function executeInspectHlidStorage(
	input: unknown,
	context: HlidAgentToolContext,
): Promise<string> {
	const parsed = hlidAgentSchemas.inspect_hlid_storage.parse(input);
	const storage = await readHlidStorage();
	if (parsed.cleanup_older_than_days === undefined) {
		return JSON.stringify({ storage });
	}
	if (!context.sessionId) {
		throw new Error(
			"Hlid could not bind the cleanup preview to the active Raven session.",
		);
	}
	const preview = await readSessionCleanupPreview(
		parsed.cleanup_older_than_days,
	);
	const previewId = randomUUID();
	const expiresAt = Date.now() + STORAGE_CLEANUP_PREVIEW_TTL_MS;
	pruneStorageCleanupPreviews();
	storageCleanupPreviews.set(previewId, {
		sessionId: context.sessionId,
		expiresAt,
		preview,
	});
	return JSON.stringify({
		storage,
		cleanup: {
			preview_id: previewId,
			expires_at: Math.floor(expiresAt / 1_000),
			...preview,
		},
	});
}

async function executeOptimizeHlidStorage(input: unknown): Promise<string> {
	hlidAgentSchemas.optimize_hlid_storage.parse(input);
	const before = await readHlidStorage();
	const response = await dbFetch("/db/storage/optimize", { method: "POST" });
	await requireDbOk(response, "Optimize Hlid storage");
	const after = (await response.json()) as Record<string, unknown>;
	return JSON.stringify({ before, after, physical_reclaim: "forge-only" });
}

async function executeCleanupHlidSessions(
	input: unknown,
	context: HlidAgentToolContext,
): Promise<string> {
	const parsed = hlidAgentSchemas.cleanup_hlid_sessions.parse(input);
	if (!context.sessionId) {
		throw new Error("Hlid could not resolve the active Raven session.");
	}
	pruneStorageCleanupPreviews();
	const receipt = storageCleanupPreviews.get(parsed.preview_id);
	if (!receipt) {
		throw new Error(
			"Cleanup preview is missing or expired. Inspect Hlid storage again before cleanup.",
		);
	}
	if (receipt.sessionId !== context.sessionId) {
		throw new Error(
			"Cleanup preview belongs to a different Raven session. Inspect Hlid storage in this session first.",
		);
	}

	const currentPreview = await readSessionCleanupPreview(receipt.preview.days);
	storageCleanupPreviews.delete(parsed.preview_id);
	if (
		cleanupPreviewSignature(currentPreview) !==
		cleanupPreviewSignature(receipt.preview)
	) {
		throw new Error(
			"Cleanup impact changed after preview. Inspect Hlid storage again and review the new totals.",
		);
	}

	const response = await dbFetch(
		`/db/sessions/cleanup?older_than_days=${receipt.preview.days}`,
		{ method: "POST" },
	);
	await requireDbOk(response, "Clean up Hlid sessions");
	const cleanup = (await response.json()) as Record<string, unknown>;
	const storage = await readHlidStorage();
	return JSON.stringify({
		preview: currentPreview,
		cleanup,
		storage,
		physical_reclaim: "forge-only",
	});
}

const hlidAgentToolHandlers = {
	hlid_help: async (input, context) => {
		const parsed = hlidAgentSchemas.hlid_help.parse(input);
		return buildHlidHelpResponse(
			parsed.topic ?? "overview",
			await liveHlidOperatingContext(context),
			{
				providerCapabilities: {
					query: parsed.query,
					capabilityId: parsed.capability_id,
					integration: parsed.integration,
					availability: parsed.availability,
					limit: parsed.limit,
					cursor: parsed.cursor,
				},
			},
		);
	},
	hlid_api: async (input) => {
		const parsed = hlidAgentSchemas.hlid_api.parse(input);
		const response = await dbFetch("/api-index");
		await requireDbOk(response, "Discover Hlid API");
		return buildHlidApiDiscoveryResponse(
			parseHlidApiIndex(await response.json()),
			parsed,
		);
	},
	inspect_hlid_storage: executeInspectHlidStorage,
	optimize_hlid_storage: executeOptimizeHlidStorage,
	cleanup_hlid_sessions: executeCleanupHlidSessions,
	delegate_hlid_agent: (input, context) =>
		executeDelegationTool("delegate_hlid_agent", input, context),
	list_hlid_agents: (input, context) =>
		executeDelegationTool("list_hlid_agents", input, context),
	inspect_hlid_agent: (input, context) =>
		executeDelegationTool("inspect_hlid_agent", input, context),
	wait_hlid_agent: (input, context) =>
		executeDelegationTool("wait_hlid_agent", input, context),
	steer_hlid_agent: (input, context) =>
		executeDelegationTool("steer_hlid_agent", input, context),
	cancel_hlid_agent: (input, context) =>
		executeDelegationTool("cancel_hlid_agent", input, context),
	resume_hlid_agent: (input, context) =>
		executeDelegationTool("resume_hlid_agent", input, context),
	publish_relic: executePublishRelic,
	start_project_preview: executeStartProjectPreview,
	inspect_project_preview: (input, context) =>
		executeProjectPreviewReadOrStop("inspect_project_preview", input, context),
	capture_project_preview: async (input, context) =>
		JSON.stringify(
			captureMetadata(await requestProjectPreviewCapture(input, context)),
		),
	export_project_preview_capture: async (input, context) => {
		const { result, savedPath } = await requestProjectPreviewExport(
			input,
			context,
		);
		return JSON.stringify({
			...captureMetadata(result),
			saved_path: savedPath,
		});
	},
	control_project_preview: async (input, context) =>
		JSON.stringify(
			captureMetadata(await requestProjectPreviewControl(input, context)),
		),
	stop_project_preview: (input, context) =>
		executeProjectPreviewReadOrStop("stop_project_preview", input, context),
} satisfies Record<HlidAgentToolName, HlidAgentToolHandler>;

export async function executeHlidAgentTool(
	name: string,
	input: unknown,
	context: HlidAgentToolContext = {},
): Promise<string> {
	if (!Object.hasOwn(hlidAgentToolHandlers, name)) {
		throw new Error(`Unknown Hlid tool: ${name}`);
	}
	return hlidAgentToolHandlers[name as HlidAgentToolName](input, context);
}

export async function executeHlidAgentToolRich(
	name: string,
	input: unknown,
	context: HlidAgentToolContext = {},
): Promise<AgentToolPayload> {
	if (
		name !== "capture_project_preview" &&
		name !== "export_project_preview_capture" &&
		name !== "control_project_preview"
	) {
		return { text: await executeHlidAgentTool(name, input, context) };
	}
	if (name === "export_project_preview_capture") {
		const { result, savedPath } = await requestProjectPreviewExport(
			input,
			context,
		);
		return {
			text: JSON.stringify({
				...captureMetadata(result),
				saved_path: savedPath,
			}),
			images: [{ data: result.image_base64, mimeType: result.mime }],
		};
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
