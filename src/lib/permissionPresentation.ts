const TOOL_LABELS: Record<string, string> = {
	bash: "Shell command",
	edit: "Edit file",
	glob: "Find files",
	grep: "Search files",
	read: "Read file",
	skill: "Use skill",
	structuredoutput: "Structured output",
	task: "Start subagent",
	toolsearch: "Tool search",
	webfetch: "Open web page",
	websearch: "Search the web",
	workflow: "Workflow",
	write: "Write file",
};

function identifierWords(value: string): string {
	return value
		.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
		.replace(/[_-]+/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

/** Human-facing action label for a provider or MCP tool identifier. */
export function permissionToolDisplayName(toolName: string): string {
	if (toolName.startsWith("hlid.windows_computer_use")) {
		return "Windows Computer Use";
	}
	const direct = TOOL_LABELS[toolName.toLowerCase()];
	if (direct) return direct;
	const finalSegment = toolName.split("__").filter(Boolean).at(-1) ?? toolName;
	const words = identifierWords(finalSegment);
	if (!words) return "Tool action";
	return words.charAt(0).toUpperCase() + words.slice(1).toLowerCase();
}

/** Concise policy copy; the exact engine reason remains available in Details. */
export function permissionPolicySummary(reason: string): string {
	const normalized = reason.trim();
	if (/no matching rule/i.test(normalized)) {
		return "No Umbod rule matched, so the default policy requires approval.";
	}
	if (/matched.+(?:approve|approval)/i.test(normalized)) {
		return "An Umbod policy rule requires approval for this action.";
	}
	return "Umbod requires approval before this action can run.";
}

const PREVIEW_KEYS = [
	"command",
	"task",
	"query",
	"file_path",
	"path",
	"url",
	"target",
	"prompt",
	"pattern",
	"name",
] as const;

/** Pick a useful action preview without leaking hook/session identifiers. */
export function permissionInputPreview(
	input: Record<string, unknown> | undefined,
	toolName: string,
): string | undefined {
	if (!input) return undefined;
	for (const key of PREVIEW_KEYS) {
		const value = input[key];
		if (typeof value === "string" && value.trim()) return value;
	}
	if (toolName.endsWith("__run_command")) {
		const commandId = input.id;
		if (typeof commandId === "string" && commandId.trim()) return commandId;
	}
	return undefined;
}
