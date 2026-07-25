import { z } from "zod";
import { getLatestProjectPreviewForSession, getProjectPreview } from "../db";
import { projectPreviewManager } from "./projectPreview";
import {
	type ProjectPreviewAgentFrame,
	type ProjectPreviewControlAction,
	projectPreviewBrowserManager,
} from "./projectPreviewBrowser";
import type { ProjectPreviewCaptureResult } from "./projectPreviewCapture";
import { handleProjectPreviewRelayRequest } from "./projectPreviewRelay";

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

const captureSchema = actionSchema.extend({
	path: z.string().trim().max(2_048).optional(),
	viewport: z.enum(["desktop", "tablet", "mobile"]).default("desktop"),
	full_page: z.boolean().default(false),
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

function parseControlInput(
	body: z.infer<typeof controlSchema>,
	base: {
		previewId: string;
		sessionId: string;
		port: number;
		initialPath: string;
	},
): ProjectPreviewControlAction {
	if (body.action === "click") {
		if (!body.frame_id || (!body.ref && (body.x == null || body.y == null))) {
			throw new Error(
				"click requires frame_id and either ref or x and y coordinates.",
			);
		}
		return {
			...base,
			action: "click",
			frameId: body.frame_id,
			...(body.ref ? { ref: body.ref } : { x: body.x, y: body.y }),
		};
	}
	if (body.action === "type") {
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
	if (body.action === "key") {
		if (!body.key) throw new Error("key requires a key value.");
		return { ...base, action: "key", key: body.key };
	}
	if (body.action === "scroll") {
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
	if (body.action === "navigate") {
		if (!body.path) throw new Error("navigate requires a Preview-local path.");
		return { ...base, action: "navigate", path: body.path };
	}
	if (body.action === "viewport") {
		if (!body.viewport) throw new Error("viewport requires a named viewport.");
		return { ...base, action: "viewport", viewport: body.viewport };
	}
	return { ...base, action: body.action };
}

function errorResponse(error: unknown): Response {
	const message = error instanceof Error ? error.message : String(error);
	const status = message.includes("not found") ? 404 : 409;
	return Response.json({ error: message }, { status });
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
		const relay = await handleProjectPreviewRelayRequest(
			url,
			req,
			(previewId) => projectPreviewManager.relayTarget(previewId),
		);
		if (relay) return relay;
		if (
			url.pathname === "/api/project-previews/start" &&
			req.method === "POST"
		) {
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

		if (
			url.pathname === "/api/project-previews/session" &&
			req.method === "GET"
		) {
			const sessionId = url.searchParams.get("session_id")?.trim();
			if (!sessionId) {
				return Response.json(
					{ error: "session_id is required" },
					{ status: 400 },
				);
			}
			return Response.json(await inspectPreview(sessionId));
		}
		if (
			(url.pathname === "/api/project-previews/session/stop" ||
				url.pathname === "/api/project-previews/session/restart") &&
			req.method === "POST"
		) {
			const body = actionSchema.parse(await req.json());
			const preview = url.pathname.endsWith("/stop")
				? await projectPreviewManager.stop(body.session_id)
				: await projectPreviewManager.restart(body.session_id);
			return Response.json(preview);
		}

		const captureMatch = url.pathname.match(
			/^\/api\/project-previews\/([^/]+)\/capture$/,
		);
		if (captureMatch && req.method === "POST") {
			const body = captureSchema.parse(await req.json());
			const previewId =
				captureMatch[1] === "session"
					? undefined
					: decodeURIComponent(captureMatch[1]);
			const preview = await inspectPreview(body.session_id, previewId);
			const target = projectPreviewManager.relayTarget(preview.id);
			const result: ProjectPreviewCaptureResult = await capture({
				previewId: preview.id,
				sessionId: preview.session_id,
				port: target.port,
				path: body.path ?? preview.path,
				viewport: body.viewport,
				fullPage: body.full_page,
			});
			return Response.json(result, {
				headers: { "cache-control": "no-store" },
			});
		}

		const controlMatch = url.pathname.match(
			/^\/api\/project-previews\/([^/]+)\/control$/,
		);
		if (controlMatch && req.method === "POST") {
			const body = controlSchema.parse(await req.json());
			const previewId =
				controlMatch[1] === "session"
					? undefined
					: decodeURIComponent(controlMatch[1]);
			const preview = await inspectPreview(body.session_id, previewId);
			const target = projectPreviewManager.relayTarget(preview.id);
			const result = await control(
				parseControlInput(body, {
					previewId: preview.id,
					sessionId: preview.session_id,
					port: target.port,
					initialPath: preview.path,
				}),
			);
			return Response.json(result, {
				headers: { "cache-control": "no-store" },
			});
		}

		const frameMatch = url.pathname.match(
			/^\/api\/project-previews\/([^/]+)\/agent-frame$/,
		);
		if (frameMatch && req.method === "GET") {
			const sessionId = url.searchParams.get("session_id")?.trim();
			if (!sessionId) {
				return Response.json(
					{ error: "session_id is required" },
					{ status: 400 },
				);
			}
			const previewId = decodeURIComponent(frameMatch[1]);
			await inspectPreview(sessionId, previewId);
			const frameId = url.searchParams.get("frame_id")?.trim();
			if (frameId && !z.string().uuid().safeParse(frameId).success) {
				return Response.json(
					{ error: "frame_id must be a UUID" },
					{ status: 400 },
				);
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

		const match = url.pathname.match(
			/^\/api\/project-previews\/([^/]+)(?:\/(stop|restart))?$/,
		);
		if (!match) return new Response("Not found", { status: 404 });
		const previewId = decodeURIComponent(match[1]);
		const action = match[2];
		if (!action && req.method === "GET") {
			const sessionId = url.searchParams.get("session_id")?.trim();
			if (!sessionId) {
				return Response.json(
					{ error: "session_id is required" },
					{ status: 400 },
				);
			}
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
