export const PROVIDER_CAPABILITY_CONTRACT_VERSION = 1 as const;

export type ProviderCapabilityScope =
	| "provider"
	| "account"
	| "host"
	| "model"
	| "workspace"
	| "session";

export type ProviderCapabilitySupport =
	| "advertised"
	| "not-advertised"
	| "unknown";

export type ProviderCapabilityIntegration =
	| "integrated"
	| "provider-native"
	| "not-integrated";

export type ProviderCapabilityReadiness =
	| "ready"
	| "gated"
	| "unavailable"
	| "unknown";

export type ProviderCapabilityMaturity =
	| "stable"
	| "beta"
	| "experimental"
	| "deprecated"
	| "removed"
	| "unknown";

export type ProviderCapabilityAvailability =
	| "available"
	| "provider-native"
	| "conditional"
	| "unavailable";

export type ProviderCapabilityEvidenceSource =
	| "hlid-adapter"
	| "provider-runtime"
	| "provider-sdk"
	| "provider-config"
	| "host-runtime";

/**
 * One bounded observation from a provider adapter. Support, Hlid integration,
 * and current readiness stay separate so an upstream feature is never
 * presented as usable merely because the provider advertises it.
 */
export type ProviderCapabilityEvidence = {
	id: string;
	label: string;
	scope: ProviderCapabilityScope;
	support: ProviderCapabilitySupport;
	integration: ProviderCapabilityIntegration;
	readiness: ProviderCapabilityReadiness;
	source: ProviderCapabilityEvidenceSource;
	maturity?: ProviderCapabilityMaturity;
	operations?: string[];
	reason?: string;
};

export type ProviderCapabilityDiscovery = {
	observedAt: number;
	/** Effective provider-visible workspace used by workspace-scoped probes. */
	context?: { cwd: string };
	evidence: ProviderCapabilityEvidence[];
	issues?: string[];
};

export type ProviderCapabilityDescriptor = ProviderCapabilityEvidence & {
	availability: ProviderCapabilityAvailability;
};

export type ProviderCapabilitySnapshot = {
	contractVersion: typeof PROVIDER_CAPABILITY_CONTRACT_VERSION;
	providerId: string;
	status: "current" | "stale" | "partial" | "unavailable";
	source: "live" | "memory" | "persisted" | "fallback" | "adapter";
	revision: string;
	observedAt: number;
	/** Workspace used for workspace-scoped provider discovery, when applicable. */
	context?: { cwd: string };
	capabilities: ProviderCapabilityDescriptor[];
	issues?: string[];
};
