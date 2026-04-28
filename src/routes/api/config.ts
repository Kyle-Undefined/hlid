import { createFileRoute } from "@tanstack/react-router";
import { HlidConfigSchema } from "#/config";
import { writeConfig } from "#/lib/config-writer";
import { forbiddenResponse } from "#/lib/originGate";

export const Route = createFileRoute("/api/config")({
	server: {
		handlers: {
			POST: async ({ request }) => {
				const forbidden = await forbiddenResponse();
				if (forbidden) return forbidden;
				try {
					const body = await request.json();
					const config = HlidConfigSchema.parse(body);
					writeConfig(config);
					return Response.json({ ok: true });
				} catch (err) {
					const msg = err instanceof Error ? err.message : "Invalid config";
					return Response.json({ error: msg }, { status: 400 });
				}
			},
		},
	},
});
