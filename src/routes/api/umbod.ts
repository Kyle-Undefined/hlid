import { createFileRoute } from "@tanstack/react-router";
import { forbiddenResponse } from "#/lib/originGate";

export async function handleGetUmbod(request: Request): Promise<Response> {
	const forbidden = forbiddenResponse(request);
	if (forbidden) return forbidden;
	try {
		const { umbodCalls, umbodSnapshot } = await import("#/server/umbod");
		const url = new URL(request.url);
		return Response.json(
			url.searchParams.get("view") === "calls"
				? await umbodCalls(url.searchParams)
				: await umbodSnapshot(),
		);
	} catch (error) {
		return Response.json(
			{
				enabled: true,
				error: error instanceof Error ? error.message : String(error),
			},
			{ status: 503 },
		);
	}
}

export const Route = createFileRoute("/api/umbod")({
	server: {
		handlers: {
			GET: ({ request }) => handleGetUmbod(request),
			POST: async ({ request }) => {
				const forbidden = forbiddenResponse(request);
				if (forbidden) return forbidden;
				try {
					const { saveUmbodManifest, umbodHookArtifacts } = await import(
						"#/server/umbod"
					);
					const body = (await request.json()) as {
						action?: unknown;
						source?: unknown;
						agents?: unknown;
						target?: unknown;
					};
					if (body.action === "generate-hooks") {
						if (
							!Array.isArray(body.agents) ||
							!body.agents.every((agent) => typeof agent === "string") ||
							(body.target !== "wsl" && body.target !== "windows")
						)
							return Response.json(
								{ error: "valid agents and target are required" },
								{ status: 400 },
							);
						return Response.json({
							artifacts: await umbodHookArtifacts(body.agents, body.target),
						});
					}
					if (typeof body.source !== "string")
						return Response.json(
							{ error: "source is required" },
							{ status: 400 },
						);
					await saveUmbodManifest(body.source);
					return Response.json({ ok: true });
				} catch (error) {
					return Response.json(
						{ error: error instanceof Error ? error.message : String(error) },
						{ status: 400 },
					);
				}
			},
		},
	},
});
