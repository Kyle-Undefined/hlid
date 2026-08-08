import type { Settings as SdkSettings } from "@anthropic-ai/claude-agent-sdk";

/**
 * Hlid owns the visible session and approval lifecycle around Claude. Refuse
 * peer-session delivery by default; the live Raven session may explicitly use
 * `hold` only when its peer inbox and dedicated continuation consumer are
 * active. Hlid never enables automatic peer acceptance. Leave forwarded
 * dialogs parked until Hlid resolves them instead of allowing Claude's remote
 * dialog timeout to cancel them.
 *
 * Every Hlid-owned Claude SDK process, including metadata-only probes, must use
 * this helper so auxiliary launches cannot drift outside that boundary.
 */
export function buildHlidClaudeSettings(
	disabledMcpjsonServers: string[] = [],
	crossSessionInbound: "refuse" | "hold" = "refuse",
): SdkSettings {
	return {
		crossSessionInbound,
		dialogExpiry: "never",
		...(disabledMcpjsonServers.length ? { disabledMcpjsonServers } : {}),
	};
}
