import type {
	HlidPromptContextManifest,
	HlidToolLoadingSummary,
	HlidTurnContextManifest,
} from "../lib/hlidContext";
import {
	HLID_AGENT_TOOL_COUNT,
	HLID_OBSIDIAN_TOOL_COUNT,
} from "../lib/hlidContext";
import {
	isClaudeRuntimeProvider,
	isCodexRuntimeProvider,
} from "../lib/providerRuntime";

function supportsDeferredHlidTools(providerId: string): boolean {
	return (
		isClaudeRuntimeProvider(providerId) || isCodexRuntimeProvider(providerId)
	);
}

export function hlidToolLoadingSummary(
	providerId: string,
): HlidToolLoadingSummary[] {
	const supportsDeferred = supportsDeferredHlidTools(providerId);
	return [
		{
			namespace: "hlid",
			total: HLID_AGENT_TOOL_COUNT,
			deferred: supportsDeferred ? HLID_AGENT_TOOL_COUNT : 0,
		},
		{
			namespace: "hlid_obsidian",
			total: HLID_OBSIDIAN_TOOL_COUNT,
			deferred: supportsDeferred ? HLID_OBSIDIAN_TOOL_COUNT : 0,
		},
	];
}

export function finalizeHlidTurnContextManifest(
	prompt: HlidPromptContextManifest,
	options: {
		delivery: HlidTurnContextManifest["delivery"];
		providerId: string;
		model?: string | null;
		effort?: string | null;
		permissionMode?: string | null;
		providerPromptChars: number;
		providerHandoffChars?: number;
		recordedAt?: number;
	},
): HlidTurnContextManifest {
	return {
		...prompt,
		recordedAt: options.recordedAt ?? Date.now(),
		delivery: options.delivery,
		providerId: options.providerId,
		...(options.model ? { model: options.model } : {}),
		...(options.effort ? { effort: options.effort } : {}),
		...(options.permissionMode
			? { permissionMode: options.permissionMode }
			: {}),
		providerPromptChars: options.providerPromptChars,
		providerHandoffChars: options.providerHandoffChars ?? 0,
		toolLoading: hlidToolLoadingSummary(options.providerId),
	};
}
