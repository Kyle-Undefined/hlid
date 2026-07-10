import { statSync } from "node:fs";
import { createFileRoute } from "@tanstack/react-router";
import { HlidConfigSchema } from "#/config";
import { writeConfig } from "#/lib/config-writer";
import { dbFetch } from "#/lib/dbClient";
import { forbiddenResponse } from "#/lib/originGate";
import { loadConfig } from "#/server/config";

export async function handleGetConfig(request: Request): Promise<Response> {
	const forbidden = forbiddenResponse(request);
	if (forbidden) return forbidden;
	return Response.json(loadConfig());
}

export const Route = createFileRoute("/api/config")({
	server: {
		handlers: {
			GET: ({ request }) => handleGetConfig(request),
			POST: async ({ request }) => {
				const forbidden = forbiddenResponse(request);
				if (forbidden) return forbidden;
				try {
					const body = await request.json();
					const config = HlidConfigSchema.parse(body);
					// M1: Validate vault.path is a real directory before persisting
					if (config.vault.path) {
						try {
							const stat = statSync(config.vault.path);
							if (!stat.isDirectory()) {
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
					writeConfig(config);
					void dbFetch("/voice/sync", { method: "POST" }).catch(() => {});
					return Response.json({ ok: true });
				} catch (err) {
					const msg = err instanceof Error ? err.message : "Invalid config";
					return Response.json({ error: msg }, { status: 400 });
				}
			},
		},
	},
});
