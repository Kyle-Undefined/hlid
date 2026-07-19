import { readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { APP_DIR, LIBRARY_DIR } from "../lib/paths";
import { getDb } from "./schema";

const DB_PATH = resolve(APP_DIR, "hlid.db");

export type StorageStats = {
	databaseBytes: number;
	walBytes: number;
	reclaimableBytes: number;
	trackedAttachmentBytes: number;
	trackedAttachments: number;
	libraryBytes: number;
	sessions: number;
	messages: number;
	usageQueries: number;
};

async function fileSize(path: string): Promise<number> {
	try {
		return (await stat(path)).size;
	} catch {
		return 0;
	}
}

async function directorySize(path: string): Promise<number> {
	let total = 0;
	for (const entry of await readdir(path, { withFileTypes: true }).catch(
		() => [],
	)) {
		const child = join(path, entry.name);
		if (entry.isDirectory()) total += await directorySize(child);
		else if (entry.isFile()) total += await fileSize(child);
	}
	return total;
}

export async function getStorageStats(): Promise<StorageStats> {
	const db = await getDb();
	const pageSize =
		db.query<{ page_size: number }, []>("PRAGMA page_size").get()?.page_size ??
		0;
	const freePages =
		db.query<{ freelist_count: number }, []>("PRAGMA freelist_count").get()
			?.freelist_count ?? 0;
	const attachments = db
		.query<{ count: number; bytes: number }, []>(
			"SELECT COUNT(*) AS count, COALESCE(SUM(size_bytes), 0) AS bytes FROM attachments",
		)
		.get() ?? { count: 0, bytes: 0 };
	const counts = db
		.query<
			{ sessions: number; messages: number; usageQueries: number },
			[]
		>(`SELECT
				(SELECT COUNT(*) FROM sessions) AS sessions,
				(SELECT COUNT(*) FROM messages) AS messages,
				(SELECT COUNT(*) FROM usage_queries) AS usageQueries`)
		.get() ?? { sessions: 0, messages: 0, usageQueries: 0 };

	const [databaseBytes, walBytes, libraryBytes] = await Promise.all([
		fileSize(DB_PATH),
		fileSize(`${DB_PATH}-wal`),
		directorySize(LIBRARY_DIR),
	]);
	return {
		databaseBytes,
		walBytes,
		reclaimableBytes: pageSize * freePages,
		trackedAttachmentBytes: attachments.bytes,
		trackedAttachments: attachments.count,
		libraryBytes,
		...counts,
	};
}

export async function optimizeStorage(): Promise<StorageStats> {
	const db = await getDb();
	db.run("PRAGMA wal_checkpoint(PASSIVE)");
	db.run("PRAGMA optimize");
	return getStorageStats();
}
