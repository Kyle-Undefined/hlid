import { type HlidConfig, HlidConfigSchema } from "../config";
import { AcpModelCatalogSchema } from "../lib/acpModelCatalog";
import {
	AcpProvider,
	type AcpProviderNativeSession,
	type AcpProviderOptions,
	AcpSessionImportUnsupportedError,
	AcpSessionListUnsupportedError,
	findAcpProviderSession,
	inspectAcpAgent,
	listAcpProviderSessions,
} from "./acpProvider";
import type { AcpCatalogItem } from "./acpRegistry";
import {
	acpRuntimeFingerprint,
	effectiveAcpEnvironment,
	OpenCodeConfigOverlayError,
} from "./acpRuntime";
import type { ProviderModelInfo } from "./agentProvider";

export type AcpProviderSessionImportInput = {
	agentId: string;
	providerId: string;
	providerLabel: string;
	providerSession: AcpProviderNativeSession;
	cwd: string;
	providerRuntimeIdentity: string;
};

type AcpRouteDependencies = {
	registry: {
		catalog: (
			config: HlidConfig,
			refresh?: boolean,
			refreshRuntimeEvidence?: boolean,
		) => Promise<AcpCatalogItem[]>;
	};
	loadConfig: () => HlidConfig;
	inspectAgent?: typeof inspectAcpAgent;
	inspectModels?: (
		options: AcpProviderOptions,
		cwd: string,
	) => Promise<ProviderModelInfo[]>;
	listSessions?: typeof listAcpProviderSessions;
	findSession?: typeof findAcpProviderSession;
	importSession?: (
		input: AcpProviderSessionImportInput,
	) => Promise<{ sessionId: string; created: boolean; rebound: boolean }>;
	logModelDiscoveryFailure?: (message: string) => void;
	logSessionListFailure?: (message: string) => void;
	logSessionImportFailure?: (message: string) => void;
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
	refreshRuntimeEvidence = false,
): Promise<
	| { config: HlidConfig; item: AcpCatalogItem; response?: never }
	| { config?: never; item?: never; response: Response }
> {
	const config = dependencies.loadConfig();
	const item = (
		await dependencies.registry.catalog(config, false, refreshRuntimeEvidence)
	).find((candidate) => candidate.id === id && candidate.enabled);
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

async function resolveEnabledAcpRuntime(
	id: string,
	dependencies: AcpRouteDependencies,
): Promise<
	| {
			config: HlidConfig;
			item: AcpCatalogItem;
			cwd: string;
			options: AcpProviderOptions;
			response?: never;
	  }
	| {
			config?: never;
			item?: never;
			cwd?: never;
			options?: never;
			response: Response;
	  }
> {
	const resolved = await resolveEnabledAcpItem(id, dependencies);
	if (resolved.response) return resolved;
	const { config, item } = resolved;
	let environment: Record<string, string>;
	try {
		environment = effectiveAcpEnvironment(item, config);
	} catch (error) {
		if (error instanceof OpenCodeConfigOverlayError) {
			return {
				response: Response.json({ error: error.message }, { status: 409 }),
			};
		}
		throw error;
	}
	const cwd = config.vault.path || process.cwd();
	return {
		config,
		item,
		cwd,
		options: {
			id: item.providerId,
			label: item.name,
			command: item.command,
			args: item.args,
			env: environment,
			discoveryCwd: cwd,
			initialAvailability: { available: true },
		},
	};
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

	const resolved = await resolveEnabledAcpRuntime(body.id, dependencies);
	if (resolved.response) return resolved.response;
	const initialized = await (dependencies.inspectAgent ?? inspectAcpAgent)(
		resolved.options,
		body.methodId,
	);
	return Response.json({
		authMethods: initialized.authMethods ?? [],
		agentInfo: initialized.agentInfo ?? null,
		canListSessions: Boolean(
			initialized.agentCapabilities?.sessionCapabilities?.list,
		),
		canImportSessions: Boolean(
			initialized.agentCapabilities?.sessionCapabilities?.list &&
				(initialized.agentCapabilities?.loadSession ||
					initialized.agentCapabilities?.sessionCapabilities?.resume),
		),
	});
}

async function listProviderNativeSessions(
	url: URL,
	dependencies: AcpRouteDependencies,
): Promise<Response> {
	const id = url.searchParams.get("id")?.trim();
	if (!id || id.length > 128) {
		return Response.json({ error: "a valid id is required" }, { status: 400 });
	}
	const cursorParam = url.searchParams.get("cursor");
	if (
		cursorParam !== null &&
		(cursorParam.length === 0 || cursorParam.length > 2_048)
	) {
		return Response.json(
			{ error: "a valid cursor is required" },
			{ status: 400 },
		);
	}

	const resolved = await resolveEnabledAcpRuntime(id, dependencies);
	if (resolved.response) return resolved.response;
	try {
		const page = await (dependencies.listSessions ?? listAcpProviderSessions)(
			resolved.options,
			resolved.cwd,
			cursorParam ?? undefined,
		);
		return Response.json(page);
	} catch (error) {
		if (error instanceof AcpSessionListUnsupportedError) {
			return Response.json(
				{ error: "The ACP agent does not advertise provider session listing" },
				{ status: 409 },
			);
		}
		(dependencies.logSessionListFailure ?? console.warn)(
			"[acp] Provider session listing failed; provider diagnostics were redacted.",
		);
		return Response.json(
			{ error: "ACP provider session listing failed" },
			{ status: 502 },
		);
	}
}

async function importProviderNativeSession(
	request: Request,
	dependencies: AcpRouteDependencies,
): Promise<Response> {
	const body = (await request.json().catch(() => null)) as {
		id?: unknown;
		providerSessionId?: unknown;
	} | null;
	if (
		typeof body?.id !== "string" ||
		body.id.length === 0 ||
		body.id.length > 128 ||
		typeof body.providerSessionId !== "string" ||
		body.providerSessionId.length === 0 ||
		body.providerSessionId.length > 512
	) {
		return Response.json(
			{ error: "a valid agent id and provider session id are required" },
			{ status: 400 },
		);
	}
	if (!dependencies.importSession) {
		return Response.json(
			{ error: "ACP provider session import is unavailable" },
			{ status: 503 },
		);
	}

	const revalidated = await resolveEnabledAcpItem(body.id, dependencies, true);
	if (revalidated.response) return revalidated.response;
	try {
		// Publish the freshly probed executable identity to live managers before
		// provider-native continuity is rebound in durable storage.
		await dependencies.syncRuntime?.();
	} catch {
		(dependencies.logSessionImportFailure ?? console.warn)(
			"[acp] Provider session import failed; internal diagnostics were redacted.",
		);
		return Response.json(
			{ error: "ACP provider session import failed" },
			{ status: 500 },
		);
	}
	// Runtime synchronization owns the authoritative materialized catalog. Read
	// it back so validation and the persisted digest use that exact identity.
	const resolved = await resolveEnabledAcpRuntime(body.id, dependencies);
	if (resolved.response) return resolved.response;
	const { config, item, cwd, options } = resolved;
	let providerSession: AcpProviderNativeSession | undefined;
	try {
		// Re-read provider-owned metadata instead of trusting a title, cwd, or
		// timestamp supplied by the browser. One initialized inspection process
		// scans a bounded provider cursor chain without loading any transcript.
		providerSession = await (
			dependencies.findSession ?? findAcpProviderSession
		)(options, cwd, body.providerSessionId);
	} catch (error) {
		if (error instanceof AcpSessionImportUnsupportedError) {
			return Response.json(
				{
					error:
						"The ACP agent can list provider sessions but cannot load or resume them",
				},
				{ status: 409 },
			);
		}
		if (error instanceof AcpSessionListUnsupportedError) {
			return Response.json(
				{ error: "The ACP agent does not advertise provider session listing" },
				{ status: 409 },
			);
		}
		(dependencies.logSessionImportFailure ?? console.warn)(
			"[acp] Provider session import validation failed; provider diagnostics were redacted.",
		);
		return Response.json(
			{ error: "ACP provider session import validation failed" },
			{ status: 502 },
		);
	}
	if (!providerSession) {
		return Response.json(
			{ error: "The provider session is not available in this workspace" },
			{ status: 404 },
		);
	}

	try {
		const runtimeProvider = new AcpProvider({
			...options,
			metadataCacheIdentity: acpRuntimeFingerprint(item, config),
		});
		const providerRuntimeIdentity = runtimeProvider.sessionContinuityIdentity;
		if (!providerRuntimeIdentity) {
			throw new Error("ACP runtime continuity identity is unavailable");
		}
		const result = await dependencies.importSession({
			agentId: item.id,
			providerId: item.providerId,
			providerLabel: item.name,
			providerSession,
			cwd,
			providerRuntimeIdentity,
		});
		if (
			typeof result.sessionId !== "string" ||
			result.sessionId.length === 0 ||
			result.sessionId.length > 512 ||
			typeof result.created !== "boolean" ||
			typeof result.rebound !== "boolean"
		) {
			throw new Error("ACP provider session import returned an invalid result");
		}
		return Response.json({
			sessionId: result.sessionId,
			created: result.created,
		});
	} catch {
		(dependencies.logSessionImportFailure ?? console.warn)(
			"[acp] Provider session import failed; internal diagnostics were redacted.",
		);
		return Response.json(
			{ error: "ACP provider session import failed" },
			{ status: 500 },
		);
	}
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
		if (url.pathname === "/acp/sessions" && request.method === "GET") {
			return listProviderNativeSessions(url, dependencies);
		}
		if (url.pathname === "/acp/sessions/import" && request.method === "POST") {
			return importProviderNativeSession(request, dependencies);
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
				agents: agents.map(
					({ runtimeExecutableEvidence: _runtimeEvidence, ...agent }) => ({
						...agent,
						env: {},
					}),
				),
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
