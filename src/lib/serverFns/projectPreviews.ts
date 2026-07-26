import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { dbFetch, dbJson, requireDbOk } from "#/lib/dbClient";
import type {
	ProjectPreviewAgentFrame,
	ProjectPreviewFeedbackResult,
	ProjectPreviewSnapshot,
} from "#/server/protocol";

export type { ProjectPreviewAgentFrame, ProjectPreviewSnapshot };

const sessionIdSchema = z.string().trim().min(1);
const previewActionSchema = z.object({
	sessionId: sessionIdSchema,
	previewId: z.string().uuid(),
});
const agentFrameSchema = previewActionSchema.extend({
	afterFrameId: z.string().uuid().optional(),
	frameId: z.string().uuid().optional(),
});
const captureFeedbackSchema = previewActionSchema.extend({
	path: z.string().trim().max(2_048).optional(),
	viewport: z.enum(["desktop", "tablet", "mobile"]),
	width: z.number().int().min(240).max(3_840),
	height: z.number().int().min(240).max(2_160),
	scrollX: z.number().int().min(0).max(100_000).optional(),
	scrollY: z.number().int().min(0).max(100_000).optional(),
});
const saveFeedbackSchema = previewActionSchema.extend({
	frameId: z.string().uuid(),
	attachmentId: z.string().uuid(),
	comment: z.string().max(10_000).optional(),
});

export const getProjectPreviewFn = createServerFn({ method: "GET" })
	.validator((raw) => sessionIdSchema.parse(raw))
	.handler(async ({ data }) => {
		const response = await dbFetch(
			`/api/project-previews/session?session_id=${encodeURIComponent(data)}`,
		);
		// Most Raven sessions do not own a preview. Treat that expected state as
		// data instead of routing it through dbJson's diagnostic warning path.
		if (response.status === 404) return null;
		if (!response.ok) return null;
		return (await response.json()) as ProjectPreviewSnapshot;
	});

export const getProjectPreviewAgentFrameFn = createServerFn({ method: "GET" })
	.validator((raw) => agentFrameSchema.parse(raw))
	.handler(({ data }) =>
		dbJson<ProjectPreviewAgentFrame | null>(
			`/api/project-previews/${encodeURIComponent(data.previewId)}/agent-frame?session_id=${encodeURIComponent(data.sessionId)}${
				data.afterFrameId
					? `&after_frame_id=${encodeURIComponent(data.afterFrameId)}`
					: ""
			}${data.frameId ? `&frame_id=${encodeURIComponent(data.frameId)}` : ""}`,
			null,
		),
	);

export const captureProjectPreviewFeedbackFn = createServerFn({
	method: "POST",
})
	.validator((raw) => captureFeedbackSchema.parse(raw))
	.handler(async ({ data }) => {
		const response = await dbFetch(
			`/api/project-previews/${encodeURIComponent(data.previewId)}/capture`,
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					session_id: data.sessionId,
					path: data.path,
					viewport: data.viewport,
					width: data.width,
					height: data.height,
					scroll_x: data.scrollX,
					scroll_y: data.scrollY,
					full_page: false,
				}),
			},
		);
		await requireDbOk(response, "Capture Project Preview feedback");
		return (await response.json()) as ProjectPreviewAgentFrame;
	});

export const saveProjectPreviewFeedbackFn = createServerFn({ method: "POST" })
	.validator((raw) => saveFeedbackSchema.parse(raw))
	.handler(async ({ data }) => {
		const response = await dbFetch(
			`/api/project-previews/${encodeURIComponent(data.previewId)}/feedback`,
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					session_id: data.sessionId,
					frame_id: data.frameId,
					attachment_id: data.attachmentId,
					comment: data.comment,
				}),
			},
		);
		await requireDbOk(response, "Save Project Preview feedback");
		return (await response.json()) as ProjectPreviewFeedbackResult;
	});

export const stopProjectPreviewFn = createServerFn({ method: "POST" })
	.validator((raw) => previewActionSchema.parse(raw))
	.handler(async ({ data }) => {
		const response = await dbFetch(
			`/api/project-previews/${encodeURIComponent(data.previewId)}/stop`,
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ session_id: data.sessionId }),
			},
		);
		await requireDbOk(response, "Stop Project Preview");
		return (await response.json()) as ProjectPreviewSnapshot;
	});

export const restartProjectPreviewFn = createServerFn({ method: "POST" })
	.validator((raw) => previewActionSchema.parse(raw))
	.handler(async ({ data }) => {
		const response = await dbFetch(
			`/api/project-previews/${encodeURIComponent(data.previewId)}/restart`,
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ session_id: data.sessionId }),
			},
		);
		await requireDbOk(response, "Restart Project Preview");
		return (await response.json()) as ProjectPreviewSnapshot;
	});
