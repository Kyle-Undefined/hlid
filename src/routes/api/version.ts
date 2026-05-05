import { createFileRoute } from "@tanstack/react-router";
import { forbiddenResponse } from "#/lib/originGate";
import { CURRENT_VERSION } from "#/lib/version";

// Tiny, gate-checked endpoint. Used by FORGE during the "applying update"
// state to poll for the new instance: when the version returned changes,
// the page reloads. Kept separate from /api/health so it stays the smallest
// possible response and can be hammered safely.
export const Route = createFileRoute("/api/version")({
	server: {
		handlers: {
			GET: async ({ request }) => {
				const forbidden = forbiddenResponse(request);
				if (forbidden) return forbidden;
				return Response.json({ version: CURRENT_VERSION });
			},
		},
	},
});
