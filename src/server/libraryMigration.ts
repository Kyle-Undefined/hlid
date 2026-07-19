import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import * as db from "../db";
import { artifactPath, prepareLibrary, storageKey } from "./libraryStore";

/**
 * Copy-first migration for legacy repo/vault `.hlid` attachments. The source
 * is removed only after hash verification and a successful compare-and-set DB
 * update, so interruption leaves a recoverable copy rather than data loss.
 */
export async function migrateLegacyAttachmentsToLibrary(): Promise<number> {
	await prepareLibrary();
	const rows = await db.listLegacyManagedAttachments();
	let migrated = 0;
	for (const row of rows) {
		const target = artifactPath(row.id, row.filename);
		let updated = false;
		try {
			await mkdir(dirname(target), { recursive: true, mode: 0o700 });
			await copyFile(row.path, target);
			const bytes = await readFile(target);
			const hash = createHash("sha256").update(bytes).digest("hex");
			if (row.sha256 && row.sha256 !== hash) {
				throw new Error(`hash mismatch for ${row.id}`);
			}
			const category = row.mime === "text/html" ? "plan" : "upload";
			updated = await db.moveAttachmentIntoLibrary(row.id, {
				path: target,
				storage_key: storageKey(target),
				category,
				retention: category === "plan" ? "retained" : "session",
				origin: "legacy",
			});
			if (!updated) {
				await unlink(target).catch(() => {});
				continue;
			}
			await unlink(row.path).catch(() => {});
			migrated++;
		} catch (error) {
			if (!updated) await unlink(target).catch(() => {});
			console.warn(`[library] could not migrate relic ${row.id}:`, error);
		}
	}
	return migrated;
}
