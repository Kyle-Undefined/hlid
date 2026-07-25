import { getDb } from "./schema";
import type { AttachmentRow } from "./types";

export type ProjectPreviewFeedbackInput = {
	attachmentId: string;
	previewId: string;
	sessionId: string;
	sourceFrameId: string;
	path: string;
	viewport: "desktop" | "tablet" | "mobile";
	width: number;
	height: number;
	sourceSha256: string;
	capturedAt: number;
	comment?: string;
};

/**
 * Converts one session upload into a retained generated Relic and binds its
 * immutable Preview provenance in the same transaction.
 */
export async function retainProjectPreviewFeedback(
	input: ProjectPreviewFeedbackInput,
): Promise<AttachmentRow | null> {
	const db = await getDb();
	let attachment: AttachmentRow | null = null;
	db.transaction(() => {
		const current =
			db
				.query<AttachmentRow, [string, string]>(
					`SELECT * FROM attachments
					 WHERE id = ? AND session_id = ?`,
				)
				.get(input.attachmentId, input.sessionId) ?? null;
		if (
			!current ||
			current.kind !== "ephemeral" ||
			current.mime !== "image/png" ||
			current.category !== "upload" ||
			current.retention !== "session" ||
			current.origin !== "upload"
		) {
			return;
		}

		db.run(
			`UPDATE attachments
			 SET category = 'report', retention = 'retained', origin = 'generated'
			 WHERE id = ?`,
			[input.attachmentId],
		);
		db.run(
			`INSERT INTO project_preview_feedback (
				attachment_id, preview_id, session_id, source_frame_id, path,
				viewport, width, height, source_sha256, captured_at, comment
			 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			[
				input.attachmentId,
				input.previewId,
				input.sessionId,
				input.sourceFrameId,
				input.path,
				input.viewport,
				input.width,
				input.height,
				input.sourceSha256,
				input.capturedAt,
				input.comment?.trim() || null,
			],
		);
		attachment = {
			...current,
			category: "report",
			retention: "retained",
			origin: "generated",
		};
	})();
	return attachment;
}
