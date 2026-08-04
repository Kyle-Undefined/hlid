import type {
	SessionKey,
	SessionStore,
	SessionStoreEntry,
} from "@anthropic-ai/claude-agent-sdk";
import { getDb } from "#/db";

type TranscriptRow = {
	payload_json: string;
};

type TranscriptDeltaRow = {
	payload_json: string;
};

const appendQueues = new Map<string, Promise<void>>();

function storedSubpath(key: SessionKey): string {
	return key.subpath ?? "";
}

function parseEntries(payload: string): SessionStoreEntry[] {
	const value: unknown = JSON.parse(payload);
	return Array.isArray(value) ? (value as SessionStoreEntry[]) : [];
}

function parseEntry(payload: string): SessionStoreEntry {
	return JSON.parse(payload) as SessionStoreEntry;
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
			const subpath = storedSubpath(key);
			const row = db
				.query<TranscriptRow, [string, string]>(`
					SELECT payload_json
					FROM provider_history_transcripts
					WHERE provider_id = 'claude' AND native_session_id = ? AND subpath = ?
				`)
				.get(key.sessionId, subpath);
			if (!row) return null;
			const deltas = db
				.query<TranscriptDeltaRow, [string, string]>(`
					SELECT payload_json
					FROM provider_history_transcript_deltas
					WHERE provider_id = 'claude' AND native_session_id = ? AND subpath = ?
					ORDER BY id
				`)
				.all(key.sessionId, subpath)
				.map((delta) => parseEntry(delta.payload_json));
			return mergeEntries(parseEntries(row.payload_json), deltas);
		},
		async append(key, entries) {
			const subpath = storedSubpath(key);
			const queueKey = `${key.sessionId}\0${subpath}`;
			const previous = appendQueues.get(queueKey) ?? Promise.resolve();
			const append = async () => {
				const db = await getDb();
				db.transaction(() => {
					db.run(
						`INSERT OR IGNORE INTO provider_history_transcripts
						 (provider_id, native_session_id, subpath, source_path, source_hash,
						  payload_json, entry_count, updated_at)
						 VALUES ('claude', ?, ?, 'sdk-session-store', 'sdk-session-store',
						         '[]', 0, unixepoch())`,
						[key.sessionId, subpath],
					);
					const base = db
						.query<TranscriptRow, [string, string]>(`
							SELECT payload_json
							FROM provider_history_transcripts
							WHERE provider_id = 'claude'
							  AND native_session_id = ? AND subpath = ?
						`)
						.get(key.sessionId, subpath);
					const baseEntries = parseEntries(base?.payload_json ?? "[]");
					const baseUuids = new Set(
						baseEntries
							.map((entry) => entry.uuid)
							.filter((uuid): uuid is string => typeof uuid === "string"),
					);
					let insertedCount = 0;
					for (const entry of entries) {
						const uuid = typeof entry.uuid === "string" ? entry.uuid : null;
						if (uuid !== null && baseUuids.has(uuid)) continue;
						const result = db.run(
							`INSERT OR IGNORE INTO provider_history_transcript_deltas
							 (provider_id, native_session_id, subpath, uuid, payload_json)
							 VALUES ('claude', ?, ?, ?, ?)`,
							[key.sessionId, subpath, uuid, JSON.stringify(entry)],
						);
						insertedCount += result.changes;
					}
					db.run(
						`UPDATE provider_history_transcripts
						 SET entry_count = entry_count + ?, updated_at = unixepoch()
						 WHERE provider_id = 'claude'
						   AND native_session_id = ? AND subpath = ?`,
						[insertedCount, key.sessionId, subpath],
					);
				}).immediate();
			};
			const next = previous.then(append, append);
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
