import type { Database } from "bun:sqlite";
import { canonicalizeCodexUsage, estimateCodexCost } from "../lib/codexPricing";
import {
	codexChildrenByParent as childIdsByParent,
	codexDirectChildIds,
} from "./codexRolloutGraph";
import { asJsonObject as asObject, readJsonlObjects } from "./jsonl";
import {
	addUsageBuckets as addUsage,
	costKnownSql,
	EMPTY_USAGE_BUCKETS as EMPTY_USAGE,
	ensureUsageRepairRunsTable,
	finiteNumber,
	storedQueriesForSession as queriesForSession,
	rebuildUsageDate,
	recordUsageRepairRun,
	type StoredQuery,
	type StoredUsageQuery,
	selectStoredQueryById as selectQueryById,
	selectStoredUsageQueryById as selectUsageQueryById,
	storedUsageBuckets as storedUsage,
	storedUsageFingerprintMatches,
	subtractUsageBuckets as subtractUsage,
	tableHasColumn,
	type UsageTokenBuckets,
	usageBucketsEqual as usageEquals,
	usageBucketsPositive as usageIsPositive,
	storedUsageQueriesForSession as usageQueriesForSession,
	usageTokenTotal,
} from "./usageRepairShared";

export const CODEX_USAGE_REPAIR_VERSION = 3 as const;

export type TokenBuckets = UsageTokenBuckets;

type UsageIncrement = {
	atMs: number;
	usage: TokenBuckets;
	model: string | null;
};

type ContextSnapshot = {
	atMs: number;
	tokens: number;
	window: number | null;
};

type RolloutTurn = {
	id: string;
	startedAtMs: number;
	endedAtMs: number | null;
	terminal: "completed" | "aborted" | null;
	increments: UsageIncrement[];
	legacyUsage: TokenBuckets;
	contexts: ContextSnapshot[];
	webSearchIds: Set<string>;
	childIds: Set<string>;
};

export type ParsedCodexRollout = {
	path: string;
	sha256: string;
	threadId: string;
	parentThreadId: string | null;
	originator: string | null;
	createdAtMs: number;
	turns: RolloutTurn[];
};

type StoredSession = {
	id: string;
	provider_session_id: string | null;
	started_at: number;
	model: string | null;
	selected_model: string | null;
	actual_model: string | null;
};

export type RepairConfidence = "legacy-root" | "legacy-root-and-children";

type RowFingerprint = {
	id: number;
	sessionId: string;
	timestamp: number;
	cost: number;
	estimatedCost: number | null;
	costKnown: number;
	usage: TokenBuckets;
	turns: number;
};

export type CodexUsageRepairRow = {
	sessionId: string;
	providerSessionId: string;
	query: RowFingerprint & {
		contextWindow: number | null;
		tokensInContext: number | null;
	};
	usageQuery: RowFingerprint & {
		providerId: string;
		unpriced: number;
	};
	corrected: {
		usage: TokenBuckets;
		estimatedCost: number | null;
		unpriced: number;
	};
	evidence: {
		confidence: RepairConfidence;
		rootThreadId: string;
		rootTurnIds: string[];
		childThreadIds: string[];
		rolloutHashes: string[];
	};
};

export type CodexUsageProviderCorrection = {
	sessionId: string;
	usageQuery: CodexUsageRepairRow["usageQuery"];
	sessionProviderId: string;
};

export type CodexUsageRepairUnresolved = {
	sessionId: string;
	providerSessionId: string | null;
	queryId?: number;
	reason:
		| "missing-provider-thread"
		| "missing-rollout"
		| "ledger-row-count-mismatch"
		| "ledger-row-mismatch"
		| "no-terminal-candidate"
		| "ambiguous-terminal-candidate"
		| "legacy-fingerprint-mismatch"
		| "unrecoverable-child"
		| "unrecoverable-windows-worker";
	detail?: string;
};

export type CodexUsageRepairManifest = {
	version: typeof CODEX_USAGE_REPAIR_VERSION;
	createdAt: string;
	databasePath?: string;
	rolloutRoots: string[];
	scannedRollouts: number;
	rows: CodexUsageRepairRow[];
	providerCorrections: CodexUsageProviderCorrection[];
	unresolved: CodexUsageRepairUnresolved[];
	totals: {
		before: TokenBuckets;
		after: TokenBuckets;
	};
};

export type ApplyCodexUsageRepairResult = {
	appliedRows: number;
	alreadyCorrectRows: number;
	correctedProviderRows: number;
	alreadyCorrectProviderRows: number;
	affectedSessions: number;
	affectedDates: number;
};

function usageIsNondecreasing(
	current: TokenBuckets,
	previous: TokenBuckets,
): boolean {
	return (
		current.inputTokens >= previous.inputTokens &&
		current.outputTokens >= previous.outputTokens &&
		current.cacheReadTokens >= previous.cacheReadTokens &&
		current.cacheCreationTokens >= previous.cacheCreationTokens
	);
}

function canonicalUsage(value: unknown): TokenBuckets | null {
	const usage = asObject(value);
	const hasUsage = [
		usage.inputTokens,
		usage.input_tokens,
		usage.outputTokens,
		usage.output_tokens,
		usage.cachedInputTokens,
		usage.cached_input_tokens,
	].some((item) => typeof item === "number");
	if (!hasUsage) return null;
	return canonicalizeCodexUsage({
		inputTokens: finiteNumber(
			usage.inputTokens ?? usage.input_tokens ?? usage.input,
		),
		outputTokens: finiteNumber(
			usage.outputTokens ?? usage.output_tokens ?? usage.output,
		),
		cacheReadTokens: finiteNumber(
			usage.cacheReadTokens ??
				usage.cache_read_input_tokens ??
				usage.cachedInputTokens ??
				usage.cached_input_tokens,
		),
		cacheCreationTokens: finiteNumber(
			usage.cacheCreationTokens ??
				usage.cache_creation_input_tokens ??
				usage.cacheWriteInputTokens ??
				usage.cache_write_input_tokens ??
				usage.cacheWriteTokens ??
				usage.cache_write_tokens,
		),
	});
}

function tokenEnvelope(
	payload: Record<string, unknown>,
): Record<string, unknown> {
	return asObject(payload.info ?? payload.usage ?? payload.tokenUsage);
}

function eventTimeMs(record: Record<string, unknown>): number {
	const value = record.timestamp;
	if (typeof value !== "string") return 0;
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? parsed : 0;
}

function terminalTimeMs(
	record: Record<string, unknown>,
	payload: Record<string, unknown>,
): number {
	const seconds = finiteNumber(payload.completed_at ?? payload.completedAt);
	return seconds > 0 ? seconds * 1000 : eventTimeMs(record);
}

function parentThreadId(meta: Record<string, unknown>): string | null {
	if (typeof meta.parent_thread_id === "string") return meta.parent_thread_id;
	const source = asObject(meta.source);
	const subagent = asObject(source.subagent);
	const spawn = asObject(subagent.thread_spawn);
	if (typeof spawn.parent_thread_id === "string") {
		return spawn.parent_thread_id;
	}
	return typeof meta.forked_from_id === "string" ? meta.forked_from_id : null;
}

function ownedStartIndex(
	records: Record<string, unknown>[],
	metaCreatedAtMs: number,
): number {
	const minimumStartedAt = Math.floor(metaCreatedAtMs / 1000) - 1;
	return records.findIndex((record) => {
		if (record.type !== "event_msg") return false;
		const payload = asObject(record.payload);
		return (
			payload.type === "task_started" &&
			finiteNumber(payload.started_at ?? payload.startedAt) >= minimumStartedAt
		);
	});
}

export async function parseCodexRollout(
	path: string,
): Promise<ParsedCodexRollout | null> {
	const { records, text } = await readJsonlObjects(path);
	if (records.length === 0) return null;
	const first = records[0];
	if (first?.type !== "session_meta") return null;
	const meta = asObject(first.payload);
	const threadId =
		typeof meta.id === "string"
			? meta.id
			: typeof meta.session_id === "string"
				? meta.session_id
				: "";
	if (!threadId) return null;
	const metaTimestamp =
		typeof meta.timestamp === "string"
			? Date.parse(meta.timestamp)
			: eventTimeMs(first);
	const createdAtMs = Number.isFinite(metaTimestamp)
		? metaTimestamp
		: eventTimeMs(first);
	const startIndex = ownedStartIndex(records, createdAtMs);
	const legacyMode = !records.some((record) => {
		if (record.type !== "event_msg") return false;
		return asObject(record.payload).type === "task_started";
	});
	const turns: RolloutTurn[] = [];
	let currentTurn: RolloutTurn | null = null;
	let currentModel: string | null = null;
	let previousTotal: TokenBuckets | null = null;
	let legacySawAgentMessage = false;
	let legacyLastEventAtMs = 0;
	const isLegacyResponseEvidence = (
		record: Record<string, unknown>,
		payload: Record<string, unknown>,
	): boolean => {
		if (record.type === "event_msg") {
			return payload.type === "agent_message" || payload.type === "token_count";
		}
		if (record.type !== "response_item") return false;
		if (payload.type === "message") return payload.role === "assistant";
		return (
			payload.type === "reasoning" ||
			payload.type === "function_call" ||
			payload.type === "custom_tool_call" ||
			payload.type === "web_search_call" ||
			payload.type === "computer_call"
		);
	};
	const finishLegacyTurn = () => {
		if (!legacyMode || !currentTurn) return;
		if (legacySawAgentMessage) {
			currentTurn.endedAtMs = Math.max(
				currentTurn.startedAtMs,
				legacyLastEventAtMs,
			);
			currentTurn.terminal = "completed";
		}
		currentTurn = null;
		legacySawAgentMessage = false;
		legacyLastEventAtMs = 0;
	};
	for (let index = Math.max(0, startIndex); index < records.length; index++) {
		const record = records[index];
		const payload = asObject(record.payload);
		const atMs = eventTimeMs(record);
		if (
			legacyMode &&
			record.type === "event_msg" &&
			payload.type === "user_message"
		) {
			finishLegacyTurn();
			currentTurn = {
				id: `legacy-${atMs || createdAtMs}-${turns.length + 1}`,
				startedAtMs: atMs || createdAtMs,
				endedAtMs: null,
				terminal: null,
				increments: [],
				legacyUsage: { ...EMPTY_USAGE },
				contexts: [],
				webSearchIds: new Set(),
				childIds: new Set(),
			};
			turns.push(currentTurn);
			legacyLastEventAtMs = currentTurn.startedAtMs;
			continue;
		}
		if (
			legacyMode &&
			currentTurn &&
			isLegacyResponseEvidence(record, payload)
		) {
			legacyLastEventAtMs = Math.max(legacyLastEventAtMs, atMs);
			if (record.type === "event_msg" && payload.type === "agent_message") {
				legacySawAgentMessage = true;
			}
		}
		if (record.type === "turn_context") {
			if (typeof payload.model === "string") currentModel = payload.model;
			continue;
		}
		if (record.type === "event_msg" && payload.type === "task_started") {
			const startedSeconds = finiteNumber(
				payload.started_at ?? payload.startedAt,
			);
			currentTurn = {
				id:
					typeof payload.turn_id === "string"
						? payload.turn_id
						: `turn-${turns.length + 1}`,
				startedAtMs: startedSeconds > 0 ? startedSeconds * 1000 : atMs,
				endedAtMs: null,
				terminal: null,
				increments: [],
				legacyUsage: { ...EMPTY_USAGE },
				contexts: [],
				webSearchIds: new Set(),
				childIds: new Set(),
			};
			turns.push(currentTurn);
			continue;
		}
		if (!currentTurn) continue;
		if (
			record.type === "event_msg" &&
			payload.type === "sub_agent_activity" &&
			payload.kind === "started" &&
			typeof payload.agent_thread_id === "string"
		) {
			currentTurn.childIds.add(payload.agent_thread_id);
			continue;
		}
		if (record.type === "event_msg" && payload.type === "token_count") {
			const envelope = tokenEnvelope(payload);
			const total = canonicalUsage(
				envelope.total ??
					envelope.totalTokenUsage ??
					envelope.total_token_usage,
			);
			const last = canonicalUsage(
				envelope.last ?? envelope.lastTokenUsage ?? envelope.last_token_usage,
			);
			if (!total) continue;
			const increment =
				previousTotal && usageIsNondecreasing(total, previousTotal)
					? subtractUsage(total, previousTotal)
					: (last ?? total);
			previousTotal = total;
			if (last) {
				currentTurn.legacyUsage = last;
				currentTurn.contexts.push({
					atMs,
					tokens:
						last.inputTokens + last.cacheReadTokens + last.cacheCreationTokens,
					window:
						finiteNumber(
							envelope.modelContextWindow ?? envelope.model_context_window,
						) || null,
				});
			}
			if (usageIsPositive(increment)) {
				currentTurn.increments.push({
					atMs,
					usage: increment,
					model: currentModel,
				});
			}
			continue;
		}
		if (
			record.type === "response_item" &&
			payload.type === "web_search_call" &&
			payload.status === "completed" &&
			typeof payload.id === "string"
		) {
			currentTurn.webSearchIds.add(payload.id);
			continue;
		}
		if (
			record.type === "event_msg" &&
			(payload.type === "task_complete" || payload.type === "turn_aborted")
		) {
			currentTurn.endedAtMs = terminalTimeMs(record, payload);
			currentTurn.terminal =
				payload.type === "task_complete" ? "completed" : "aborted";
			currentTurn = null;
		}
	}
	finishLegacyTurn();
	const hash = new Bun.CryptoHasher("sha256").update(text).digest("hex");
	return {
		path,
		sha256: hash,
		threadId,
		parentThreadId: parentThreadId(meta),
		originator: typeof meta.originator === "string" ? meta.originator : null,
		createdAtMs,
		turns,
	};
}

export async function loadCodexRollouts(
	rolloutRoots: string[],
): Promise<Map<string, ParsedCodexRollout>> {
	const rollouts = new Map<string, ParsedCodexRollout>();
	for (const root of rolloutRoots) {
		const glob = new Bun.Glob("**/rollout-*.jsonl");
		try {
			for await (const path of glob.scan({ cwd: root, absolute: true })) {
				const rollout = await parseCodexRollout(path);
				if (!rollout) continue;
				const existing = rollouts.get(rollout.threadId);
				if (!existing || compareRolloutEvidence(rollout, existing) > 0) {
					rollouts.set(rollout.threadId, rollout);
				}
			}
		} catch {
			// Missing optional roots (for example Windows-native history from WSL)
			// are reflected by unresolved session rows in the manifest.
		}
	}
	return rollouts;
}

function rolloutEvidence(rollout: ParsedCodexRollout): number[] {
	return [
		rollout.turns.filter((turn) => turn.terminal === "completed").length,
		rollout.turns.filter((turn) => turn.terminal !== null).length,
		rollout.turns.reduce((total, turn) => total + turn.increments.length, 0),
		rollout.turns.reduce((total, turn) => total + turn.contexts.length, 0),
		rollout.turns.reduce((total, turn) => total + turn.childIds.size, 0),
		rollout.turns.reduce((total, turn) => total + turn.webSearchIds.size, 0),
		rollout.turns.length,
		Math.max(0, ...rollout.turns.map((turn) => turn.endedAtMs ?? 0)),
	];
}

function compareRolloutEvidence(
	candidate: ParsedCodexRollout,
	existing: ParsedCodexRollout,
): number {
	const candidateEvidence = rolloutEvidence(candidate);
	const existingEvidence = rolloutEvidence(existing);
	for (let index = 0; index < candidateEvidence.length; index++) {
		const difference = candidateEvidence[index] - existingEvidence[index];
		if (difference !== 0) return difference;
	}
	// Content-equivalent copies are harmless; a stable path tie-break prevents
	// optional archive/root ordering from changing the selected manifest.
	return candidate.path.localeCompare(existing.path);
}

function completedTurns(
	rollout: ParsedCodexRollout,
): Array<RolloutTurn & { endedAtMs: number }> {
	return rollout.turns.filter(
		(turn): turn is RolloutTurn & { endedAtMs: number } =>
			turn.terminal === "completed" && turn.endedAtMs != null,
	);
}

type TurnEvidence = { rollout: ParsedCodexRollout; turn: RolloutTurn };

type ChildTree = {
	turns: TurnEvidence[];
	threadIds: string[];
	hashes: string[];
	turnKeys: string[];
	exact: boolean;
};

function expandChildTree(args: {
	owner: ParsedCodexRollout;
	ownerTurn: RolloutTurn & { endedAtMs: number };
	rollouts: Map<string, ParsedCodexRollout>;
	children: Map<string, string[]>;
}): ChildTree {
	type Pending = {
		id: string;
		startMs: number;
		endMs: number;
	};
	const queue: Pending[] = codexDirectChildIds({
		owner: args.owner,
		turn: args.ownerTurn,
		rollouts: args.rollouts,
		children: args.children,
	}).map((id) => ({
		id,
		startMs: args.ownerTurn.startedAtMs,
		endMs: args.ownerTurn.endedAtMs,
	}));
	const selected: TurnEvidence[] = [];
	const threadIds = new Set<string>();
	const hashes = new Set<string>();
	const turnKeys = new Set<string>();
	let exact = true;
	while (queue.length > 0) {
		const pending = queue.shift();
		if (!pending) continue;
		const rollout = args.rollouts.get(pending.id);
		if (!rollout) {
			exact = false;
			continue;
		}
		const turns = completedTurns(rollout).filter(
			(turn) =>
				turn.startedAtMs >= pending.startMs - 1_000 &&
				turn.startedAtMs <= pending.endMs + 1_000,
		);
		if (turns.length === 0) {
			exact = false;
			continue;
		}
		threadIds.add(rollout.threadId);
		hashes.add(rollout.sha256);
		for (const turn of turns) {
			const key = `${rollout.threadId}:${turn.id}`;
			if (turnKeys.has(key)) continue;
			turnKeys.add(key);
			selected.push({ rollout, turn });
			for (const id of codexDirectChildIds({
				owner: rollout,
				turn,
				rollouts: args.rollouts,
				children: args.children,
			})) {
				queue.push({ id, startMs: turn.startedAtMs, endMs: turn.endedAtMs });
			}
		}
	}
	return {
		turns: selected,
		threadIds: [...threadIds],
		hashes: [...hashes],
		turnKeys: [...turnKeys],
		exact,
	};
}

function unavailableWindowsWorkerQueryIds(
	db: Database,
	sessionId: string,
	queries: StoredQuery[],
): Set<number> {
	const rows = db
		.query<{ subagent_json: string | null }, [string]>(
			`SELECT subagent_json FROM tool_events
			 WHERE session_id = ?
			   AND name IN ('windows_computer_use', 'hlid.windows_computer_use')`,
		)
		.all(sessionId);
	const result = new Set<number>();
	for (const row of rows) {
		if (!row.subagent_json) continue;
		try {
			const data = asObject(JSON.parse(row.subagent_json));
			const completedAt = finiteNumber(data.endedAtMs ?? data.startedAtMs);
			if (completedAt <= 0) continue;
			const owner = queries.find(
				(query) => query.timestamp * 1000 >= completedAt,
			);
			if (owner) result.add(owner.id);
		} catch {
			// An unparseable worker cannot be assigned safely, and therefore cannot
			// create a false-positive repair row.
		}
	}
	return result;
}

function fullUsageForTurns(
	turns: Array<{ rollout: ParsedCodexRollout; turn: RolloutTurn }>,
): TokenBuckets {
	let total = { ...EMPTY_USAGE };
	for (const { turn } of turns) {
		for (const increment of turn.increments) {
			total = addUsage(total, increment.usage);
		}
	}
	return total;
}

function legacyUsageForTurns(
	turns: Array<{ rollout: ParsedCodexRollout; turn: RolloutTurn }>,
): TokenBuckets {
	return turns.reduce((total, { turn }) => addUsage(total, turn.legacyUsage), {
		...EMPTY_USAGE,
	});
}

function estimatedCostForTurns(
	turns: Array<{ rollout: ParsedCodexRollout; turn: RolloutTurn }>,
	fallbackModel: string | null,
): number | null {
	let total = 0;
	for (const { turn } of turns) {
		for (const increment of turn.increments) {
			const cost = estimateCodexCost(
				increment.model ?? fallbackModel,
				increment.usage,
				{ webSearchCalls: 0 },
				increment.atMs,
			);
			if (cost == null) return null;
			total += cost;
		}
		const webSearchCost = estimateCodexCost(
			fallbackModel,
			{ ...EMPTY_USAGE },
			{ webSearchCalls: turn.webSearchIds.size },
			turn.endedAtMs ?? turn.startedAtMs,
		);
		if (webSearchCost == null) return null;
		total += webSearchCost;
	}
	return total;
}

function numberEqual(a: number | null, b: number | null): boolean {
	if (a == null || b == null) return a === b;
	return Math.abs(a - b) < 1e-9;
}

function mirroredRowsMatch(
	query: StoredQuery,
	usage: StoredUsageQuery,
): boolean {
	return (
		query.session_id === usage.session_id &&
		query.timestamp === usage.timestamp &&
		query.cost === usage.cost &&
		numberEqual(query.estimated_cost, usage.estimated_cost) &&
		query.cost_known === usage.cost_known &&
		query.turns === usage.turns &&
		usageEquals(storedUsage(query), storedUsage(usage))
	);
}

function fingerprintQuery(row: StoredQuery): CodexUsageRepairRow["query"] {
	return {
		id: row.id,
		sessionId: row.session_id,
		timestamp: row.timestamp,
		cost: row.cost,
		estimatedCost: row.estimated_cost,
		costKnown: row.cost_known,
		usage: storedUsage(row),
		turns: row.turns,
		contextWindow: row.context_window,
		tokensInContext: row.tokens_in_context,
	};
}

function fingerprintUsageQuery(
	row: StoredUsageQuery,
): CodexUsageRepairRow["usageQuery"] {
	return {
		id: row.id,
		sessionId: row.session_id ?? "",
		timestamp: row.timestamp,
		cost: row.cost,
		estimatedCost: row.estimated_cost,
		costKnown: row.cost_known,
		usage: storedUsage(row),
		turns: row.turns,
		providerId: row.provider_id,
		unpriced: row.unpriced,
	};
}

type Candidate = {
	rootTurn: RolloutTurn & { endedAtMs: number };
	rootTurns: TurnEvidence[];
	childTurns: TurnEvidence[];
	childTurnKeys: string[];
	confidence: RepairConfidence;
	correctedUsage: TokenBuckets;
	estimatedCost: number | null;
};

function candidateForQuery(args: {
	query: StoredQuery;
	root: ParsedCodexRollout;
	rootTurn: RolloutTurn & { endedAtMs: number };
	childTree: ChildTree;
	fallbackModel: string | null;
}): Candidate | null {
	const stored = storedUsage(args.query);
	const rootWindow = [{ rollout: args.root, turn: args.rootTurn }];
	const childTree = args.childTree;
	if (!childTree.exact) return null;
	const rootLegacy = args.rootTurn.legacyUsage;
	const combinedLegacy = addUsage(
		rootLegacy,
		legacyUsageForTurns(childTree.turns),
	);
	const allTurns = [...rootWindow, ...childTree.turns];
	const correctedUsage = fullUsageForTurns(allTurns);
	let confidence: RepairConfidence | null = null;
	if (usageEquals(stored, correctedUsage)) {
		confidence =
			childTree.turns.length > 0 ? "legacy-root-and-children" : "legacy-root";
	} else if (usageEquals(stored, combinedLegacy)) {
		confidence = "legacy-root-and-children";
	} else if (childTree.turns.length > 0 && usageEquals(stored, rootLegacy)) {
		// Early provider versions observed the child but omitted its final usage.
		confidence = "legacy-root";
	} else if (childTree.turns.length === 0 && usageEquals(stored, rootLegacy)) {
		confidence = "legacy-root";
	}
	if (!confidence) return null;
	return {
		rootTurn: args.rootTurn,
		rootTurns: rootWindow,
		childTurns: childTree.turns,
		childTurnKeys: childTree.turnKeys,
		confidence,
		correctedUsage,
		estimatedCost: estimatedCostForTurns(allTurns, args.fallbackModel),
	};
}

function sessionRows(db: Database): StoredSession[] {
	const liveHistoryOnly = tableHasColumn(db, "sessions", "history_imported")
		? "AND history_imported = 0"
		: "";
	return db
		.query<StoredSession, []>(`
			SELECT id, provider_session_id, started_at, model,
			       selected_model, actual_model
			FROM sessions
			WHERE provider_id = 'codex'
			  ${liveHistoryOnly}
			ORDER BY started_at, id
		`)
		.all();
}

function providerCorrections(db: Database): CodexUsageProviderCorrection[] {
	const rows = db
		.query<StoredUsageQuery & { session_provider_id: string }, []>(`
			SELECT u.id, u.session_id, u.timestamp, u.cost, u.estimated_cost,
			       ${costKnownSql(db, "usage_queries")} AS cost_known,
			       u.unpriced, u.input_tokens, u.output_tokens,
			       u.cache_read_tokens, u.cache_creation_tokens, u.turns,
			       u.provider_id, s.provider_id AS session_provider_id
			FROM usage_queries u
			JOIN sessions s ON s.id = u.session_id
			WHERE u.provider_id != s.provider_id
			  AND (u.provider_id = 'codex' OR s.provider_id = 'codex')
			ORDER BY u.id
		`)
		.all();
	return rows.map((row) => ({
		sessionId: row.session_id as string,
		usageQuery: fingerprintUsageQuery(row),
		sessionProviderId: row.session_provider_id,
	}));
}

function manifestTotals(rows: CodexUsageRepairRow[]): {
	before: TokenBuckets;
	after: TokenBuckets;
} {
	let before = { ...EMPTY_USAGE };
	let after = { ...EMPTY_USAGE };
	for (const row of rows) {
		before = addUsage(before, row.query.usage);
		after = addUsage(after, row.corrected.usage);
	}
	return { before, after };
}

export async function planCodexUsageRepair(args: {
	db: Database;
	rolloutRoots: string[];
	databasePath?: string;
}): Promise<CodexUsageRepairManifest> {
	const rollouts = await loadCodexRollouts(args.rolloutRoots);
	const rows: CodexUsageRepairRow[] = [];
	const childTurnOwners = new Map<string, number[]>();
	const unresolved: CodexUsageRepairUnresolved[] = [];
	const children = childIdsByParent(rollouts);
	for (const session of sessionRows(args.db)) {
		const queries = queriesForSession(args.db, session.id);
		const ledgerRows = usageQueriesForSession(args.db, session.id);
		if (!session.provider_session_id) {
			for (const query of queries) {
				unresolved.push({
					sessionId: session.id,
					providerSessionId: null,
					queryId: query.id,
					reason: "missing-provider-thread",
				});
			}
			continue;
		}
		const root = rollouts.get(session.provider_session_id);
		if (!root) {
			for (const query of queries) {
				unresolved.push({
					sessionId: session.id,
					providerSessionId: session.provider_session_id,
					queryId: query.id,
					reason: "missing-rollout",
				});
			}
			continue;
		}
		if (queries.length !== ledgerRows.length) {
			for (const query of queries) {
				unresolved.push({
					sessionId: session.id,
					providerSessionId: session.provider_session_id,
					queryId: query.id,
					reason: "ledger-row-count-mismatch",
					detail: `${queries.length} query rows / ${ledgerRows.length} ledger rows`,
				});
			}
			continue;
		}
		if (
			queries.some(
				(query, index) => !mirroredRowsMatch(query, ledgerRows[index]),
			)
		) {
			for (const query of queries) {
				unresolved.push({
					sessionId: session.id,
					providerSessionId: session.provider_session_id,
					queryId: query.id,
					reason: "ledger-row-mismatch",
				});
			}
			continue;
		}
		const rootTurns = completedTurns(root);
		const windowsWorkerQueries = unavailableWindowsWorkerQueryIds(
			args.db,
			session.id,
			queries,
		);
		const fallbackModel =
			session.actual_model ?? session.selected_model ?? session.model;
		let lowerBoundSeconds = session.started_at - 2;
		for (let queryIndex = 0; queryIndex < queries.length; queryIndex++) {
			const query = queries[queryIndex];
			if (windowsWorkerQueries.has(query.id)) {
				unresolved.push({
					sessionId: session.id,
					providerSessionId: session.provider_session_id,
					queryId: query.id,
					reason: "unrecoverable-windows-worker",
					detail: "the ephemeral Computer Use rollout was not persisted",
				});
				lowerBoundSeconds = query.timestamp + 0.001;
				continue;
			}
			const rootCandidates = rootTurns.filter((turn) => {
				const completedSeconds = Math.floor(turn.endedAtMs / 1000);
				const startedSeconds = Math.floor(turn.startedAtMs / 1000);
				return (
					completedSeconds <= query.timestamp &&
					completedSeconds >= lowerBoundSeconds &&
					startedSeconds >= lowerBoundSeconds - 2
				);
			});
			lowerBoundSeconds = query.timestamp + 0.001;
			if (rootCandidates.length !== 1) {
				unresolved.push({
					sessionId: session.id,
					providerSessionId: session.provider_session_id,
					queryId: query.id,
					reason:
						rootCandidates.length === 0
							? "no-terminal-candidate"
							: "ambiguous-terminal-candidate",
					detail: `${rootCandidates.length} completed root tasks in the query interval`,
				});
				continue;
			}
			const rootTurn = rootCandidates[0];
			const childTree = expandChildTree({
				owner: root,
				ownerTurn: rootTurn,
				rollouts,
				children,
			});
			if (!childTree.exact) {
				unresolved.push({
					sessionId: session.id,
					providerSessionId: session.provider_session_id,
					queryId: query.id,
					reason: "unrecoverable-child",
				});
				continue;
			}
			const candidate = candidateForQuery({
				query,
				root,
				rootTurn,
				childTree,
				fallbackModel,
			});
			if (!candidate) {
				unresolved.push({
					sessionId: session.id,
					providerSessionId: session.provider_session_id,
					queryId: query.id,
					reason: "legacy-fingerprint-mismatch",
				});
				continue;
			}
			const ledger = ledgerRows[queryIndex];
			const evidenceRollouts = new Map<string, ParsedCodexRollout>();
			for (const item of [...candidate.rootTurns, ...candidate.childTurns]) {
				evidenceRollouts.set(item.rollout.threadId, item.rollout);
			}
			rows.push({
				sessionId: session.id,
				providerSessionId: session.provider_session_id,
				query: fingerprintQuery(query),
				usageQuery: fingerprintUsageQuery(ledger),
				corrected: {
					usage: candidate.correctedUsage,
					estimatedCost: candidate.estimatedCost,
					unpriced:
						candidate.estimatedCost == null && query.cost_known === 0 ? 1 : 0,
				},
				evidence: {
					confidence: candidate.confidence,
					rootThreadId: root.threadId,
					rootTurnIds: candidate.rootTurns.map(({ turn }) => turn.id),
					childThreadIds: [
						...new Set(
							candidate.childTurns.map(({ rollout }) => rollout.threadId),
						),
					],
					rolloutHashes: [...evidenceRollouts.values()].map(
						(rollout) => rollout.sha256,
					),
				},
			});
			const manifestIndex = rows.length - 1;
			for (const key of candidate.childTurnKeys) {
				const owners = childTurnOwners.get(key) ?? [];
				owners.push(manifestIndex);
				childTurnOwners.set(key, owners);
			}
		}
	}
	const collidedRows = new Set<number>();
	for (const owners of childTurnOwners.values()) {
		if (owners.length <= 1) continue;
		for (const owner of owners) collidedRows.add(owner);
	}
	const safeRows = rows.filter((row, index) => {
		if (!collidedRows.has(index)) return true;
		unresolved.push({
			sessionId: row.sessionId,
			providerSessionId: row.providerSessionId,
			queryId: row.query.id,
			reason: "unrecoverable-child",
			detail: "the same child turn mapped to more than one query",
		});
		return false;
	});
	return {
		version: CODEX_USAGE_REPAIR_VERSION,
		createdAt: new Date().toISOString(),
		databasePath: args.databasePath,
		rolloutRoots: [...args.rolloutRoots],
		scannedRollouts: rollouts.size,
		rows: safeRows,
		providerCorrections: providerCorrections(args.db),
		unresolved,
		totals: manifestTotals(safeRows),
	};
}

function fingerprintMatchesQuery(
	row: StoredQuery,
	fingerprint: CodexUsageRepairRow["query"],
): boolean {
	return (
		storedUsageFingerprintMatches(row, fingerprint, numberEqual) &&
		row.context_window === fingerprint.contextWindow &&
		row.tokens_in_context === fingerprint.tokensInContext
	);
}

function fingerprintMatchesUsageQuery(
	row: StoredUsageQuery,
	fingerprint: CodexUsageRepairRow["usageQuery"],
): boolean {
	return (
		storedUsageFingerprintMatches(row, fingerprint, numberEqual) &&
		row.provider_id === fingerprint.providerId &&
		row.unpriced === fingerprint.unpriced
	);
}

function rowAlreadyCorrect(
	query: StoredQuery,
	usageQuery: StoredUsageQuery,
	manifest: CodexUsageRepairRow,
): boolean {
	const correctedCostKnown =
		manifest.query.costKnown === 1 ||
		manifest.query.cost !== 0 ||
		manifest.corrected.estimatedCost != null
			? 1
			: 0;
	return (
		query.session_id === manifest.sessionId &&
		usageQuery.session_id === manifest.sessionId &&
		usageEquals(storedUsage(query), manifest.corrected.usage) &&
		usageEquals(storedUsage(usageQuery), manifest.corrected.usage) &&
		numberEqual(query.estimated_cost, manifest.corrected.estimatedCost) &&
		numberEqual(usageQuery.estimated_cost, manifest.corrected.estimatedCost) &&
		query.cost_known === correctedCostKnown &&
		usageQuery.cost_known === correctedCostKnown &&
		usageQuery.unpriced === manifest.corrected.unpriced &&
		usageQuery.provider_id === "codex"
	);
}

function rebuildSession(db: Database, sessionId: string): void {
	const unpricedPredicate = tableHasColumn(db, "queries", "cost_known")
		? "estimated_cost IS NULL AND cost_known = 0"
		: "estimated_cost IS NULL AND cost = 0";
	db.run(
		`UPDATE sessions SET
			total_input_tokens = COALESCE((SELECT SUM(input_tokens) FROM queries WHERE session_id = ?), 0),
			total_output_tokens = COALESCE((SELECT SUM(output_tokens) FROM queries WHERE session_id = ?), 0),
			total_cache_read_tokens = COALESCE((SELECT SUM(cache_read_tokens) FROM queries WHERE session_id = ?), 0),
			total_cache_creation_tokens = COALESCE((SELECT SUM(cache_creation_tokens) FROM queries WHERE session_id = ?), 0),
			total_estimated_cost = COALESCE((SELECT SUM(estimated_cost) FROM queries WHERE session_id = ?), 0),
			unpriced_query_count = COALESCE((SELECT SUM(CASE WHEN ${unpricedPredicate} THEN 1 ELSE 0 END) FROM queries WHERE session_id = ?), 0)
		 WHERE id = ?`,
		[
			sessionId,
			sessionId,
			sessionId,
			sessionId,
			sessionId,
			sessionId,
			sessionId,
		],
	);
}

export function applyCodexUsageRepair(
	db: Database,
	manifest: CodexUsageRepairManifest,
): ApplyCodexUsageRepairResult {
	if (manifest.version !== CODEX_USAGE_REPAIR_VERSION) {
		throw new Error(
			`Unsupported Codex usage repair version: ${manifest.version}`,
		);
	}
	const affectedSessions = new Set<string>();
	const affectedDates = new Set<string>();
	let appliedRows = 0;
	let alreadyCorrectRows = 0;
	let correctedProviderRows = 0;
	let alreadyCorrectProviderRows = 0;
	const queryHasCostKnown = tableHasColumn(db, "queries", "cost_known");
	const usageQueryHasCostKnown = tableHasColumn(
		db,
		"usage_queries",
		"cost_known",
	);
	const transaction = db.transaction(() => {
		ensureUsageRepairRunsTable(db);
		for (const row of manifest.rows) {
			const query = selectQueryById(db, row.query.id);
			const usageQuery = selectUsageQueryById(db, row.usageQuery.id);
			if (!query || !usageQuery) {
				throw new Error(`Repair target disappeared for query ${row.query.id}`);
			}
			if (rowAlreadyCorrect(query, usageQuery, row)) {
				alreadyCorrectRows++;
				continue;
			}
			if (
				!fingerprintMatchesQuery(query, row.query) ||
				!fingerprintMatchesUsageQuery(usageQuery, row.usageQuery)
			) {
				throw new Error(
					`Repair fingerprint changed for query ${row.query.id}; no rows were updated`,
				);
			}
			const corrected = row.corrected;
			const correctedCostKnown =
				row.query.costKnown === 1 ||
				row.query.cost !== 0 ||
				corrected.estimatedCost != null
					? 1
					: 0;
			const queryValues = [
				corrected.usage.inputTokens,
				corrected.usage.outputTokens,
				corrected.usage.cacheReadTokens,
				corrected.usage.cacheCreationTokens,
				corrected.estimatedCost,
			];
			if (queryHasCostKnown) {
				db.run(
					`UPDATE queries SET input_tokens = ?, output_tokens = ?,
					 cache_read_tokens = ?, cache_creation_tokens = ?, estimated_cost = ?,
					 cost_known = ? WHERE id = ?`,
					[...queryValues, correctedCostKnown, row.query.id],
				);
			} else {
				db.run(
					`UPDATE queries SET input_tokens = ?, output_tokens = ?,
					 cache_read_tokens = ?, cache_creation_tokens = ?, estimated_cost = ?
					 WHERE id = ?`,
					[...queryValues, row.query.id],
				);
			}
			const usageValues = [
				corrected.usage.inputTokens,
				corrected.usage.outputTokens,
				corrected.usage.cacheReadTokens,
				corrected.usage.cacheCreationTokens,
				corrected.estimatedCost,
			];
			if (usageQueryHasCostKnown) {
				db.run(
					`UPDATE usage_queries SET input_tokens = ?, output_tokens = ?,
					 cache_read_tokens = ?, cache_creation_tokens = ?, estimated_cost = ?,
					 cost_known = ?, unpriced = ?, provider_id = 'codex'
					 WHERE id = ?`,
					[
						...usageValues,
						correctedCostKnown,
						corrected.unpriced,
						row.usageQuery.id,
					],
				);
			} else {
				db.run(
					`UPDATE usage_queries SET input_tokens = ?, output_tokens = ?,
					 cache_read_tokens = ?, cache_creation_tokens = ?, estimated_cost = ?,
					 unpriced = ?, provider_id = 'codex' WHERE id = ?`,
					[...usageValues, corrected.unpriced, row.usageQuery.id],
				);
			}
			affectedSessions.add(row.sessionId);
			const date = db
				.query<{ date: string }, [number]>(
					`SELECT DATE(?, 'unixepoch', 'localtime') AS date`,
				)
				.get(row.query.timestamp)?.date;
			if (date) affectedDates.add(date);
			appliedRows++;
		}
		for (const correction of manifest.providerCorrections) {
			const usageQuery = selectUsageQueryById(db, correction.usageQuery.id);
			if (!usageQuery || usageQuery.session_id !== correction.sessionId) {
				throw new Error(
					`Provider repair target disappeared for usage query ${correction.usageQuery.id}`,
				);
			}
			if (usageQuery.provider_id === correction.sessionProviderId) {
				alreadyCorrectProviderRows++;
				continue;
			}
			if (!fingerprintMatchesUsageQuery(usageQuery, correction.usageQuery)) {
				throw new Error(
					`Provider repair fingerprint changed for usage query ${correction.usageQuery.id}; no rows were updated`,
				);
			}
			db.run(`UPDATE usage_queries SET provider_id = ? WHERE id = ?`, [
				correction.sessionProviderId,
				correction.usageQuery.id,
			]);
			correctedProviderRows++;
		}
		for (const sessionId of affectedSessions) rebuildSession(db, sessionId);
		for (const date of affectedDates) rebuildUsageDate(db, date);
		for (const row of manifest.rows) {
			const query = selectQueryById(db, row.query.id);
			const usageQuery = selectUsageQueryById(db, row.usageQuery.id);
			if (!query || !usageQuery || !rowAlreadyCorrect(query, usageQuery, row)) {
				throw new Error(
					`Post-repair verification failed for query ${row.query.id}`,
				);
			}
		}
		for (const correction of manifest.providerCorrections) {
			const usageQuery = selectUsageQueryById(db, correction.usageQuery.id);
			if (usageQuery?.provider_id !== correction.sessionProviderId) {
				throw new Error(
					`Post-repair provider verification failed for usage query ${correction.usageQuery.id}`,
				);
			}
		}
		recordUsageRepairRun(db, {
			manifest,
			version: manifest.version,
			plannedRows: manifest.rows.length,
			appliedRows,
			alreadyCorrectRows,
			unresolvedRows: manifest.unresolved.length,
			beforeTokens: tokenBucketTotal(manifest.totals.before),
			afterTokens: tokenBucketTotal(manifest.totals.after),
		});
	});
	transaction.immediate();
	return {
		appliedRows,
		alreadyCorrectRows,
		correctedProviderRows,
		alreadyCorrectProviderRows,
		affectedSessions: affectedSessions.size,
		affectedDates: affectedDates.size,
	};
}

export const tokenBucketTotal = usageTokenTotal;
