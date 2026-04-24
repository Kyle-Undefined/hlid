import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/health")({
	server: {
		handlers: {
			GET: () =>
				Response.json({
					status: "ok",
					version: "0.1.0",
					ts: Date.now(),
				}),
		},
	},
});
