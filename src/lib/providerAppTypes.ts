export const PROVIDER_APP_CONTRACT_VERSION = 1 as const;

export type ProviderAppAuthentication =
	| "ready"
	| "required"
	| "not-required"
	| "unknown";

export type ProviderAppReadiness =
	| "usable"
	| "needs-auth"
	| "disabled"
	| "not-installed"
	| "unavailable"
	| "unknown";

export type ProviderAppOAuthState = "idle" | "pending" | "complete" | "failed";

export type ProviderAppInventoryItem = {
	id: string;
	name: string;
	description?: string;
	available: boolean;
	installed: boolean;
	configured: boolean;
	authentication: ProviderAppAuthentication;
	usable: boolean;
	readiness: ProviderAppReadiness;
	canAuthenticate: boolean;
	oauthState: ProviderAppOAuthState;
	reason?: string;
	distributionChannel?: string;
	pluginDisplayNames?: string[];
};

export type ProviderConnectorInventoryItem = {
	id: string;
	name: string;
	authentication: ProviderAppAuthentication;
	usable: boolean;
	canAuthenticate: boolean;
	oauthState: ProviderAppOAuthState;
	toolCount: number;
	resourceCount: number;
	resourceTemplateCount: number;
	reason?: string;
};

export type ProviderAppCatalogScope = {
	providerId: string;
	account: "active-provider-account";
	host: "current-hlid-host";
	workspace: string;
	sessionId: string | null;
};

export type ProviderAppCatalogPage = {
	contractVersion: typeof PROVIDER_APP_CONTRACT_VERSION;
	providerId: string;
	status: "current" | "partial" | "unavailable";
	/** A provider refresh is running out of band; poll this same scope for the result. */
	refreshing?: boolean;
	observedAt: number;
	scope: ProviderAppCatalogScope;
	apps: ProviderAppInventoryItem[];
	connectors: ProviderConnectorInventoryItem[];
	installedCount: number;
	usableCount: number;
	missingAuthenticationCount: number;
	returned: number;
	nextCursor: string | null;
	truncated: boolean;
	issues?: string[];
	/** Presentation severity for provider-scoped catalog issues. Defaults to warning. */
	issueSeverity?: "info" | "warning";
};

export type ProviderAppCatalogRequest = {
	cwd: string;
	sessionId?: string;
	cursor?: string;
	limit?: number;
	refresh?: boolean;
};

export type ProviderAppAuthenticationRequest = {
	cwd: string;
	target: { kind: "app" | "mcp"; id: string };
};

export type ProviderAppAuthenticationStart = {
	opened: boolean;
};
