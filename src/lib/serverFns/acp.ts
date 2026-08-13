/** ACP agent registry and authentication server fns. */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import type { AcpTargetStatus } from "#/lib/acpManagedTypes";
import { AcpModelCatalogSchema } from "#/lib/acpModelCatalog";
import { dbFetch, dbJson, requireDbOk } from "#/lib/dbClient";
import type { ProviderInfo } from "#/lib/providerTypes";
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
	targets: AcpTargetStatus[];
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

export type AcpProviderNativeSession = {
	sessionId: string;
	title?: string | null;
	updatedAt?: string | null;
};

export type AcpProviderNativeSessionPage = {
	sessions: AcpProviderNativeSession[];
	canImportSessions: boolean;
	nextCursor?: string;
};

export type AcpProviderSessionImportResult = {
	sessionId: string;
	created: boolean;
};

const ACP_REGISTRY_REFRESH_TIMEOUT_MS = 15_000;
const ACP_MODEL_DISCOVERY_TIMEOUT_MS = 15_000;
// The owner allows the default 9s inspection plus 10s session phase. Leave
// transport headroom so a valid provider response is not aborted first.
const ACP_SESSION_LIST_TIMEOUT_MS = 22_000;
const ACP_SESSION_IMPORT_TIMEOUT_MS = 30_000;
const AcpProviderNativeSessionPageSchema = z
	.object({
		sessions: z
			.array(
				z
					.object({
						sessionId: z.string().min(1).max(512),
						title: z.string().max(1_000).nullable().optional(),
						updatedAt: z.string().max(128).nullable().optional(),
					})
					.strict(),
			)
			.max(100),
		canImportSessions: z.boolean(),
		nextCursor: z.string().min(1).max(2_048).optional(),
	})
	.strict();
const AcpProviderSessionImportResultSchema = z
	.object({
		sessionId: z.string().min(1).max(512),
		created: z.boolean(),
	})
	.strict();
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

/** Live model inspection without Hlid's OpenCode visibility overlay. */
export async function discoverAcpModels(
	id: string,
	cwd?: string,
): Promise<NonNullable<ProviderInfo["models"]>> {
	const query = new URLSearchParams({ id });
	if (cwd !== undefined) query.set("cwd", cwd);
	const response = await dbFetch(`/acp/models?${query.toString()}`, {
		signal: AbortSignal.timeout(ACP_MODEL_DISCOVERY_TIMEOUT_MS),
	});
	await requireDbOk(response, "discover ACP models");
	const payload = (await response.json()) as { models?: unknown };
	const parsed = AcpModelCatalogSchema.safeParse(payload.models);
	if (!parsed.success) {
		throw new Error("ACP model discovery returned an invalid catalog");
	}
	return parsed.data as NonNullable<ProviderInfo["models"]>;
}

export const discoverAcpModelsFn = createServerFn({ method: "GET" })
	.validator((raw) =>
		z
			.object({
				id: z.string().min(1).max(128),
				cwd: z.string().min(1).max(4_096).optional(),
			})
			.parse(raw),
	)
	.handler(({ data }) => discoverAcpModels(data.id, data.cwd));

export async function listAcpProviderSessions(
	id: string,
	cursor?: string,
	cwd?: string,
): Promise<AcpProviderNativeSessionPage> {
	const query = new URLSearchParams({ id });
	if (cursor !== undefined) query.set("cursor", cursor);
	if (cwd !== undefined) query.set("cwd", cwd);
	const response = await dbFetch(`/acp/sessions?${query.toString()}`, {
		signal: AbortSignal.timeout(ACP_SESSION_LIST_TIMEOUT_MS),
	});
	await requireDbOk(response, "list ACP provider sessions");
	const parsed = AcpProviderNativeSessionPageSchema.safeParse(
		await response.json(),
	);
	if (!parsed.success) {
		throw new Error("ACP provider session listing returned an invalid page");
	}
	return parsed.data;
}

export const listAcpProviderSessionsFn = createServerFn({ method: "GET" })
	.validator((raw) =>
		z
			.object({
				id: z.string().min(1).max(128),
				cursor: z.string().min(1).max(2_048).optional(),
				cwd: z.string().min(1).max(4_096).optional(),
			})
			.parse(raw),
	)
	.handler(({ data }) =>
		listAcpProviderSessions(data.id, data.cursor, data.cwd),
	);

export async function importAcpProviderSession(
	id: string,
	providerSessionId: string,
	cwd?: string,
): Promise<AcpProviderSessionImportResult> {
	const response = await dbFetch("/acp/sessions/import", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ id, providerSessionId, ...(cwd ? { cwd } : {}) }),
		signal: AbortSignal.timeout(ACP_SESSION_IMPORT_TIMEOUT_MS),
	});
	await requireDbOk(response, "import ACP provider session");
	const parsed = AcpProviderSessionImportResultSchema.safeParse(
		await response.json(),
	);
	if (!parsed.success) {
		throw new Error("ACP provider session import returned an invalid result");
	}
	return parsed.data;
}

export const importAcpProviderSessionFn = createServerFn({ method: "POST" })
	.validator((raw) =>
		z
			.object({
				id: z.string().min(1).max(128),
				providerSessionId: z.string().min(1).max(512),
				cwd: z.string().min(1).max(4_096).optional(),
			})
			.parse(raw),
	)
	.handler(({ data }) =>
		importAcpProviderSession(data.id, data.providerSessionId, data.cwd),
	);

export const authenticateAcpFn = createServerFn({ method: "POST" })
	.validator((raw) =>
		z
			.object({
				id: z.string().min(1),
				methodId: z.string().optional(),
				cwd: z.string().min(1).max(4_096).optional(),
			})
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
			canListSessions: boolean;
		};
	});
