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

export const getSessionDataFn = createServerFn({ method: "GET" })
	.validator((raw) =>
		z
			.string()
			.refine((s) => s.trim().length > 0, "sessionId must be non-empty")
			.parse(raw),
	)
	.handler(({ data: sessionId }) =>
		dbJson<EnrichedMessageRow[]>(
			`/db/session-messages?session_id=${encodeURIComponent(sessionId)}`,
			[],
		),
	);

export const getSessionAgentCwdFn = createServerFn({ method: "GET" })
	.validator((raw) => sessionIdSchema.parse(raw))
	.handler(async ({ data: sessionId }) => {
		const { getSessionAgentCwd } = await import("#/db");
		return getSessionAgentCwd(sessionId);
	});

export const getSessionModelFn = createServerFn({ method: "GET" })
	.validator((raw) => sessionIdSchema.parse(raw))
	.handler(async ({ data: sessionId }) => {
		const { getSessionModel } = await import("#/db");
		return getSessionModel(sessionId);
	});

export const getSessionProviderIdFn = createServerFn({ method: "GET" })
	.validator((raw) => sessionIdSchema.parse(raw))
	.handler(async ({ data: sessionId }) => {
		const { getSessionProviderId } = await import("#/db");
		return getSessionProviderId(sessionId);
	});

export const getSessionPermissionsFn = createServerFn({ method: "GET" })
	.validator((raw) => sessionIdSchema.parse(raw))
	.handler(({ data: sessionId }) =>
		dbJson<PermissionEventRow[]>(
			`/db/session-permissions?session_id=${encodeURIComponent(sessionId)}`,
			[],
		),
	);

const getSessionRows = <T>(path: string, sessionId: string) =>
	dbJson<T[]>(`${path}?session_id=${encodeURIComponent(sessionId)}`, []);

type SessionPlanProposalRow = {
	proposal_id: string;
	seq: number;
	plan: string;
	decision: string;
	html_attachment_id: string | null;
	timestamp: number;
};

export const getSessionPlanProposalsFn = createServerFn({ method: "GET" })
	.validator((raw) => sessionIdSchema.parse(raw))
	.handler(({ data: sessionId }) =>
		getSessionRows<SessionPlanProposalRow>(
			"/db/session-plan-proposals",
			sessionId,
		),
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
	.validator((raw) => sessionIdSchema.parse(raw))
	.handler(({ data: sessionId }) =>
		getSessionRows<SessionAskUserQuestionRow>(
			"/db/session-ask-user-questions",
			sessionId,
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
