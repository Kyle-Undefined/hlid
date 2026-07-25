import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { dbFetch, dbJson, requireDbOk } from "#/lib/dbClient";
import type {
	ProjectPreviewAgentFrame,
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

export const getProjectPreviewFn = createServerFn({ method: "GET" })
	.validator((raw) => sessionIdSchema.parse(raw))
	.handler(({ data }) =>
		dbJson<ProjectPreviewSnapshot | null>(
			`/api/project-previews/session?session_id=${encodeURIComponent(data)}`,
			null,
		),
	);

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
