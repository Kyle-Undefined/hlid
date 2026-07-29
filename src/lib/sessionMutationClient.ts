import { dbFetch, requireDbOk } from "./dbClient";

export async function patchSession(
	id: string,
	patch: Record<string, unknown>,
	operation: string,
): Promise<{ ok: true }> {
	await requireDbOk(
		await dbFetch(`/db/session?id=${encodeURIComponent(id)}`, {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(patch),
		}),
		operation,
	);
	return { ok: true };
}
