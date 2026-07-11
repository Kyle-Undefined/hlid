import type { HlidConfig } from "../config";
import { handleUpload, removeAttachment, serveAttachment } from "./attachments";
import { loadConfig } from "./config";
import { broadcast } from "./runState";

const MAX_CONCURRENT_UPLOADS = 4;
let activeUploads = 0;

/**
 * Handles all /api/attachments/* routes. Returns null if the path doesn't
 * match, allowing the caller to fall through to the next handler.
 *
 * `fallbackConfig` is the startup config used when a live re-read fails.
 */
export async function handleAttachmentRoute(
	url: URL,
	req: Request,
	fallbackConfig: HlidConfig,
): Promise<Response | null> {
	if (url.pathname === "/api/attachments/upload" && req.method === "POST") {
		// Re-read config so newly-added agents route correctly without a restart.
		// Falls back to the captured startup config if disk read fails.
		let uploadConfig = fallbackConfig;
		try {
			uploadConfig = loadConfig();
		} catch (err) {
			console.warn(
				"[attachments] loadConfig failed, using startup config:",
				err,
			);
		}
		if (activeUploads >= MAX_CONCURRENT_UPLOADS) {
			return Response.json(
				{ error: "upload_capacity_reached" },
				{ status: 429, headers: { "retry-after": "1" } },
			);
		}
		activeUploads++;
		try {
			return await handleUpload(req, uploadConfig, async (id, kind) => {
				try {
					await broadcast({ type: "attachment_created", id, kind });
				} catch (err) {
					console.warn("[attachments] broadcast failed:", err);
				}
			});
		} finally {
			activeUploads--;
		}
	}

	const rawMatch = url.pathname.match(
		/^\/api\/attachments\/([a-zA-Z0-9_-]+)\/raw$/,
	);
	if (rawMatch) {
		if (req.method !== "GET")
			return new Response("Method Not Allowed", { status: 405 });
		return serveAttachment(rawMatch[1]);
	}

	const idMatch = url.pathname.match(/^\/api\/attachments\/([a-zA-Z0-9_-]+)$/);
	if (idMatch) {
		if (req.method !== "DELETE")
			return new Response("Method Not Allowed", { status: 405 });
		let deleteConfig = fallbackConfig;
		try {
			deleteConfig = loadConfig();
		} catch {
			// fallback config already set
		}
		return removeAttachment(idMatch[1], deleteConfig);
	}

	return null;
}
