import { createFileRoute } from "@tanstack/react-router";
import { CURRENT_VERSION } from "#/lib/version";

export const Route = createFileRoute("/api/health")({
	server: {
		handlers: {
			GET: async () => {
				return Response.json({
					service: "hlid",
					status: "ok",
					version: CURRENT_VERSION,
					ts: Date.now(),
				});
			},
		},
	},
});
