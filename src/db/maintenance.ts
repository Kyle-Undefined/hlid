import { readdir, stat, statfs } from "node:fs/promises";
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
	pendingFileDeletions: number;
	availableBytes: number;
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

async function availableSpace(path: string): Promise<number> {
	try {
		const stats = await statfs(path);
		return Number(stats.bavail) * Number(stats.bsize);
	} catch {
		return 0;
	}
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
			{
				sessions: number;
				messages: number;
				usageQueries: number;
				pendingFileDeletions: number;
			},
			[]
		>(`SELECT
					(SELECT COUNT(*) FROM sessions) AS sessions,
					(SELECT COUNT(*) FROM messages) AS messages,
					(SELECT COUNT(*) FROM usage_queries) AS usageQueries,
					(SELECT COUNT(*) FROM pending_file_deletions) AS pendingFileDeletions`)
		.get() ?? {
		sessions: 0,
		messages: 0,
		usageQueries: 0,
		pendingFileDeletions: 0,
	};

	const [databaseBytes, walBytes, libraryBytes, availableBytes] =
		await Promise.all([
			fileSize(DB_PATH),
			fileSize(`${DB_PATH}-wal`),
			directorySize(LIBRARY_DIR),
			availableSpace(APP_DIR),
		]);
	return {
		databaseBytes,
		walBytes,
		reclaimableBytes: pageSize * freePages,
		trackedAttachmentBytes: attachments.bytes,
		trackedAttachments: attachments.count,
		libraryBytes,
		availableBytes,
		...counts,
	};
}

export async function optimizeStorage(): Promise<StorageStats> {
	const db = await getDb();
	db.run("PRAGMA wal_checkpoint(PASSIVE)");
	db.run("PRAGMA optimize");
	return getStorageStats();
}

function assertDatabaseHealthy(db: Awaited<ReturnType<typeof getDb>>): void {
	const rows = db
		.query<{ quick_check: string }, []>("PRAGMA quick_check")
		.all();
	if (rows.length !== 1 || rows[0]?.quick_check !== "ok") {
		throw new Error("Database quick check failed; storage was not reclaimed.");
	}
}

/**
 * Physically rebuild SQLite after logical cleanup. Callers must first ensure no
 * provider or terminal session is running because VACUUM blocks this connection.
 */
export async function reclaimStorage(): Promise<StorageStats> {
	const before = await getStorageStats();
	const requiredBytes =
		before.databaseBytes + before.walBytes + 64 * 1024 * 1024;
	if (before.availableBytes > 0 && before.availableBytes < requiredBytes) {
		throw new Error(
			`Reclaiming storage needs about ${requiredBytes} bytes free for SQLite's temporary rebuild.`,
		);
	}
	const db = await getDb();
	assertDatabaseHealthy(db);
	db.run("PRAGMA wal_checkpoint(TRUNCATE)");
	db.run("VACUUM");
	db.run("PRAGMA optimize");
	db.run("PRAGMA wal_checkpoint(TRUNCATE)");
	assertDatabaseHealthy(db);
	return getStorageStats();
}
