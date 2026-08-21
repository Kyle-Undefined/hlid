import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { forbiddenResponse } from "#/lib/originGate";
import { expandTilde, pathStartsWith } from "#/lib/paths";
import { bootstrapStarterWorkspace } from "#/server/starterWorkspace";

const RequestSchema = z.object({
	parent_path: z.string().trim().min(1).max(4096),
});

export async function handleStarterWorkspaceRequest(
	request: Request,
): Promise<Response> {
	const forbidden = forbiddenResponse(request);
	if (forbidden) return forbidden;
	let parentPath: string;
	try {
		parentPath = RequestSchema.parse(await request.json()).parent_path;
	} catch {
		return Response.json({ error: "A folder is required." }, { status: 400 });
	}
	try {
		const home = await realpath(homedir());
		const parent = await realpath(expandTilde(parentPath));
		if (!pathStartsWith(home, parent)) {
			return Response.json(
				{ error: "Choose a folder inside your home directory." },
				{ status: 403 },
			);
		}
		return Response.json(await bootstrapStarterWorkspace(parent));
	} catch (error) {
		return Response.json(
			{
				error:
					error instanceof Error
						? error.message
						: "Could not create starter workspace.",
			},
			{ status: 409 },
		);
	}
}

export const Route = createFileRoute("/api/starter-workspace")({
	server: {
		handlers: { POST: ({ request }) => handleStarterWorkspaceRequest(request) },
	},
});
