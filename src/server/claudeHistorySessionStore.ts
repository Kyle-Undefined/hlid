import type {
	SessionKey,
	SessionStore,
	SessionStoreEntry,
} from "@anthropic-ai/claude-agent-sdk";
import { getDb } from "#/db";

type TranscriptRow = {
	payload_json: string;
	source_path: string;
	source_hash: string;
};

const appendQueues = new Map<string, Promise<void>>();

function storedSubpath(key: SessionKey): string {
	return key.subpath ?? "";
}

function parseEntries(payload: string): SessionStoreEntry[] {
	const value: unknown = JSON.parse(payload);
	return Array.isArray(value) ? (value as SessionStoreEntry[]) : [];
}

function mergeEntries(
	current: SessionStoreEntry[],
	incoming: SessionStoreEntry[],
): SessionStoreEntry[] {
	const seen = new Set(
		current
			.map((entry) => entry.uuid)
			.filter((uuid): uuid is string => typeof uuid === "string"),
	);
	const merged = [...current];
	for (const entry of incoming) {
		if (typeof entry.uuid === "string") {
			if (seen.has(entry.uuid)) continue;
			seen.add(entry.uuid);
		}
		merged.push(entry);
	}
	return merged;
}

export function createClaudeHistorySessionStore(): SessionStore {
	return {
		async load(key) {
			const db = await getDb();
			const row = db
				.query<TranscriptRow, [string, string]>(`
					SELECT payload_json, source_path, source_hash
					FROM provider_history_transcripts
					WHERE provider_id = 'claude' AND native_session_id = ? AND subpath = ?
				`)
				.get(key.sessionId, storedSubpath(key));
			return row ? parseEntries(row.payload_json) : null;
		},
		async append(key, entries) {
			const queueKey = `${key.sessionId}\0${storedSubpath(key)}`;
			const previous = appendQueues.get(queueKey) ?? Promise.resolve();
			const next = previous.then(async () => {
				const db = await getDb();
				const row = db
					.query<TranscriptRow, [string, string]>(`
						SELECT payload_json, source_path, source_hash
						FROM provider_history_transcripts
						WHERE provider_id = 'claude' AND native_session_id = ? AND subpath = ?
					`)
					.get(key.sessionId, storedSubpath(key));
				const merged = mergeEntries(
					row ? parseEntries(row.payload_json) : [],
					entries,
				);
				db.run(
					`INSERT INTO provider_history_transcripts
					 (provider_id, native_session_id, subpath, source_path, source_hash,
					  payload_json, entry_count, updated_at)
					 VALUES ('claude', ?, ?, ?, ?, ?, ?, unixepoch())
					 ON CONFLICT(provider_id, native_session_id, subpath) DO UPDATE SET
					  payload_json = excluded.payload_json,
					  entry_count = excluded.entry_count,
					  updated_at = excluded.updated_at`,
					[
						key.sessionId,
						storedSubpath(key),
						row?.source_path ?? "sdk-session-store",
						row?.source_hash ?? "sdk-session-store",
						JSON.stringify(merged),
						merged.length,
					],
				);
			});
			appendQueues.set(queueKey, next);
			try {
				await next;
			} finally {
				if (appendQueues.get(queueKey) === next) appendQueues.delete(queueKey);
			}
		},
		async listSubkeys(key) {
			const db = await getDb();
			return db
				.query<{ subpath: string }, [string]>(`
					SELECT subpath FROM provider_history_transcripts
					WHERE provider_id = 'claude' AND native_session_id = ? AND subpath <> ''
					ORDER BY subpath
				`)
				.all(key.sessionId)
				.map((row) => row.subpath);
		},
	};
}
