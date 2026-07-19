import type { ServerMessage } from "../server/protocol";
import {
	canonicalSessionId,
	getSubscribedSessionId,
} from "./wsSessionStatusStore";

export type LiveStats = {
	turns: number;
	cost: number;
	estimated_cost?: number;
	unpriced_queries?: number;
	duration_ms: number;
	input_tokens: number;
	output_tokens: number;
	cache_read_tokens: number;
	cache_creation_tokens: number;
	pending_input_tokens: number;
	pending_output_tokens: number;
	pending_cache_read_tokens: number;
	pending_cache_creation_tokens: number;
	context_window: number | null;
	max_output_tokens: number | null;
	last_context_used: number | null;
	last_output_tokens: number | null;
	queries: number;
};

export const EMPTY_STATS: LiveStats = {
	turns: 0,
	cost: 0,
	estimated_cost: 0,
	unpriced_queries: 0,
	duration_ms: 0,
	input_tokens: 0,
	output_tokens: 0,
	cache_read_tokens: 0,
	cache_creation_tokens: 0,
	pending_input_tokens: 0,
	pending_output_tokens: 0,
	pending_cache_read_tokens: 0,
	pending_cache_creation_tokens: 0,
	context_window: null,
	max_output_tokens: null,
	last_context_used: null,
	last_output_tokens: null,
	queries: 0,
};

const STATS_KEY = "hlid:live_stats";
const CONTEXT_SESSION_KEY = "hlid:context_stats_session";

function persistStats(stats: LiveStats): void {
	try {
		sessionStorage.setItem(STATS_KEY, JSON.stringify(stats));
	} catch {}
}

function loadPersistedStats(): LiveStats | null {
	try {
		const raw = sessionStorage.getItem(STATS_KEY);
		return raw
			? { ...EMPTY_STATS, ...(JSON.parse(raw) as Partial<LiveStats>) }
			: null;
	} catch {
		return null;
	}
}

function clearPersistedStats(): void {
	try {
		sessionStorage.removeItem(STATS_KEY);
		sessionStorage.removeItem(CONTEXT_SESSION_KEY);
	} catch {}
}

function loadContextSessionId(): string | null {
	try {
		return sessionStorage.getItem(CONTEXT_SESSION_KEY);
	} catch {
		return null;
	}
}

let liveStats: LiveStats = loadPersistedStats() ?? { ...EMPTY_STATS };
let contextSessionId: string | null = loadContextSessionId();
let pendingSessionToday = false;
const subscribers = new Set<() => void>();

function notifySubscribers(): void {
	for (const subscriber of subscribers) subscriber();
}

function markContextSession(sessionId: string): void {
	contextSessionId = canonicalSessionId(sessionId);
	try {
		sessionStorage.setItem(CONTEXT_SESSION_KEY, contextSessionId);
	} catch {}
}

export function switchStatsContext(sessionId: string): void {
	const next = canonicalSessionId(sessionId);
	const current = contextSessionId
		? canonicalSessionId(contextSessionId)
		: null;
	if (current === next) {
		markContextSession(next);
		return;
	}
	markContextSession(next);
	liveStats = {
		...liveStats,
		context_window: null,
		last_context_used: null,
	};
	persistStats(liveStats);
	notifySubscribers();
}

function markCurrentContextSession(): void {
	const sessionId = getSubscribedSessionId();
	if (sessionId) markContextSession(sessionId);
}

export function applyUsageUpdate(
	msg: Extract<ServerMessage, { type: "usage_update" }>,
): void {
	markCurrentContextSession();
	liveStats = {
		...liveStats,
		pending_input_tokens: msg.query_input_tokens,
		pending_output_tokens: msg.query_output_tokens,
		pending_cache_read_tokens: msg.query_cache_read_tokens,
		pending_cache_creation_tokens: msg.query_cache_creation_tokens,
		last_context_used: msg.tokens_in_context,
		last_output_tokens: msg.output_tokens,
		context_window: msg.context_window ?? liveStats.context_window,
	};
	persistStats(liveStats);
	notifySubscribers();
}

export function applyContextUpdate(
	msg: Extract<ServerMessage, { type: "context_update" }>,
): void {
	markCurrentContextSession();
	liveStats = {
		...liveStats,
		last_context_used: msg.tokens_in_context,
		context_window: msg.context_window,
	};
	persistStats(liveStats);
	notifySubscribers();
}

export function clearPendingUsage(): void {
	if (
		liveStats.pending_input_tokens === 0 &&
		liveStats.pending_output_tokens === 0 &&
		liveStats.pending_cache_read_tokens === 0 &&
		liveStats.pending_cache_creation_tokens === 0
	)
		return;
	liveStats = {
		...liveStats,
		pending_input_tokens: 0,
		pending_output_tokens: 0,
		pending_cache_read_tokens: 0,
		pending_cache_creation_tokens: 0,
	};
	persistStats(liveStats);
	notifySubscribers();
}

export function applyDone(msg: Extract<ServerMessage, { type: "done" }>): void {
	markCurrentContextSession();
	pendingSessionToday = false;
	liveStats = {
		turns: liveStats.turns + msg.turns,
		cost: liveStats.cost + (msg.cost ?? 0),
		estimated_cost: (liveStats.estimated_cost ?? 0) + (msg.estimated_cost ?? 0),
		unpriced_queries:
			(liveStats.unpriced_queries ?? 0) +
			(msg.cost == null && msg.estimated_cost == null ? 1 : 0),
		duration_ms: liveStats.duration_ms + msg.duration_ms,
		input_tokens: liveStats.input_tokens + msg.input_tokens,
		output_tokens: liveStats.output_tokens + msg.output_tokens,
		cache_read_tokens: liveStats.cache_read_tokens + msg.cache_read_tokens,
		cache_creation_tokens:
			liveStats.cache_creation_tokens + msg.cache_creation_tokens,
		pending_input_tokens: 0,
		pending_output_tokens: 0,
		pending_cache_read_tokens: 0,
		pending_cache_creation_tokens: 0,
		context_window: msg.context_window ?? liveStats.context_window,
		max_output_tokens: msg.max_output_tokens ?? liveStats.max_output_tokens,
		last_context_used:
			msg.tokens_in_context ??
			msg.input_tokens + msg.cache_read_tokens + msg.cache_creation_tokens,
		last_output_tokens: msg.output_tokens,
		queries: liveStats.queries + 1,
	};
	persistStats(liveStats);
	notifySubscribers();
}

export function getLiveStats(): LiveStats {
	return liveStats;
}

export function subscribeStats(fn: () => void): () => void {
	subscribers.add(fn);
	return () => subscribers.delete(fn);
}

export function resetLiveStats(): void {
	liveStats = { ...EMPTY_STATS };
	contextSessionId = null;
	clearPersistedStats();
	notifySubscribers();
}

export function setPendingSessionToday(pending: boolean): void {
	pendingSessionToday = pending;
}

export function getPendingSessionToday(): boolean {
	return pendingSessionToday;
}

export function seedContextStats(
	contextWindow: number,
	lastContextUsed: number,
	sessionId = getSubscribedSessionId(),
): void {
	const target = sessionId ? canonicalSessionId(sessionId) : null;
	const current = contextSessionId
		? canonicalSessionId(contextSessionId)
		: null;
	const sameSession = target == null || target === current;
	const nextContextWindow = sameSession
		? (liveStats.context_window ?? contextWindow)
		: contextWindow;
	const nextContextUsed = sameSession
		? (liveStats.last_context_used ?? lastContextUsed)
		: lastContextUsed;
	if (
		sameSession &&
		nextContextWindow === liveStats.context_window &&
		nextContextUsed === liveStats.last_context_used
	)
		return;
	if (target) markContextSession(target);
	liveStats = {
		...liveStats,
		context_window: nextContextWindow,
		last_context_used: nextContextUsed,
	};
	persistStats(liveStats);
	notifySubscribers();
}

export function resetLiveStatsForTesting(): void {
	liveStats = { ...EMPTY_STATS };
	contextSessionId = null;
	pendingSessionToday = false;
	subscribers.clear();
}
