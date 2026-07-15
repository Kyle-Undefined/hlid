import { z } from "zod";
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
});

const answers = z
	.record(shortText, z.array(shortText).max(20))
	.refine((value) => Object.keys(value).length <= 20, "too many answers");
const notes = z
	.record(shortText, shortText)
	.refine((value) => Object.keys(value).length <= 20, "too many notes");

const clientMessageSchema = z.discriminatedUnion("type", [
	z.strictObject({
		type: z.literal("chat"),
		text: z
			.string()
			.min(1)
			.max(1024 * 1024),
		session_id: id.optional(),
		skill_context: path.optional(),
		command_action: z.enum(["review", "computer-use"]).optional(),
		agent_cwd: path.optional(),
		attachments: z.array(attachment).max(32).optional(),
		turn_id: id.optional(),
		plan_mode: z.boolean().optional(),
		plan_html: z.boolean().optional(),
		provider: shortText.optional(),
		model: shortText.optional(),
		effort: shortText.optional(),
		permission_mode: shortText.optional(),
	}),
	z.strictObject({ type: z.literal("cancel_queued"), turn_id: id }),
	z.strictObject({ type: z.literal("promote_queued"), turn_id: id }),
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
		type: z.literal("probe_slash_commands"),
		agent_cwd: path.optional(),
		session_id: id.optional(),
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
	z.strictObject({
		type: z.literal("new_session"),
		agent_cwd: path.optional(),
		agent_name: z.string().min(1).max(256).optional(),
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
