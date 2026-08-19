const GENERATED_MEDIA_TOOL_NAMES = new Set([
	"ImageGeneration",
	"imageGeneration",
]);

const VISUALIZATION_TOOL_NAMES = new Set([
	"create_visualization",
	"hlid.create_visualization",
	"mcp__hlid__create_visualization",
]);

const PROJECT_PREVIEW_TOOL_SUFFIXES = [
	"open_web_browser",
	"inspect_web_browser",
	"capture_web_browser",
	"control_web_browser",
	"start_web_browser_recording",
	"stop_web_browser_recording",
	"stop_web_browser",
	"start_project_preview",
	"inspect_project_preview",
	"capture_project_preview",
	"control_project_preview",
	"stop_project_preview",
] as const;

const OBSIDIAN_MUTATION_TOOL_SUFFIXES = [
	"create_note",
	"capture_note",
	"append_note",
	"prepend_note",
	"replace_note_text",
	"patch_note",
	"move_file",
	"rename_file",
	"trash_file",
	"base_create",
	"task_update",
	"property_set",
	"property_remove",
	"run_command",
] as const;

const HLID_DELEGATION_TOOL_SUFFIXES = [
	"delegate_hlid_agent",
	"list_hlid_agents",
	"inspect_hlid_agent",
	"wait_hlid_agent",
	"steer_hlid_agent",
	"cancel_hlid_agent",
	"cleanup_hlid_worktree",
	"resume_hlid_agent",
] as const;

function hasNamespacedSuffix(name: string, suffix: string): boolean {
	const normalized = name.toLowerCase();
	return (
		normalized === suffix ||
		normalized.endsWith(`__${suffix}`) ||
		normalized.endsWith(`.${suffix}`) ||
		normalized.endsWith(`/${suffix}`) ||
		normalized.endsWith(`:${suffix}`)
	);
}

export function isGeneratedMediaToolName(name: string): boolean {
	return GENERATED_MEDIA_TOOL_NAMES.has(name);
}

export function isHlidVisualizationToolName(name: string): boolean {
	return VISUALIZATION_TOOL_NAMES.has(name);
}

export function isProjectPreviewToolName(name: string): boolean {
	return PROJECT_PREVIEW_TOOL_SUFFIXES.some((suffix) => name.endsWith(suffix));
}

export function isObsidianMutationToolName(name: string): boolean {
	return OBSIDIAN_MUTATION_TOOL_SUFFIXES.some((suffix) =>
		hasNamespacedSuffix(name, suffix),
	);
}

export function isHlidDelegationToolName(name: string): boolean {
	return HLID_DELEGATION_TOOL_SUFFIXES.some((suffix) => name.endsWith(suffix));
}

/** Tool names whose durable transcript presentation depends on full response context. */
export function isTranscriptPagingSpecialToolName(name: string): boolean {
	return (
		isGeneratedMediaToolName(name) ||
		isHlidVisualizationToolName(name) ||
		isProjectPreviewToolName(name) ||
		isObsidianMutationToolName(name) ||
		isHlidDelegationToolName(name)
	);
}
