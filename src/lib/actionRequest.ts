export async function parseJsonAction<const Actions extends readonly string[]>(
	request: Request,
	actions: Actions,
	invalidJsonMessage = "Invalid JSON",
): Promise<{ action: Actions[number] } | Response> {
	let body: { action?: unknown };
	try {
		body = (await request.json()) as { action?: unknown };
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
	return { action: body.action as Actions[number] };
}
