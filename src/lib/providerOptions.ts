/**
 * Pure, client-safe helpers for deriving model/effort option lists from a
 * ProviderInfo. Centralizes the "hidden model filtering" + "per-model effort
 * catalog with provider-level fallback" logic so every picker (vault-level
 * ClaudeSection, per-agent AgentCard/AddAgentPanel) stays in sync.
 */
import type { AgentListItem, ProviderInfo } from "./serverFns";

type ModelOptions = NonNullable<ProviderInfo["models"]>;
type EffortOption = {
	value: string;
	label: string;
	desc?: string;
	isDefault?: boolean;
};

/** Models the provider exposes for picking, with `hidden: true` entries filtered out. */
export function modelOptions(p: ProviderInfo | undefined): ModelOptions {
	return (p?.models ?? []).filter((m) => m.hidden !== true);
}

/**
 * Effort options for the currently selected model: the model's own declared
 * `efforts` if present, else the provider-level `effortLevels`, else [].
 */
export function effortOptionsFor(
	p: ProviderInfo | undefined,
	modelValue: string,
): EffortOption[] {
	const model = p?.models?.find((m) => m.value === modelValue);
	return model?.efforts ?? p?.effortLevels ?? [];
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
