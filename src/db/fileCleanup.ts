import { getDb } from "./schema";

export type PendingFileDeletion = {
	path: string;
	attempts: number;
};

export async function listPendingFileDeletions(
	limit = 500,
): Promise<PendingFileDeletion[]> {
	const db = await getDb();
	const boundedLimit = Math.max(1, Math.min(5_000, Math.trunc(limit)));
	return db
		.query<PendingFileDeletion, [number]>(
			`SELECT path, attempts
			 FROM pending_file_deletions
			 ORDER BY created_at, path
			 LIMIT ?`,
		)
		.all(boundedLimit);
}

export async function completePendingFileDeletion(path: string): Promise<void> {
	const db = await getDb();
	db.run(`DELETE FROM pending_file_deletions WHERE path = ?`, [path]);
}

export async function failPendingFileDeletion(
	path: string,
	error: string,
): Promise<void> {
	const db = await getDb();
	db.run(
		`UPDATE pending_file_deletions
		 SET attempts = attempts + 1, last_error = ?
		 WHERE path = ?`,
		[error.slice(0, 2_000), path],
	);
}
