import { createFileRoute } from "@tanstack/react-router";
import { forbiddenResponse } from "#/lib/originGate";

type UmbodRouteOperations = Pick<
	typeof import("#/server/umbod"),
	"saveUmbodManifest" | "umbodHookArtifacts"
>;

const loadUmbodRouteOperations = async (): Promise<UmbodRouteOperations> => {
	const { saveUmbodManifest, umbodHookArtifacts } = await import(
		"#/server/umbod"
	);
	return { saveUmbodManifest, umbodHookArtifacts };
};

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function isFileSystemError(error: unknown): boolean {
	return (
		error instanceof Error &&
		"code" in error &&
		typeof (error as NodeJS.ErrnoException).code === "string"
	);
}

type UmbodCommand =
	| { kind: "generate-hooks"; agents: string[]; target: "wsl" | "windows" }
	| { kind: "save-manifest"; source: string };

function parseUmbodCommand(body: {
	action?: unknown;
	source?: unknown;
	agents?: unknown;
	target?: unknown;
}): { ok: true; command: UmbodCommand } | { ok: false; response: Response } {
	if (body.action === "generate-hooks") {
		if (
			!Array.isArray(body.agents) ||
			!body.agents.every((agent) => typeof agent === "string") ||
			(body.target !== "wsl" && body.target !== "windows")
		) {
			return {
				ok: false,
				response: Response.json(
					{ error: "valid agents and target are required" },
					{ status: 400 },
				),
			};
		}
		return {
			ok: true,
			command: {
				kind: "generate-hooks",
				agents: body.agents,
				target: body.target,
			},
		};
	}
	if (body.action !== undefined && body.action !== "save-manifest") {
		return {
			ok: false,
			response: Response.json({ error: "unknown action" }, { status: 400 }),
		};
	}
	if (typeof body.source !== "string") {
		return {
			ok: false,
			response: Response.json({ error: "source is required" }, { status: 400 }),
		};
	}
	return {
		ok: true,
		command: { kind: "save-manifest", source: body.source },
	};
}

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

export async function handlePostUmbod(
	request: Request,
	loadOperations: () => Promise<UmbodRouteOperations> = loadUmbodRouteOperations,
): Promise<Response> {
	const forbidden = forbiddenResponse(request);
	if (forbidden) return forbidden;

	let body: {
		action?: unknown;
		source?: unknown;
		agents?: unknown;
		target?: unknown;
	};
	try {
		body = (await request.json()) as typeof body;
	} catch {
		return Response.json({ error: "invalid JSON body" }, { status: 400 });
	}

	const parsed = parseUmbodCommand(body);
	if (!parsed.ok) return parsed.response;
	let operations: UmbodRouteOperations;
	try {
		operations = await loadOperations();
	} catch (error) {
		return Response.json({ error: errorMessage(error) }, { status: 500 });
	}
	if (parsed.command.kind === "generate-hooks") {
		try {
			return Response.json({
				artifacts: await operations.umbodHookArtifacts(
					parsed.command.agents,
					parsed.command.target,
				),
			});
		} catch (error) {
			return Response.json({ error: errorMessage(error) }, { status: 500 });
		}
	}

	try {
		await operations.saveUmbodManifest(parsed.command.source);
		return Response.json({ ok: true });
	} catch (error) {
		return Response.json(
			{ error: errorMessage(error) },
			{ status: isFileSystemError(error) ? 500 : 400 },
		);
	}
}

export const Route = createFileRoute("/api/umbod")({
	server: {
		handlers: {
			GET: ({ request }) => handleGetUmbod(request),
			POST: ({ request }) => handlePostUmbod(request),
		},
	},
});
