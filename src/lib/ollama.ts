export const OLLAMA_INFERENCE_RELAY_PORT = 11435;
export const OPENCODE_LOCAL_MODEL_MIN_CONTEXT = 65_536;
export const OLLAMA_KEEP_WARM_POLICIES = ["5m", "30m", "session"] as const;
export type OllamaKeepWarmPolicy = (typeof OLLAMA_KEEP_WARM_POLICIES)[number];
export const DEFAULT_OLLAMA_KEEP_WARM_POLICY: OllamaKeepWarmPolicy = "5m";

/** Native Ollama keep_alive value used for a Hlid-managed OpenCode runtime. */
export function ollamaKeepAliveValue(
	policy: OllamaKeepWarmPolicy,
): "5m" | "30m" | -1 {
	return policy === "session" ? -1 : policy;
}
/**
 * OpenCode requires an explicit output limit whenever a custom model declares
 * a context limit. Keep enough of the fixed 65,536-token window available for
 * the prompt and tool history while still allowing substantial generations.
 */
export const OPENCODE_LOCAL_MODEL_OUTPUT_LIMIT = 8_192;
export const OLLAMA_MAX_CONTEXT_LENGTH = 4 * 1024 * 1024;

export function ollamaModelNameHasWhitespaceOrControl(value: string): boolean {
	return [...value].some((character) => {
		const code = character.codePointAt(0) ?? 0;
		return /\s/.test(character) || code < 0x20 || code === 0x7f;
	});
}

/**
 * OpenCode launch preparation can include bounded Ollama inspection, WSL
 * network discovery, Windows firewall verification, and a relay probe.
 */
export const OLLAMA_OPENCODE_ACP_PREPARATION_TIMEOUT_MS = 60_000;
/** Leave room for preparation plus ACP spawn, initialization, and discovery. */
export const OLLAMA_OPENCODE_ACP_INSPECTION_TIMEOUT_MS = 90_000;
