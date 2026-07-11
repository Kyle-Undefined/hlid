import { forbiddenResponse } from "#/lib/originGate";

type PathResolver<T> = (input: T) => string | Response;

function errorJson(error: unknown, fallback: string, status: number): Response {
	return Response.json(
		{ error: error instanceof Error ? error.message : fallback },
		{ status },
	);
}

export async function handleMcpGet(
	request: Request,
	resolvePath: PathResolver<Request>,
	read: (path: string) => unknown,
): Promise<Response> {
	const forbidden = forbiddenResponse(request);
	if (forbidden) return forbidden;
	const path = resolvePath(request);
	if (path instanceof Response) return path;
	try {
		return Response.json(read(path));
	} catch (error) {
		return errorJson(error, "Internal error", 500);
	}
}

export async function handleMcpMutation<T>(
	request: Request,
	resolvePath: PathResolver<Record<string, unknown>>,
	parseMutation: (body: Record<string, unknown>) => T | Response,
	mutate: (path: string, value: T) => void,
): Promise<Response> {
	const forbidden = forbiddenResponse(request);
	if (forbidden) return forbidden;
	try {
		const body = (await request.json()) as Record<string, unknown>;
		const path = resolvePath(body);
		if (path instanceof Response) return path;
		const value = parseMutation(body);
		if (value instanceof Response) return value;
		mutate(path, value);
		return Response.json({ ok: true });
	} catch (error) {
		return errorJson(error, "Bad request", 400);
	}
}

export function parseServers(
	body: Record<string, unknown>,
): Record<string, unknown> | Response {
	if (
		typeof body.servers !== "object" ||
		body.servers === null ||
		Array.isArray(body.servers)
	) {
		return Response.json(
			{ error: "Invalid body: servers required" },
			{ status: 400 },
		);
	}
	return body.servers as Record<string, unknown>;
}

export function parseToggle(
	body: Record<string, unknown>,
): { name: string; disabled: boolean } | Response {
	if (typeof body.name !== "string" || typeof body.disabled !== "boolean") {
		return Response.json(
			{
				error: "Invalid body: name (string) and disabled (boolean) required",
			},
			{ status: 400 },
		);
	}
	return { name: body.name, disabled: body.disabled };
}
