/** Session lookup and per-session history server fns (used by / and /raven). */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import type {
	AttachmentRow,
	MessageRow,
	PermissionEventRow,
	SessionRow,
	ToolEventDetailRow,
	ToolEventSummaryRow,
} from "#/db";
import { dbFetch, dbJson, requireDbOk } from "#/lib/dbClient";
import {
	sessionForkSchema,
	sessionIdSchema,
	sessionToolEventSchema,
	terminalSessionSchema,
} from "#/lib/serverFnSchemas";
import type { SessionStatusEntry } from "#/server/protocol";

// These reads enrich an already-readable transcript. A transient internal
// transport miss should settle before the UI slow-request threshold instead
// of consuming the generic five-second read timeout.
const SESSION_METADATA_READ_BUDGET = {
	initialTimeoutMs: 1_000,
	retryTimeoutMs: 500,
} as const;

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

export const getSessionRowFn = createServerFn({ method: "GET" })
	.validator((raw) => sessionIdSchema.parse(raw))
	.handler(({ data }) =>
		dbJson<SessionRow | null>(
			`/db/session-row?id=${encodeURIComponent(data)}`,
			null,
			SESSION_METADATA_READ_BUDGET,
		),
	);

export const getLiveSessionsFn = createServerFn({ method: "GET" }).handler(() =>
	dbJson<SessionStatusEntry[]>("/db/live-sessions", []),
);

const sessionIdsSchema = z.array(sessionIdSchema).max(64);

/** Fetch persisted totals for the DB chats currently attached to live sessions. */
export const getSessionRowsByIdsFn = createServerFn({ method: "GET" })
	.validator((raw) => sessionIdsSchema.parse(raw))
	.handler(async ({ data: sessionIds }) => {
		const { getSessionById } = await import("#/db");
		const uniqueIds = [...new Set(sessionIds)];
		const rows = await Promise.all(uniqueIds.map((id) => getSessionById(id)));
		return rows.filter((row): row is SessionRow => row !== null);
	});

type EnrichedMessageRow = MessageRow & {
	toolEvents?: ToolEventSummaryRow[];
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

/** Hydrates a complete historical tool result only when its block is opened. */
export const getSessionToolEventDetailFn = createServerFn({ method: "GET" })
	.validator((raw) => sessionToolEventSchema.parse(raw))
	.handler(({ data }) => {
		const params = new URLSearchParams({
			session_id: data.sessionId,
			tool_id: data.toolId,
		});
		return dbJson<ToolEventDetailRow | null>(
			`/db/session-tool-event?${params}`,
			null,
		);
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
			SESSION_METADATA_READ_BUDGET,
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
		SESSION_METADATA_READ_BUDGET,
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
			SESSION_METADATA_READ_BUDGET,
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

/**
 * Fork a session's transcript into a brand-new session (Claude-only today —
 * see AgentProvider.forkSession). Used by Ledger's row action, Raven's
 * in-session fork button, and Raven's per-message "branch from here" action
 * (pass `messageId` to branch up to and including that assistant row instead
 * of the whole session).
 */
export const forkSessionFn = createServerFn({ method: "POST" })
	.validator((raw) => sessionForkSchema.parse(raw))
	.handler(async ({ data }) => {
		const res = await requireDbOk(
			await dbFetch("/db/session/fork", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ id: data.id, messageId: data.messageId }),
			}),
			"fork session",
		);
		return res.json() as Promise<{ ok: true; id: string }>;
	});
