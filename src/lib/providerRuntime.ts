import { CLIPROXY_CODEX_PROVIDER_ID } from "./providerIds";

/** Providers that execute through Claude Code and therefore use Claude runtime behavior. */
export function isClaudeRuntimeProvider(providerId: string): boolean {
	return providerId === "claude" || providerId === CLIPROXY_CODEX_PROVIDER_ID;
}

/** Providers whose token usage should use Hlid's Codex pricing catalog. */
export function isCodexPricedProvider(providerId: string): boolean {
	return providerId === "codex" || providerId === CLIPROXY_CODEX_PROVIDER_ID;
}
