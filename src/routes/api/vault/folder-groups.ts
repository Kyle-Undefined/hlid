import { createFileRoute } from "@tanstack/react-router";
import { forbiddenResponse } from "#/lib/originGate";
import { scanFolderGroups } from "#/lib/vault";
import { loadConfig } from "#/server/config";

export async function handleGetFolderGroups(
	request: Request,
): Promise<Response> {
	const forbidden = forbiddenResponse(request);
	if (forbidden) return forbidden;

	const config = loadConfig();
	if (!config.vault.path) {
		return Response.json({ error: "No vault configured" }, { status: 400 });
	}

	const url = new URL(request.url);
	const folder =
		url.searchParams.get("folder") ?? config.vault.areas ?? "areas";

	if (!folder) {
		return Response.json({ error: "No folder configured" }, { status: 400 });
	}

	if (folder.includes("..") || folder.startsWith("/") || folder.includes("\\")) {
		return Response.json({ error: "Invalid folder path" }, { status: 400 });
	}

	try {
		const groups = scanFolderGroups(config.vault.path, folder);
		return Response.json(groups);
	} catch (err) {
		const msg = err instanceof Error ? err.message : "Internal error";
		return Response.json({ error: msg }, { status: 500 });
	}
}

export const Route = createFileRoute("/api/vault/folder-groups")({
	server: {
		handlers: {
			GET: ({ request }) => handleGetFolderGroups(request),
		},
	},
});
