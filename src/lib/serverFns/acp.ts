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
	resolvedExecutable?: string;
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

export type AcpAgentInfo = {
	name: string;
	version: string;
	title?: string | null;
};

const ACP_REGISTRY_REFRESH_TIMEOUT_MS = 15_000;

export async function loadAcpRegistry(
	refresh = false,
): Promise<AcpCatalogItem[]> {
	const path = withRefreshQuery("/acp/registry", { refresh });
	if (!refresh) {
		return dbJson<{ agents: AcpCatalogItem[] }>(path, { agents: [] }).then(
			(response) => response.agents,
		);
	}
	const response = await dbFetch(path, {
		signal: AbortSignal.timeout(ACP_REGISTRY_REFRESH_TIMEOUT_MS),
	});
	await requireDbOk(response, "refresh ACP registry");
	const payload = (await response.json()) as { agents?: unknown };
	if (!Array.isArray(payload.agents)) {
		throw new Error("ACP registry refresh returned an invalid catalog");
	}
	return payload.agents as AcpCatalogItem[];
}

export const getAcpRegistryFn = createServerFn({ method: "GET" })
	.validator((raw) => optionalRefreshSchema.parse(raw))
	.handler(({ data }) => loadAcpRegistry(data?.refresh));

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
		return (await response.json()) as {
			authMethods: AcpAuthMethod[];
			agentInfo: AcpAgentInfo | null;
		};
	});
