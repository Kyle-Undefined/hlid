import type { HlidConfig } from "../config";
import { inspectAcpAgent } from "./acpProvider";
import type { AcpCatalogItem } from "./acpRegistry";

type AcpRouteDependencies = {
	registry: {
		catalog: (
			config: HlidConfig,
			refresh?: boolean,
		) => Promise<AcpCatalogItem[]>;
	};
	loadConfig: () => HlidConfig;
	inspectAgent?: typeof inspectAcpAgent;
};

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

	const config = dependencies.loadConfig();
	const item = (await dependencies.registry.catalog(config)).find(
		(candidate) => candidate.id === body.id && candidate.enabled,
	);
	if (!item) {
		return Response.json(
			{ error: "ACP agent is not enabled" },
			{ status: 404 },
		);
	}
	if (!item.available) {
		return Response.json({ error: item.unavailableReason }, { status: 409 });
	}

	const configured = (config.acp_agents ?? []).find(
		(agent) => agent.id === item.id,
	);
	const initialized = await (dependencies.inspectAgent ?? inspectAcpAgent)(
		{
			id: item.providerId,
			label: item.name,
			command: item.command,
			args: item.args,
			env: { ...item.env, ...configured?.env },
		},
		body.methodId,
	);
	return Response.json({
		authMethods: initialized.authMethods ?? [],
		agentInfo: initialized.agentInfo ?? null,
	});
}

export function createAcpRouteHandler(dependencies: AcpRouteDependencies) {
	return async (url: URL, request: Request): Promise<Response | null> => {
		if (url.pathname === "/acp/registry" && request.method === "GET") {
			const refresh = url.searchParams.get("refresh") === "1";
			return Response.json({
				agents: await dependencies.registry.catalog(
					dependencies.loadConfig(),
					refresh,
				),
			});
		}
		if (url.pathname === "/acp/authenticate" && request.method === "POST") {
			return authenticateAcpAgent(request, dependencies);
		}
		return null;
	};
}
