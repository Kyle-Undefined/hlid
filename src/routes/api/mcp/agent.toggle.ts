import { createFileRoute } from "@tanstack/react-router";
import { handleToggleAgentMcp } from "./agent";

export const Route = createFileRoute("/api/mcp/agent/toggle")({
	server: {
		handlers: {
			POST: ({ request }) => handleToggleAgentMcp(request),
		},
	},
});
