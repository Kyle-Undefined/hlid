import type { ProjectPreviewFeedbackAnnotation } from "../server/protocol";
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
	annotations?: ProjectPreviewFeedbackAnnotation[];
};

export type ProjectPreviewFeedbackContext = {
	attachmentId: string;
	previewId: string;
	sourceFrameId: string;
	path: string;
	viewport: string;
	capturedAt: number;
	comment: string | null;
	annotations: ProjectPreviewFeedbackAnnotation[];
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
				viewport, width, height, source_sha256, captured_at, comment,
				annotations_json
			 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
				JSON.stringify(input.annotations ?? []),
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

export async function getProjectPreviewFeedbackContexts(
	attachmentIds: string[],
): Promise<ProjectPreviewFeedbackContext[]> {
	const ids = [...new Set(attachmentIds)].slice(0, 32);
	if (ids.length === 0) return [];
	const db = await getDb();
	const placeholders = ids.map(() => "?").join(", ");
	const rows = db
		.query<
			{
				attachment_id: string;
				preview_id: string;
				source_frame_id: string;
				path: string;
				viewport: string;
				captured_at: number;
				comment: string | null;
				annotations_json: string;
			},
			string[]
		>(
			`SELECT attachment_id, preview_id, source_frame_id, path, viewport,
			        captured_at, comment, annotations_json
			 FROM project_preview_feedback
			 WHERE attachment_id IN (${placeholders})`,
		)
		.all(...ids);
	return rows.map((row) => {
		let annotations: ProjectPreviewFeedbackAnnotation[] = [];
		try {
			const parsed = JSON.parse(row.annotations_json);
			if (Array.isArray(parsed)) annotations = parsed;
		} catch {}
		return {
			attachmentId: row.attachment_id,
			previewId: row.preview_id,
			sourceFrameId: row.source_frame_id,
			path: row.path,
			viewport: row.viewport,
			capturedAt: row.captured_at,
			comment: row.comment,
			annotations,
		};
	});
}
