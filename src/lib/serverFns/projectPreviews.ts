import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { dbFetch, dbJson, requireDbOk } from "#/lib/dbClient";
import type {
	ProjectPreviewAgentFrame,
	ProjectPreviewAgentFrameWindow,
	ProjectPreviewFeedbackResult,
	ProjectPreviewSnapshot,
} from "#/server/protocol";

export type {
	ProjectPreviewAgentFrame,
	ProjectPreviewAgentFrameSummary,
	ProjectPreviewSnapshot,
} from "#/server/protocol";

const sessionIdSchema = z.string().trim().min(1);
const previewActionSchema = z.object({
	sessionId: sessionIdSchema,
	previewId: z.string().uuid(),
});
const agentFrameSchema = previewActionSchema.extend({
	afterFrameId: z.string().uuid().optional(),
	frameId: z.string().uuid().optional(),
});
const agentFramesSchema = previewActionSchema.extend({
	afterFrameId: z.string().uuid().optional(),
});
const captureFeedbackSchema = previewActionSchema.extend({
	path: z.string().trim().max(2_048).optional(),
	viewport: z.enum(["desktop", "tablet", "mobile"]),
	width: z.number().int().min(240).max(3_840),
	height: z.number().int().min(240).max(2_160),
	scrollX: z.number().int().min(0).max(100_000).optional(),
	scrollY: z.number().int().min(0).max(100_000).optional(),
});
const feedbackAnnotationSchema = z.object({
	mark_index: z.number().int().min(0).max(99),
	mark_kind: z.enum(["highlight", "rectangle", "arrow", "text"]),
	ref: z.string().regex(/^e[1-9][0-9]{0,2}$/),
	role: z.string().max(120),
	name: z.string().max(500),
	tag: z.string().max(80),
	type: z.string().max(120).optional(),
	disabled: z.boolean().optional(),
	bounds: z.object({
		x: z.number().finite(),
		y: z.number().finite(),
		width: z.number().finite().min(0),
		height: z.number().finite().min(0),
	}),
});
const saveFeedbackSchema = previewActionSchema.extend({
	frameId: z.string().uuid(),
	attachmentId: z.string().uuid(),
	comment: z.string().max(10_000).optional(),
	annotations: z.array(feedbackAnnotationSchema).max(50).default([]),
});

function projectPreviewAgentFramePath(
	data: z.infer<typeof agentFrameSchema>,
	endpoint: "agent-frame" | "agent-frames",
): string {
	const search = new URLSearchParams({ session_id: data.sessionId });
	if (data.afterFrameId) search.set("after_frame_id", data.afterFrameId);
	if (data.frameId) search.set("frame_id", data.frameId);
	return `/api/project-previews/${encodeURIComponent(data.previewId)}/${endpoint}?${search}`;
}

async function postProjectPreviewJson<T>(
	previewId: string,
	action: "capture" | "feedback" | "restart" | "stop",
	body: Record<string, unknown>,
	operation: string,
): Promise<T> {
	const response = await dbFetch(
		`/api/project-previews/${encodeURIComponent(previewId)}/${action}`,
		{
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		},
	);
	await requireDbOk(response, operation);
	return (await response.json()) as T;
}

async function postProjectPreviewRecording<T>(
	data: z.infer<typeof previewActionSchema>,
	action: "start" | "stop",
): Promise<T> {
	const response = await dbFetch(
		`/api/project-previews/${encodeURIComponent(data.previewId)}/recording/${action}`,
		{
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ session_id: data.sessionId }),
		},
	);
	await requireDbOk(
		response,
		action === "start" ? "Start Browser recording" : "Save Browser recording",
	);
	return (await response.json()) as T;
}

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
			projectPreviewAgentFramePath(data, "agent-frame"),
			null,
		),
	);

export const getProjectPreviewAgentFramesFn = createServerFn({ method: "GET" })
	.validator((raw) => agentFramesSchema.parse(raw))
	.handler(({ data }) =>
		dbJson<ProjectPreviewAgentFrameWindow | null>(
			projectPreviewAgentFramePath(data, "agent-frames"),
			null,
		),
	);

export const captureProjectPreviewFeedbackFn = createServerFn({
	method: "POST",
})
	.validator((raw) => captureFeedbackSchema.parse(raw))
	.handler(({ data }) =>
		postProjectPreviewJson<ProjectPreviewAgentFrame>(
			data.previewId,
			"capture",
			{
				session_id: data.sessionId,
				path: data.path,
				viewport: data.viewport,
				width: data.width,
				height: data.height,
				scroll_x: data.scrollX,
				scroll_y: data.scrollY,
				full_page: false,
			},
			"Capture Project Preview feedback",
		),
	);

export const saveProjectPreviewFeedbackFn = createServerFn({ method: "POST" })
	.validator((raw) => saveFeedbackSchema.parse(raw))
	.handler(({ data }) =>
		postProjectPreviewJson<ProjectPreviewFeedbackResult>(
			data.previewId,
			"feedback",
			{
				session_id: data.sessionId,
				frame_id: data.frameId,
				attachment_id: data.attachmentId,
				comment: data.comment,
				annotations: data.annotations,
			},
			"Save Project Preview feedback",
		),
	);

export const startWebBrowserRecordingFn = createServerFn({ method: "POST" })
	.validator((raw) => previewActionSchema.parse(raw))
	.handler(({ data }) =>
		postProjectPreviewRecording<ProjectPreviewAgentFrame>(data, "start"),
	);

export const stopWebBrowserRecordingFn = createServerFn({ method: "POST" })
	.validator((raw) => previewActionSchema.parse(raw))
	.handler(({ data }) =>
		postProjectPreviewRecording<{
			id: string;
			filename: string;
			open_url: string;
			frame_count: number;
			duration_seconds: number;
			truncated: boolean;
		}>(data, "stop"),
	);

export const stopProjectPreviewFn = createServerFn({ method: "POST" })
	.validator((raw) => previewActionSchema.parse(raw))
	.handler(({ data }) =>
		postProjectPreviewJson<ProjectPreviewSnapshot>(
			data.previewId,
			"stop",
			{ session_id: data.sessionId },
			"Stop Project Preview",
		),
	);

export const restartProjectPreviewFn = createServerFn({ method: "POST" })
	.validator((raw) => previewActionSchema.parse(raw))
	.handler(({ data }) =>
		postProjectPreviewJson<ProjectPreviewSnapshot>(
			data.previewId,
			"restart",
			{ session_id: data.sessionId },
			"Restart Project Preview",
		),
	);
