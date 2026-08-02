import {
	PROVIDER_APP_CONTRACT_VERSION,
	type ProviderAppAuthentication,
	type ProviderAppCatalogPage,
	type ProviderAppOAuthState,
} from "../lib/providerAppTypes";
import type {
	AppsInstalledResponse,
	AppsListResponse,
	ListMcpServerStatusResponse,
} from "./codexProtocol";

export type CodexAppAuthAttempt = {
	state: Exclude<ProviderAppOAuthState, "idle" | "complete">;
	startedAt: number;
	error?: string;
};

const AUTH_ATTEMPT_TIMEOUT_MS = 10 * 60_000;

function object(value: unknown): Record<string, unknown> {
	return value && typeof value === "object"
		? (value as Record<string, unknown>)
		: {};
}

function boundedText(value: unknown, max: number): string | undefined {
	if (typeof value !== "string") return undefined;
	const clean = value.trim();
	if (!clean) return undefined;
	return clean.slice(0, max);
}

function boundedList(value: unknown, maxItems = 20): string[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const items = value.flatMap((item) => {
		const text = boundedText(item, 120);
		return text ? [text] : [];
	});
	return items.length ? items.slice(0, maxItems) : undefined;
}

function list(value: unknown, keys: string[]): unknown[] {
	if (Array.isArray(value)) return value;
	const record = object(value);
	for (const key of keys) {
		if (Array.isArray(record[key])) return record[key] as unknown[];
	}
	return [];
}

function oauthState(
	attempt: CodexAppAuthAttempt | undefined,
	ready: boolean,
	now: number,
): ProviderAppOAuthState {
	if (!attempt) return "idle";
	if (ready) return "complete";
	if (attempt.state === "failed") return "failed";
	return now - attempt.startedAt >= AUTH_ATTEMPT_TIMEOUT_MS
		? "failed"
		: "pending";
}

function authenticationForApp(input: {
	installed: boolean;
	callable: boolean;
	isAccessible: boolean | undefined;
	canAuthenticate: boolean;
}): ProviderAppAuthentication {
	if (input.callable) return "ready";
	if (input.canAuthenticate && input.isAccessible === false) return "required";
	if (input.installed && input.canAuthenticate) return "required";
	return "unknown";
}

function appReason(input: {
	installed: boolean;
	configured: boolean;
	callable: boolean;
	authentication: ProviderAppAuthentication;
}): string | undefined {
	if (!input.installed) {
		return input.authentication === "required"
			? "Connect this app to the active provider account before it can be used."
			: "This app is available but is not installed for the active provider account.";
	}
	if (!input.configured)
		return "Disabled by the effective provider configuration.";
	if (input.authentication === "required") return "Authentication is required.";
	if (!input.callable) {
		return "The provider did not expose a callable model-visible tool. Authentication or policy may still gate this app.";
	}
	return undefined;
}

function mapApp(input: {
	raw: unknown;
	installed?: Record<string, unknown>;
	attempt?: CodexAppAuthAttempt;
	now: number;
}) {
	const raw = object(input.raw);
	const installed = input.installed;
	const id = boundedText(raw.id, 240) ?? "";
	const name =
		boundedText(raw.name, 160) ??
		boundedText(installed?.runtimeName, 160) ??
		id;
	const isInstalled = Boolean(installed);
	const configured = installed
		? installed.enabled !== false
		: raw.isEnabled !== false;
	const callable = installed?.callable === true;
	const canAuthenticate = Boolean(boundedText(raw.installUrl, 4_096));
	const authentication = authenticationForApp({
		installed: isInstalled,
		callable,
		isAccessible:
			typeof raw.isAccessible === "boolean" ? raw.isAccessible : undefined,
		canAuthenticate,
	});
	const usable = isInstalled && configured && callable;
	const readiness = !isInstalled
		? ("not-installed" as const)
		: !configured
			? ("disabled" as const)
			: authentication === "required"
				? ("needs-auth" as const)
				: usable
					? ("usable" as const)
					: ("unknown" as const);
	const reason = appReason({
		installed: isInstalled,
		configured,
		callable,
		authentication,
	});
	return {
		id,
		name,
		...(boundedText(raw.description, 500)
			? { description: boundedText(raw.description, 500) }
			: {}),
		available: true,
		installed: isInstalled,
		configured,
		authentication,
		usable,
		readiness,
		canAuthenticate,
		oauthState: oauthState(input.attempt, usable, input.now),
		...(reason ? { reason } : {}),
		...(boundedText(raw.distributionChannel, 120)
			? { distributionChannel: boundedText(raw.distributionChannel, 120) }
			: {}),
		...(boundedList(raw.pluginDisplayNames)
			? { pluginDisplayNames: boundedList(raw.pluginDisplayNames) }
			: {}),
	};
}

function connectorAuthentication(raw: unknown): ProviderAppAuthentication {
	switch (raw) {
		case "notLoggedIn":
			return "required";
		case "bearerToken":
		case "oAuth":
			return "ready";
		case "unsupported":
			return "not-required";
		default:
			return "unknown";
	}
}

function countObject(value: unknown): number {
	return value && typeof value === "object" && !Array.isArray(value)
		? Object.keys(value).length
		: 0;
}

export function mapCodexAppCatalogPage(input: {
	providerId: string;
	cwd: string;
	sessionId?: string;
	appsResponse: unknown;
	installedResponse: unknown;
	mcpResponse: unknown;
	cursor?: string;
	authAttempts?: ReadonlyMap<string, CodexAppAuthAttempt>;
	issues?: string[];
	now?: number;
}): ProviderAppCatalogPage {
	const now = input.now ?? Date.now();
	const appsResponse = object(input.appsResponse) as Partial<AppsListResponse>;
	const installedResponse = object(
		input.installedResponse,
	) as Partial<AppsInstalledResponse>;
	const mcpResponse = object(
		input.mcpResponse,
	) as Partial<ListMcpServerStatusResponse>;
	const installed = new Map<string, Record<string, unknown>>();
	for (const value of list(installedResponse.apps, ["apps", "data"])) {
		const item = object(value);
		const id = boundedText(item.id, 240);
		if (id) installed.set(id, item);
	}
	const seen = new Set<string>();
	const apps = list(appsResponse.data, ["data", "apps"]).flatMap((value) => {
		const item = object(value);
		const id = boundedText(item.id, 240);
		if (!id || seen.has(id)) return [];
		seen.add(id);
		return [
			mapApp({
				raw: item,
				installed: installed.get(id),
				attempt: input.authAttempts?.get(`app:${id}`),
				now,
			}),
		];
	});
	if (!input.cursor) {
		for (const [id, runtime] of installed) {
			if (seen.has(id)) continue;
			apps.unshift(
				mapApp({
					raw: { id, name: runtime.runtimeName },
					installed: runtime,
					attempt: input.authAttempts?.get(`app:${id}`),
					now,
				}),
			);
		}
	}
	const connectors = list(mcpResponse.data, ["data", "servers"]).flatMap(
		(value) => {
			const item = object(value);
			const id = boundedText(item.name ?? item.serverName, 240);
			if (!id) return [];
			const authentication = connectorAuthentication(item.authStatus);
			const toolCount = countObject(item.tools);
			const resourceCount = Array.isArray(item.resources)
				? item.resources.length
				: 0;
			const resourceTemplateCount = Array.isArray(item.resourceTemplates)
				? item.resourceTemplates.length
				: 0;
			const usable = authentication !== "required" && toolCount > 0;
			const attempt = input.authAttempts?.get(`mcp:${id}`);
			const reason =
				authentication === "required"
					? "Authentication is required."
					: toolCount === 0
						? "No callable tools are currently reported."
						: undefined;
			return [
				{
					id,
					name:
						boundedText(object(item.serverInfo).title, 160) ??
						boundedText(object(item.serverInfo).name, 160) ??
						id,
					authentication,
					usable,
					canAuthenticate: authentication === "required",
					oauthState: oauthState(attempt, usable, now),
					toolCount,
					resourceCount,
					resourceTemplateCount,
					...(reason ? { reason } : {}),
				},
			];
		},
	);
	const nextCursor = boundedText(appsResponse.nextCursor, 500) ?? null;
	const issues = (input.issues ?? [])
		.map((issue) => issue.slice(0, 300))
		.slice(0, 10);
	return {
		contractVersion: PROVIDER_APP_CONTRACT_VERSION,
		providerId: input.providerId.slice(0, 120),
		status: issues.length ? "partial" : "current",
		observedAt: now,
		scope: {
			providerId: input.providerId.slice(0, 120),
			account: "active-provider-account",
			host: "current-hlid-host",
			workspace: input.cwd.slice(0, 4_096),
			sessionId: input.sessionId?.slice(0, 240) ?? null,
		},
		apps,
		connectors,
		installedCount: installed.size,
		usableCount: [...installed.values()].filter(
			(item) => item.enabled !== false && item.callable === true,
		).length,
		missingAuthenticationCount:
			apps.filter((app) => app.installed && app.authentication === "required")
				.length +
			connectors.filter((connector) => connector.authentication === "required")
				.length,
		returned: apps.length,
		nextCursor,
		truncated: nextCursor !== null,
		...(issues.length ? { issues } : {}),
	};
}
