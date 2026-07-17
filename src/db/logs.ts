import { getDb } from "./schema";
import type { LogCounts, LogLevel, LogRow } from "./types";

/** Maximum number of rows retained in the event_log table. */
const LOG_MAX_ROWS = 1000;

export async function appendLog(
	level: LogLevel,
	source: string,
	message: string,
	detail?: unknown,
): Promise<void> {
	try {
		const db = await getDb();
		db.transaction(() => {
			db.run(
				`INSERT INTO event_log (level, source, message, detail) VALUES (?, ?, ?, ?)`,
				[
					level,
					source,
					message,
					detail !== undefined ? JSON.stringify(detail) : null,
				],
			);
			db.run(
				`DELETE FROM event_log WHERE id <= (SELECT id FROM event_log ORDER BY id DESC LIMIT 1 OFFSET ${LOG_MAX_ROWS})`,
			);
		})();
	} catch (e) {
		console.error("[db] appendLog failed:", e);
	}
}

export async function getLogs(
	page: number,
	pageSize: number,
	level?: LogLevel,
): Promise<{ logs: LogRow[]; total: number; counts: LogCounts }> {
	const db = await getDb();
	const offset = (Math.max(1, page) - 1) * Math.max(1, pageSize);

	const rows = level
		? db
				.query<LogRow, [string, number, number]>(
					`SELECT * FROM event_log WHERE level = ? ORDER BY timestamp DESC, id DESC LIMIT ? OFFSET ?`,
				)
				.all(level, pageSize, offset)
		: db
				.query<LogRow, [number, number]>(
					`SELECT * FROM event_log ORDER BY timestamp DESC, id DESC LIMIT ? OFFSET ?`,
				)
				.all(pageSize, offset);

	const totalRow = level
		? db
				.query<{ total: number }, [string]>(
					`SELECT COUNT(*) as total FROM event_log WHERE level = ?`,
				)
				.get(level)
		: db
				.query<{ total: number }, []>(`SELECT COUNT(*) as total FROM event_log`)
				.get();

	const countRows = db
		.query<{ level: string; n: number }, []>(
			`SELECT level, COUNT(*) as n FROM event_log GROUP BY level`,
		)
		.all();
	const counts: LogCounts = { error: 0, warn: 0, info: 0 };
	for (const r of countRows) {
		if (r.level === "error" || r.level === "warn" || r.level === "info")
			counts[r.level] = r.n;
	}

	return { logs: rows, total: totalRow?.total ?? 0, counts };
}

export async function clearLogs(): Promise<void> {
	const db = await getDb();
	db.run(`DELETE FROM event_log`);
}
