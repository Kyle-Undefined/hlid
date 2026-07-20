import {
	CLIPROXY_CODEX_HARNESS_PROVIDER_ID,
	CLIPROXY_CODEX_PROVIDER_ID,
} from "./providerIds";

/** Providers that execute through Claude Code and therefore use Claude runtime behavior. */
export function isClaudeRuntimeProvider(providerId: string): boolean {
	return providerId === "claude" || providerId === CLIPROXY_CODEX_PROVIDER_ID;
}

/** Providers that execute through Codex CLI and therefore use Codex wrappers. */
export function isCodexRuntimeProvider(providerId: string): boolean {
	return (
		providerId === "codex" || providerId === CLIPROXY_CODEX_HARNESS_PROVIDER_ID
	);
}
