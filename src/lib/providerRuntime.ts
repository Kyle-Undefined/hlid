import { CLIPROXY_CODEX_PROVIDER_ID } from "./providerIds";

/** Providers that execute through Claude Code and therefore use Claude runtime behavior. */
export function isClaudeRuntimeProvider(providerId: string): boolean {
	return providerId === "claude" || providerId === CLIPROXY_CODEX_PROVIDER_ID;
}
