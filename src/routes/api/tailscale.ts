import { createFileRoute } from "@tanstack/react-router";
import { forbiddenResponse } from "#/lib/originGate";
import { getTailscaleStatus } from "#/lib/tailscale";

export const Route = createFileRoute("/api/tailscale")({
	server: {
		handlers: {
			GET: async ({ request }) => {
				const forbidden = forbiddenResponse(request);
				if (forbidden) return forbidden;
				return Response.json(await getTailscaleStatus());
			},
		},
	},
});
