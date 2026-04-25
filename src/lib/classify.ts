export type StatusVocabulary = {
	active: string[];
	planning: string[];
	done: string[];
};

export type ProjectStatus = "active" | "planning" | "done" | "unknown";

export function classifyStatus(
	raw: string | undefined,
	vocab: StatusVocabulary,
): ProjectStatus {
	if (!raw) return "unknown";
	const lower = raw.toLowerCase();
	if (vocab.active.some((v) => v.toLowerCase() === lower)) return "active";
	if (vocab.planning.some((v) => v.toLowerCase() === lower)) return "planning";
	if (vocab.done.some((v) => v.toLowerCase() === lower)) return "done";
	return "unknown";
}
