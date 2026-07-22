import type { HlidConfig } from "../config";
import {
	handleGeneratedRelicPublish,
	handleUpload,
	openAttachmentInObsidian,
	promoteAttachmentToObsidian,
	removeAttachment,
	serveAttachment,
} from "./attachments";
import { loadConfig } from "./config";
import { bumpDataRevision } from "./dataRevision";
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
	if (url.pathname === "/api/relics/publish" && req.method === "POST") {
		if (activeUploads >= MAX_CONCURRENT_UPLOADS) {
			return Response.json(
				{ error: "upload_capacity_reached" },
				{ status: 429, headers: { "retry-after": "1" } },
			);
		}
		activeUploads++;
		try {
			return await handleGeneratedRelicPublish(
				req,
				loadCurrentConfig(fallbackConfig),
				async (id) => {
					bumpDataRevision("relics", "storage");
					try {
						await broadcast({
							type: "attachment_created",
							id,
							kind: "ephemeral",
						});
					} catch (err) {
						console.warn("[relics] broadcast failed:", err);
					}
				},
			);
		} finally {
			activeUploads--;
		}
	}

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
				bumpDataRevision("relics", "storage");
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

	const promoteMatch = url.pathname.match(
		/^\/api\/attachments\/([a-zA-Z0-9_-]+)\/promote-to-obsidian$/,
	);
	if (promoteMatch) {
		if (req.method !== "POST")
			return new Response("Method Not Allowed", { status: 405 });
		const response = await promoteAttachmentToObsidian(
			promoteMatch[1],
			loadCurrentConfig(fallbackConfig),
		);
		if (response.ok) bumpDataRevision("relics", "storage");
		return response;
	}

	const openObsidianMatch = url.pathname.match(
		/^\/api\/attachments\/([a-zA-Z0-9_-]+)\/open-in-obsidian$/,
	);
	if (openObsidianMatch) {
		if (req.method !== "POST")
			return new Response("Method Not Allowed", { status: 405 });
		return openAttachmentInObsidian(
			openObsidianMatch[1],
			loadCurrentConfig(fallbackConfig),
		);
	}

	const idMatch = url.pathname.match(/^\/api\/attachments\/([a-zA-Z0-9_-]+)$/);
	if (idMatch) {
		if (req.method !== "DELETE")
			return new Response("Method Not Allowed", { status: 405 });
		const response = await removeAttachment(
			idMatch[1],
			loadCurrentConfig(fallbackConfig),
		);
		if (response.ok) bumpDataRevision("relics", "storage");
		return response;
	}

	return null;
}

function loadCurrentConfig(fallbackConfig: HlidConfig): HlidConfig {
	try {
		return loadConfig();
	} catch {
		return fallbackConfig;
	}
}
