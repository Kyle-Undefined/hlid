import { createHash } from "node:crypto";
import { z } from "zod";
import {
	getLatestProjectPreviewForSession,
	getProjectPreview,
	retainProjectPreviewFeedback,
} from "../db";
import { bumpDataRevision } from "./dataRevision";
import { projectPreviewManager } from "./projectPreview";
import {
	type ProjectPreviewAgentFrame,
	type ProjectPreviewControlAction,
	projectPreviewBrowserManager,
} from "./projectPreviewBrowser";
import {
	MAX_PROJECT_PREVIEW_SCROLL_OFFSET,
	MAX_PROJECT_PREVIEW_VIEWPORT_HEIGHT,
	MAX_PROJECT_PREVIEW_VIEWPORT_WIDTH,
	MIN_PROJECT_PREVIEW_VIEWPORT_HEIGHT,
	MIN_PROJECT_PREVIEW_VIEWPORT_WIDTH,
	type ProjectPreviewCaptureResult,
} from "./projectPreviewCapture";
import {
	handleProjectPreviewRelayRequest,
	projectPreviewSelectionRedirect,
} from "./projectPreviewRelay";

const startSchema = z.object({
	session_id: z.string().trim().min(1),
	runtime_cwd: z.string().trim().min(1),
	command: z.string().trim().min(1).max(4_096),
	port: z.number().int().min(1).max(65_535),
	path: z.string().trim().max(2_048).optional(),
	working_directory: z.string().trim().max(1_024).optional(),
	label: z.string().trim().min(1).max(100).optional(),
	present: z.boolean().optional(),
	replace_existing: z.boolean().optional(),
	readiness_timeout_seconds: z.number().int().min(1).max(120).optional(),
});

const actionSchema = z.object({
	session_id: z.string().trim().min(1),
});

const captureSchema = actionSchema
	.extend({
		path: z.string().trim().max(2_048).optional(),
		viewport: z.enum(["desktop", "tablet", "mobile"]).default("desktop"),
		width: z
			.number()
			.int()
			.min(MIN_PROJECT_PREVIEW_VIEWPORT_WIDTH)
			.max(MAX_PROJECT_PREVIEW_VIEWPORT_WIDTH)
			.optional(),
		height: z
			.number()
			.int()
			.min(MIN_PROJECT_PREVIEW_VIEWPORT_HEIGHT)
			.max(MAX_PROJECT_PREVIEW_VIEWPORT_HEIGHT)
			.optional(),
		scroll_x: z
			.number()
			.int()
			.min(0)
			.max(MAX_PROJECT_PREVIEW_SCROLL_OFFSET)
			.optional(),
		scroll_y: z
			.number()
			.int()
			.min(0)
			.max(MAX_PROJECT_PREVIEW_SCROLL_OFFSET)
			.optional(),
		full_page: z.boolean().default(false),
	})
	.refine(
		(value) => (value.width === undefined) === (value.height === undefined),
		{
			message: "width and height must be provided together",
		},
	);
const feedbackSchema = actionSchema.extend({
	frame_id: z.string().uuid(),
	attachment_id: z.string().uuid(),
	comment: z.string().max(10_000).optional(),
});

const controlSchema = actionSchema.extend({
	action: z.enum([
		"click",
		"type",
		"key",
		"scroll",
		"navigate",
		"reload",
		"viewport",
	]),
	frame_id: z.string().uuid().optional(),
	ref: z
		.string()
		.regex(/^e[1-9][0-9]{0,2}$/)
		.optional(),
	x: z.number().finite().min(0).max(10_000).optional(),
	y: z.number().finite().min(0).max(10_000).optional(),
	text: z.string().max(100_000).optional(),
	key: z.string().trim().min(1).max(100).optional(),
	delta_x: z.number().finite().min(-5_000).max(5_000).optional(),
	delta_y: z.number().finite().min(-5_000).max(5_000).optional(),
	path: z.string().trim().max(2_048).optional(),
	viewport: z.enum(["desktop", "tablet", "mobile"]).optional(),
});

type CaptureProjectPreview = (
	input: Parameters<typeof projectPreviewBrowserManager.capture>[0],
) => Promise<ProjectPreviewCaptureResult>;
type ControlProjectPreview = (
	input: ProjectPreviewControlAction,
) => Promise<ProjectPreviewAgentFrame>;

type ControlInput = z.infer<typeof controlSchema>;
type ControlBase = {
	previewId: string;
	sessionId: string;
	port: number;
	initialPath: string;
};
type ControlAction<Action extends ProjectPreviewControlAction["action"]> =
	Extract<ProjectPreviewControlAction, { action: Action }>;

function parseClickControlInput(
	body: ControlInput,
	base: ControlBase,
): ControlAction<"click"> {
	if (!body.frame_id || (!body.ref && (body.x == null || body.y == null))) {
		throw new Error(
			"click requires frame_id and either ref or x and y coordinates.",
		);
	}
	if (body.ref) {
		return {
			...base,
			action: "click",
			frameId: body.frame_id,
			ref: body.ref,
		};
	}
	return {
		...base,
		action: "click",
		frameId: body.frame_id,
		x: body.x,
		y: body.y,
	};
}

function parseTypeControlInput(
	body: ControlInput,
	base: ControlBase,
): ControlAction<"type"> {
	if (!body.frame_id || !body.ref || body.text === undefined) {
		throw new Error("type requires frame_id, ref, and text.");
	}
	return {
		...base,
		action: "type",
		frameId: body.frame_id,
		ref: body.ref,
		text: body.text,
	};
}

function parseKeyControlInput(
	body: ControlInput,
	base: ControlBase,
): ControlAction<"key"> {
	if (!body.key) throw new Error("key requires a key value.");
	return { ...base, action: "key", key: body.key };
}

function parseScrollControlInput(
	body: ControlInput,
	base: ControlBase,
): ControlAction<"scroll"> {
	if (body.delta_x === undefined && body.delta_y === undefined) {
		throw new Error("scroll requires delta_x or delta_y.");
	}
	return {
		...base,
		action: "scroll",
		deltaX: body.delta_x ?? 0,
		deltaY: body.delta_y ?? 0,
	};
}

function parseNavigateControlInput(
	body: ControlInput,
	base: ControlBase,
): ControlAction<"navigate"> {
	if (!body.path) throw new Error("navigate requires a Preview-local path.");
	return { ...base, action: "navigate", path: body.path };
}

function parseViewportControlInput(
	body: ControlInput,
	base: ControlBase,
): ControlAction<"viewport"> {
	if (!body.viewport) throw new Error("viewport requires a named viewport.");
	return { ...base, action: "viewport", viewport: body.viewport };
}

export function parseControlInput(
	body: ControlInput,
	base: ControlBase,
): ProjectPreviewControlAction {
	switch (body.action) {
		case "click":
			return parseClickControlInput(body, base);
		case "type":
			return parseTypeControlInput(body, base);
		case "key":
			return parseKeyControlInput(body, base);
		case "scroll":
			return parseScrollControlInput(body, base);
		case "navigate":
			return parseNavigateControlInput(body, base);
		case "viewport":
			return parseViewportControlInput(body, base);
		case "reload":
			return { ...base, action: "reload" };
	}
}

function errorResponse(error: unknown): Response {
	const message = error instanceof Error ? error.message : String(error);
	const status = message.includes("not found") ? 404 : 409;
	return Response.json({ error: message }, { status });
}

function requiredSessionId(url: URL): string | Response {
	const sessionId = url.searchParams.get("session_id")?.trim();
	return (
		sessionId ||
		Response.json({ error: "session_id is required" }, { status: 400 })
	);
}

async function inspectPreview(sessionId: string, previewId?: string) {
	try {
		return projectPreviewManager.inspect(sessionId, previewId);
	} catch {
		const persisted = previewId
			? await getProjectPreview(previewId)
			: await getLatestProjectPreviewForSession(sessionId);
		if (!persisted || persisted.session_id !== sessionId) {
			throw new Error("Project preview not found for this session.");
		}
		return persisted;
	}
}

async function resolveBrowserPreview(rawPreviewId: string, sessionId: string) {
	const previewId =
		rawPreviewId === "session" ? undefined : decodeURIComponent(rawPreviewId);
	const preview = await inspectPreview(sessionId, previewId);
	const target = projectPreviewManager.relayTarget(preview.id);
	return { preview, port: target.port };
}

type ProjectPreviewRouteContext = {
	url: URL;
	req: Request;
	capture: CaptureProjectPreview;
	control: ControlProjectPreview;
};

type ProjectPreviewApiRouteHandler = (
	context: ProjectPreviewRouteContext,
) => Promise<Response | null>;

async function handleStartRoute({
	url,
	req,
}: ProjectPreviewRouteContext): Promise<Response | null> {
	if (url.pathname !== "/api/project-previews/start" || req.method !== "POST") {
		return null;
	}
	const body = startSchema.parse(await req.json());
	const preview = await projectPreviewManager.start({
		sessionId: body.session_id,
		runtimeCwd: body.runtime_cwd,
		command: body.command,
		port: body.port,
		path: body.path,
		workingDirectory: body.working_directory,
		label: body.label,
		present: body.present,
		replaceExisting: body.replace_existing,
		readinessTimeoutSeconds: body.readiness_timeout_seconds,
	});
	return Response.json(preview, {
		status: preview.state === "ready" ? 201 : 409,
	});
}

async function handleSessionRoute({
	url,
	req,
}: ProjectPreviewRouteContext): Promise<Response | null> {
	if (
		url.pathname === "/api/project-previews/session" &&
		req.method === "GET"
	) {
		const sessionId = requiredSessionId(url);
		if (sessionId instanceof Response) return sessionId;
		return Response.json(await inspectPreview(sessionId));
	}
	if (
		(url.pathname !== "/api/project-previews/session/stop" &&
			url.pathname !== "/api/project-previews/session/restart") ||
		req.method !== "POST"
	) {
		return null;
	}
	const body = actionSchema.parse(await req.json());
	const preview = url.pathname.endsWith("/stop")
		? await projectPreviewManager.stop(body.session_id)
		: await projectPreviewManager.restart(body.session_id);
	return Response.json(preview);
}

async function handleCaptureRoute({
	url,
	req,
	capture,
}: ProjectPreviewRouteContext): Promise<Response | null> {
	const match = url.pathname.match(
		/^\/api\/project-previews\/([^/]+)\/capture$/,
	);
	if (!match || req.method !== "POST") return null;
	const body = captureSchema.parse(await req.json());
	const { preview, port } = await resolveBrowserPreview(
		match[1],
		body.session_id,
	);
	const result: ProjectPreviewCaptureResult = await capture({
		previewId: preview.id,
		sessionId: preview.session_id,
		port,
		path: body.path ?? preview.path,
		viewport: body.viewport,
		...(body.width !== undefined && body.height !== undefined
			? { size: { width: body.width, height: body.height } }
			: {}),
		...(body.scroll_x !== undefined ? { scrollX: body.scroll_x } : {}),
		...(body.scroll_y !== undefined ? { scrollY: body.scroll_y } : {}),
		fullPage: body.full_page,
	});
	return Response.json(result, {
		headers: { "cache-control": "no-store" },
	});
}

async function handleControlRoute({
	url,
	req,
	control,
}: ProjectPreviewRouteContext): Promise<Response | null> {
	const match = url.pathname.match(
		/^\/api\/project-previews\/([^/]+)\/control$/,
	);
	if (!match || req.method !== "POST") return null;
	const body = controlSchema.parse(await req.json());
	const { preview, port } = await resolveBrowserPreview(
		match[1],
		body.session_id,
	);
	const result = await control(
		parseControlInput(body, {
			previewId: preview.id,
			sessionId: preview.session_id,
			port,
			initialPath: preview.path,
		}),
	);
	return Response.json(result, {
		headers: { "cache-control": "no-store" },
	});
}

async function handleFeedbackRoute({
	url,
	req,
}: ProjectPreviewRouteContext): Promise<Response | null> {
	const match = url.pathname.match(
		/^\/api\/project-previews\/([^/]+)\/feedback$/,
	);
	if (!match || req.method !== "POST") return null;
	const body = feedbackSchema.parse(await req.json());
	const previewId = decodeURIComponent(match[1]);
	const preview = await inspectPreview(body.session_id, previewId);
	const frame = projectPreviewBrowserManager.getFrame(
		preview.id,
		body.session_id,
		body.frame_id,
	);
	if (!frame) {
		return Response.json(
			{ error: "The source Preview capture is no longer available." },
			{ status: 410 },
		);
	}
	const sourceSha256 = createHash("sha256")
		.update(Buffer.from(frame.image_base64, "base64"))
		.digest("hex");
	const attachment = await retainProjectPreviewFeedback({
		attachmentId: body.attachment_id,
		previewId: preview.id,
		sessionId: body.session_id,
		sourceFrameId: frame.frame_id,
		path: frame.path,
		viewport: frame.viewport,
		width: frame.width,
		height: frame.height,
		sourceSha256,
		capturedAt: frame.captured_at,
		comment: body.comment,
	});
	if (!attachment) {
		return Response.json(
			{
				error: "Preview feedback must use a new PNG uploaded by this session.",
			},
			{ status: 409 },
		);
	}
	bumpDataRevision("relics", "storage");
	return Response.json({
		attachment: {
			id: attachment.id,
			path: attachment.path,
			filename: attachment.filename,
			mime: attachment.mime,
			kind: attachment.kind,
			reference: "relic",
		},
		open_url: `/api/attachments/${attachment.id}/raw`,
	});
}

async function handleAgentFrameRoute({
	url,
	req,
}: ProjectPreviewRouteContext): Promise<Response | null> {
	const match = url.pathname.match(
		/^\/api\/project-previews\/([^/]+)\/agent-frame$/,
	);
	if (!match || req.method !== "GET") return null;
	const sessionId = requiredSessionId(url);
	if (sessionId instanceof Response) return sessionId;
	const previewId = decodeURIComponent(match[1]);
	await inspectPreview(sessionId, previewId);
	const frameId = url.searchParams.get("frame_id")?.trim();
	if (frameId && !z.string().uuid().safeParse(frameId).success) {
		return Response.json({ error: "frame_id must be a UUID" }, { status: 400 });
	}
	const frame = projectPreviewBrowserManager.getFrame(
		previewId,
		sessionId,
		frameId,
	);
	if (frame && url.searchParams.get("after_frame_id") === frame.frame_id) {
		return Response.json(null, {
			headers: { "cache-control": "no-store" },
		});
	}
	return Response.json(frame, {
		headers: { "cache-control": "no-store" },
	});
}

async function handleByIdRoute({
	url,
	req,
}: ProjectPreviewRouteContext): Promise<Response> {
	const match = url.pathname.match(
		/^\/api\/project-previews\/([^/]+)(?:\/(stop|restart))?$/,
	);
	if (!match) return new Response("Not found", { status: 404 });
	const previewId = decodeURIComponent(match[1]);
	const action = match[2];
	if (!action && req.method === "GET") {
		const sessionId = requiredSessionId(url);
		if (sessionId instanceof Response) return sessionId;
		return Response.json(await inspectPreview(sessionId, previewId));
	}
	if (req.method !== "POST" || !action) {
		return new Response("Method not allowed", { status: 405 });
	}
	const body = actionSchema.parse(await req.json());
	const preview =
		action === "stop"
			? await projectPreviewManager.stop(body.session_id, previewId)
			: await projectPreviewManager.restart(body.session_id, previewId);
	return Response.json(preview);
}

const projectPreviewApiRouteHandlers = [
	handleStartRoute,
	handleSessionRoute,
	handleCaptureRoute,
	handleControlRoute,
	handleFeedbackRoute,
	handleAgentFrameRoute,
] satisfies ProjectPreviewApiRouteHandler[];

async function handleProjectPreviewApiRoute(
	context: ProjectPreviewRouteContext,
): Promise<Response> {
	for (const handler of projectPreviewApiRouteHandlers) {
		const response = await handler(context);
		if (response) return response;
	}
	return handleByIdRoute(context);
}

export async function handleProjectPreviewRoute(
	url: URL,
	req: Request,
	capture: CaptureProjectPreview = (input) =>
		projectPreviewBrowserManager.capture(input),
	control: ControlProjectPreview = (input) =>
		projectPreviewBrowserManager.control(input),
): Promise<Response | null> {
	if (!url.pathname.startsWith("/api/project-previews")) return null;
	try {
		const selection = projectPreviewSelectionRedirect(url, (previewId) =>
			projectPreviewManager.relayTarget(previewId),
		);
		if (selection) return selection;
		const relay = await handleProjectPreviewRelayRequest(
			url,
			req,
			(previewId) => projectPreviewManager.relayTarget(previewId),
		);
		if (relay) return relay;
		return await handleProjectPreviewApiRoute({ url, req, capture, control });
	} catch (error) {
		if (error instanceof z.ZodError) {
			return Response.json(
				{ error: error.issues[0]?.message ?? "Invalid preview request" },
				{ status: 400 },
			);
		}
		return errorResponse(error);
	}
}
