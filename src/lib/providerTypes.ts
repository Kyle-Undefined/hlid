/**
 * UI-facing provider shapes shared between server fns and components.
 * Kept separate from the createServerFn modules so components that only
 * need the types don't depend on the fetch layer.
 */
import type { ProviderCapabilitySnapshot } from "./providerCapabilityTypes";

export type ProviderPermissionProfile = {
	id: string;
	label: string;
	description?: string;
	allowed: boolean;
};

export type ProviderInfo = {
	id: string;
	label: string;
	available: boolean;
	unavailableReason?: string;
	/**
	 * Models the provider supports. Use to populate model picker in UI.
	 * Strict superset of the original `{value,label}` shape — additive fields
	 * (`description`/`isDefault`/`hidden`/`inputModalities`/`efforts`/
	 * `serviceTiers`) come
	 * from the live model catalog (see ProviderModelInfo in
	 * server/agentProvider.ts) when available.
	 */
	models?: Array<{
		value: string;
		label: string;
		resolvedModel?: string;
		description?: string;
		isDefault?: boolean;
		hidden?: boolean;
		supportsAutoMode?: boolean;
		inputModalities?: Array<"text" | "image" | "audio">;
		efforts?: Array<{
			value: string;
			label: string;
			desc?: string;
			isDefault?: boolean;
		}>;
		serviceTiers?: Array<{
			value: string;
			label: string;
			desc?: string;
			isDefault?: boolean;
		}>;
	}>;
	/** Result of an explicit provider model refresh. Omitted on cached navigation reads. */
	modelCatalogRefresh?: {
		status: "current" | "stale" | "unavailable";
		source: "live" | "memory" | "persisted" | "fallback";
		reason?: string;
	};
	/** Effort/thinking levels. Absent if the provider has no such concept. */
	effortLevels?: Array<{ value: string; label: string; desc?: string }>;
	/** Permission gate modes the provider honours. */
	permissionModes?: Array<{ value: string; label: string; desc?: string }>;
	/** Provider-native named permission profiles available for this workspace. */
	permissionProfiles?: ProviderPermissionProfile[];
	/** Raven/delegation-only modes that must not leak into persistent config. */
	sessionPermissionModes?: Array<{
		value: string;
		label: string;
		desc?: string;
	}>;
	/** Provider-native reviewers available for interactive approval requests. */
	approvalReviewers?: Array<{
		value: "user" | "auto_review";
		label: string;
		desc?: string;
		isDefault?: boolean;
	}>;
	/** Provider-native session forking exposed through Hlid. */
	forkCapability?: {
		kind: "exact";
		/** Native identifier needed for a branch through one displayed turn. */
		cutoff?: "message" | "turn";
		wholeSession: true;
		throughMessage: boolean;
	};
	/** Host-only provider capabilities and their live readiness. */
	hostCapabilities?: Record<
		string,
		{ label: string; available: boolean; reason?: string }
	>;
	/** Provider-owned structured capability shape. */
	capabilities?: {
		goalControl?: boolean;
		structuredActivities?: ReadonlyArray<"compact" | "review">;
		workflowCatalog?: boolean;
		realtime?: boolean;
		appCatalog?: boolean;
		appAuthentication?: boolean;
		backgroundActivities?: {
			maturity: "experimental" | "beta" | "stable";
			operations: ReadonlyArray<
				"background" | "list" | "stop" | "terminate" | "clean"
			>;
		};
	};
	/** Bounded provider evidence resolved against Hlid's current integration. */
	capabilitySnapshot?: ProviderCapabilitySnapshot;
};

/** Account info for the authenticated agent backing a live claude session. */
export type AccountInfo = {
	email?: string;
	organization?: string;
	subscriptionType?: string;
};
