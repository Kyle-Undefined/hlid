/** Session lookup and per-session history server fns (used by / and /raven). */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import type {
	AttachmentRow,
	MessageRow,
	PermissionEventRow,
	SessionRow,
	ToolEventRow,
} from "#/db";
import { dbJson } from "#/lib/dbClient";
import { sessionIdSchema, terminalSessionSchema } from "#/lib/serverFnSchemas";
import type { SessionStatusEntry } from "#/server/protocol";

/** Returns the session_id of the currently active/last session, or null. */
export const getCurrentSessionFn = createServerFn({ method: "GET" }).handler(
	async () => {
		const data = await dbJson<{ session_id: string | null } | null>(
			"/db/current-session",
			null,
		);
		return data?.session_id ?? null;
	},
);

/**
 * Returns the SessionRow for the currently active session (from server memory),
 * falling back to the most recent session in the DB if no session is active.
 * Uses a single round-trip to the data API instead of 2-3 sequential requests.
 */
export const getActiveSessionRowFn = createServerFn({
	method: "GET",
}).handler(() => dbJson<SessionRow | null>("/db/active-session", null));

export const getLiveSessionsFn = createServerFn({ method: "GET" }).handler(() =>
	dbJson<SessionStatusEntry[]>("/db/live-sessions", []),
);

type EnrichedMessageRow = MessageRow & {
	toolEvents?: ToolEventRow[];
	attachments?: AttachmentRow[];
};

const sessionTranscriptPageSchema = z.object({
	sessionId: sessionIdSchema,
	beforeSeq: z.number().int().nonnegative().optional(),
	beforeId: z.number().int().nonnegative().optional(),
	limit: z.number().int().min(1).max(5_001),
});

const sessionTranscriptWindowSchema = z.object({
	sessionId: sessionIdSchema,
	minSeq: z.number().int().nonnegative(),
	minId: z.number().int().nonnegative().optional(),
});

const sessionScopedPageSchema = z.object({
	sessionId: sessionIdSchema,
	minSeq: z.number().int().nonnegative(),
	beforeSeq: z.number().int().nonnegative().optional(),
	maxSeq: z.number().int().nonnegative().optional(),
});

function sessionPagePath(
	path: string,
	data: z.infer<typeof sessionScopedPageSchema>,
): string {
	const params = new URLSearchParams({
		session_id: data.sessionId,
		min_seq: String(data.minSeq),
	});
	if (data.beforeSeq !== undefined) {
		params.set("before_seq", String(data.beforeSeq));
	}
	if (data.maxSeq !== undefined) {
		params.set("max_seq", String(data.maxSeq));
	}
	return `${path}?${params}`;
}

export const getSessionDataFn = createServerFn({ method: "GET" })
	.validator((raw) =>
		z
			.union([
				sessionIdSchema,
				sessionTranscriptPageSchema,
				sessionTranscriptWindowSchema,
			])
			.parse(raw),
	)
	.handler(({ data }) => {
		if (typeof data === "string") {
			return dbJson<EnrichedMessageRow[]>(
				`/db/session-messages?session_id=${encodeURIComponent(data)}`,
				[],
			);
		}
		const params = new URLSearchParams({
			session_id: data.sessionId,
		});
		if ("limit" in data) {
			params.set("limit", String(data.limit));
			if (data.beforeSeq !== undefined) {
				params.set("before_seq", String(data.beforeSeq));
				if (data.beforeId !== undefined) {
					params.set("before_id", String(data.beforeId));
				}
			}
		} else {
			params.set("min_seq", String(data.minSeq));
			if (data.minId !== undefined) {
				params.set("min_id", String(data.minId));
			}
		}
		return dbJson<EnrichedMessageRow[]>(`/db/session-messages?${params}`, []);
	});

/** Returns all persisted Raven controls in one session-scoped read. */
export const getSessionSelectionFn = createServerFn({ method: "GET" })
	.validator((raw) => sessionIdSchema.parse(raw))
	.handler(async ({ data: sessionId }) => {
		const { getSessionSelection } = await import("#/db");
		return getSessionSelection(sessionId);
	});

export const getSessionPermissionsFn = createServerFn({ method: "GET" })
	.validator((raw) =>
		z.union([sessionIdSchema, sessionScopedPageSchema]).parse(raw),
	)
	.handler(({ data }) =>
		dbJson<PermissionEventRow[]>(
			typeof data === "string"
				? `/db/session-permissions?session_id=${encodeURIComponent(data)}`
				: sessionPagePath("/db/session-permissions", data),
			[],
		),
	);

const getSessionRows = <T>(
	path: string,
	data: string | z.infer<typeof sessionScopedPageSchema>,
) =>
	dbJson<T[]>(
		typeof data === "string"
			? `${path}?session_id=${encodeURIComponent(data)}`
			: sessionPagePath(path, data),
		[],
	);

const validateSessionRowsRequest = (raw: unknown) =>
	z.union([sessionIdSchema, sessionScopedPageSchema]).parse(raw);

type SessionPlanProposalRow = {
	proposal_id: string;
	seq: number;
	plan: string;
	decision: string;
	html_attachment_id: string | null;
	timestamp: number;
};

export const getSessionPlanProposalsFn = createServerFn({ method: "GET" })
	.validator(validateSessionRowsRequest)
	.handler(({ data }) =>
		getSessionRows<SessionPlanProposalRow>("/db/session-plan-proposals", data),
	);

type SessionAskUserQuestionRow = {
	request_id: string;
	seq: number;
	questions_json: string;
	answers_json: string | null;
	notes_json: string | null;
	timestamp: number;
};

export const getSessionAskUserQuestionsFn = createServerFn({ method: "GET" })
	.validator(validateSessionRowsRequest)
	.handler(({ data }) =>
		getSessionRows<SessionAskUserQuestionRow>(
			"/db/session-ask-user-questions",
			data,
		),
	);

export const getSessionContextFn = createServerFn({ method: "GET" })
	.validator((raw) => sessionIdSchema.parse(raw))
	.handler(({ data: sessionId }) =>
		dbJson<{
			context_window: number | null;
			last_context_used: number | null;
			actual_model: string | null;
		} | null>(
			`/db/session-context?session_id=${encodeURIComponent(sessionId)}`,
			null,
		),
	);

/**
 * Ensure a DB session row exists for the given session ID.
 * Terminal sessions don't write messages/tool_events but do need a row so
 * the Ledger shows an entry and resume works when switching back to custom UI.
 */
export const ensureSessionFn = createServerFn({ method: "POST" })
	.validator((raw) => terminalSessionSchema.parse(raw))
	.handler(async ({ data: { id, label, model } }) => {
		const { createSession } = await import("#/db");
		await createSession(id, label, model);
	});
