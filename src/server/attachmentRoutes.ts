import type { HlidConfig } from "../config";
import { handleUpload, removeAttachment, serveAttachment } from "./attachments";
import { loadConfig } from "./config";
import { broadcast } from "./runState";

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
		return handleUpload(req, uploadConfig, async (id, kind) => {
			try {
				await broadcast({ type: "attachment_created", id, kind });
			} catch (err) {
				console.warn("[attachments] broadcast failed:", err);
			}
		});
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
		return removeAttachment(idMatch[1]);
	}

	return null;
}
