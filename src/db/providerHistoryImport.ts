import type { Database } from "bun:sqlite";
import { realpathSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { estimateClaudeCost } from "../lib/claudePricing";
import { estimateCodexCost } from "../lib/codexPricing";
import {
	codexChildrenByParent,
	codexDirectChildIds,
} from "./codexRolloutGraph";
import { loadCodexRollouts, type ParsedCodexRollout } from "./codexUsageRepair";
import { asJsonObject as asObject, readJsonlObjects } from "./jsonl";
import {
	addUsageBuckets as addUsage,
	EMPTY_USAGE_BUCKETS as EMPTY_USAGE,
	finiteNumber,
	rebuildUsageDate,
	type UsageTokenBuckets,
	usageTokenTotal,
} from "./usageRepairShared";

export const PROVIDER_HISTORY_IMPORT_VERSION = 3 as const;

export type HistoryProviderId = "codex" | "claude";

export type HistoryTokenBuckets = UsageTokenBuckets;

export type ProviderHistorySourceFile = {
	path: string;
	sha256: string;
};

export type ProviderHistoryQuery = {
	providerId: HistoryProviderId;
	nativeSessionId: string;
	sourceId: string;
	sourceHash: string;
	startedAt: number;
	timestamp: number;
	durationMs: number;
	turns: number;
	stopReason: string | null;
	model: string | null;
	cwd: string | null;
	sourceSurface: string;
	contextWindow: number | null;
	tokensInContext: number | null;
	usage: HistoryTokenBuckets;
	estimatedCost: number | null;
	unpriced: number;
	evidence: {
		rootId: string;
		childIds: string[];
		callIds: string[];
		sources: ProviderHistorySourceFile[];
	};
};

export type ProviderHistorySession = {
	providerId: HistoryProviderId;
	nativeSessionId: string;
	importedSessionId: string;
	sourceId: string;
	sourceHash: string;
	createSession: boolean;
	label: string;
	model: string | null;
	cwd: string | null;
	sourceSurface: string;
	startedAt: number;
	endedAt: number;
	queries: ProviderHistoryQuery[];
};

export type ProviderHistoryImportSkipped = {
	providerId: HistoryProviderId;
	nativeSessionId: string | null;
	reason:
		| "originated-in-hlid"
		| "existing-native-session"
		| "import-tombstone"
		| "unsupported-entrypoint"
		| "no-terminal-usage"
		| "unrecoverable-child"
		| "ambiguous-child-owner"
		| "unassigned-claude-usage"
		| "provenance-conflict";
	detail?: string;
};

export type ProviderHistoryImportManifest = {
	version: typeof PROVIDER_HISTORY_IMPORT_VERSION;
	createdAt: string;
	databasePath?: string;
	codexRoots: string[];
	claudeRoots: string[];
	scanned: {
		codexRollouts: number;
		claudeRootSessions: number;
		claudeSubagentFiles: number;
	};
	sourceFiles: ProviderHistorySourceFile[];
	sessions: ProviderHistorySession[];
	skipped: ProviderHistoryImportSkipped[];
	alreadyImported: {
		sessions: number;
		queries: number;
	};
	totals: HistoryTokenBuckets & {
		sessions: number;
		queries: number;
		turns: number;
	};
};

export type ApplyProviderHistoryImportResult = {
	createdSessions: number;
	insertedQueries: number;
	alreadyImportedSessions: number;
	alreadyImportedQueries: number;
	tombstonedSessions: number;
	affectedDates: number;
};

type ProvenanceRow = {
	provider_id: string;
	source_kind: string;
	source_id: string;
	source_hash: string;
	imported_session_id: string;
	imported_query_id: number | null;
	imported_usage_query_id: number | null;
};

type ProvenanceSourceKind = "session" | "query" | "call";

type NativeSessionRow = {
	id: string;
	provider_session_id: string;
};

type CodexTurn = ParsedCodexRollout["turns"][number];

type CodexTerminalTurn = CodexTurn & {
	endedAtMs: number;
	terminal: "completed" | "aborted";
};

export const historyTokenTotal = usageTokenTotal;

function positiveUsage(usage: HistoryTokenBuckets): boolean {
	return historyTokenTotal(usage) > 0;
}

function sha256(value: string): string {
	return new Bun.CryptoHasher("sha256").update(value).digest("hex");
}

function canonicalHash(value: unknown): string {
	return sha256(JSON.stringify(value));
}

async function fileHash(path: string): Promise<string> {
	return sha256(await Bun.file(path).text());
}

function importedSessionId(
	providerId: HistoryProviderId,
	nativeSessionId: string,
): string {
	return `history:${providerId}:${nativeSessionId}`;
}

function logicalHistoryCwd(value: string): string {
	const wsl = value.match(/^\\\\wsl(?:\.localhost)?\\[^\\]+\\(.+)$/i);
	if (wsl) return `/${wsl[1].replace(/\\/g, "/")}`;
	if (/^[a-z]:\\/i.test(value)) {
		return `${value[0].toUpperCase()}${value.slice(1)}`;
	}
	return value;
}

function canonicalHistoryCwd(
	value: string | null,
	existing: Map<string, string>,
): string | null {
	if (!value?.trim()) return null;
	let logical = logicalHistoryCwd(value.trim());
	try {
		logical = realpathSync(logical);
	} catch {
		// Windows-only and removed project paths remain useful historical facets.
	}
	const key = logical.toLocaleLowerCase();
	const known = existing.get(key);
	if (known) return known;
	existing.set(key, logical);
	return logical;
}

function canonicalizeHistoryCwds(
	db: Database,
	sessions: ProviderHistorySession[],
): void {
	const existing = new Map<string, string>();
	for (const row of db
		.query<{ agent_cwd: string }, []>(
			`SELECT DISTINCT agent_cwd FROM sessions
			 WHERE agent_cwd IS NOT NULL AND TRIM(agent_cwd) <> ''`,
		)
		.all()) {
		const logical = logicalHistoryCwd(row.agent_cwd);
		existing.set(logical.toLocaleLowerCase(), logical);
	}
	for (const session of sessions) {
		session.cwd = canonicalHistoryCwd(session.cwd, existing);
		for (const query of session.queries) {
			query.cwd = canonicalHistoryCwd(query.cwd, existing);
		}
	}
}

function tableExists(db: Database, table: string): boolean {
	return (
		db
			.query<{ present: number }, [string]>(
				`SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?`,
			)
			.get(table)?.present === 1
	);
}

function tableColumns(db: Database, table: string): Set<string> {
	return new Set(
		db
			.query<{ name: string }, []>(`PRAGMA table_info(${table})`)
			.all()
			.map((row) => row.name),
	);
}

function ensureProvenanceTable(db: Database): void {
	db.run(`
		CREATE TABLE IF NOT EXISTS history_import_items (
			provider_id TEXT NOT NULL,
			source_kind TEXT NOT NULL,
			source_id TEXT NOT NULL,
			source_hash TEXT NOT NULL,
			imported_session_id TEXT NOT NULL,
			imported_query_id INTEGER,
			imported_usage_query_id INTEGER,
			imported_at INTEGER NOT NULL DEFAULT (unixepoch()),
			PRIMARY KEY (provider_id, source_kind, source_id)
		)
	`);
	db.run(
		`CREATE INDEX IF NOT EXISTS idx_history_import_session
		 ON history_import_items(imported_session_id)`,
	);
}

function provenanceRows(db: Database): Map<string, ProvenanceRow> {
	if (!tableExists(db, "history_import_items")) return new Map();
	const rows = db
		.query<ProvenanceRow, []>(`
			SELECT provider_id, source_kind, source_id, source_hash,
			       imported_session_id, imported_query_id, imported_usage_query_id
			FROM history_import_items
		`)
		.all();
	return new Map(
		rows.map((row) => [
			`${row.provider_id}:${row.source_kind}:${row.source_id}`,
			row,
		]),
	);
}

function provenanceKey(
	providerId: HistoryProviderId,
	sourceKind: ProvenanceSourceKind,
	sourceId: string,
): string {
	return `${providerId}:${sourceKind}:${sourceId}`;
}

function nativeSessions(
	db: Database,
	providerId: HistoryProviderId,
): Map<string, NativeSessionRow> {
	return new Map(
		db
			.query<NativeSessionRow, [string]>(`
				SELECT id, provider_session_id
				FROM sessions
				WHERE provider_id = ? AND provider_session_id IS NOT NULL
			`)
			.all(providerId)
			.map((row) => [row.provider_session_id, row]),
	);
}

function nativeClaudeSessions(db: Database): Map<string, NativeSessionRow> {
	const columns = tableColumns(db, "sessions");
	const hasLegacyId = columns.has("claude_session_id");
	const rows = db
		.query<
			{
				id: string;
				provider_id: string | null;
				provider_session_id: string | null;
				claude_session_id: string | null;
			},
			[]
		>(`
			SELECT id, provider_id, provider_session_id,
			       ${hasLegacyId ? "claude_session_id" : "NULL"} AS claude_session_id
			FROM sessions
			WHERE (provider_id = 'claude' AND provider_session_id IS NOT NULL)
			   ${hasLegacyId ? "OR claude_session_id IS NOT NULL" : ""}
		`)
		.all();
	const native = new Map<string, NativeSessionRow>();
	for (const row of rows) {
		const ids = [
			row.provider_id === "claude" ? row.provider_session_id : null,
			row.claude_session_id,
		];
		for (const id of ids) {
			if (!id) continue;
			native.set(id, { id: row.id, provider_session_id: id });
		}
	}
	return native;
}

function existingSessionIds(db: Database): Set<string> {
	return new Set(
		db
			.query<{ id: string }, []>(`SELECT id FROM sessions`)
			.all()
			.map((row) => row.id),
	);
}

function sessionDisposition(args: {
	providerId: HistoryProviderId;
	nativeSessionId: string;
	native: Map<string, NativeSessionRow>;
	existingSessionIds: Set<string>;
	provenance: Map<string, ProvenanceRow>;
}):
	| { kind: "new"; importedSessionId: string }
	| { kind: "existing-import"; importedSessionId: string }
	| { kind: "existing-native" }
	| { kind: "tombstone" } {
	const sessionSourceId = `session:${args.nativeSessionId}`;
	const provenance = args.provenance.get(
		provenanceKey(args.providerId, "session", sessionSourceId),
	);
	const native = args.native.get(args.nativeSessionId);
	if (provenance) {
		if (!args.existingSessionIds.has(provenance.imported_session_id)) {
			return { kind: "tombstone" };
		}
		if (!native || native.id === provenance.imported_session_id) {
			return {
				kind: "existing-import",
				importedSessionId: provenance.imported_session_id,
			};
		}
		return { kind: "existing-native" };
	}
	if (native) return { kind: "existing-native" };
	return {
		kind: "new",
		importedSessionId: importedSessionId(args.providerId, args.nativeSessionId),
	};
}

function terminalTurns(rollout: ParsedCodexRollout): CodexTerminalTurn[] {
	return rollout.turns.filter(
		(turn): turn is CodexTerminalTurn =>
			(turn.terminal === "completed" || turn.terminal === "aborted") &&
			turn.endedAtMs != null,
	);
}

type CodexTurnEvidence = {
	rollout: ParsedCodexRollout;
	turn: CodexTerminalTurn;
};

type CodexChildTree = {
	turns: CodexTurnEvidence[];
	threadIds: string[];
	sources: ProviderHistorySourceFile[];
	turnKeys: string[];
	exact: boolean;
};

function expandCodexChildTree(args: {
	owner: ParsedCodexRollout;
	ownerTurn: CodexTerminalTurn;
	rollouts: Map<string, ParsedCodexRollout>;
	children: Map<string, string[]>;
}): CodexChildTree {
	type Pending = { id: string; startMs: number; endMs: number };
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
	const selected: CodexTurnEvidence[] = [];
	const threadIds = new Set<string>();
	const sources = new Map<string, ProviderHistorySourceFile>();
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
		const terminal = terminalTurns(rollout);
		const turns = terminal.filter(
			(turn) =>
				turn.startedAtMs >= pending.startMs - 1_000 &&
				turn.startedAtMs <= pending.endMs + 1_000 &&
				turn.endedAtMs <= pending.endMs,
		);
		if (turns.length === 0) {
			// Long-lived workers can have only later, independently terminal turns.
			// They are imported as standalone usage queries below. A child with no
			// terminal evidence at all is still unsafe to fold into this query.
			if (terminal.length === 0) exact = false;
			continue;
		}
		threadIds.add(rollout.threadId);
		sources.set(rollout.path, {
			path: rollout.path,
			sha256: rollout.sha256,
		});
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
				queue.push({
					id,
					startMs: turn.startedAtMs,
					endMs: turn.endedAtMs,
				});
			}
		}
	}
	return {
		turns: selected,
		threadIds: [...threadIds],
		sources: [...sources.values()],
		turnKeys: [...turnKeys],
		exact,
	};
}

function codexUsageForTurns(turns: CodexTurnEvidence[]): HistoryTokenBuckets {
	let usage = { ...EMPTY_USAGE };
	for (const { turn } of turns) {
		for (const increment of turn.increments) {
			usage = addUsage(usage, increment.usage);
		}
	}
	return usage;
}

function codexCostForTurns(
	turns: CodexTurnEvidence[],
	fallbackModel: string | null,
): number | null {
	let cost = 0;
	for (const { turn } of turns) {
		for (const increment of turn.increments) {
			const incrementCost = estimateCodexCost(
				increment.model ?? fallbackModel,
				increment.usage,
				{ webSearchCalls: 0 },
				increment.atMs,
			);
			if (incrementCost == null) return null;
			cost += incrementCost;
		}
		const hostedCost = estimateCodexCost(
			fallbackModel,
			{ ...EMPTY_USAGE },
			{ webSearchCalls: turn.webSearchIds.size },
			turn.endedAtMs ?? turn.startedAtMs,
		);
		if (hostedCost == null) return null;
		cost += hostedCost;
	}
	return cost;
}

function codexTurnModel(
	rootTurn: CodexTerminalTurn,
	allTurns: CodexTurnEvidence[],
): string | null {
	for (const increment of [...rootTurn.increments].reverse()) {
		if (increment.model) return increment.model;
	}
	for (const { turn } of [...allTurns].reverse()) {
		for (const increment of [...turn.increments].reverse()) {
			if (increment.model) return increment.model;
		}
	}
	return null;
}

async function codexMetadata(
	rollout: ParsedCodexRollout,
): Promise<{ cwd: string | null; sourceSurface: string }> {
	const firstLine = (await Bun.file(rollout.path).text())
		.split("\n")
		.find((line) => line.trim().length > 0);
	if (!firstLine) {
		return {
			cwd: null,
			sourceSurface: rollout.originator ?? "codex",
		};
	}
	try {
		const record = asObject(JSON.parse(firstLine));
		const payload = asObject(record.payload);
		return {
			cwd: typeof payload.cwd === "string" ? payload.cwd : null,
			sourceSurface:
				typeof payload.originator === "string"
					? payload.originator
					: (rollout.originator ?? "codex"),
		};
	} catch {
		return {
			cwd: null,
			sourceSurface: rollout.originator ?? "codex",
		};
	}
}

function formatImportDate(timestampSeconds: number): string {
	return new Date(timestampSeconds * 1_000).toISOString().slice(0, 10);
}

type PlannerState = {
	provenance: Map<string, ProvenanceRow>;
	skipped: ProviderHistoryImportSkipped[];
	alreadyImportedSessions: number;
	alreadyImportedQueries: number;
	sourceFiles: Map<string, ProviderHistorySourceFile>;
};

function includeSources(
	state: PlannerState,
	sources: ProviderHistorySourceFile[],
): void {
	for (const source of sources) state.sourceFiles.set(source.path, source);
}

function queryImportDisposition(args: {
	state: PlannerState;
	providerId: HistoryProviderId;
	sourceId: string;
	sourceHash: string;
	nativeSessionId: string;
}): "new" | "existing" | "conflict" {
	const row = args.state.provenance.get(
		provenanceKey(args.providerId, "query", args.sourceId),
	);
	if (!row) return "new";
	if (row.source_hash !== args.sourceHash) {
		args.state.skipped.push({
			providerId: args.providerId,
			nativeSessionId: args.nativeSessionId,
			reason: "provenance-conflict",
			detail: `source ${args.sourceId} no longer matches its imported fingerprint`,
		});
		return "conflict";
	}
	args.state.alreadyImportedQueries++;
	return "existing";
}

async function planCodexSessions(args: {
	db: Database;
	rolloutRoots: string[];
	state: PlannerState;
}): Promise<{
	sessions: ProviderHistorySession[];
	scannedRollouts: number;
}> {
	if (args.rolloutRoots.length === 0) {
		return { sessions: [], scannedRollouts: 0 };
	}
	const rollouts = await loadCodexRollouts(args.rolloutRoots);
	const native = nativeSessions(args.db, "codex");
	const sessionIds = existingSessionIds(args.db);
	const children = codexChildrenByParent(rollouts);
	const sessions: ProviderHistorySession[] = [];
	const childTurnOwners = new Map<string, string[]>();
	const sessionByQuerySource = new Map<string, ProviderHistorySession>();
	const sessionByRootThread = new Map<string, ProviderHistorySession>();
	const newRootThreads = new Set<string>();
	const alreadyAssignedCalls = new Set(
		[...args.state.provenance.values()]
			.filter(
				(row) => row.provider_id === "codex" && row.source_kind === "call",
			)
			.map((row) => row.source_id),
	);
	const recognizedQuerySourceIds = new Set<string>();
	for (const root of rollouts.values()) {
		if (root.parentThreadId) continue;
		if (root.originator === "hlid") {
			args.state.skipped.push({
				providerId: "codex",
				nativeSessionId: root.threadId,
				reason: "originated-in-hlid",
			});
			continue;
		}
		const disposition = sessionDisposition({
			providerId: "codex",
			nativeSessionId: root.threadId,
			native,
			existingSessionIds: sessionIds,
			provenance: args.state.provenance,
		});
		if (disposition.kind === "existing-native") {
			args.state.skipped.push({
				providerId: "codex",
				nativeSessionId: root.threadId,
				reason: "existing-native-session",
			});
			continue;
		}
		if (disposition.kind === "tombstone") {
			args.state.alreadyImportedSessions++;
			args.state.skipped.push({
				providerId: "codex",
				nativeSessionId: root.threadId,
				reason: "import-tombstone",
			});
			continue;
		}
		if (disposition.kind === "existing-import") {
			args.state.alreadyImportedSessions++;
		}
		const metadata = await codexMetadata(root);
		const queries: ProviderHistoryQuery[] = [];
		for (const rootTurn of terminalTurns(root)) {
			const childTree = expandCodexChildTree({
				owner: root,
				ownerTurn: rootTurn,
				rollouts,
				children,
			});
			if (!childTree.exact) {
				args.state.skipped.push({
					providerId: "codex",
					nativeSessionId: root.threadId,
					reason: "unrecoverable-child",
					detail: `turn ${rootTurn.id}`,
				});
				continue;
			}
			const allTurns: CodexTurnEvidence[] = [
				{ rollout: root, turn: rootTurn },
				...childTree.turns,
			];
			const usage = codexUsageForTurns(allTurns);
			if (!positiveUsage(usage)) continue;
			const model = codexTurnModel(rootTurn, allTurns);
			const sources = [
				{ path: root.path, sha256: root.sha256 },
				...childTree.sources,
			];
			const sourceId = `turn:${root.threadId}:${rootTurn.id}`;
			const callIds = allTurns.map(
				({ rollout, turn }) => `${rollout.threadId}:${turn.id}`,
			);
			const sourceHash = canonicalHash({
				provider: "codex",
				sourceId,
				terminal: rootTurn.terminal,
				usage,
				model,
				callIds,
			});
			if (callIds.some((callId) => alreadyAssignedCalls.has(callId))) {
				const existing = args.state.provenance.get(
					provenanceKey("codex", "query", sourceId),
				);
				if (existing?.source_hash === sourceHash) {
					args.state.alreadyImportedQueries++;
					recognizedQuerySourceIds.add(sourceId);
					for (const callId of callIds) alreadyAssignedCalls.add(callId);
				}
				continue;
			}
			const importDisposition = queryImportDisposition({
				state: args.state,
				providerId: "codex",
				sourceId,
				sourceHash,
				nativeSessionId: root.threadId,
			});
			if (importDisposition !== "new") {
				if (importDisposition === "existing") {
					recognizedQuerySourceIds.add(sourceId);
					for (const callId of callIds) alreadyAssignedCalls.add(callId);
				}
				continue;
			}
			const context = rootTurn.contexts.at(-1);
			const estimatedCost = codexCostForTurns(allTurns, model);
			const query: ProviderHistoryQuery = {
				providerId: "codex",
				nativeSessionId: root.threadId,
				sourceId,
				sourceHash,
				startedAt: Math.floor(rootTurn.startedAtMs / 1_000),
				timestamp: Math.floor(rootTurn.endedAtMs / 1_000),
				durationMs: Math.max(0, rootTurn.endedAtMs - rootTurn.startedAtMs),
				turns: allTurns.length,
				stopReason: rootTurn.terminal,
				model,
				cwd: metadata.cwd,
				sourceSurface: metadata.sourceSurface,
				contextWindow: context?.window ?? null,
				tokensInContext: context?.tokens ?? null,
				usage,
				estimatedCost,
				unpriced: estimatedCost == null ? 1 : 0,
				evidence: {
					rootId: `${root.threadId}:${rootTurn.id}`,
					childIds: childTree.threadIds,
					callIds,
					sources,
				},
			};
			queries.push(query);
			for (const key of childTree.turnKeys) {
				const owners = childTurnOwners.get(key) ?? [];
				owners.push(sourceId);
				childTurnOwners.set(key, owners);
			}
		}
		const startedAt =
			queries.length > 0
				? Math.min(...queries.map((query) => query.startedAt))
				: Math.floor(root.createdAtMs / 1_000);
		const endedAt =
			queries.length > 0
				? Math.max(...queries.map((query) => query.timestamp))
				: startedAt;
		const model =
			[...queries].reverse().find((query) => query.model)?.model ?? null;
		const sourceId = `session:${root.threadId}`;
		const sourceHash = canonicalHash({
			provider: "codex",
			nativeSessionId: root.threadId,
			cwd: metadata.cwd,
			sourceSurface: metadata.sourceSurface,
		});
		const session: ProviderHistorySession = {
			providerId: "codex",
			nativeSessionId: root.threadId,
			importedSessionId: disposition.importedSessionId,
			sourceId,
			sourceHash,
			createSession: disposition.kind === "new",
			label: `Imported Codex ${metadata.sourceSurface} · ${formatImportDate(startedAt)}`,
			model,
			cwd: metadata.cwd,
			sourceSurface: metadata.sourceSurface,
			startedAt,
			endedAt,
			queries,
		};
		sessions.push(session);
		sessionByRootThread.set(root.threadId, session);
		if (disposition.kind === "new") newRootThreads.add(root.threadId);
		for (const query of queries) {
			sessionByQuerySource.set(query.sourceId, session);
		}
	}

	const collided = new Set<string>();
	for (const owners of childTurnOwners.values()) {
		if (owners.length <= 1) continue;
		for (const owner of owners) collided.add(owner);
	}
	if (collided.size > 0) {
		for (const sourceId of collided) {
			const session = sessionByQuerySource.get(sourceId);
			if (!session) continue;
			session.queries = session.queries.filter(
				(query) => query.sourceId !== sourceId,
			);
		}
	}

	// Some Codex surfaces keep long-lived forked workers (for example Desktop's
	// guardian) and run later terminal turns after the parent query has ended.
	// Those turns cannot be causally folded into one parent query, but each has
	// exact terminal usage. Preserve them as individual usage queries on the
	// owning external session instead of dropping them from profile totals.
	const assignedCalls = new Set([
		...alreadyAssignedCalls,
		...sessions.flatMap((session) =>
			session.queries.flatMap((query) => query.evidence.callIds),
		),
	]);
	const rootThreadIdFor = (rollout: ParsedCodexRollout): string | null => {
		let current = rollout;
		const seen = new Set<string>();
		while (current.parentThreadId && !seen.has(current.threadId)) {
			seen.add(current.threadId);
			const parent = rollouts.get(current.parentThreadId);
			if (!parent) break;
			current = parent;
		}
		return sessionByRootThread.has(current.threadId) ? current.threadId : null;
	};
	for (const rollout of rollouts.values()) {
		const rootThreadId = rootThreadIdFor(rollout);
		if (!rootThreadId) continue;
		const session = sessionByRootThread.get(rootThreadId);
		if (!session) continue;
		let metadata: Awaited<ReturnType<typeof codexMetadata>> | null = null;
		for (const turn of terminalTurns(rollout)) {
			const callId = `${rollout.threadId}:${turn.id}`;
			const usage = codexUsageForTurns([{ rollout, turn }]);
			if (!positiveUsage(usage)) continue;
			const model = codexTurnModel(turn, [{ rollout, turn }]);
			const sourceId = `turn:${rollout.threadId}:${turn.id}`;
			const sourceHash = canonicalHash({
				provider: "codex",
				sourceId,
				terminal: turn.terminal,
				usage,
				model,
				callIds: [callId],
			});
			if (assignedCalls.has(callId)) {
				const existing = args.state.provenance.get(
					provenanceKey("codex", "query", sourceId),
				);
				if (
					existing?.source_hash === sourceHash &&
					!recognizedQuerySourceIds.has(sourceId)
				) {
					args.state.alreadyImportedQueries++;
					recognizedQuerySourceIds.add(sourceId);
				}
				continue;
			}
			if (
				queryImportDisposition({
					state: args.state,
					providerId: "codex",
					sourceId,
					sourceHash,
					nativeSessionId: session.nativeSessionId,
				}) !== "new"
			) {
				continue;
			}
			metadata ??= await codexMetadata(rollout);
			const context = turn.contexts.at(-1);
			const estimatedCost = codexCostForTurns([{ rollout, turn }], model);
			session.queries.push({
				providerId: "codex",
				nativeSessionId: session.nativeSessionId,
				sourceId,
				sourceHash,
				startedAt: Math.floor(turn.startedAtMs / 1_000),
				timestamp: Math.floor(turn.endedAtMs / 1_000),
				durationMs: Math.max(0, turn.endedAtMs - turn.startedAtMs),
				turns: 1,
				stopReason: turn.terminal,
				model,
				cwd: metadata.cwd,
				sourceSurface: metadata.sourceSurface,
				contextWindow: context?.window ?? null,
				tokensInContext: context?.tokens ?? null,
				usage,
				estimatedCost,
				unpriced: estimatedCost == null ? 1 : 0,
				evidence: {
					rootId: callId,
					childIds: [],
					callIds: [callId],
					sources: [{ path: rollout.path, sha256: rollout.sha256 }],
				},
			});
			assignedCalls.add(callId);
		}
	}

	const safeSessions = sessions.filter((session) => session.queries.length > 0);
	for (const session of safeSessions) {
		session.startedAt = Math.min(
			...session.queries.map((query) => query.startedAt),
		);
		session.endedAt = Math.max(
			...session.queries.map((query) => query.timestamp),
		);
		session.model =
			[...session.queries].reverse().find((query) => query.model)?.model ??
			null;
		for (const query of session.queries) {
			includeSources(args.state, query.evidence.sources);
		}
	}
	for (const session of sessions) {
		if (
			session.queries.length === 0 &&
			newRootThreads.has(session.nativeSessionId)
		) {
			args.state.skipped.push({
				providerId: "codex",
				nativeSessionId: session.nativeSessionId,
				reason: "no-terminal-usage",
			});
		}
	}
	return { sessions: safeSessions, scannedRollouts: rollouts.size };
}

type ClaudeRecord = Record<string, unknown> & {
	type?: string;
	subtype?: string;
	sessionId?: string;
	uuid?: string;
	parentUuid?: string | null;
	timestamp?: string;
	entrypoint?: string;
	cwd?: string;
	isMeta?: boolean;
	isSidechain?: boolean;
	promptId?: string;
	sourceToolAssistantUUID?: string;
	message?: Record<string, unknown>;
};

type ClaudeFile = {
	path: string;
	sha256: string;
	records: ClaudeRecord[];
};

async function readClaudeFile(path: string): Promise<ClaudeFile> {
	const { records: jsonRecords, text } = await readJsonlObjects(path);
	const records = jsonRecords as ClaudeRecord[];
	return { path, sha256: sha256(text), records };
}

function claudeTimestamp(record: ClaudeRecord): number {
	const value =
		typeof record.timestamp === "string" ? Date.parse(record.timestamp) : 0;
	return Number.isFinite(value) ? value : 0;
}

function isClaudeHumanPrompt(record: ClaudeRecord): boolean {
	if (
		record.type !== "user" ||
		record.isMeta === true ||
		record.isSidechain === true
	) {
		return false;
	}
	const content = asObject(record.message).content;
	if (typeof content === "string") return true;
	if (!Array.isArray(content)) return false;
	return (
		content.some((item) => asObject(item).type === "text") &&
		!content.some((item) => asObject(item).type === "tool_result")
	);
}

function claudeUsage(record: ClaudeRecord): HistoryTokenBuckets | null {
	if (record.type !== "assistant") return null;
	const usage = asObject(asObject(record.message).usage);
	if (Object.keys(usage).length === 0) return null;
	return {
		inputTokens: finiteNumber(usage.input_tokens),
		outputTokens: finiteNumber(usage.output_tokens),
		cacheReadTokens: finiteNumber(usage.cache_read_input_tokens),
		cacheCreationTokens: finiteNumber(usage.cache_creation_input_tokens),
	};
}

type ClaudeAssistantSnapshot = {
	messageId: string;
	usage: HistoryTokenBuckets;
	model: string | null;
	stopReason: string | null;
	atMs: number;
	records: ClaudeRecord[];
	childFile: string | null;
};

function claudeAssistantSnapshots(
	file: ClaudeFile,
	childFile: string | null,
): ClaudeAssistantSnapshot[] {
	const snapshots = new Map<string, ClaudeAssistantSnapshot>();
	for (const record of file.records) {
		const usage = claudeUsage(record);
		if (!usage) continue;
		const message = asObject(record.message);
		const messageId =
			typeof message.id === "string"
				? message.id
				: typeof record.uuid === "string"
					? record.uuid
					: "";
		if (!messageId) continue;
		const previous = snapshots.get(messageId);
		const snapshot: ClaudeAssistantSnapshot = {
			messageId,
			usage,
			model: typeof message.model === "string" ? message.model : null,
			stopReason:
				typeof message.stop_reason === "string" ? message.stop_reason : null,
			atMs: claudeTimestamp(record),
			records: [...(previous?.records ?? []), record],
			childFile,
		};
		// Claude writes repeated snapshots for a single API message. The final
		// snapshot is the complete usage envelope; counting every row multiplies
		// cached input by the number of streamed content blocks.
		snapshots.set(messageId, snapshot);
	}
	return [...snapshots.values()];
}

function claudeChildDir(rootFile: string, nativeSessionId: string): string {
	return join(dirname(rootFile), nativeSessionId, "subagents");
}

async function loadClaudeChildren(
	rootFile: string,
	nativeSessionId: string,
): Promise<ClaudeFile[]> {
	const result: ClaudeFile[] = [];
	const childDir = claudeChildDir(rootFile, nativeSessionId);
	try {
		for await (const path of new Bun.Glob("*.jsonl").scan({
			cwd: childDir,
			absolute: true,
		})) {
			result.push(await readClaudeFile(path));
		}
	} catch {
		// A session without a subagents directory is normal.
	}
	return result;
}

function nearestClaudePrompt(args: {
	startUuid: string | null | undefined;
	recordsByUuid: Map<string, ClaudeRecord>;
	promptByUuid: Map<string, string>;
}): string | null {
	let uuid = args.startUuid ?? null;
	const seen = new Set<string>();
	while (uuid && !seen.has(uuid)) {
		seen.add(uuid);
		const direct = args.promptByUuid.get(uuid);
		if (direct) return direct;
		const record = args.recordsByUuid.get(uuid);
		uuid = typeof record?.parentUuid === "string" ? record.parentUuid : null;
	}
	return null;
}

type ClaudeQueryGroup = {
	prompt: ClaudeRecord;
	promptKey: string;
	calls: ClaudeAssistantSnapshot[];
	durationMs: number | null;
};

type ClaudeQueryCandidate = {
	nativeSessionId: string;
	prompt: ClaudeRecord;
	promptKey: string;
	calls: ClaudeAssistantSnapshot[];
	durationMs: number | null;
	root: ClaudeFile;
	children: ClaudeFile[];
	cwd: string | null;
};

type ClaudeSessionCandidate = {
	nativeSessionId: string;
	importedSessionId: string;
	createSession: boolean;
	sourceId: string;
	sourceHash: string;
	cwd: string | null;
	queries: ClaudeQueryCandidate[];
};

function claudeCandidateEndMs(candidate: ClaudeQueryCandidate): number {
	const startedAtMs = claudeTimestamp(candidate.prompt);
	return Math.max(
		startedAtMs,
		...candidate.calls.map((call) => call.atMs),
		candidate.durationMs ? startedAtMs + candidate.durationMs : 0,
	);
}

function compareClaudeCandidateOwnership(
	a: ClaudeQueryCandidate,
	b: ClaudeQueryCandidate,
): number {
	const started = claudeTimestamp(a.prompt) - claudeTimestamp(b.prompt);
	if (started !== 0) return started;
	const ended = claudeCandidateEndMs(a) - claudeCandidateEndMs(b);
	if (ended !== 0) return ended;
	const calls = a.calls.length - b.calls.length;
	if (calls !== 0) return calls;
	return (
		a.nativeSessionId.localeCompare(b.nativeSessionId) ||
		a.promptKey.localeCompare(b.promptKey) ||
		a.root.path.localeCompare(b.root.path)
	);
}

function buildClaudeQuery(
	candidate: ClaudeQueryCandidate,
): ProviderHistoryQuery | null {
	const calls = [...candidate.calls]
		.filter((call) => call.model !== "<synthetic>" || positiveUsage(call.usage))
		.sort((a, b) => a.atMs - b.atMs || a.messageId.localeCompare(b.messageId));
	if (calls.length === 0) return null;
	let usage = { ...EMPTY_USAGE };
	for (const call of calls) usage = addUsage(usage, call.usage);
	if (!positiveUsage(usage)) return null;
	const mainCalls = calls.filter((call) => call.childFile == null);
	const preferredCalls = mainCalls.length > 0 ? mainCalls : calls;
	const finalCall = preferredCalls.at(-1);
	const model =
		[...preferredCalls]
			.reverse()
			.find((call) => call.model && call.model !== "<synthetic>")?.model ??
		null;
	const startedAtMs = claudeTimestamp(candidate.prompt);
	const endedAtMs = Math.max(
		startedAtMs,
		...calls.map((call) => call.atMs),
		candidate.durationMs ? startedAtMs + candidate.durationMs : 0,
	);
	const sourceId = `prompt:${candidate.nativeSessionId}:${candidate.promptKey}`;
	const estimatedCost = estimateClaudeCost(model, usage, endedAtMs);
	const childIds = [
		...new Set(
			calls
				.map((call) => call.childFile)
				.filter((path): path is string => path != null)
				.map((path) => basename(path, ".jsonl")),
		),
	];
	const callIds = calls.map((call) => call.messageId);
	const sources = [candidate.root, ...candidate.children]
		.filter(
			(file) =>
				file.path === candidate.root.path ||
				calls.some((call) => call.childFile === file.path),
		)
		.map(({ path, sha256 }) => ({ path, sha256 }));
	return {
		providerId: "claude",
		nativeSessionId: candidate.nativeSessionId,
		sourceId,
		sourceHash: canonicalHash({
			provider: "claude",
			sourceId,
			usage,
			model,
			callIds,
		}),
		startedAt: Math.floor(startedAtMs / 1_000),
		timestamp: Math.floor(endedAtMs / 1_000),
		durationMs: candidate.durationMs ?? Math.max(0, endedAtMs - startedAtMs),
		turns: calls.length,
		stopReason: finalCall?.stopReason ?? null,
		model,
		cwd: candidate.cwd,
		sourceSurface: "claude-cli",
		contextWindow: null,
		tokensInContext: finalCall
			? finalCall.usage.inputTokens +
				finalCall.usage.cacheReadTokens +
				finalCall.usage.cacheCreationTokens
			: null,
		usage,
		estimatedCost,
		unpriced: estimatedCost == null ? 1 : 0,
		evidence: {
			rootId: `${candidate.nativeSessionId}:${candidate.promptKey}`,
			childIds,
			callIds,
			sources,
		},
	};
}

async function planClaudeRoot(args: {
	root: ClaudeFile;
	children: ClaudeFile[];
	nativeSessionId: string;
	importedSessionId: string;
	createSession: boolean;
	state: PlannerState;
}): Promise<ClaudeSessionCandidate | null> {
	const recordsByUuid = new Map<string, ClaudeRecord>();
	for (const record of args.root.records) {
		if (typeof record.uuid === "string") recordsByUuid.set(record.uuid, record);
	}
	const prompts = new Map<string, ClaudeRecord>();
	const promptByUuid = new Map<string, string>();
	for (const record of args.root.records) {
		if (!isClaudeHumanPrompt(record) || typeof record.uuid !== "string")
			continue;
		const promptKey =
			typeof record.promptId === "string" ? record.promptId : record.uuid;
		if (!prompts.has(promptKey)) prompts.set(promptKey, record);
		promptByUuid.set(record.uuid, promptKey);
	}
	const groups = new Map<string, ClaudeQueryGroup>();
	for (const [promptKey, prompt] of prompts) {
		groups.set(promptKey, {
			prompt,
			promptKey,
			calls: [],
			durationMs: null,
		});
	}

	const rootSnapshots = claudeAssistantSnapshots(args.root, null);
	const unassigned: ClaudeAssistantSnapshot[] = [];
	for (const snapshot of rootSnapshots) {
		let promptKey: string | null = null;
		for (const record of [...snapshot.records].reverse()) {
			promptKey = nearestClaudePrompt({
				startUuid:
					typeof record.parentUuid === "string"
						? record.parentUuid
						: record.uuid,
				recordsByUuid,
				promptByUuid,
			});
			if (promptKey) break;
		}
		const group = promptKey ? groups.get(promptKey) : null;
		if (group) group.calls.push(snapshot);
		else if (positiveUsage(snapshot.usage)) unassigned.push(snapshot);
	}
	const promptByAgentId = new Map<string, string>();
	for (const record of args.root.records) {
		const agentId = asObject(record.toolUseResult).agentId;
		if (typeof agentId !== "string") continue;
		const promptKey = nearestClaudePrompt({
			startUuid:
				typeof record.parentUuid === "string" ? record.parentUuid : record.uuid,
			recordsByUuid,
			promptByUuid,
		});
		if (promptKey) promptByAgentId.set(agentId, promptKey);
	}

	for (const child of args.children) {
		const filenameAgentId = basename(child.path, ".jsonl").replace(
			/^agent-/,
			"",
		);
		let ownerPrompt: string | null =
			promptByAgentId.get(filenameAgentId) ?? null;
		for (const record of child.records) {
			if (ownerPrompt) break;
			if (typeof record.sourceToolAssistantUUID !== "string") continue;
			ownerPrompt = nearestClaudePrompt({
				startUuid: record.sourceToolAssistantUUID,
				recordsByUuid,
				promptByUuid,
			});
			if (ownerPrompt) break;
		}
		const snapshots = claudeAssistantSnapshots(child, child.path);
		const group = ownerPrompt ? groups.get(ownerPrompt) : null;
		if (group) group.calls.push(...snapshots);
		else
			unassigned.push(...snapshots.filter(({ usage }) => positiveUsage(usage)));
	}
	// Message ids are provider-call identities. Claude can copy the same assistant
	// snapshot into a parent and one or more subagent files, so dedupe globally,
	// preferring the parent copy and otherwise the latest complete snapshot.
	const uniqueCalls = new Map<
		string,
		{ promptKey: string; call: ClaudeAssistantSnapshot }
	>();
	for (const [promptKey, group] of groups) {
		for (const call of group.calls) {
			const previous = uniqueCalls.get(call.messageId);
			const prefer =
				!previous ||
				(previous.call.childFile != null && call.childFile == null) ||
				(previous.call.childFile === call.childFile &&
					call.atMs >= previous.call.atMs);
			if (prefer) uniqueCalls.set(call.messageId, { promptKey, call });
		}
		group.calls = [];
	}
	for (const { promptKey, call } of uniqueCalls.values()) {
		groups.get(promptKey)?.calls.push(call);
	}
	const assignedCallIds = new Set(uniqueCalls.keys());
	const unresolvedCalls = new Map<string, ClaudeAssistantSnapshot>();
	for (const call of unassigned) {
		if (assignedCallIds.has(call.messageId)) continue;
		const previous = unresolvedCalls.get(call.messageId);
		if (!previous || call.atMs >= previous.atMs) {
			unresolvedCalls.set(call.messageId, call);
		}
	}

	for (const record of args.root.records) {
		if (
			record.type !== "system" ||
			record.subtype !== "turn_duration" ||
			typeof record.parentUuid !== "string"
		) {
			continue;
		}
		const promptKey = nearestClaudePrompt({
			startUuid: record.parentUuid,
			recordsByUuid,
			promptByUuid,
		});
		const group = promptKey ? groups.get(promptKey) : null;
		const duration = finiteNumber(record.durationMs);
		if (group && duration > 0) group.durationMs = duration;
	}

	if (unresolvedCalls.size > 0) {
		args.state.skipped.push({
			providerId: "claude",
			nativeSessionId: args.nativeSessionId,
			reason: "unassigned-claude-usage",
			detail: `${unresolvedCalls.size} assistant API messages lacked a causal top-level prompt`,
		});
		return null;
	}

	const cwd =
		args.root.records.find((record) => typeof record.cwd === "string")?.cwd ??
		null;
	const queries: ClaudeQueryCandidate[] = [];
	for (const group of groups.values()) {
		const calls = group.calls.filter(
			(call) => call.model !== "<synthetic>" || positiveUsage(call.usage),
		);
		if (calls.length === 0) continue;
		let usage = { ...EMPTY_USAGE };
		for (const call of calls) usage = addUsage(usage, call.usage);
		if (!positiveUsage(usage)) continue;
		queries.push({
			nativeSessionId: args.nativeSessionId,
			prompt: group.prompt,
			promptKey: group.promptKey,
			calls,
			durationMs: group.durationMs,
			root: args.root,
			children: args.children,
			cwd,
		});
	}
	if (queries.length === 0) return null;
	const sourceId = `session:${args.nativeSessionId}`;
	return {
		nativeSessionId: args.nativeSessionId,
		importedSessionId: args.importedSessionId,
		sourceId,
		sourceHash: canonicalHash({
			provider: "claude",
			nativeSessionId: args.nativeSessionId,
			cwd,
			sourceSurface: "claude-cli",
		}),
		createSession: args.createSession,
		cwd,
		queries,
	};
}

function claudeCandidateSourceId(candidate: ClaudeQueryCandidate): string {
	return `prompt:${candidate.nativeSessionId}:${candidate.promptKey}`;
}

function existingClaudeCallOwners(
	state: PlannerState,
): Map<string, string | null> {
	const querySources = new Map<number, string>();
	for (const row of state.provenance.values()) {
		if (
			row.provider_id === "claude" &&
			row.source_kind === "query" &&
			row.imported_query_id != null
		) {
			querySources.set(row.imported_query_id, row.source_id);
		}
	}
	const owners = new Map<string, string | null>();
	for (const row of state.provenance.values()) {
		if (row.provider_id !== "claude" || row.source_kind !== "call") continue;
		owners.set(
			row.source_id,
			row.imported_query_id == null
				? null
				: (querySources.get(row.imported_query_id) ?? null),
		);
	}
	return owners;
}

function reconcileClaudeCallsGlobally(
	sessions: ClaudeSessionCandidate[],
	state: PlannerState,
): ProviderHistorySession[] {
	type Occurrence = {
		candidate: ClaudeQueryCandidate;
		call: ClaudeAssistantSnapshot;
	};
	const occurrences = new Map<string, Occurrence[]>();
	for (const session of sessions) {
		for (const candidate of session.queries) {
			for (const call of candidate.calls) {
				const rows = occurrences.get(call.messageId) ?? [];
				rows.push({ candidate, call });
				occurrences.set(call.messageId, rows);
			}
		}
	}

	const importedOwners = existingClaudeCallOwners(state);
	const assigned = new Map<ClaudeQueryCandidate, ClaudeAssistantSnapshot[]>();
	for (const [messageId, rows] of occurrences) {
		const importedOwner = importedOwners.get(messageId);
		let eligible = rows;
		if (importedOwners.has(messageId)) {
			eligible = rows.filter(
				({ candidate }) =>
					importedOwner != null &&
					claudeCandidateSourceId(candidate) === importedOwner,
			);
			// A call already imported from a source outside the current scan remains
			// claimed there. Removing it here lets a newly discovered continuation
			// retain only its genuinely new API calls.
			if (eligible.length === 0) continue;
		}
		eligible.sort((a, b) => {
			const owner = compareClaudeCandidateOwnership(a.candidate, b.candidate);
			if (owner !== 0) return owner;
			const parent =
				Number(a.call.childFile != null) - Number(b.call.childFile != null);
			if (parent !== 0) return parent;
			return b.call.atMs - a.call.atMs;
		});
		const winner = eligible[0];
		const calls = assigned.get(winner.candidate) ?? [];
		calls.push(winner.call);
		assigned.set(winner.candidate, calls);
	}

	const result: ProviderHistorySession[] = [];
	for (const candidateSession of sessions) {
		const queries: ProviderHistoryQuery[] = [];
		for (const candidate of candidateSession.queries) {
			candidate.calls = assigned.get(candidate) ?? [];
			const query = buildClaudeQuery(candidate);
			if (!query) continue;
			if (
				queryImportDisposition({
					state,
					providerId: "claude",
					sourceId: query.sourceId,
					sourceHash: query.sourceHash,
					nativeSessionId: candidate.nativeSessionId,
				}) !== "new"
			) {
				continue;
			}
			queries.push(query);
			includeSources(state, query.evidence.sources);
		}
		if (queries.length === 0) continue;
		queries.sort(
			(a, b) =>
				a.startedAt - b.startedAt || a.sourceId.localeCompare(b.sourceId),
		);
		const startedAt = Math.min(...queries.map((query) => query.startedAt));
		const endedAt = Math.max(...queries.map((query) => query.timestamp));
		const model =
			[...queries].reverse().find((query) => query.model)?.model ?? null;
		result.push({
			providerId: "claude",
			nativeSessionId: candidateSession.nativeSessionId,
			importedSessionId: candidateSession.importedSessionId,
			sourceId: candidateSession.sourceId,
			sourceHash: candidateSession.sourceHash,
			createSession: candidateSession.createSession,
			label: `Imported Claude CLI · ${formatImportDate(startedAt)}`,
			model,
			cwd: candidateSession.cwd,
			sourceSurface: "claude-cli",
			startedAt,
			endedAt,
			queries,
		});
	}
	return result;
}

async function planClaudeSessions(args: {
	db: Database;
	projectRoots: string[];
	state: PlannerState;
}): Promise<{
	sessions: ProviderHistorySession[];
	rootSessions: number;
	subagentFiles: number;
}> {
	const native = nativeClaudeSessions(args.db);
	const sessionIds = existingSessionIds(args.db);
	const candidates: ClaudeSessionCandidate[] = [];
	let rootSessions = 0;
	let subagentFiles = 0;
	for (const projectRoot of args.projectRoots) {
		try {
			for await (const path of new Bun.Glob("*/*.jsonl").scan({
				cwd: projectRoot,
				absolute: true,
			})) {
				rootSessions++;
				const root = await readClaudeFile(path);
				const nativeSessionId =
					root.records.find((record) => typeof record.sessionId === "string")
						?.sessionId ?? basename(path, ".jsonl");
				const disposition = sessionDisposition({
					providerId: "claude",
					nativeSessionId,
					native,
					existingSessionIds: sessionIds,
					provenance: args.state.provenance,
				});
				if (disposition.kind === "existing-native") {
					args.state.skipped.push({
						providerId: "claude",
						nativeSessionId,
						reason: "existing-native-session",
					});
					continue;
				}
				if (disposition.kind === "tombstone") {
					args.state.alreadyImportedSessions++;
					args.state.skipped.push({
						providerId: "claude",
						nativeSessionId,
						reason: "import-tombstone",
					});
					continue;
				}
				if (disposition.kind === "existing-import") {
					args.state.alreadyImportedSessions++;
				}
				const entrypoints = new Set(
					root.records
						.map((record) => record.entrypoint)
						.filter((entry): entry is string => typeof entry === "string"),
				);
				if (!entrypoints.has("cli")) {
					args.state.skipped.push({
						providerId: "claude",
						nativeSessionId,
						reason: "unsupported-entrypoint",
						detail: [...entrypoints].join(",") || "missing entrypoint",
					});
					continue;
				}
				const children = await loadClaudeChildren(path, nativeSessionId);
				subagentFiles += children.length;
				const session = await planClaudeRoot({
					root,
					children,
					nativeSessionId,
					importedSessionId: disposition.importedSessionId,
					createSession: disposition.kind === "new",
					state: args.state,
				});
				if (session) candidates.push(session);
				else if (
					disposition.kind === "new" &&
					!args.state.skipped.some(
						(row) =>
							row.providerId === "claude" &&
							row.nativeSessionId === nativeSessionId &&
							row.reason === "unassigned-claude-usage",
					)
				) {
					args.state.skipped.push({
						providerId: "claude",
						nativeSessionId,
						reason: "no-terminal-usage",
					});
				}
			}
		} catch {
			// Optional roots may not exist on every host.
		}
	}
	return {
		sessions: reconcileClaudeCallsGlobally(candidates, args.state),
		rootSessions,
		subagentFiles,
	};
}

function manifestTotals(
	sessions: ProviderHistorySession[],
): ProviderHistoryImportManifest["totals"] {
	let usage = { ...EMPTY_USAGE };
	let queries = 0;
	let turns = 0;
	for (const session of sessions) {
		for (const query of session.queries) {
			usage = addUsage(usage, query.usage);
			queries++;
			turns += query.turns;
		}
	}
	return { ...usage, sessions: sessions.length, queries, turns };
}

export async function planProviderHistoryImport(args: {
	db: Database;
	codexRoots?: string[];
	claudeRoots?: string[];
	databasePath?: string;
}): Promise<ProviderHistoryImportManifest> {
	const state: PlannerState = {
		provenance: provenanceRows(args.db),
		skipped: [],
		alreadyImportedSessions: 0,
		alreadyImportedQueries: 0,
		sourceFiles: new Map(),
	};
	const codexRoots = [...(args.codexRoots ?? [])];
	const claudeRoots = [...(args.claudeRoots ?? [])];
	const [codex, claude] = await Promise.all([
		planCodexSessions({
			db: args.db,
			rolloutRoots: codexRoots,
			state,
		}),
		planClaudeSessions({
			db: args.db,
			projectRoots: claudeRoots,
			state,
		}),
	]);
	const sessions = [...codex.sessions, ...claude.sessions].sort(
		(a, b) =>
			a.startedAt - b.startedAt ||
			a.importedSessionId.localeCompare(b.importedSessionId),
	);
	canonicalizeHistoryCwds(args.db, sessions);
	return {
		version: PROVIDER_HISTORY_IMPORT_VERSION,
		createdAt: new Date().toISOString(),
		databasePath: args.databasePath,
		codexRoots,
		claudeRoots,
		scanned: {
			codexRollouts: codex.scannedRollouts,
			claudeRootSessions: claude.rootSessions,
			claudeSubagentFiles: claude.subagentFiles,
		},
		sourceFiles: [...state.sourceFiles.values()].sort((a, b) =>
			a.path.localeCompare(b.path),
		),
		sessions,
		skipped: state.skipped,
		alreadyImported: {
			sessions: state.alreadyImportedSessions,
			queries: state.alreadyImportedQueries,
		},
		totals: manifestTotals(sessions),
	};
}

async function verifyManifestSources(
	manifest: ProviderHistoryImportManifest,
): Promise<void> {
	for (const source of manifest.sourceFiles) {
		const current = await fileHash(source.path).catch(() => null);
		if (current !== source.sha256) {
			throw new Error(
				`History source changed after planning: ${source.path}; no rows were imported`,
			);
		}
	}
}

function insertDynamic(
	db: Database,
	table: string,
	values: Record<string, string | number | null>,
): number {
	const available = tableColumns(db, table);
	const entries = Object.entries(values).filter(([column]) =>
		available.has(column),
	);
	const columns = entries.map(([column]) => column);
	const placeholders = entries.map(() => "?");
	const result = db.run(
		`INSERT INTO ${table} (${columns.join(", ")}) VALUES (${placeholders.join(", ")})`,
		entries.map(([, value]) => value),
	);
	return Number(result.lastInsertRowid);
}

function insertSession(db: Database, session: ProviderHistorySession): void {
	insertDynamic(db, "sessions", {
		id: session.importedSessionId,
		label: session.label,
		model: session.model,
		selected_model: null,
		actual_model: session.model,
		started_at: session.startedAt,
		ended_at: session.endedAt,
		query_count: 0,
		total_cost: 0,
		total_estimated_cost: 0,
		unpriced_query_count: 0,
		total_input_tokens: 0,
		total_output_tokens: 0,
		total_cache_read_tokens: 0,
		total_cache_creation_tokens: 0,
		total_turns: 0,
		agent_cwd: session.cwd,
		provider_id: session.providerId,
		// Imported usage rows are historical facts, not resumable chats. The
		// provider-native identity remains canonical in history_import_items.
		provider_session_id: null,
		claude_session_id: null,
		history_imported: 1,
	});
	if (tableExists(db, "session_search")) {
		db.run(
			`INSERT OR IGNORE INTO session_search (session_id, text) VALUES (?, ?)`,
			[session.importedSessionId, session.label.toLocaleLowerCase()],
		);
	}
}

function insertQuery(
	db: Database,
	session: ProviderHistorySession,
	query: ProviderHistoryQuery,
): { queryId: number; usageQueryId: number } {
	const queryId = insertDynamic(db, "queries", {
		session_id: session.importedSessionId,
		timestamp: query.timestamp,
		provider_id: query.providerId,
		cost: 0,
		estimated_cost: query.estimatedCost,
		cost_known: query.estimatedCost == null ? 0 : 1,
		input_tokens: query.usage.inputTokens,
		output_tokens: query.usage.outputTokens,
		cache_read_tokens: query.usage.cacheReadTokens,
		cache_creation_tokens: query.usage.cacheCreationTokens,
		duration_ms: query.durationMs,
		turns: query.turns,
		context_window: query.contextWindow,
		stop_reason: query.stopReason,
		tokens_in_context: query.tokensInContext,
		model: query.model,
		agent_cwd: query.cwd,
		cwd: query.cwd,
		source: query.sourceSurface,
		source_surface: query.sourceSurface,
	});
	const usageQueryId = insertDynamic(db, "usage_queries", {
		session_id: session.importedSessionId,
		timestamp: query.timestamp,
		cost: 0,
		estimated_cost: query.estimatedCost,
		cost_known: query.estimatedCost == null ? 0 : 1,
		unpriced: query.unpriced,
		input_tokens: query.usage.inputTokens,
		output_tokens: query.usage.outputTokens,
		cache_read_tokens: query.usage.cacheReadTokens,
		cache_creation_tokens: query.usage.cacheCreationTokens,
		turns: query.turns,
		provider_id: query.providerId,
		model: query.model,
		agent_cwd: query.cwd,
		cwd: query.cwd,
		source: query.sourceSurface,
		source_surface: query.sourceSurface,
	});
	return { queryId, usageQueryId };
}

function insertProvenance(
	db: Database,
	row: {
		providerId: HistoryProviderId;
		sourceKind: ProvenanceSourceKind;
		sourceId: string;
		sourceHash: string;
		importedSessionId: string;
		queryId?: number;
		usageQueryId?: number;
	},
): void {
	db.run(
		`INSERT INTO history_import_items
		 (provider_id, source_kind, source_id, source_hash, imported_session_id,
		  imported_query_id, imported_usage_query_id)
		 VALUES (?, ?, ?, ?, ?, ?, ?)`,
		[
			row.providerId,
			row.sourceKind,
			row.sourceId,
			row.sourceHash,
			row.importedSessionId,
			row.queryId ?? null,
			row.usageQueryId ?? null,
		],
	);
}

function selectProvenance(
	db: Database,
	providerId: HistoryProviderId,
	sourceKind: ProvenanceSourceKind,
	sourceId: string,
): ProvenanceRow | null {
	return (
		db
			.query<ProvenanceRow, [string, string, string]>(`
				SELECT provider_id, source_kind, source_id, source_hash,
				       imported_session_id, imported_query_id, imported_usage_query_id
				FROM history_import_items
				WHERE provider_id = ? AND source_kind = ? AND source_id = ?
			`)
			.get(providerId, sourceKind, sourceId) ?? null
	);
}

function ensureCallProvenance(
	db: Database,
	session: ProviderHistorySession,
	query: ProviderHistoryQuery,
	ids: { queryId: number; usageQueryId: number },
): void {
	for (const callId of query.evidence.callIds) {
		const sourceHash = canonicalHash({
			provider: query.providerId,
			callId,
		});
		const existing = selectProvenance(db, query.providerId, "call", callId);
		if (existing) {
			if (
				existing.source_hash !== sourceHash ||
				existing.imported_session_id !== session.importedSessionId ||
				existing.imported_query_id !== ids.queryId ||
				existing.imported_usage_query_id !== ids.usageQueryId
			) {
				throw new Error(
					`Native call provenance conflict for ${query.providerId}/${callId}; no rows were imported`,
				);
			}
			continue;
		}
		insertProvenance(db, {
			providerId: query.providerId,
			sourceKind: "call",
			sourceId: callId,
			sourceHash,
			importedSessionId: session.importedSessionId,
			queryId: ids.queryId,
			usageQueryId: ids.usageQueryId,
		});
	}
}

function rebuildImportedSession(db: Database, sessionId: string): void {
	db.run(
		`UPDATE sessions SET
		 query_count = (SELECT COUNT(*) FROM queries WHERE session_id = ?),
		 total_cost = COALESCE((SELECT SUM(cost) FROM queries WHERE session_id = ?), 0),
		 total_estimated_cost = COALESCE((SELECT SUM(estimated_cost) FROM queries WHERE session_id = ?), 0),
			 unpriced_query_count = COALESCE((SELECT SUM(CASE WHEN estimated_cost IS NULL AND COALESCE(cost_known, 0) = 0 THEN 1 ELSE 0 END) FROM queries WHERE session_id = ?), 0),
		 total_input_tokens = COALESCE((SELECT SUM(input_tokens) FROM queries WHERE session_id = ?), 0),
		 total_output_tokens = COALESCE((SELECT SUM(output_tokens) FROM queries WHERE session_id = ?), 0),
		 total_cache_read_tokens = COALESCE((SELECT SUM(cache_read_tokens) FROM queries WHERE session_id = ?), 0),
		 total_cache_creation_tokens = COALESCE((SELECT SUM(cache_creation_tokens) FROM queries WHERE session_id = ?), 0),
			 total_turns = COALESCE((SELECT SUM(turns) FROM queries WHERE session_id = ?), 0),
			 ended_at = COALESCE((SELECT MAX(timestamp) FROM queries WHERE session_id = ?), ended_at)
		 WHERE id = ?`,
		[
			sessionId,
			sessionId,
			sessionId,
			sessionId,
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

function dateForTimestamp(db: Database, timestamp: number): string {
	return (
		db
			.query<{ date: string }, [number]>(
				`SELECT DATE(?, 'unixepoch', 'localtime') AS date`,
			)
			.get(timestamp)?.date ?? ""
	);
}

function verifyImportedSession(db: Database, sessionId: string): void {
	type Totals = {
		queries: number;
		input: number;
		output: number;
		read: number;
		creation: number;
		turns: number;
	};
	const query = db
		.query<Totals, [string]>(`
			SELECT COUNT(*) AS queries,
			       COALESCE(SUM(input_tokens), 0) AS input,
			       COALESCE(SUM(output_tokens), 0) AS output,
			       COALESCE(SUM(cache_read_tokens), 0) AS read,
			       COALESCE(SUM(cache_creation_tokens), 0) AS creation,
			       COALESCE(SUM(turns), 0) AS turns
			FROM queries WHERE session_id = ?
		`)
		.get(sessionId);
	const ledger = db
		.query<Totals, [string]>(`
			SELECT COUNT(*) AS queries,
			       COALESCE(SUM(input_tokens), 0) AS input,
			       COALESCE(SUM(output_tokens), 0) AS output,
			       COALESCE(SUM(cache_read_tokens), 0) AS read,
			       COALESCE(SUM(cache_creation_tokens), 0) AS creation,
			       COALESCE(SUM(turns), 0) AS turns
			FROM usage_queries WHERE session_id = ?
		`)
		.get(sessionId);
	if (!query || !ledger || JSON.stringify(query) !== JSON.stringify(ledger)) {
		throw new Error(`Imported query/ledger totals diverged for ${sessionId}`);
	}
	const session = db
		.query<
			{
				query_count: number;
				total_input_tokens: number;
				total_output_tokens: number;
				total_cache_read_tokens: number;
				total_cache_creation_tokens: number;
				total_turns: number;
			},
			[string]
		>(`
			SELECT query_count, total_input_tokens, total_output_tokens,
			       total_cache_read_tokens, total_cache_creation_tokens, total_turns
			FROM sessions WHERE id = ?
		`)
		.get(sessionId);
	if (
		!session ||
		session.query_count !== query.queries ||
		session.total_input_tokens !== query.input ||
		session.total_output_tokens !== query.output ||
		session.total_cache_read_tokens !== query.read ||
		session.total_cache_creation_tokens !== query.creation ||
		session.total_turns !== query.turns
	) {
		throw new Error(`Imported session aggregate diverged for ${sessionId}`);
	}
}

function verifyUsageDate(db: Database, date: string): void {
	type Daily = {
		queries: number;
		input_tokens: number;
		output_tokens: number;
		cache_read_tokens: number;
		cache_creation_tokens: number;
		turns: number;
	};
	const expected = db
		.query<Daily, [string]>(`
			SELECT COUNT(*) AS queries,
			       COALESCE(SUM(input_tokens), 0) AS input_tokens,
			       COALESCE(SUM(output_tokens), 0) AS output_tokens,
			       COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens,
			       COALESCE(SUM(cache_creation_tokens), 0) AS cache_creation_tokens,
			       COALESCE(SUM(turns), 0) AS turns
			FROM usage_queries
			WHERE DATE(timestamp, 'unixepoch', 'localtime') = ?
		`)
		.get(date);
	const actual = db
		.query<Daily, [string]>(`
			SELECT queries, input_tokens, output_tokens, cache_read_tokens,
			       cache_creation_tokens, turns
			FROM usage_daily WHERE date = ?
		`)
		.get(date);
	if (
		!expected ||
		!actual ||
		JSON.stringify(expected) !== JSON.stringify(actual)
	) {
		throw new Error(`Imported daily aggregate diverged for ${date}`);
	}
}

export async function applyProviderHistoryImport(
	db: Database,
	manifest: ProviderHistoryImportManifest,
): Promise<ApplyProviderHistoryImportResult> {
	if (manifest.version !== PROVIDER_HISTORY_IMPORT_VERSION) {
		throw new Error(
			`Unsupported provider history import version: ${manifest.version}`,
		);
	}
	await verifyManifestSources(manifest);
	let createdSessions = 0;
	let insertedQueries = 0;
	let alreadyImportedSessions = 0;
	let alreadyImportedQueries = 0;
	let tombstonedSessions = 0;
	const affectedSessions = new Set<string>();
	const affectedDates = new Set<string>();
	db.run("BEGIN IMMEDIATE");
	try {
		ensureProvenanceTable(db);
		for (const session of manifest.sessions) {
			const sessionProvenance = selectProvenance(
				db,
				session.providerId,
				"session",
				session.sourceId,
			);
			const storedSession = db
				.query<
					{
						id: string;
						provider_id: string;
						provider_session_id: string | null;
					},
					[string]
				>(
					`SELECT id, provider_id, provider_session_id FROM sessions WHERE id = ?`,
				)
				.get(session.importedSessionId);
			if (sessionProvenance) {
				if (
					sessionProvenance.source_hash !== session.sourceHash ||
					sessionProvenance.imported_session_id !== session.importedSessionId
				) {
					throw new Error(
						`Session provenance conflict for ${session.sourceId}; no rows were imported`,
					);
				}
				alreadyImportedSessions++;
				if (!storedSession) {
					tombstonedSessions++;
					continue;
				}
			} else if (storedSession) {
				throw new Error(
					`Imported session id already exists without provenance: ${session.importedSessionId}`,
				);
			} else {
				const nativeCollision = db
					.query<{ id: string }, [string, string]>(`
						SELECT id FROM sessions
						WHERE provider_id = ? AND provider_session_id = ?
					`)
					.get(session.providerId, session.nativeSessionId);
				if (nativeCollision) {
					throw new Error(
						`Native session appeared after planning: ${session.providerId}/${session.nativeSessionId}`,
					);
				}
				insertSession(db, session);
				insertProvenance(db, {
					providerId: session.providerId,
					sourceKind: "session",
					sourceId: session.sourceId,
					sourceHash: session.sourceHash,
					importedSessionId: session.importedSessionId,
				});
				createdSessions++;
			}

			for (const query of session.queries) {
				const provenance = selectProvenance(
					db,
					query.providerId,
					"query",
					query.sourceId,
				);
				if (provenance) {
					if (
						provenance.source_hash !== query.sourceHash ||
						provenance.imported_session_id !== session.importedSessionId
					) {
						throw new Error(
							`Query provenance conflict for ${query.sourceId}; no rows were imported`,
						);
					}
					if (
						provenance.imported_query_id == null ||
						provenance.imported_usage_query_id == null
					) {
						throw new Error(
							`Query provenance is missing mirrored row ids for ${query.sourceId}`,
						);
					}
					ensureCallProvenance(db, session, query, {
						queryId: provenance.imported_query_id,
						usageQueryId: provenance.imported_usage_query_id,
					});
					alreadyImportedQueries++;
					continue;
				}
				const ids = insertQuery(db, session, query);
				insertProvenance(db, {
					providerId: query.providerId,
					sourceKind: "query",
					sourceId: query.sourceId,
					sourceHash: query.sourceHash,
					importedSessionId: session.importedSessionId,
					queryId: ids.queryId,
					usageQueryId: ids.usageQueryId,
				});
				ensureCallProvenance(db, session, query, ids);
				insertedQueries++;
				affectedSessions.add(session.importedSessionId);
				const date = dateForTimestamp(db, query.timestamp);
				if (date) affectedDates.add(date);
			}
			db.run(
				`UPDATE sessions
				 SET started_at = MIN(started_at, ?),
				     ended_at = MAX(COALESCE(ended_at, ?), ?)
				 WHERE id = ?`,
				[
					session.startedAt,
					session.endedAt,
					session.endedAt,
					session.importedSessionId,
				],
			);
		}
		for (const sessionId of affectedSessions) {
			rebuildImportedSession(db, sessionId);
		}
		for (const date of affectedDates) rebuildUsageDate(db, date);
		for (const sessionId of affectedSessions) {
			verifyImportedSession(db, sessionId);
		}
		for (const date of affectedDates) verifyUsageDate(db, date);
		const foreignKeys = db.query("PRAGMA foreign_key_check").all();
		if (foreignKeys.length > 0) {
			throw new Error(
				`SQLite foreign-key check failed: ${JSON.stringify(foreignKeys)}`,
			);
		}
		db.run("COMMIT");
	} catch (error) {
		db.run("ROLLBACK");
		throw error;
	}
	return {
		createdSessions,
		insertedQueries,
		alreadyImportedSessions,
		alreadyImportedQueries,
		tombstonedSessions,
		affectedDates: affectedDates.size,
	};
}
