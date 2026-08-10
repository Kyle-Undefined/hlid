export type AcpModelVisibilityFilter = {
	mode: "hide" | "only";
	models: readonly string[];
};

/** Empty/provider-default selections remain valid; explicit models obey the filter. */
export function acpModelVisible(
	model: string | null | undefined,
	filter: AcpModelVisibilityFilter | null | undefined,
): boolean {
	if (!filter || !model) return true;
	const selected = filter.models.includes(model);
	return filter.mode === "hide" ? !selected : selected;
}

export function openCodeModelVisible(
	providerId: string,
	model: string | null | undefined,
	filter: AcpModelVisibilityFilter | null | undefined,
): boolean {
	return providerId !== "acp:opencode" || acpModelVisible(model, filter);
}
