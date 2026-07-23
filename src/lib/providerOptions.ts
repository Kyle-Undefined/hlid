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

export type ModelInputAvailability = {
	available: boolean;
	modelLabel?: string;
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

/**
 * Effort options for the currently selected model: the model's own declared
 * `efforts` if present, else the provider-level `effortLevels`, else [].
 */
export function effortOptionsFor(
	p: ProviderInfo | undefined,
	modelValue: string,
	planMode = false,
): EffortOption[] {
	const model = p?.models?.find((m) => m.value === modelValue);
	const efforts = model?.efforts ?? p?.effortLevels ?? [];
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
