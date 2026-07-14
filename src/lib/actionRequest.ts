export async function parseJsonAction<const Actions extends readonly string[]>(
	request: Request,
	actions: Actions,
	invalidJsonMessage = "Invalid JSON",
): Promise<
	{ action: Actions[number]; body: Record<string, unknown> } | Response
> {
	let body: Record<string, unknown> & { action?: unknown };
	try {
		body = (await request.json()) as Record<string, unknown> & {
			action?: unknown;
		};
	} catch {
		return Response.json(
			{ ok: false, error: invalidJsonMessage },
			{ status: 400 },
		);
	}
	if (
		typeof body.action !== "string" ||
		!(actions as readonly string[]).includes(body.action)
	) {
		return Response.json(
			{
				ok: false,
				error: `action must be one of: ${actions.join(", ")}`,
			},
			{ status: 400 },
		);
	}
	return { action: body.action as Actions[number], body };
}
