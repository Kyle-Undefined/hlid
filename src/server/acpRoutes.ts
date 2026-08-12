import { type HlidConfig, HlidConfigSchema } from "../config";
import { acpExecutionTargetLabel } from "../lib/acpExecutionTarget";
import { parseAcpManagedMutationRequest } from "../lib/acpManagedTypes";
import { AcpModelCatalogSchema } from "../lib/acpModelCatalog";
import { acpRuntimeIdentity } from "../lib/acpRuntimeIdentity";
import type { AcpManagedInstaller } from "./acpManagedInstall";
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
	acpDiscoveryCwd,
	acpRuntimeFingerprint,
	effectiveAcpEnvironment,
	OpenCodeConfigOverlayError,
} from "./acpRuntime";
import {
	type AcpExecutionTargetDescriptor,
	acpExecutionTargetId,
	configuredAcpExecutionTarget,
} from "./acpTargets";
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
	managedInstaller?: Pick<AcpManagedInstaller, "mutate"> &
		Partial<Pick<AcpManagedInstaller, "claimedTargets">>;
	managedMutationAuthorized?: (request: Request) => boolean;
	logManagedMutationFailure?: (message: string) => void;
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
	| {
			config: HlidConfig;
			item: AcpCatalogItem;
			configured: NonNullable<HlidConfig["acp_agents"]>[number] | undefined;
			response?: never;
	  }
	| { config?: never; item?: never; configured?: never; response: Response }
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
	return {
		config,
		item,
		configured: (config.acp_agents ?? []).find((agent) => agent.id === item.id),
	};
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
	const { config, configured, item } = resolved;
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
	const cwd = acpDiscoveryCwd(config, configured);
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
			target: configured?.target,
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
	const { config, configured, item } = resolved;
	const targetCwd = acpDiscoveryCwd(config, configured);
	try {
		const models = await (dependencies.inspectModels ?? inspectAcpModels)(
			{
				id: item.providerId,
				label: item.name,
				command: item.command,
				args: item.args,
				env: item.env,
				target: configured?.target,
				discoveryCwd: targetCwd,
				initialAvailability: { available: true },
			},
			targetCwd,
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

function managedMutationTarget(
	config: HlidConfig,
	action: "install" | "update" | "remove",
	agentId: string,
	targetId: string,
	dependencies: AcpRouteDependencies,
): AcpExecutionTargetDescriptor | null {
	const configured = configuredAcpExecutionTarget(config, targetId);
	if (configured || action !== "remove") return configured;
	const claim = dependencies.managedInstaller
		?.claimedTargets?.()
		.find(
			(candidate) =>
				candidate.agentId === agentId && candidate.targetId === targetId,
		);
	return claim
		? {
				targetId: claim.targetId,
				target: claim.target,
				label: acpExecutionTargetLabel(claim.target),
				cwd: claim.hostCwd,
				recommended: false,
			}
		: null;
}

async function mutateManagedAcpInstallation(
	request: Request,
	dependencies: AcpRouteDependencies,
): Promise<Response> {
	if (!dependencies.managedInstaller) {
		return Response.json(
			{ ok: false, error: "Managed ACP installation is unavailable" },
			{ status: 503 },
		);
	}
	if (
		dependencies.managedMutationAuthorized &&
		!dependencies.managedMutationAuthorized(request)
	) {
		return Response.json({ ok: false, error: "Forbidden" }, { status: 403 });
	}
	const parsed = await parseAcpManagedMutationRequest(request);
	if (!parsed.success) {
		return Response.json(
			{ ok: false, error: "A valid ACP installation action is required" },
			{ status: 400 },
		);
	}
	const config = dependencies.loadConfig();
	const descriptor = managedMutationTarget(
		config,
		parsed.data.action,
		parsed.data.agentId,
		parsed.data.targetId,
		dependencies,
	);
	const configured = (config.acp_agents ?? []).find(
		(agent) => agent.id === parsed.data.agentId,
	);
	if (!descriptor) {
		return Response.json(
			{ ok: false, error: "ACP execution target is not configured" },
			{ status: 404 },
		);
	}
	const item = (await dependencies.registry.catalog(config)).find(
		(agent) => agent.id === parsed.data.agentId,
	);
	const target = item?.targets.find(
		(candidate) => candidate.targetId === descriptor.targetId,
	);
	if (!item || !target) {
		return Response.json(
			{ ok: false, error: "ACP agent or execution target was not found" },
			{ status: 404 },
		);
	}
	if (parsed.data.revision !== target.mutationRevision) {
		return Response.json(
			{
				ok: false,
				error:
					"ACP installation details changed. Review the current version and confirm again.",
			},
			{ status: 409 },
		);
	}
	const allowed =
		parsed.data.action === "install"
			? target.canInstall
			: parsed.data.action === "update"
				? target.canUpdate
				: target.canRemove;
	if (!allowed) {
		return Response.json(
			{ ok: false, error: `ACP ${parsed.data.action} is no longer available` },
			{ status: 409 },
		);
	}
	const currentConfig = dependencies.loadConfig();
	const currentDescriptor = managedMutationTarget(
		currentConfig,
		parsed.data.action,
		parsed.data.agentId,
		parsed.data.targetId,
		dependencies,
	);
	const currentConfigured = (currentConfig.acp_agents ?? []).find(
		(agent) => agent.id === item.id,
	);
	const currentSelectedTargetId = currentConfigured
		? acpExecutionTargetId(currentConfigured.target ?? { kind: "host" })
		: undefined;
	if (
		!currentDescriptor ||
		JSON.stringify(currentDescriptor) !== JSON.stringify(descriptor) ||
		acpRuntimeIdentity(configured ? [configured] : []) !==
			acpRuntimeIdentity(currentConfigured ? [currentConfigured] : []) ||
		item.enabled !== Boolean(currentConfigured) ||
		(item.enabled && currentSelectedTargetId !== descriptor.targetId)
	) {
		return Response.json(
			{
				ok: false,
				error:
					"ACP configuration changed. Wait for the save to finish and confirm again.",
			},
			{ status: 409 },
		);
	}
	try {
		const job = dependencies.managedInstaller.mutate({
			action: parsed.data.action,
			agent: item,
			targetDescriptor: descriptor,
			platformTarget: target.platformTarget,
			enabled: item.enabled && target.selected,
		});
		void job.completion.catch((error) => {
			(dependencies.logManagedMutationFailure ?? console.warn)(
				`[acp] Managed ${parsed.data.action} failed: ${error instanceof Error ? error.message : String(error)}`,
			);
		});
		return Response.json({ ok: true, data: job.operation }, { status: 202 });
	} catch (error) {
		return Response.json(
			{
				ok: false,
				error: error instanceof Error ? error.message : String(error),
			},
			{ status: 409 },
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
						targets: (agent.targets ?? []).map(
							({ env: _env, ...target }) => target,
						),
					}),
				),
			});
		}
		if (url.pathname === "/acp/managed/mutate" && request.method === "POST") {
			return mutateManagedAcpInstallation(request, dependencies);
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
