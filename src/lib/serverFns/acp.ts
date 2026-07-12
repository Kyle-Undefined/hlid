/** ACP agent registry and authentication server fns. */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { dbFetch, dbJson, requireDbOk } from "#/lib/dbClient";
import { optionalRefreshSchema, withRefreshQuery } from "#/lib/serverFnSchemas";

export type AcpCatalogItem = {
	id: string;
	name: string;
	version: string;
	description: string;
	providerId: string;
	enabled: boolean;
	available: boolean;
	unavailableReason?: string;
	command: string;
	args: string[];
	env: Record<string, string>;
	installGuidance: string;
	repository?: string;
	website?: string;
};

export type AcpAuthMethod = {
	id: string;
	name: string;
	type?: "env_var" | "terminal";
	description?: string | null;
	link?: string | null;
	args?: string[];
	vars?: Array<{ name: string; label?: string | null; secret?: boolean }>;
};

export const getAcpRegistryFn = createServerFn({ method: "GET" })
	.validator((raw) => optionalRefreshSchema.parse(raw))
	.handler(({ data }) =>
		dbJson<{ agents: AcpCatalogItem[] }>(
			withRefreshQuery("/acp/registry", data),
			{
				agents: [],
			},
		).then((response) => response.agents),
	);

export const authenticateAcpFn = createServerFn({ method: "POST" })
	.validator((raw) =>
		z
			.object({ id: z.string().min(1), methodId: z.string().optional() })
			.parse(raw),
	)
	.handler(async ({ data }) => {
		const response = await dbFetch("/acp/authenticate", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(data),
		});
		await requireDbOk(response, "inspect ACP authentication");
		return (await response.json()) as { authMethods: AcpAuthMethod[] };
	});
