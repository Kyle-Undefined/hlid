import { createFileRoute } from "@tanstack/react-router";
import { handleToggleVaultMcp } from "./vault";

// Toggle lives at /api/mcp/vault/toggle — handler shared with vault.ts
export const Route = createFileRoute("/api/mcp/vault/toggle")({
	server: {
		handlers: {
			POST: ({ request }) => handleToggleVaultMcp(request),
		},
	},
});
