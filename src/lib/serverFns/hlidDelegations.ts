import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { dbFetch, requireDbOk } from "#/lib/dbClient";
import type { HlidDelegationSnapshot } from "#/lib/hlidDelegation";

export type HlidDelegationListItem = HlidDelegationSnapshot & {
	result_available: boolean;
	error_available: boolean;
};

const listInputSchema = z.object({
	sessionId: z.string().trim().min(1),
	limit: z.number().int().min(1).max(100).optional(),
});

export function hlidDelegationsPath(input: {
	sessionId: string;
	limit?: number;
}): string {
	const search = new URLSearchParams({
		parent_session_id: input.sessionId,
		...(input.limit !== undefined ? { limit: String(input.limit) } : {}),
	});
	return `/hlid-agents?${search.toString()}`;
}

export const getHlidDelegationsFn = createServerFn({ method: "GET" })
	.validator((raw) => listInputSchema.parse(raw))
	.handler(async ({ data }) => {
		const response = await dbFetch(hlidDelegationsPath(data));
		await requireDbOk(response, "Load Hlid delegated children");
		return (await response.json()) as HlidDelegationListItem[];
	});
