import { markAnalyticsChanged } from "./analyticsRevision";
import { getDb } from "./schema";

export async function getSetting(key: string): Promise<string | null> {
	const db = await getDb();
	const row = db
		.query<{ value: string }, [string]>(
			`SELECT value FROM settings WHERE key = ?`,
		)
		.get(key);
	return row?.value ?? null;
}

export async function saveSetting(key: string, value: string): Promise<void> {
	const db = await getDb();
	await db.run(
		`INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, unixepoch())`,
		[key, value],
	);
	if (key.startsWith("rl_")) {
		markAnalyticsChanged(["providerUsage"], "provider_usage_updated");
	}
}

async function deleteSetting(key: string): Promise<void> {
	const db = await getDb();
	await db.run(`DELETE FROM settings WHERE key = ?`, [key]);
}

// ─── current_session_id shorthands ───────────────────────────────────────────

export async function getCurrentSessionId(): Promise<string | null> {
	return getSetting("current_session_id");
}

export async function setCurrentSessionId(id: string): Promise<void> {
	return saveSetting("current_session_id", id);
}

export async function clearCurrentSessionId(): Promise<void> {
	return deleteSetting("current_session_id");
}
