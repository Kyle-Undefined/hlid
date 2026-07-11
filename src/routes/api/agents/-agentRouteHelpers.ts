import { forbiddenResponse } from "#/lib/originGate";

export function getAgentPath(request: Request): string | Response {
	const forbidden = forbiddenResponse(request);
	if (forbidden) return forbidden;

	const agentPath = new URL(request.url).searchParams.get("path");
	return (
		agentPath ?? Response.json({ error: "Missing path param" }, { status: 400 })
	);
}
