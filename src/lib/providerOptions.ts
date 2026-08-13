/**
 * Pure, client-safe helpers for deriving model/effort option lists from a
 * ProviderInfo. Centralizes the "hidden model filtering" + "per-model effort
 * catalog with provider-level fallback" logic so every picker (vault-level
 * ClaudeSection, per-agent AgentCard/AddAgentPanel) stays in sync.
 */

import type { HlidConfig } from "../config";
import { isCliProxyProvider } from "./providerIds";
import type { ProviderInfo } from "./providerTypes";
import type { AgentListItem } from "./serverFns/agents";

type ModelOptions = NonNullable<ProviderInfo["models"]>;
type EffortOption = {
	value: string;
	label: string;
	desc?: string;
	isDefault?: boolean;
};

type PermissionOption = {
	value: string;
	label: string;
	desc?: string;
};

export type SessionPermissionOptionContext = {
	model: string | null | undefined;
	policyEnforced: boolean;
	usageGateEnforced: boolean;
};

export type ModelInputAvailability = {
	available: boolean;
	modelLabel?: string;
	reason?: string;
};

export type CodexRealtimeAvailability = {
	available: boolean;
	reason?: string;
};

export type CodexRealtimeBackendStatus = {
	available?: boolean;
	reason?: string;
};

/** Models the provider exposes for picking, with `hidden: true` entries filtered out. */
export function modelOptions(p: ProviderInfo | undefined): ModelOptions {
	return (p?.models ?? []).filter((m) => m.hidden !== true);
}

/** Resolve whether the active catalog model accepts a particular input kind. */
export function modelInputAvailability(
	p: ProviderInfo | undefined,
	modelValue: string | null | undefined,
	modality: "text" | "image" | "audio",
): ModelInputAvailability {
	if (!p) {
		return {
			available: false,
			reason: "The provider model catalog is still loading.",
		};
	}
	if (!p.available) {
		return {
			available: false,
			reason: p.unavailableReason ?? `${p.label} is unavailable.`,
		};
	}
	const visibleModels = modelOptions(p);
	const model = modelValue
		? p.models?.find((candidate) => candidate.value === modelValue)
		: (visibleModels.find((candidate) => candidate.isDefault) ??
			visibleModels[0]);
	if (!model) {
		return {
			available: false,
			reason: modelValue
				? `${modelValue} is not present in the current ${p.label} model catalog.`
				: `${p.label} did not report an active model.`,
		};
	}
	if (model.inputModalities?.includes(modality)) {
		return { available: true, modelLabel: model.label };
	}
	return {
		available: false,
		modelLabel: model.label,
		reason: model.inputModalities
			? `${model.label} does not support ${modality} input.`
			: `${model.label} has not reported ${modality} input support.`,
	};
}

/** Resolve whether any selectable model currently advertises an input kind. */
export function providerAdvertisesInput(
	p: ProviderInfo | undefined,
	modality: "text" | "image" | "audio",
): ModelInputAvailability {
	if (!p) {
		return {
			available: false,
			reason: "The provider model catalog is still loading.",
		};
	}
	if (!p.available) {
		return {
			available: false,
			reason: p.unavailableReason ?? `${p.label} is unavailable.`,
		};
	}
	const model = modelOptions(p).find((candidate) =>
		candidate.inputModalities?.includes(modality),
	);
	return model
		? { available: true, modelLabel: model.label }
		: {
				available: false,
				reason: `No selectable ${p.label} model advertises ${modality} input.`,
			};
}

/** Resolve whether Codex realtime dictation is viable from current Forge state. */
export function codexRealtimeAvailability(
	previewEnabled: boolean,
	provider: ProviderInfo | undefined,
	backend: CodexRealtimeBackendStatus | undefined,
): CodexRealtimeAvailability {
	if (!previewEnabled) {
		return {
			available: false,
			reason: "Enable Codex realtime Developer Preview to use Codex dictation.",
		};
	}
	if (!provider) {
		return {
			available: false,
			reason: "The Codex provider catalog is still loading.",
		};
	}
	if (!provider.available) {
		return {
			available: false,
			reason:
				provider.unavailableReason ??
				"The native Codex provider is unavailable.",
		};
	}
	if (provider.capabilities?.realtime !== true) {
		return {
			available: false,
			reason:
				"The current Codex provider does not advertise realtime conversation support.",
		};
	}
	if (backend?.available === false) {
		return {
			available: false,
			reason:
				backend.reason ??
				"Codex realtime voice is unavailable for the current account or backend.",
		};
	}
	return {
		available: true,
		...(backend?.available === undefined
			? {
					reason:
						"Account and backend support will be confirmed when Codex dictation starts.",
				}
			: {}),
	};
}

/**
 * Effort options for the currently selected model: the model's own declared
 * `efforts` if present. Provider-scoped runtimes may fall back to their global
 * list; model-scoped runtimes must advertise effort on the exact model.
 */
export function effortOptionsFor(
	p: ProviderInfo | undefined,
	modelValue: string,
	planMode = false,
): EffortOption[] {
	const model = p?.models?.find((m) => m.value === modelValue);
	const efforts =
		model?.efforts ?? (p?.effortScope === "model" ? [] : p?.effortLevels) ?? [];
	// Codex's native plan-mode override currently supports through xhigh.
	// Claude's plan workflow has no equivalent plan-specific ceiling.
	return planMode && p?.id === "codex"
		? efforts.filter(
				(effort) => effort.value !== "max" && effort.value !== "ultra",
			)
		: efforts;
}

/** Keep the Codex plan picker and the effort sent to app-server in sync. */
export function normalizeEffortForPlanMode(
	providerId: string,
	effort: string | null | undefined,
): string | null | undefined {
	return providerId === "codex" && (effort === "max" || effort === "ultra")
		? "xhigh"
		: effort;
}

/** The `isDefault` effort of the selected model, if any. */
export function defaultEffortFor(
	p: ProviderInfo | undefined,
	modelValue: string,
): string | undefined {
	const model = p?.models?.find((m) => m.value === modelValue);
	return model?.efforts?.find((e) => e.isDefault)?.value;
}

/**
 * Permission modes available to one Raven session. Claude's Auto mode is
 * deliberately fail-closed: the selected catalog row must carry affirmative
 * raw model capability for either its selectable alias or resolved model.
 * Effective settings and policy readiness remain a live mutation concern.
 *
 * Providers that do not distinguish persistent and session catalogs retain
 * their existing permission list through the compatibility fallback.
 */
export function sessionPermissionOptionsFor(
	p: ProviderInfo | undefined,
	context: SessionPermissionOptionContext,
): PermissionOption[] {
	const modes = p?.sessionPermissionModes ?? p?.permissionModes ?? [];
	return modes.filter((mode) => {
		if (mode.value === "dontAsk") {
			return p?.id === "claude" && !context.policyEnforced;
		}
		if (mode.value !== "auto") return true;
		if (
			p?.id !== "claude" ||
			context.policyEnforced ||
			context.usageGateEnforced ||
			!context.model
		) {
			return false;
		}
		return (
			p.models?.some(
				(model) =>
					(model.value === context.model ||
						model.resolvedModel === context.model) &&
					model.supportsAutoMode === true,
			) === true
		);
	});
}

/** Short, unambiguous permission labels used in compact live-session UI. */
export function permissionModeBadgeLabel(
	mode: string | null | undefined,
): string | null {
	if (!mode) return null;
	if (mode === "bypassPermissions") return "bypass";
	if (mode === "acceptEdits") return "edits";
	if (mode === "default") return "ask";
	if (mode === "dontAsk") return "pre-approved";
	if (mode === "auto") return "auto";
	return mode;
}

/**
 * The providerId a chat should use right now: the agent's own provider when
 * an agent skill context is active, else the vault's configured provider.
 * Used by raven's model/permission switcher to pick the right ProviderInfo
 * (models/permissionModes) out of the providers list depending on whether
 * the user is chatting in an agent context or the vault.
 */
export function resolveActiveProviderId(
	agentList: ReadonlyArray<Pick<AgentListItem, "path" | "provider">>,
	agentSkillContext: string | undefined,
	vaultProviderId: string,
): string {
	if (!agentSkillContext) return vaultProviderId;
	const agent = agentList.find((a) => a.path === agentSkillContext);
	return agent?.provider ?? vaultProviderId;
}

/** Model explicitly configured for the vault's provider (never live-session state). */
export function configuredVaultModel(config: HlidConfig): string | null {
	if (config.vault_provider === "codex") return config.codex?.model || null;
	if (isCliProxyProvider(config.vault_provider)) {
		return config.cliproxy.model || null;
	}
	if (config.vault_provider === "claude") return config.claude?.model || null;
	return null;
}
