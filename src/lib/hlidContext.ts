export const HLID_CONTEXT_CONTRACT_VERSION = 1 as const;
export const HLID_AGENT_TOOL_COUNT = 8;
export const HLID_OBSIDIAN_TOOL_COUNT = 28;
export const HLID_WINDOWS_COMPUTER_USE_TOOL = "windows_computer_use";

export type HlidContextBlockKind =
	| "operating_brief"
	| "workspace_instruction"
	| "attachments"
	| "vault"
	| "vault_references"
	| "workspace_references"
	| "skills"
	| "plan";

export type HlidContextBlock = {
	kind: HlidContextBlockKind;
	chars: number;
	count: number;
};

export type HlidVaultContextReference = {
	path: string;
	delivery: "inline" | "inline-truncated" | "metadata" | "unavailable";
	includedChars: number;
	sourceChars?: number;
	error?: string;
};

export type HlidWorkspaceContextReference = {
	path: string;
	mime: string;
	environment: string;
	sha256: string;
};

export type HlidContextAttachment = {
	filename: string;
	mime: string;
	delivery: "native" | "path";
};

export type HlidPromptContextManifest = {
	contractVersion: typeof HLID_CONTEXT_CONTRACT_VERSION;
	userMessageChars: number;
	promptChars: number;
	hlidAddedChars: number;
	estimatedHlidTokens: number;
	blocks: HlidContextBlock[];
	vaultName?: string;
	agentMode: "cwd" | "context";
	agentCwd?: string;
	runtimeCwd?: string;
	instructionFile?: string;
	skills: string[];
	attachments: HlidContextAttachment[];
	vaultReferences: HlidVaultContextReference[];
	workspaceReferences: HlidWorkspaceContextReference[];
	planHtml: boolean;
	operatingBrief?: {
		version: number;
		briefRevision?: string;
		/** Legacy pre-0.1 context receipts used a capability-registry fingerprint here. */
		registryRevision?: string;
		/** Small Hlid-owned brief retained so /context can show what was established. */
		preview?: string;
		included: boolean;
		delivery?: "included" | "already-established" | "not-delivered";
		chars: number;
	};
};

export type HlidToolLoadingItem = {
	name: string;
	delivery: "loaded" | "deferred";
};

export type HlidToolLoadingSummary = {
	namespace: "hlid" | "hlid_obsidian";
	total: number;
	deferred: number;
	/** Optional for receipts created before detailed tool inventory shipped. */
	tools?: HlidToolLoadingItem[];
};

export function describeHlidToolLoading(
	tools: readonly { name: string; deferLoading: boolean }[],
	supportsDeferred: boolean,
): HlidToolLoadingItem[] {
	return tools.map((tool) => ({
		name: tool.name,
		delivery:
			supportsDeferred && tool.deferLoading
				? ("deferred" as const)
				: ("loaded" as const),
	}));
}

export type HlidTurnContextManifest = HlidPromptContextManifest & {
	recordedAt: number;
	delivery: "chat" | "provider-command" | "steer";
	providerId: string;
	model?: string;
	effort?: string;
	permissionMode?: string;
	providerPromptChars: number;
	providerHandoffChars: number;
	toolLoading: HlidToolLoadingSummary[];
};

export function estimateContextTokens(chars: number): number {
	return Math.ceil(Math.max(0, chars) / 4);
}

export function parseHlidTurnContextManifest(
	raw: string | null | undefined,
): HlidTurnContextManifest | null {
	if (!raw) return null;
	try {
		const parsed = JSON.parse(raw) as Partial<HlidTurnContextManifest>;
		return parsed.contractVersion === HLID_CONTEXT_CONTRACT_VERSION
			? (parsed as HlidTurnContextManifest)
			: null;
	} catch {
		return null;
	}
}
