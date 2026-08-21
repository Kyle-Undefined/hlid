import { createFileRoute } from "@tanstack/react-router";
import { LocalAiSetupMutationSchema } from "#/lib/localAiSetup";
import { forbiddenResponse } from "#/lib/originGate";

type LocalAiSetupApiOperations = Pick<
	typeof import("#/server/localAiSetup")["localAiSetup"],
	"snapshot" | "mutate"
>;

async function defaultOperations(): Promise<LocalAiSetupApiOperations> {
	return (await import("#/server/localAiSetup")).localAiSetup;
}

export async function handleGetLocalAiSetup(
	request: Request,
	loadOperations = defaultOperations,
): Promise<Response> {
	const forbidden = forbiddenResponse(request);
	if (forbidden) return forbidden;
	try {
		return Response.json(await (await loadOperations()).snapshot());
	} catch (error) {
		return Response.json(
			{ error: error instanceof Error ? error.message : String(error) },
			{ status: 503 },
		);
	}
}

export async function handlePostLocalAiSetup(
	request: Request,
	loadOperations = defaultOperations,
): Promise<Response> {
	const forbidden = forbiddenResponse(request);
	if (forbidden) return forbidden;
	let body: unknown;
	try {
		body = await request.json();
	} catch {
		return Response.json({ error: "invalid JSON" }, { status: 400 });
	}
	const parsed = LocalAiSetupMutationSchema.safeParse(body);
	if (!parsed.success) {
		return Response.json(
			{ error: "invalid local AI setup action" },
			{ status: 400 },
		);
	}
	try {
		return Response.json(await (await loadOperations()).mutate(parsed.data));
	} catch (error) {
		return Response.json(
			{ error: error instanceof Error ? error.message : String(error) },
			{ status: 500 },
		);
	}
}

export const Route = createFileRoute("/api/local-ai-setup")({
	server: {
		handlers: {
			GET: ({ request }) => handleGetLocalAiSetup(request),
			POST: ({ request }) => handlePostLocalAiSetup(request),
		},
	},
});
