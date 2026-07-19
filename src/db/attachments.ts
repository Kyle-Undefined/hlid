import { normalizeSearchText } from "../lib/search";
import { getDb } from "./schema";
import type {
	AttachmentCategory,
	AttachmentKind,
	AttachmentListFilter,
	AttachmentOrigin,
	AttachmentRetention,
	AttachmentRow,
	AttachmentTypeFilter,
} from "./types";

/**
 * SQL predicate for a broad MIME class. TEXT covers text/* plus JSON;
 * OTHER is everything the first three classes don't match.
 */
const TYPE_PREDICATES: Record<AttachmentTypeFilter, string> = {
	image: `mime LIKE 'image/%'`,
	pdf: `mime = 'application/pdf'`,
	text: `(mime LIKE 'text/%' OR mime = 'application/json')`,
	other: `(mime NOT LIKE 'image/%' AND mime != 'application/pdf' AND mime NOT LIKE 'text/%' AND mime != 'application/json')`,
};

export async function createAttachment(row: {
	id: string;
	session_id: string | null;
	kind: AttachmentKind;
	filename: string;
	path: string;
	mime: string;
	size_bytes: number;
	sha256: string | null;
	storage_key?: string | null;
	category?: AttachmentCategory;
	retention?: AttachmentRetention;
	origin?: AttachmentOrigin;
	agent_cwd?: string | null;
}): Promise<void> {
	const db = await getDb();
	db.transaction(() => {
		db.run(
			`INSERT INTO attachments (id, session_id, message_seq, kind, filename, path, mime, size_bytes, sha256, created_at, storage_key, category, retention, origin, agent_cwd)
		 VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, unixepoch(), ?, ?, ?, ?, ?)`,
			[
				row.id,
				row.session_id,
				row.kind,
				row.filename,
				row.path,
				row.mime,
				row.size_bytes,
				row.sha256,
				row.storage_key ?? null,
				row.category ?? "other",
				row.retention ?? "session",
				row.origin ?? "legacy",
				row.agent_cwd ?? null,
			],
		);
		db.run(
			`INSERT INTO attachment_search (attachment_id, text) VALUES (?, ?)`,
			[row.id, normalizeSearchText(row.filename)],
		);
	})();
}

export async function linkAttachmentToMessage(
	id: string,
	sessionId: string,
	messageSeq: number,
): Promise<boolean> {
	const db = await getDb();
	const result = db.run(
		`UPDATE attachments SET session_id = ?, message_seq = ? WHERE id = ?`,
		[sessionId, messageSeq, id],
	);
	return result.changes > 0;
}

export async function getAttachment(id: string): Promise<AttachmentRow | null> {
	const db = await getDb();
	return (
		db
			.query<AttachmentRow, [string]>(`SELECT * FROM attachments WHERE id = ?`)
			.get(id) ?? null
	);
}

export async function getAttachmentsForSession(
	sessionId: string,
	minMessageSeq?: number,
	beforeMessageSeq?: number,
	maxMessageSeq?: number,
): Promise<AttachmentRow[]> {
	const db = await getDb();
	if (minMessageSeq !== undefined) {
		if (maxMessageSeq !== undefined) {
			return db
				.query<AttachmentRow, [string, number, number]>(
					`SELECT * FROM attachments WHERE session_id = ? AND message_seq >= ? AND message_seq <= ? ORDER BY message_seq ASC, created_at ASC, id ASC`,
				)
				.all(sessionId, minMessageSeq, maxMessageSeq);
		}
		if (beforeMessageSeq !== undefined) {
			return db
				.query<AttachmentRow, [string, number, number]>(
					`SELECT * FROM attachments WHERE session_id = ? AND message_seq >= ? AND message_seq < ? ORDER BY created_at ASC`,
				)
				.all(sessionId, minMessageSeq, beforeMessageSeq);
		}
		return db
			.query<AttachmentRow, [string, number]>(
				`SELECT * FROM attachments WHERE session_id = ? AND message_seq >= ? ORDER BY created_at ASC`,
			)
			.all(sessionId, minMessageSeq);
	}
	return db
		.query<AttachmentRow, [string]>(
			`SELECT * FROM attachments WHERE session_id = ? ORDER BY created_at ASC`,
		)
		.all(sessionId);
}

export async function deleteAttachment(
	id: string,
): Promise<AttachmentRow | null> {
	const db = await getDb();
	let row: AttachmentRow | null = null;
	db.transaction(() => {
		row =
			db
				.query<AttachmentRow, [string]>(
					`SELECT * FROM attachments WHERE id = ?`,
				)
				.get(id) ?? null;
		if (!row) return;
		db.run(`DELETE FROM attachments WHERE id = ?`, [id]);
	})();
	return row;
}

export async function listAttachments(
	filter: AttachmentListFilter = {},
): Promise<{ rows: AttachmentRow[]; total: number; total_bytes: number }> {
	const db = await getDb();
	const where: string[] = [];
	const params: (string | number)[] = [];
	if (filter.kind != null) {
		where.push("kind = ?");
		params.push(filter.kind);
	}
	if (filter.category != null) {
		where.push("category = ?");
		params.push(filter.category);
	}
	if (filter.retention != null) {
		where.push("retention = ?");
		params.push(filter.retention);
	}
	if (filter.origin != null) {
		where.push("origin = ?");
		params.push(filter.origin);
	}
	if (filter.sessionId != null) {
		where.push("session_id = ?");
		params.push(filter.sessionId);
	}
	if (filter.type != null) {
		where.push(TYPE_PREDICATES[filter.type]);
	}
	if (filter.search != null) {
		const escaped = filter.search
			.replace(/\\/g, "\\\\")
			.replace(/%/g, "\\%")
			.replace(/_/g, "\\_");
		where.push(
			"EXISTS (SELECT 1 FROM attachment_search search_idx WHERE search_idx.attachment_id = attachments.id AND search_idx.text LIKE ? ESCAPE '\\')",
		);
		params.push(`%${normalizeSearchText(escaped)}%`);
	}
	if (filter.since != null) {
		where.push("created_at >= ?");
		params.push(filter.since);
	}
	if (filter.until != null) {
		where.push("created_at <= ?");
		params.push(filter.until);
	}
	const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

	const totals = db
		.query<{ total: number; total_bytes: number }, (string | number)[]>(
			`SELECT COUNT(*) as total, COALESCE(SUM(size_bytes), 0) as total_bytes FROM attachments ${whereSql}`,
		)
		.get(...params) ?? { total: 0, total_bytes: 0 };

	const limit = filter.limit ?? 100;
	const offset = filter.offset ?? 0;
	// Whitelisted ORDER BY — filter.sort/dir are typed unions, never raw input.
	const sortCol = filter.sort === "size_bytes" ? "size_bytes" : "created_at";
	const sortDir = filter.dir === "asc" ? "ASC" : "DESC";
	const rows = db
		.query<AttachmentRow, (string | number)[]>(
			`SELECT * FROM attachments ${whereSql} ORDER BY ${sortCol} ${sortDir} LIMIT ? OFFSET ?`,
		)
		.all(...params, limit, offset);

	return { rows, total: totals.total, total_bytes: totals.total_bytes };
}

/** Legacy Hlid-owned files that still live under a vault or agent `.hlid`. */
export async function listLegacyManagedAttachments(): Promise<AttachmentRow[]> {
	const db = await getDb();
	return db
		.query<AttachmentRow, []>(
			`SELECT * FROM attachments WHERE kind = 'ephemeral' AND storage_key IS NULL ORDER BY created_at ASC`,
		)
		.all();
}

export async function moveAttachmentIntoLibrary(
	id: string,
	metadata: {
		path: string;
		storage_key: string;
		category: AttachmentCategory;
		retention: AttachmentRetention;
		origin: AttachmentOrigin;
	},
): Promise<boolean> {
	const db = await getDb();
	const result = db.run(
		`UPDATE attachments
		 SET path = ?, storage_key = ?, category = ?, retention = ?, origin = ?
		 WHERE id = ? AND storage_key IS NULL`,
		[
			metadata.path,
			metadata.storage_key,
			metadata.category,
			metadata.retention,
			metadata.origin,
			id,
		],
	);
	return result.changes > 0;
}
