import { createFileRoute } from "@tanstack/react-router";
import { forbiddenResponse } from "#/lib/originGate";
import {
	readVaultMcpFile,
	toggleVaultMcpFile,
	writeVaultMcpFile,
} from "#/lib/vaultMcp";
import { loadConfig } from "#/server/config";

// ─── Handlers (exported for unit tests) ──────────────────────────────────────

export async function handleGetVaultMcp(request: Request): Promise<Response> {
	const forbidden = forbiddenResponse(request);
	if (forbidden) return forbidden;

	const config = loadConfig();
	if (!config.vault.path) {
		return Response.json({ error: "No vault configured" }, { status: 400 });
	}

	try {
		return Response.json(readVaultMcpFile(config.vault.path));
	} catch (err) {
		const msg = err instanceof Error ? err.message : "Internal error";
		return Response.json({ error: msg }, { status: 500 });
	}
}

export async function handlePostVaultMcp(request: Request): Promise<Response> {
	const forbidden = forbiddenResponse(request);
	if (forbidden) return forbidden;

	const config = loadConfig();
	if (!config.vault.path) {
		return Response.json({ error: "No vault configured" }, { status: 400 });
	}

	try {
		const body = (await request.json()) as {
			servers?: Record<string, unknown>;
		};
		if (
			!body ||
			typeof body.servers !== "object" ||
			body.servers === null ||
			Array.isArray(body.servers)
		) {
			return Response.json(
				{ error: "Invalid body: servers required" },
				{ status: 400 },
			);
		}
		writeVaultMcpFile(config.vault.path, body.servers);
		return Response.json({ ok: true });
	} catch (err) {
		const msg = err instanceof Error ? err.message : "Bad request";
		return Response.json({ error: msg }, { status: 400 });
	}
}

export async function handleToggleVaultMcp(
	request: Request,
): Promise<Response> {
	const forbidden = forbiddenResponse(request);
	if (forbidden) return forbidden;

	const config = loadConfig();
	if (!config.vault.path) {
		return Response.json({ error: "No vault configured" }, { status: 400 });
	}

	try {
		const body = (await request.json()) as {
			name?: string;
			disabled?: boolean;
		};
		if (typeof body.name !== "string" || typeof body.disabled !== "boolean") {
			return Response.json(
				{
					error: "Invalid body: name (string) and disabled (boolean) required",
				},
				{ status: 400 },
			);
		}
		toggleVaultMcpFile(config.vault.path, body.name, body.disabled);
		return Response.json({ ok: true });
	} catch (err) {
		const msg = err instanceof Error ? err.message : "Bad request";
		return Response.json({ error: msg }, { status: 400 });
	}
}

// ─── Route ───────────────────────────────────────────────────────────────────

export const Route = createFileRoute("/api/mcp/vault")({
	server: {
		handlers: {
			GET: ({ request }) => handleGetVaultMcp(request),
			POST: ({ request }) => handlePostVaultMcp(request),
		},
	},
});
