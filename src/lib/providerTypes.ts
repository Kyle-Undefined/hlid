/**
 * UI-facing provider shapes shared between server fns and components.
 * Kept separate from the createServerFn modules so components that only
 * need the types don't depend on the fetch layer.
 */
export type ProviderInfo = {
	id: string;
	label: string;
	available: boolean;
	unavailableReason?: string;
	/**
	 * Models the provider supports. Use to populate model picker in UI.
	 * Strict superset of the original `{value,label}` shape — additive fields
	 * (`description`/`isDefault`/`hidden`/`efforts`) come from the live model
	 * catalog (see ProviderModelInfo in server/agentProvider.ts) when available.
	 */
	models?: Array<{
		value: string;
		label: string;
		description?: string;
		isDefault?: boolean;
		hidden?: boolean;
		efforts?: Array<{
			value: string;
			label: string;
			desc?: string;
			isDefault?: boolean;
		}>;
	}>;
	/** Effort/thinking levels. Absent if the provider has no such concept. */
	effortLevels?: Array<{ value: string; label: string; desc?: string }>;
	/** Permission gate modes the provider honours. */
	permissionModes?: Array<{ value: string; label: string; desc?: string }>;
};

/** Account info for the authenticated agent backing a live claude session. */
export type AccountInfo = {
	email?: string;
	organization?: string;
	subscriptionType?: string;
};
