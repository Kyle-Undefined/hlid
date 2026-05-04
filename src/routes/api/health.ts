import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/health")({
	server: {
		handlers: {
			GET: async () => {
				return Response.json({
					service: "hlid",
					status: "ok",
					version: "0.1.0",
					ts: Date.now(),
				});
			},
		},
	},
});
