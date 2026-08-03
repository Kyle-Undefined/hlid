import { z } from "zod";
import {
	MAX_COMPOSER_REFERENCES,
	MAX_WORKSPACE_REFERENCES,
} from "../lib/vaultReferences";
import type { ClientMessage } from "./protocol";

export const MAX_WS_PAYLOAD_BYTES = 2 * 1024 * 1024;
const id = z.string().min(1).max(256);
const path = z.string().min(1).max(4096);
const shortText = z.string().max(4096);
const noFields = <T extends string>(type: T) =>
	z.strictObject({ type: z.literal(type) });

const attachment = z.strictObject({
	id,
	path,
	filename: z.string().min(1).max(512),
	mime: z.string().min(1).max(256),
	kind: z.string().min(1).max(64),
	reference: z.literal("relic").optional(),
});

const workspaceReference = z.strictObject({
	relativePath: path,
	sha256: z.string().regex(/^[a-f0-9]{64}$/),
});

const goalStart = z.strictObject({
	objective: z.string().trim().min(1).max(4000),
	token_budget: z.number().int().positive().nullable().optional(),
});

const answers = z
	.record(shortText, z.array(shortText).max(20))
	.refine((value) => Object.keys(value).length <= 20, "too many answers");
const notes = z
	.record(shortText, shortText)
	.refine((value) => Object.keys(value).length <= 20, "too many notes");

const clientMessageSchema = z.discriminatedUnion("type", [
	z
		.strictObject({
			type: z.literal("chat"),
			text: z.string().max(1024 * 1024),
			session_id: id.optional(),
			skill_context: path.optional(),
			skill_contexts: z.array(path).optional(),
			command_action: z.enum(["review", "computer-use", "compact"]).optional(),
			agent_cwd: path.optional(),
			attachments: z.array(attachment).max(32).optional(),
			vault_references: z.array(path).max(32).optional(),
			workspace_references: z
				.array(workspaceReference)
				.max(MAX_WORKSPACE_REFERENCES)
				.optional(),
			turn_id: id.optional(),
			plan_mode: z.boolean().optional(),
			plan_html: z.boolean().optional(),
			provider: shortText.optional(),
			model: shortText.optional(),
			effort: shortText.optional(),
			permission_mode: shortText.optional(),
			goal: goalStart.optional(),
		})
		.refine(
			(message) =>
				message.text.length > 0 ||
				(message.attachments?.length ?? 0) > 0 ||
				(message.vault_references?.length ?? 0) > 0 ||
				(message.workspace_references?.length ?? 0) > 0,
			{ message: "chat requires text, an attachment, or a vault reference" },
		)
		.refine(
			(message) =>
				(message.vault_references?.length ?? 0) +
					(message.workspace_references?.length ?? 0) +
					(message.attachments?.filter(
						(attachment) => attachment.reference === "relic",
					).length ?? 0) <=
				MAX_COMPOSER_REFERENCES,
			{ message: "chat has too many exact references" },
		),
	z.strictObject({ type: z.literal("cancel_queued"), turn_id: id }),
	z.strictObject({ type: z.literal("promote_queued"), turn_id: id }),
	z.strictObject({ type: z.literal("steer_queued"), turn_id: id }),
	z.strictObject({
		type: z.literal("steer_active"),
		session_id: id,
		turn_id: id,
		text: z
			.string()
			.trim()
			.min(1)
			.max(1024 * 1024),
	}),
	noFields("abort"),
	noFields("skip_sleep"),
	noFields("clear"),
	noFields("reload_session"),
	z.strictObject({
		type: z.literal("permission_response"),
		id,
		approved: z.boolean(),
		saveScope: z.enum(["session", "local"]).optional(),
		denyMessage: shortText.optional(),
	}),
	noFields("sync"),
	z.strictObject({
		type: z.literal("probe_mcp"),
		agent_cwd: path.optional(),
		session_id: id.optional(),
	}),
	z.strictObject({
		type: z.literal("mcp_control"),
		request_id: id,
		session_id: id,
		server_name: z.string().trim().min(1).max(512),
		action: z.enum([
			"reconnect",
			"enable",
			"disable",
			"permission-default",
			"permission-auto",
			"permission-clear",
		]),
	}),
	z
		.strictObject({
			type: z.literal("file_rewind"),
			request_id: id,
			session_id: id,
			turn_id: id,
			action: z.enum(["preview", "execute"]),
			preview_id: id.optional(),
		})
		.superRefine((value, context) => {
			if (value.action === "execute" && !value.preview_id) {
				context.addIssue({
					code: "custom",
					message: "preview_id is required when executing a file rewind",
					path: ["preview_id"],
				});
			}
			if (value.action === "preview" && value.preview_id !== undefined) {
				context.addIssue({
					code: "custom",
					message: "preview_id is only valid when executing a file rewind",
					path: ["preview_id"],
				});
			}
		}),
	z.strictObject({
		type: z.literal("probe_slash_commands"),
		agent_cwd: path.optional(),
		session_id: id.optional(),
	}),
	z.strictObject({
		type: z.literal("probe_workflows"),
		agent_cwd: path.optional(),
		session_id: id.optional(),
	}),
	z.strictObject({
		type: z.literal("save_workflow"),
		request_id: id,
		session_id: id.optional(),
		source_script_path: path,
		scope: z.enum(["project", "personal"]),
		overwrite: z.boolean().optional(),
	}),
	z.strictObject({
		type: z.literal("delete_workflow"),
		request_id: id,
		session_id: id.optional(),
		script_path: path,
		scope: z.enum(["project", "personal"]),
	}),
	z.strictObject({
		type: z.literal("read_workflow_source"),
		request_id: id,
		session_id: id.optional(),
		script_path: path,
		scope: z.enum(["project", "personal"]).optional(),
	}),
	z
		.strictObject({
			type: z.literal("goal_control"),
			request_id: id,
			session_id: id,
			action: z.enum(["get", "set", "pause", "resume", "clear"]),
			objective: z.string().max(4000).optional(),
			token_budget: z.number().int().positive().nullable().optional(),
			agent_cwd: path.optional(),
		})
		.superRefine((value, context) => {
			if (value.action === "set" && !value.objective?.trim()) {
				context.addIssue({
					code: "custom",
					message: "objective is required when setting a goal",
					path: ["objective"],
				});
			}
			if (value.action !== "set" && value.objective !== undefined) {
				context.addIssue({
					code: "custom",
					message: "objective is only valid when setting a goal",
					path: ["objective"],
				});
			}
			if (value.action !== "set" && value.token_budget !== undefined) {
				context.addIssue({
					code: "custom",
					message: "token_budget is only valid when setting a goal",
					path: ["token_budget"],
				});
			}
		}),
	z.strictObject({
		type: z.literal("realtime_start"),
		session_id: id,
		mode: z.enum(["dictation", "live", "read-aloud"]),
		sdp: z
			.string()
			.min(1)
			.max(512 * 1024),
		voice: z.string().min(1).max(64).optional(),
		agent_cwd: path.optional(),
	}),
	z.strictObject({
		type: z.literal("realtime_speak"),
		session_id: id,
		text: z
			.string()
			.trim()
			.min(1)
			.max(1024 * 1024),
	}),
	z.strictObject({
		type: z.literal("realtime_stop"),
		session_id: id,
	}),
	z.strictObject({
		type: z.literal("sync_mcp_list"),
		agent_cwd: path.optional(),
		inventory: z.boolean().optional(),
	}),
	z.strictObject({
		type: z.literal("ask_user_question_response"),
		id,
		answers,
		notes: notes.optional(),
	}),
	z
		.strictObject({
			type: z.literal("plan_mode_exit_response"),
			id,
			decision: z.enum(["approved", "cancelled", "edited"]),
			feedback: shortText.optional(),
		})
		.superRefine((value, context) => {
			if (value.decision === "edited" && value.feedback === undefined) {
				context.addIssue({
					code: "custom",
					message: "feedback is required for an edited plan",
					path: ["feedback"],
				});
			}
			if (value.decision !== "edited" && value.feedback !== undefined) {
				context.addIssue({
					code: "custom",
					message: "feedback is only valid for an edited plan",
					path: ["feedback"],
				});
			}
		}),
	z.strictObject({ type: z.literal("subscribe_session"), session_id: id }),
	z.strictObject({ type: z.literal("stop_session"), session_id: id }),
	z.strictObject({ type: z.literal("close_session"), session_id: id }),
	z.strictObject({
		type: z.literal("set_provider"),
		provider: shortText,
		model: shortText.optional(),
		effort: shortText.optional(),
		permission_mode: shortText.optional(),
		session_id: id.optional(),
	}),
	z.strictObject({
		type: z.literal("set_model"),
		model: shortText.optional(),
		session_id: id.optional(),
	}),
	z.strictObject({
		type: z.literal("set_permission_mode"),
		mode: shortText,
		session_id: id.optional(),
	}),
	z.strictObject({
		type: z.literal("set_effort"),
		effort: shortText,
		session_id: id.optional(),
	}),
	z.strictObject({
		type: z.literal("workflow_control"),
		action: z.literal("stop"),
		task_id: id,
		session_id: id.optional(),
	}),
	z
		.strictObject({
			type: z.literal("background_activity_control"),
			action: z.enum(["background", "stop", "terminate", "clean"]),
			activity_id: id.optional(),
			session_id: id.optional(),
		})
		.refine(
			(message) =>
				(message.action !== "stop" && message.action !== "terminate") ||
				Boolean(message.activity_id?.trim()),
			{ message: "stop and terminate require activity_id" },
		),
]);

export function parseClientMessage(raw: string): ClientMessage | null {
	if (Buffer.byteLength(raw, "utf8") > MAX_WS_PAYLOAD_BYTES) return null;
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		return null;
	}
	const result = clientMessageSchema.safeParse(value);
	return result.success ? (result.data as ClientMessage) : null;
}

const terminalResizeSchema = z.strictObject({
	type: z.literal("resize"),
	cols: z.number().finite().int(),
	rows: z.number().finite().int(),
});

export type TerminalDimensions = { cols: number; rows: number };

function clampTerminalDimensions(
	cols: number,
	rows: number,
): TerminalDimensions {
	return {
		cols: Math.min(500, Math.max(2, Math.trunc(cols))),
		rows: Math.min(200, Math.max(1, Math.trunc(rows))),
	};
}

export function parseTerminalResize(raw: string): TerminalDimensions | null {
	if (Buffer.byteLength(raw, "utf8") > 1024) return null;
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		return null;
	}
	const result = terminalResizeSchema.safeParse(value);
	return result.success
		? clampTerminalDimensions(result.data.cols, result.data.rows)
		: null;
}

const terminalTerminateSchema = z.strictObject({
	type: z.literal("terminate"),
});

/** Explicit "toggle off" control frame — kills the PTY immediately, bypassing the idle timer. */
export function parseTerminalTerminate(raw: string): boolean {
	if (Buffer.byteLength(raw, "utf8") > 1024) return false;
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		return false;
	}
	return terminalTerminateSchema.safeParse(value).success;
}

export function parseInitialTerminalDimensions(
	cols: string | null,
	rows: string | null,
): TerminalDimensions {
	const parsedCols = Number(cols ?? 80);
	const parsedRows = Number(rows ?? 24);
	return clampTerminalDimensions(
		Number.isFinite(parsedCols) ? parsedCols : 80,
		Number.isFinite(parsedRows) ? parsedRows : 24,
	);
}
