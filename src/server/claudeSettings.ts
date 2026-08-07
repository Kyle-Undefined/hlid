import type { Settings as SdkSettings } from "@anthropic-ai/claude-agent-sdk";

/**
 * Hlid owns the visible session and approval lifecycle around Claude. Refuse
 * peer-session delivery so model-authored text cannot enter Raven as an
 * ordinary user prompt, and leave forwarded dialogs parked until Hlid resolves
 * them instead of allowing Claude's remote-dialog timeout to cancel them.
 *
 * Every Hlid-owned Claude SDK process, including metadata-only probes, must use
 * this helper so auxiliary launches cannot drift outside that boundary.
 */
export function buildHlidClaudeSettings(
	disabledMcpjsonServers: string[] = [],
): SdkSettings {
	return {
		crossSessionInbound: "refuse",
		dialogExpiry: "never",
		...(disabledMcpjsonServers.length ? { disabledMcpjsonServers } : {}),
	};
}
