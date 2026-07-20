import type { Database } from "bun:sqlite";
import { asJsonObject as asObject, readJsonlObjects } from "./jsonl";
import {
	addUsageBuckets as addUsage,
	EMPTY_USAGE_BUCKETS as EMPTY_USAGE,
	ensureUsageRepairRunsTable,
	finiteNumber,
	storedQueriesForSession as queries,
	rebuildUsageDate,
	recordUsageRepairRun,
	type StoredQuery,
	type StoredUsageQuery,
	selectStoredQueryById as selectQuery,
	selectStoredUsageQueryById as selectUsageQuery,
	storedUsageBuckets as storedUsage,
	storedUsageFingerprintMatches,
	tableHasColumn,
	type UsageTokenBuckets,
	usageBucketsEqual as usageEquals,
	usageBucketsPositive as usagePositive,
	storedUsageQueriesForSession as usageQueries,
	usageTokenTotal,
} from "./usageRepairShared";

export const CLAUDE_USAGE_REPAIR_VERSION = 1 as const;

export type ClaudeTokenBuckets = UsageTokenBuckets;

type ClaudeCall = {
	id: string;
	atMs: number;
	usage: ClaudeTokenBuckets;
};

type ClaudePrompt = {
	id: string;
	startedAtMs: number;
	rootCalls: Map<string, ClaudeCall>;
};

type ParsedClaudeRoot = {
	path: string;
	sha256: string;
	sessionId: string;
	prompts: ClaudePrompt[];
	rootMessageIds: Set<string>;
};

type ParsedClaudeChild = {
	path: string;
	sha256: string;
	sessionId: string;
	promptIds: Set<string>;
	calls: Map<string, ClaudeCall>;
};

type StoredSession = {
	id: string;
	provider_session_id: string | null;
	started_at: number;
};

type QueryFingerprint = {
	id: number;
	sessionId: string;
	timestamp: number;
	cost: number;
	estimatedCost: number | null;
	costKnown: number;
	usage: ClaudeTokenBuckets;
	turns: number;
	contextWindow: number | null;
	tokensInContext: number | null;
};

type UsageQueryFingerprint = {
	id: number;
	sessionId: string | null;
	timestamp: number;
	cost: number;
	estimatedCost: number | null;
	costKnown: number;
	unpriced: number;
	usage: ClaudeTokenBuckets;
	turns: number;
	providerId: string;
};

export type ClaudeUsageRepairRow = {
	sessionId: string;
	providerSessionId: string;
	query: QueryFingerprint;
	usageQuery: UsageQueryFingerprint;
	corrected: ClaudeTokenBuckets;
	evidence: {
		promptId: string;
		rootMessageIds: string[];
		childMessageIds: string[];
		transcriptHashes: string[];
	};
};

export type ClaudeUsageRepairUnresolved = {
	sessionId: string;
	providerSessionId: string | null;
	queryId?: number;
	reason:
		| "missing-provider-session"
		| "duplicate-provider-session"
		| "missing-transcript"
		| "ambiguous-root-transcript"
		| "ledger-row-count-mismatch"
		| "ledger-row-mismatch"
		| "no-prompt-candidate"
		| "ambiguous-prompt-candidate"
		| "root-fingerprint-mismatch"
		| "ambiguous-child-message";
	detail?: string;
};

export type ClaudeUsageRepairManifest = {
	version: typeof CLAUDE_USAGE_REPAIR_VERSION;
	createdAt: string;
	databasePath?: string;
	transcriptRoots: string[];
	scannedRootTranscripts: number;
	scannedChildTranscripts: number;
	rows: ClaudeUsageRepairRow[];
	unresolved: ClaudeUsageRepairUnresolved[];
	totals: { before: ClaudeTokenBuckets; after: ClaudeTokenBuckets };
};

export type ApplyClaudeUsageRepairResult = {
	appliedRows: number;
	alreadyCorrectRows: number;
	affectedSessions: number;
	affectedDates: number;
};

function parsedUsage(value: unknown): ClaudeTokenBuckets | null {
	const usage = asObject(value);
	if (
		![
			usage.input_tokens,
			usage.output_tokens,
			usage.cache_read_input_tokens,
			usage.cache_creation_input_tokens,
		].some((item) => typeof item === "number")
	) {
		return null;
	}
	return {
		inputTokens: finiteNumber(usage.input_tokens),
		outputTokens: finiteNumber(usage.output_tokens),
		cacheReadTokens: finiteNumber(usage.cache_read_input_tokens),
		cacheCreationTokens: finiteNumber(usage.cache_creation_input_tokens),
	};
}

function timestampMs(record: Record<string, unknown>): number {
	if (typeof record.timestamp !== "string") return 0;
	const parsed = Date.parse(record.timestamp);
	return Number.isFinite(parsed) ? parsed : 0;
}

function messageTextBlocks(value: unknown): unknown[] {
	return Array.isArray(value) ? value : [value];
}

function isPromptStart(record: Record<string, unknown>): boolean {
	if (
		record.type !== "user" ||
		record.isSidechain === true ||
		record.isMeta === true ||
		typeof record.promptId !== "string" ||
		!record.promptId
	) {
		return false;
	}
	const content = asObject(record.message).content;
	return messageTextBlocks(content).some((block) => {
		if (typeof block === "string") {
			const text = block.trim();
			return (
				text.length > 0 &&
				!text.startsWith("<local-command-caveat>") &&
				!text.startsWith("<command-name>")
			);
		}
		const item = asObject(block);
		return item.type === "text" && typeof item.text === "string" && !!item.text;
	});
}

function callFromRecord(record: Record<string, unknown>): ClaudeCall | null {
	if (record.type !== "assistant") return null;
	const message = asObject(record.message);
	const id = typeof message.id === "string" ? message.id : "";
	const usage = parsedUsage(message.usage);
	if (!id || !usage) return null;
	return { id, atMs: timestampMs(record), usage };
}

function sessionIdFor(records: Record<string, unknown>[]): string {
	for (const record of records) {
		if (typeof record.sessionId === "string" && record.sessionId) {
			return record.sessionId;
		}
	}
	return "";
}

export async function parseClaudeRootTranscript(
	path: string,
): Promise<ParsedClaudeRoot | null> {
	const { records, text } = await readJsonlObjects(path);
	const sessionId = sessionIdFor(records);
	if (!sessionId) return null;
	const prompts: ClaudePrompt[] = [];
	const promptById = new Map<string, ClaudePrompt>();
	const rootMessageIds = new Set<string>();
	let currentPrompt: ClaudePrompt | null = null;
	for (const record of records) {
		if (isPromptStart(record)) {
			const id = record.promptId as string;
			currentPrompt = promptById.get(id) ?? null;
			if (!currentPrompt) {
				currentPrompt = {
					id,
					startedAtMs: timestampMs(record),
					rootCalls: new Map(),
				};
				promptById.set(id, currentPrompt);
				prompts.push(currentPrompt);
			}
		}
		const call = callFromRecord(record);
		if (!call || !currentPrompt) continue;
		rootMessageIds.add(call.id);
		const previous = currentPrompt.rootCalls.get(call.id);
		if (!previous || call.atMs >= previous.atMs) {
			currentPrompt.rootCalls.set(call.id, call);
		}
	}
	return {
		path,
		sha256: new Bun.CryptoHasher("sha256").update(text).digest("hex"),
		sessionId,
		prompts,
		rootMessageIds,
	};
}

export async function parseClaudeChildTranscript(
	path: string,
): Promise<ParsedClaudeChild | null> {
	const { records, text } = await readJsonlObjects(path);
	const sessionId = sessionIdFor(records);
	if (!sessionId) return null;
	const promptIds = new Set<string>();
	const calls = new Map<string, ClaudeCall>();
	for (const record of records) {
		if (record.type === "user" && typeof record.promptId === "string") {
			promptIds.add(record.promptId);
		}
		const call = callFromRecord(record);
		if (!call) continue;
		const previous = calls.get(call.id);
		if (!previous || call.atMs >= previous.atMs) calls.set(call.id, call);
	}
	return {
		path,
		sha256: new Bun.CryptoHasher("sha256").update(text).digest("hex"),
		sessionId,
		promptIds,
		calls,
	};
}

async function loadClaudeTranscripts(roots: string[]): Promise<{
	roots: Map<string, ParsedClaudeRoot[]>;
	children: ParsedClaudeChild[];
}> {
	const rootMap = new Map<string, ParsedClaudeRoot[]>();
	const children: ParsedClaudeChild[] = [];
	for (const root of roots) {
		try {
			for await (const path of new Bun.Glob("**/*.jsonl").scan({
				cwd: root,
				absolute: true,
			})) {
				if (path.includes("/subagents/") || path.includes("\\subagents\\")) {
					const child = await parseClaudeChildTranscript(path);
					if (child) children.push(child);
					continue;
				}
				const transcript = await parseClaudeRootTranscript(path);
				if (!transcript) continue;
				const entries = rootMap.get(transcript.sessionId) ?? [];
				if (!entries.some((entry) => entry.sha256 === transcript.sha256)) {
					entries.push(transcript);
				}
				rootMap.set(transcript.sessionId, entries);
			}
		} catch {
			// Optional roots may not exist on the current host.
		}
	}
	return { roots: rootMap, children };
}

function sessions(db: Database): StoredSession[] {
	const liveHistoryOnly = tableHasColumn(db, "sessions", "history_imported")
		? "AND history_imported = 0"
		: "";
	return db
		.query<StoredSession, []>(`
			SELECT id, provider_session_id, started_at
			FROM sessions
			WHERE provider_id = 'claude'
			  ${liveHistoryOnly}
			ORDER BY started_at, id
		`)
		.all();
}

function queryFingerprint(row: StoredQuery): QueryFingerprint {
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

function usageQueryFingerprint(row: StoredUsageQuery): UsageQueryFingerprint {
	return {
		id: row.id,
		sessionId: row.session_id,
		timestamp: row.timestamp,
		cost: row.cost,
		estimatedCost: row.estimated_cost,
		costKnown: row.cost_known,
		unpriced: row.unpriced,
		usage: storedUsage(row),
		turns: row.turns,
		providerId: row.provider_id,
	};
}

function nullableNumberEqual(a: number | null, b: number | null): boolean {
	return a === b || (a == null && b == null);
}

function mirrored(query: StoredQuery, ledger: StoredUsageQuery): boolean {
	return (
		ledger.session_id === query.session_id &&
		ledger.timestamp === query.timestamp &&
		ledger.cost === query.cost &&
		nullableNumberEqual(ledger.estimated_cost, query.estimated_cost) &&
		ledger.cost_known === query.cost_known &&
		ledger.turns === query.turns &&
		ledger.provider_id === "claude" &&
		usageEquals(storedUsage(query), storedUsage(ledger))
	);
}

function callsUsage(calls: Iterable<ClaudeCall>): ClaudeTokenBuckets {
	let usage = { ...EMPTY_USAGE };
	for (const call of calls) usage = addUsage(usage, call.usage);
	return usage;
}

type ChildEvidence = {
	usageByPrompt: Map<string, ClaudeTokenBuckets>;
	idsByPrompt: Map<string, string[]>;
	hashesByPrompt: Map<string, Set<string>>;
	ambiguousPrompts: Set<string>;
};

function childEvidence(
	root: ParsedClaudeRoot,
	children: ParsedClaudeChild[],
): ChildEvidence {
	const candidates = new Map<
		string,
		Array<{ promptId: string; call: ClaudeCall; hash: string }>
	>();
	for (const child of children) {
		if (child.sessionId !== root.sessionId || child.promptIds.size !== 1)
			continue;
		const promptId = [...child.promptIds][0];
		for (const call of child.calls.values()) {
			if (root.rootMessageIds.has(call.id)) continue;
			const entries = candidates.get(call.id) ?? [];
			entries.push({ promptId, call, hash: child.sha256 });
			candidates.set(call.id, entries);
		}
	}
	const usageByPrompt = new Map<string, ClaudeTokenBuckets>();
	const idsByPrompt = new Map<string, string[]>();
	const hashesByPrompt = new Map<string, Set<string>>();
	const ambiguousPrompts = new Set<string>();
	for (const [messageId, entries] of candidates) {
		const owners = new Set(entries.map((entry) => entry.promptId));
		if (owners.size !== 1) {
			for (const owner of owners) ambiguousPrompts.add(owner);
			continue;
		}
		const promptId = [...owners][0];
		const call = entries.reduce((latest, entry) =>
			entry.call.atMs >= latest.call.atMs ? entry : latest,
		);
		usageByPrompt.set(
			promptId,
			addUsage(usageByPrompt.get(promptId) ?? EMPTY_USAGE, call.call.usage),
		);
		const ids = idsByPrompt.get(promptId) ?? [];
		ids.push(messageId);
		idsByPrompt.set(promptId, ids);
		const hashes = hashesByPrompt.get(promptId) ?? new Set<string>();
		for (const entry of entries) hashes.add(entry.hash);
		hashesByPrompt.set(promptId, hashes);
	}
	return { usageByPrompt, idsByPrompt, hashesByPrompt, ambiguousPrompts };
}

function manifestTotals(rows: ClaudeUsageRepairRow[]): {
	before: ClaudeTokenBuckets;
	after: ClaudeTokenBuckets;
} {
	let before = { ...EMPTY_USAGE };
	let after = { ...EMPTY_USAGE };
	for (const row of rows) {
		before = addUsage(before, row.query.usage);
		after = addUsage(after, row.corrected);
	}
	return { before, after };
}

export async function planClaudeUsageRepair(args: {
	db: Database;
	transcriptRoots: string[];
	databasePath?: string;
}): Promise<ClaudeUsageRepairManifest> {
	const loaded = await loadClaudeTranscripts(args.transcriptRoots);
	const rows: ClaudeUsageRepairRow[] = [];
	const unresolved: ClaudeUsageRepairUnresolved[] = [];
	const storedSessions = sessions(args.db);
	const providerCounts = new Map<string, number>();
	for (const session of storedSessions) {
		if (!session.provider_session_id) continue;
		providerCounts.set(
			session.provider_session_id,
			(providerCounts.get(session.provider_session_id) ?? 0) + 1,
		);
	}
	for (const session of storedSessions) {
		const storedQueries = queries(args.db, session.id);
		if (storedQueries.length === 0) continue;
		const providerSessionId = session.provider_session_id;
		if (!providerSessionId) {
			for (const query of storedQueries) {
				unresolved.push({
					sessionId: session.id,
					providerSessionId: null,
					queryId: query.id,
					reason: "missing-provider-session",
				});
			}
			continue;
		}
		if ((providerCounts.get(providerSessionId) ?? 0) !== 1) {
			for (const query of storedQueries) {
				unresolved.push({
					sessionId: session.id,
					providerSessionId,
					queryId: query.id,
					reason: "duplicate-provider-session",
				});
			}
			continue;
		}
		const transcriptCandidates = loaded.roots.get(providerSessionId) ?? [];
		if (transcriptCandidates.length !== 1) {
			for (const query of storedQueries) {
				unresolved.push({
					sessionId: session.id,
					providerSessionId,
					queryId: query.id,
					reason:
						transcriptCandidates.length === 0
							? "missing-transcript"
							: "ambiguous-root-transcript",
				});
			}
			continue;
		}
		const root = transcriptCandidates[0];
		const ledgerRows = usageQueries(args.db, session.id);
		if (ledgerRows.length !== storedQueries.length) {
			for (const query of storedQueries) {
				unresolved.push({
					sessionId: session.id,
					providerSessionId,
					queryId: query.id,
					reason: "ledger-row-count-mismatch",
				});
			}
			continue;
		}
		if (
			storedQueries.some((query, index) => !mirrored(query, ledgerRows[index]))
		) {
			for (const query of storedQueries) {
				unresolved.push({
					sessionId: session.id,
					providerSessionId,
					queryId: query.id,
					reason: "ledger-row-mismatch",
				});
			}
			continue;
		}
		const child = childEvidence(root, loaded.children);
		let lowerBoundMs = session.started_at * 1000 - 2_000;
		for (let index = 0; index < storedQueries.length; index++) {
			const query = storedQueries[index];
			const upperBoundMs = query.timestamp * 1000 + 1_999;
			const candidates = root.prompts.filter(
				(prompt) =>
					prompt.startedAtMs >= lowerBoundMs &&
					prompt.startedAtMs <= upperBoundMs,
			);
			lowerBoundMs = query.timestamp * 1000 + 2_000;
			if (candidates.length !== 1) {
				unresolved.push({
					sessionId: session.id,
					providerSessionId,
					queryId: query.id,
					reason:
						candidates.length === 0
							? "no-prompt-candidate"
							: "ambiguous-prompt-candidate",
					detail: `${candidates.length} root prompts in the query interval`,
				});
				continue;
			}
			const prompt = candidates[0];
			const rootUsage = callsUsage(prompt.rootCalls.values());
			if (child.ambiguousPrompts.has(prompt.id)) {
				unresolved.push({
					sessionId: session.id,
					providerSessionId,
					queryId: query.id,
					reason: "ambiguous-child-message",
				});
				continue;
			}
			const childUsage = child.usageByPrompt.get(prompt.id) ?? EMPTY_USAGE;
			const corrected = addUsage(rootUsage, childUsage);
			if (
				usagePositive(childUsage) &&
				usageEquals(storedUsage(query), corrected)
			) {
				// A previous repair already folded this exact child evidence. A fresh
				// plan must remain clean and idempotent, not report the corrected row as
				// a root-only fingerprint mismatch.
				continue;
			}
			if (!usageEquals(storedUsage(query), rootUsage)) {
				unresolved.push({
					sessionId: session.id,
					providerSessionId,
					queryId: query.id,
					reason: "root-fingerprint-mismatch",
				});
				continue;
			}
			if (!usagePositive(childUsage)) continue;
			rows.push({
				sessionId: session.id,
				providerSessionId,
				query: queryFingerprint(query),
				usageQuery: usageQueryFingerprint(ledgerRows[index]),
				corrected,
				evidence: {
					promptId: prompt.id,
					rootMessageIds: [...prompt.rootCalls.keys()],
					childMessageIds: child.idsByPrompt.get(prompt.id) ?? [],
					transcriptHashes: [
						root.sha256,
						...(child.hashesByPrompt.get(prompt.id) ?? []),
					],
				},
			});
		}
	}
	return {
		version: CLAUDE_USAGE_REPAIR_VERSION,
		createdAt: new Date().toISOString(),
		databasePath: args.databasePath,
		transcriptRoots: [...args.transcriptRoots],
		scannedRootTranscripts: [...loaded.roots.values()].reduce(
			(total, entries) => total + entries.length,
			0,
		),
		scannedChildTranscripts: loaded.children.length,
		rows,
		unresolved,
		totals: manifestTotals(rows),
	};
}

function queryFingerprintMatches(
	row: StoredQuery,
	fingerprint: QueryFingerprint,
): boolean {
	return (
		storedUsageFingerprintMatches(row, fingerprint, nullableNumberEqual) &&
		row.context_window === fingerprint.contextWindow &&
		row.tokens_in_context === fingerprint.tokensInContext
	);
}

function usageFingerprintMatches(
	row: StoredUsageQuery,
	fingerprint: UsageQueryFingerprint,
): boolean {
	return (
		storedUsageFingerprintMatches(row, fingerprint, nullableNumberEqual) &&
		row.unpriced === fingerprint.unpriced &&
		row.provider_id === fingerprint.providerId
	);
}

function rebuildSession(db: Database, sessionId: string): void {
	db.run(
		`UPDATE sessions SET
			total_input_tokens = COALESCE((SELECT SUM(input_tokens) FROM queries WHERE session_id = ?), 0),
			total_output_tokens = COALESCE((SELECT SUM(output_tokens) FROM queries WHERE session_id = ?), 0),
			total_cache_read_tokens = COALESCE((SELECT SUM(cache_read_tokens) FROM queries WHERE session_id = ?), 0),
			total_cache_creation_tokens = COALESCE((SELECT SUM(cache_creation_tokens) FROM queries WHERE session_id = ?), 0)
		 WHERE id = ?`,
		[sessionId, sessionId, sessionId, sessionId, sessionId],
	);
}

function selectClaudeRepairTarget(
	db: Database,
	repair: ClaudeUsageRepairRow,
): { query: StoredQuery | null; ledger: StoredUsageQuery | null } {
	return {
		query: selectQuery(db, repair.query.id),
		ledger: selectUsageQuery(db, repair.usageQuery.id),
	};
}

export function applyClaudeUsageRepair(
	db: Database,
	manifest: ClaudeUsageRepairManifest,
): ApplyClaudeUsageRepairResult {
	if (manifest.version !== CLAUDE_USAGE_REPAIR_VERSION) {
		throw new Error(
			`Unsupported Claude usage repair version: ${manifest.version}`,
		);
	}
	let appliedRows = 0;
	let alreadyCorrectRows = 0;
	const affectedSessions = new Set<string>();
	const affectedDates = new Set<string>();
	const transaction = db.transaction(() => {
		ensureUsageRepairRunsTable(db);
		for (const repair of manifest.rows) {
			const { query, ledger } = selectClaudeRepairTarget(db, repair);
			if (!query || !ledger) {
				throw new Error(
					`Repair target disappeared for query ${repair.query.id}`,
				);
			}
			if (
				usageEquals(storedUsage(query), repair.corrected) &&
				usageEquals(storedUsage(ledger), repair.corrected)
			) {
				alreadyCorrectRows++;
				continue;
			}
			if (
				!queryFingerprintMatches(query, repair.query) ||
				!usageFingerprintMatches(ledger, repair.usageQuery)
			) {
				throw new Error(
					`Repair fingerprint changed for query ${repair.query.id}; no rows were updated`,
				);
			}
			const values = [
				repair.corrected.inputTokens,
				repair.corrected.outputTokens,
				repair.corrected.cacheReadTokens,
				repair.corrected.cacheCreationTokens,
			];
			db.run(
				`UPDATE queries SET input_tokens = ?, output_tokens = ?,
				 cache_read_tokens = ?, cache_creation_tokens = ? WHERE id = ?`,
				[...values, repair.query.id],
			);
			db.run(
				`UPDATE usage_queries SET input_tokens = ?, output_tokens = ?,
				 cache_read_tokens = ?, cache_creation_tokens = ? WHERE id = ?`,
				[...values, repair.usageQuery.id],
			);
			affectedSessions.add(repair.sessionId);
			const date = db
				.query<{ date: string }, [number]>(
					`SELECT DATE(?, 'unixepoch', 'localtime') AS date`,
				)
				.get(repair.query.timestamp)?.date;
			if (date) affectedDates.add(date);
			appliedRows++;
		}
		for (const sessionId of affectedSessions) rebuildSession(db, sessionId);
		for (const date of affectedDates) rebuildUsageDate(db, date);
		for (const repair of manifest.rows) {
			const { query, ledger } = selectClaudeRepairTarget(db, repair);
			if (
				!query ||
				!ledger ||
				!usageEquals(storedUsage(query), repair.corrected) ||
				!usageEquals(storedUsage(ledger), repair.corrected)
			) {
				throw new Error(
					`Post-repair verification failed for query ${repair.query.id}`,
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
			beforeTokens: claudeTokenTotal(manifest.totals.before),
			afterTokens: claudeTokenTotal(manifest.totals.after),
		});
	});
	transaction.immediate();
	return {
		appliedRows,
		alreadyCorrectRows,
		affectedSessions: affectedSessions.size,
		affectedDates: affectedDates.size,
	};
}

export const claudeTokenTotal = usageTokenTotal;
