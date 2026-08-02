import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { dbFetch, dbJson, requireDbOk } from "#/lib/dbClient";
import type { ProviderAppCatalogPage } from "#/lib/providerAppTypes";

const providerAppQuerySchema = z.object({
	providerId: z.string().min(1).max(240),
	cwd: z.string().min(1).max(4_096).optional(),
	sessionId: z.string().min(1).max(240).optional(),
	cursor: z.string().max(500).optional(),
	limit: z.number().int().min(1).max(100).optional(),
	refresh: z.boolean().optional(),
});

export function providerAppsPath(
	data: z.infer<typeof providerAppQuerySchema>,
): string {
	const params = new URLSearchParams({ provider_id: data.providerId });
	if (data.cwd) params.set("cwd", data.cwd);
	if (data.sessionId) params.set("session_id", data.sessionId);
	if (data.cursor) params.set("cursor", data.cursor);
	if (data.limit) params.set("limit", String(data.limit));
	if (data.refresh) params.set("refresh", "1");
	return `/provider-apps?${params}`;
}

function unavailableCatalog(
	providerId: string,
	cwd: string | undefined,
): ProviderAppCatalogPage {
	return {
		contractVersion: 1,
		providerId,
		status: "unavailable",
		observedAt: 0,
		scope: {
			providerId,
			account: "active-provider-account",
			host: "current-hlid-host",
			workspace: cwd ?? "",
			sessionId: null,
		},
		apps: [],
		connectors: [],
		installedCount: 0,
		usableCount: 0,
		missingAuthenticationCount: 0,
		returned: 0,
		nextCursor: null,
		truncated: false,
		issues: ["Provider app inventory is unavailable."],
	};
}

export const getProviderAppsFn = createServerFn({ method: "GET" })
	.validator((raw) => providerAppQuerySchema.parse(raw))
	.handler(({ data }) =>
		dbJson<ProviderAppCatalogPage>(
			providerAppsPath(data),
			unavailableCatalog(data.providerId, data.cwd),
			{ initialTimeoutMs: 20_000, retryTimeoutMs: false },
		),
	);

export const authenticateProviderAppFn = createServerFn({ method: "POST" })
	.validator((raw) =>
		z
			.object({
				providerId: z.string().min(1).max(240),
				cwd: z.string().min(1).max(4_096).optional(),
				kind: z.enum(["app", "mcp"]),
				id: z.string().min(1).max(240),
			})
			.parse(raw),
	)
	.handler(async ({ data }) => {
		const response = await dbFetch("/provider-apps/authenticate", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(data),
		});
		await requireDbOk(response, "start provider app authentication");
		return (await response.json()) as { ok: boolean };
	});
