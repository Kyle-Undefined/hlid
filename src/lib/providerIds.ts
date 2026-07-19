export const CLIPROXY_CODEX_PROVIDER_ID = "cliproxy-codex";
export const CLIPROXY_CODEX_HARNESS_PROVIDER_ID = "cliproxy:codex";
export const CLIPROXY_OPENCODE_PROVIDER_ID = "cliproxy:opencode";

export function isCliProxyProvider(providerId: string): boolean {
	return (
		providerId === CLIPROXY_CODEX_PROVIDER_ID ||
		providerId.startsWith("cliproxy:")
	);
}
