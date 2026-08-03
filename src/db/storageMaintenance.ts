import { createHash, randomUUID } from "node:crypto";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { LIBRARY_DIR, pathStartsWith } from "../lib/paths";
import { optimizeManagedImage } from "../server/imageOptimization";
import { TOOL_RESULT_PREVIEW_CHARS } from "../server/protocol";
import { type Db, getDb } from "./schema";

const STORAGE_MAINTENANCE_BATCH_SIZE = 16;
const CODEX_TRANSCRIPTS_COMPACTED = "_maintenance_compact_codex_transcripts_v1";
const TOOL_IMAGES_SANITIZED = "_maintenance_sanitize_tool_images_v1";
const TOOL_SUMMARIES_BACKFILLED =
	"_maintenance_backfill_tool_result_summaries_v1";
const MANAGED_IMAGES_OPTIMIZED = "_maintenance_optimize_managed_images_v1";
const DURABLE_IMAGE_PLACEHOLDER = "[image omitted from durable transcript]";

type PostUpgradeStorageMaintenanceResult = {
	codexTranscriptsCompacted: number;
	toolImagesSanitized: number;
	toolSummariesBackfilled: number;
	managedImagesProcessed: number;
	managedImageBytesSaved: number;
};

function maintenanceComplete(db: Db, key: string): boolean {
	return (
		db
			.query<{ value: string }, [string]>(
				"SELECT value FROM settings WHERE key = ?",
			)
			.get(key)?.value === "1"
	);
}

function markMaintenanceComplete(db: Db, key: string): void {
	db.run(
		`INSERT OR REPLACE INTO settings (key, value, updated_at)
		 VALUES (?, '1', unixepoch())`,
		[key],
	);
}

function yieldToServer(): Promise<void> {
	return new Promise((resolve) => setImmediate(resolve));
}

async function compactCodexTranscripts(db: Db): Promise<number> {
	if (maintenanceComplete(db, CODEX_TRANSCRIPTS_COMPACTED)) return 0;
	let compacted = 0;
	while (true) {
		const rows = db
			.query<{ rowid: number }, [number]>(
				`SELECT rowid
				 FROM provider_history_transcripts
				 WHERE provider_id = 'codex' AND payload_json <> '[]'
				 ORDER BY rowid
				 LIMIT ?`,
			)
			.all(STORAGE_MAINTENANCE_BATCH_SIZE);
		if (rows.length === 0) break;
		db.transaction(() => {
			for (const row of rows) {
				compacted += db.run(
					"UPDATE provider_history_transcripts SET payload_json = '[]' WHERE rowid = ?",
					[row.rowid],
				).changes;
			}
		})();
		await yieldToServer();
	}
	markMaintenanceComplete(db, CODEX_TRANSCRIPTS_COMPACTED);
	return compacted;
}

export function sanitizeDurableToolResult(resultText: string): string {
	if (!resultText.includes("data:image/")) return resultText;
	return resultText.replace(
		/data:image\/[a-z0-9.+-]+;base64,[a-z0-9+/=_-]+/gi,
		DURABLE_IMAGE_PLACEHOLDER,
	);
}

async function sanitizeToolImages(db: Db): Promise<number> {
	if (maintenanceComplete(db, TOOL_IMAGES_SANITIZED)) return 0;
	let sanitized = 0;
	// Source and diagnostic output may mention the prefix without containing an
	// image. Advance by ID so those unchanged rows cannot starve later matches.
	let lastScannedId = 0;
	while (true) {
		const rows = db
			.query<{ id: number; result_text: string }, [number, number]>(
				`SELECT id, result_text
				 FROM tool_events
				 WHERE id > ?
				   AND result_text IS NOT NULL
				   AND instr(result_text, 'data:image/') > 0
				 ORDER BY id
				 LIMIT ?`,
			)
			.all(lastScannedId, STORAGE_MAINTENANCE_BATCH_SIZE);
		if (rows.length === 0) break;
		db.transaction(() => {
			for (const row of rows) {
				const resultText = sanitizeDurableToolResult(row.result_text);
				if (resultText === row.result_text) continue;
				sanitized += db.run(
					`UPDATE tool_events
					 SET result_text = ?, result_length = ?, result_preview = ?
					 WHERE id = ?`,
					[
						resultText,
						resultText.length,
						resultText.slice(0, TOOL_RESULT_PREVIEW_CHARS),
						row.id,
					],
				).changes;
			}
		})();
		lastScannedId = rows.at(-1)?.id ?? lastScannedId;
		await yieldToServer();
	}
	markMaintenanceComplete(db, TOOL_IMAGES_SANITIZED);
	return sanitized;
}

async function backfillToolSummaries(db: Db): Promise<number> {
	if (maintenanceComplete(db, TOOL_SUMMARIES_BACKFILLED)) return 0;
	let backfilled = 0;
	while (true) {
		const rows = db
			.query<{ id: number; result_text: string }, [number]>(
				`SELECT id, result_text
				 FROM tool_events
				 WHERE result_text IS NOT NULL
				   AND (result_length IS NULL OR result_preview IS NULL)
				 ORDER BY id
				 LIMIT ?`,
			)
			.all(STORAGE_MAINTENANCE_BATCH_SIZE);
		if (rows.length === 0) break;
		db.transaction(() => {
			for (const row of rows) {
				backfilled += db.run(
					`UPDATE tool_events
					 SET result_length = ?, result_preview = ?
					 WHERE id = ?`,
					[
						row.result_text.length,
						row.result_text.slice(0, TOOL_RESULT_PREVIEW_CHARS),
						row.id,
					],
				).changes;
			}
		})();
		await yieldToServer();
	}
	markMaintenanceComplete(db, TOOL_SUMMARIES_BACKFILLED);
	return backfilled;
}

async function optimizeManagedImages(
	db: Db,
): Promise<{ processed: number; bytesSaved: number }> {
	if (maintenanceComplete(db, MANAGED_IMAGES_OPTIMIZED)) {
		return { processed: 0, bytesSaved: 0 };
	}
	let processed = 0;
	let bytesSaved = 0;
	while (true) {
		const rows = db
			.query<{ id: string; path: string; size_bytes: number }, [number]>(
				`SELECT id, path, size_bytes
				 FROM attachments
				 WHERE kind = 'ephemeral'
				   AND storage_key IS NOT NULL
				   AND mime = 'image/png'
				   AND image_optimized_at IS NULL
				 ORDER BY created_at, id
				 LIMIT ?`,
			)
			.all(STORAGE_MAINTENANCE_BATCH_SIZE);
		if (rows.length === 0) break;
		for (const row of rows) {
			const path = resolve(row.path);
			let storedSize = row.size_bytes;
			let sha256: string | null = null;
			let originalSize = row.size_bytes;
			let temporaryPath: string | null = null;
			try {
				if (!pathStartsWith(LIBRARY_DIR, path)) {
					throw new Error("managed image path escapes the Hlid library");
				}
				const source = Buffer.from(await readFile(path));
				originalSize = source.byteLength;
				const optimized = optimizeManagedImage(source, "image/png");
				if (optimized.optimized) {
					temporaryPath = join(
						dirname(path),
						`.${basename(path)}.${randomUUID()}.hlid-optimize`,
					);
					await writeFile(temporaryPath, optimized.buffer, {
						flag: "wx",
						mode: 0o600,
					});
					await rename(temporaryPath, path);
					temporaryPath = null;
					storedSize = optimized.buffer.byteLength;
					bytesSaved += originalSize - storedSize;
					sha256 = createHash("sha256").update(optimized.buffer).digest("hex");
				} else {
					storedSize = source.byteLength;
					sha256 = createHash("sha256").update(source).digest("hex");
				}
			} catch {
				// A missing or non-library file should not strand the whole upgrade.
				// Mark its current record inspected; normal attachment reads still
				// surface missing/integrity failures to the user.
			} finally {
				if (temporaryPath)
					await rm(temporaryPath, { force: true }).catch(() => {});
			}
			db.run(
				`UPDATE attachments
				 SET size_bytes = ?, sha256 = COALESCE(?, sha256),
				     image_optimized_at = unixepoch(), original_size_bytes = ?
				 WHERE id = ?`,
				[storedSize, sha256, originalSize, row.id],
			);
			processed += 1;
			await yieldToServer();
		}
	}
	markMaintenanceComplete(db, MANAGED_IMAGES_OPTIMIZED);
	return { processed, bytesSaved };
}

/**
 * Compact storage formats introduced by an app upgrade without blocking schema
 * initialization. Each row batch commits independently, so a restart resumes
 * from the remaining rows. Physical file shrink remains an explicit reclaim.
 */
export async function runPostUpgradeStorageMaintenance(): Promise<PostUpgradeStorageMaintenanceResult> {
	const db = await getDb();
	const codexTranscriptsCompacted = await compactCodexTranscripts(db);
	const toolImagesSanitized = await sanitizeToolImages(db);
	const toolSummariesBackfilled = await backfillToolSummaries(db);
	const managedImages = await optimizeManagedImages(db);
	const result = {
		codexTranscriptsCompacted,
		toolImagesSanitized,
		toolSummariesBackfilled,
		managedImagesProcessed: managedImages.processed,
		managedImageBytesSaved: managedImages.bytesSaved,
	};
	db.run("PRAGMA wal_checkpoint(PASSIVE)");
	db.run("PRAGMA optimize");
	return result;
}
