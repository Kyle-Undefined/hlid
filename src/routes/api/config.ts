import { stat } from "node:fs/promises";
import { createFileRoute } from "@tanstack/react-router";
import { HlidConfigSchema } from "#/config";
import { writeConfig } from "#/lib/config-writer";
import { dbFetch } from "#/lib/dbClient";
import { forbiddenResponse } from "#/lib/originGate";
import { expandTilde } from "#/lib/paths";
import { loadConfig } from "#/server/config";

export async function handleGetConfig(request: Request): Promise<Response> {
	const forbidden = forbiddenResponse(request);
	if (forbidden) return forbidden;
	return Response.json(loadConfig());
}

export async function handlePostConfig(request: Request): Promise<Response> {
	const forbidden = forbiddenResponse(request);
	if (forbidden) return forbidden;
	let config: ReturnType<typeof HlidConfigSchema.parse>;
	try {
		config = HlidConfigSchema.parse(await request.json());
	} catch (error) {
		const message = error instanceof Error ? error.message : "Invalid config";
		return Response.json({ error: message }, { status: 400 });
	}
	if (config.vault.path) {
		try {
			const vaultStat = await stat(expandTilde(config.vault.path));
			if (!vaultStat.isDirectory()) {
				return Response.json(
					{ error: "vault.path is not a directory" },
					{ status: 400 },
				);
			}
		} catch {
			return Response.json(
				{ error: "vault.path does not exist" },
				{ status: 400 },
			);
		}
	}
	if (config.umbod.enabled) {
		try {
			const { ensureUmbodManifest } = await import("#/server/umbod");
			await ensureUmbodManifest(config.umbod.manifest_path);
		} catch (error) {
			return Response.json(
				{
					error: `Invalid Umbod manifest: ${error instanceof Error ? error.message : String(error)}`,
				},
				{ status: 400 },
			);
		}
	}
	try {
		writeConfig(config);
	} catch {
		return Response.json({ error: "Failed to write config" }, { status: 500 });
	}
	void dbFetch("/voice/sync", { method: "POST" }).catch(() => {});
	return Response.json({ ok: true });
}

export const Route = createFileRoute("/api/config")({
	server: {
		handlers: {
			GET: ({ request }) => handleGetConfig(request),
			POST: ({ request }) => handlePostConfig(request),
		},
	},
});
