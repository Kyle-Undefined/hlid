import type {
	ModelInfo as SdkModelInfo,
	PermissionMode as SdkPermissionMode,
} from "@anthropic-ai/claude-agent-sdk";

type ClaudeAutoModeQuery = {
	setModel(model?: string): Promise<void>;
	setPermissionMode(mode: SdkPermissionMode): Promise<void>;
};

/**
 * Verify the CLI's effective Auto policy for each model the SDK explicitly
 * marks as Auto-capable. This is deliberately stricter than the metadata bit:
 * enterprise settings can disable Auto even when the model supports it.
 *
 * The caller owns an ephemeral metadata-only Query. Every attempt restores the
 * ordinary permission mode before moving on, and any rejection fails that model
 * closed. No prompt is yielded and no user turn is created.
 */
export async function probeClaudeAutoModeModels(
	q: ClaudeAutoModeQuery,
	models: readonly SdkModelInfo[],
): Promise<Set<string>> {
	const supported = new Set<string>();
	for (const model of models) {
		if (model.supportsAutoMode !== true) continue;
		if (await probeClaudeAutoModeModel(q, model.value)) {
			supported.add(model.value);
		}
	}
	try {
		await q.setModel(undefined);
	} catch {
		// The process is ephemeral; callers abort it after reading metadata.
	}
	return supported;
}

/** Transactionally test one exact model string against an initialized Query. */
export async function probeClaudeAutoModeModel(
	q: ClaudeAutoModeQuery,
	model: string,
): Promise<boolean> {
	let selected = false;
	let accepted = false;
	let restored = false;
	try {
		await q.setModel(model);
		selected = true;
		try {
			await q.setPermissionMode("auto");
			accepted = true;
		} finally {
			await q.setPermissionMode("default");
			restored = true;
		}
	} catch {
		// Rejection or a failed rollback makes this exact mode unusable.
	}
	return selected && accepted && restored;
}
