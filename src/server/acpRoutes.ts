import { type HlidConfig, HlidConfigSchema } from "../config";
import { AcpModelCatalogSchema } from "../lib/acpModelCatalog";
import {
	AcpProvider,
	type AcpProviderOptions,
	inspectAcpAgent,
} from "./acpProvider";
import type { AcpCatalogItem } from "./acpRegistry";
import {
	effectiveAcpEnvironment,
	OpenCodeConfigOverlayError,
} from "./acpRuntime";
import type { ProviderModelInfo } from "./agentProvider";

type AcpRouteDependencies = {
	registry: {
		catalog: (
			config: HlidConfig,
			refresh?: boolean,
		) => Promise<AcpCatalogItem[]>;
	};
	loadConfig: () => HlidConfig;
	inspectAgent?: typeof inspectAcpAgent;
	inspectModels?: (
		options: AcpProviderOptions,
		cwd: string,
	) => Promise<ProviderModelInfo[]>;
	logModelDiscoveryFailure?: (message: string) => void;
	syncRuntime?: () => Promise<unknown>;
};

async function inspectAcpModels(
	options: AcpProviderOptions,
	cwd: string,
): Promise<ProviderModelInfo[]> {
	return new AcpProvider(options).listModels({ cwd });
}

async function resolveEnabledAcpItem(
	id: string,
	dependencies: AcpRouteDependencies,
): Promise<
	| { config: HlidConfig; item: AcpCatalogItem; response?: never }
	| { config?: never; item?: never; response: Response }
> {
	const config = dependencies.loadConfig();
	const item = (await dependencies.registry.catalog(config)).find(
		(candidate) => candidate.id === id && candidate.enabled,
	);
	if (!item) {
		return {
			response: Response.json(
				{ error: "ACP agent is not enabled" },
				{ status: 404 },
			),
		};
	}
	if (!item.available) {
		return {
			response: Response.json(
				{ error: item.unavailableReason },
				{ status: 409 },
			),
		};
	}
	return { config, item };
}

async function discoverAcpModels(
	url: URL,
	dependencies: AcpRouteDependencies,
): Promise<Response> {
	const id = url.searchParams.get("id")?.trim();
	if (!id) {
		return Response.json({ error: "id is required" }, { status: 400 });
	}

	const resolved = await resolveEnabledAcpItem(id, dependencies);
	if (resolved.response) return resolved.response;
	const { config, item } = resolved;

	const discoveryCwd = config.vault.path || process.cwd();
	try {
		const models = await (dependencies.inspectModels ?? inspectAcpModels)(
			{
				id: item.providerId,
				label: item.name,
				command: item.command,
				args: item.args,
				env: item.env,
				discoveryCwd,
				initialAvailability: { available: true },
			},
			discoveryCwd,
		);
		const parsed = AcpModelCatalogSchema.safeParse(models);
		if (!parsed.success) throw new Error("invalid ACP model catalog");
		return Response.json({ models: parsed.data });
	} catch {
		(dependencies.logModelDiscoveryFailure ?? console.warn)(
			"[acp] Raw model discovery failed; provider diagnostics were redacted.",
		);
		return Response.json(
			{ error: "ACP model discovery failed" },
			{ status: 502 },
		);
	}
}

async function authenticateAcpAgent(
	request: Request,
	dependencies: AcpRouteDependencies,
): Promise<Response> {
	const body = (await request.json().catch(() => null)) as {
		id?: string;
		methodId?: string;
	} | null;
	if (!body?.id) {
		return Response.json({ error: "id is required" }, { status: 400 });
	}

	const resolved = await resolveEnabledAcpItem(body.id, dependencies);
	if (resolved.response) return resolved.response;
	const { config, item } = resolved;

	let environment: Record<string, string>;
	try {
		environment = effectiveAcpEnvironment(item, config);
	} catch (error) {
		if (error instanceof OpenCodeConfigOverlayError) {
			return Response.json({ error: error.message }, { status: 409 });
		}
		throw error;
	}
	const initialized = await (dependencies.inspectAgent ?? inspectAcpAgent)(
		{
			id: item.providerId,
			label: item.name,
			command: item.command,
			args: item.args,
			env: environment,
			discoveryCwd: config.vault.path || process.cwd(),
		},
		body.methodId,
	);
	return Response.json({
		authMethods: initialized.authMethods ?? [],
		agentInfo: initialized.agentInfo ?? null,
	});
}

async function preflightAcpConfig(
	request: Request,
	dependencies: AcpRouteDependencies,
): Promise<Response> {
	const parsed = HlidConfigSchema.safeParse(
		await request.json().catch(() => null),
	);
	if (!parsed.success) {
		return Response.json(
			{ error: "A valid Hlid config is required" },
			{ status: 400 },
		);
	}
	const config = parsed.data;
	const filteredAgents = (config.acp_agents ?? []).filter(
		(agent) => agent.model_filter,
	);
	if (filteredAgents.length === 0) return Response.json({ ok: true });

	const catalog = await dependencies.registry.catalog(config);
	for (const configured of filteredAgents) {
		const item = catalog.find(
			(candidate) => candidate.id === configured.id && candidate.enabled,
		);
		if (!item) {
			return Response.json(
				{ error: `ACP agent ${JSON.stringify(configured.id)} is not enabled` },
				{ status: 404 },
			);
		}
		try {
			effectiveAcpEnvironment(item, config);
		} catch (error) {
			if (error instanceof OpenCodeConfigOverlayError) {
				return Response.json({ error: error.message }, { status: 409 });
			}
			throw error;
		}
	}
	return Response.json({ ok: true });
}

export function createAcpRouteHandler(dependencies: AcpRouteDependencies) {
	return async (url: URL, request: Request): Promise<Response | null> => {
		if (url.pathname === "/acp/preflight" && request.method === "POST") {
			return preflightAcpConfig(request, dependencies);
		}
		if (url.pathname === "/acp/models" && request.method === "GET") {
			return discoverAcpModels(url, dependencies);
		}
		if (url.pathname === "/acp/registry" && request.method === "GET") {
			const refresh = url.searchParams.get("refresh") === "1";
			const agents = await dependencies.registry.catalog(
				dependencies.loadConfig(),
				refresh,
			);
			if (refresh && dependencies.syncRuntime) {
				await dependencies.syncRuntime();
			}
			return Response.json({
				agents: agents.map((agent) => ({ ...agent, env: {} })),
			});
		}
		if (url.pathname === "/acp/authenticate" && request.method === "POST") {
			return authenticateAcpAgent(request, dependencies);
		}
		if (url.pathname === "/acp/sync" && request.method === "POST") {
			if (!dependencies.syncRuntime) {
				return Response.json(
					{ error: "ACP runtime synchronization is unavailable" },
					{ status: 503 },
				);
			}
			try {
				return Response.json(await dependencies.syncRuntime());
			} catch (error) {
				if (error instanceof OpenCodeConfigOverlayError) {
					return Response.json({ error: error.message }, { status: 409 });
				}
				throw error;
			}
		}
		return null;
	};
}
