export const HLID_CONTEXT_CONTRACT_VERSION = 1 as const;
export const HLID_AGENT_TOOL_COUNT = 30;
export const HLID_OBSIDIAN_TOOL_COUNT = 28;
export const HLID_WINDOWS_COMPUTER_USE_TOOL = "windows_computer_use";
export const HLID_CREATE_VISUALIZATION_TOOL = "create_visualization";

export type HlidContextBlockKind =
	| "operating_brief"
	| "workspace_instruction"
	| "attachments"
	| "vault"
	| "vault_references"
	| "workspace_references"
	| "skills"
	| "delegation_context"
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

/** Bounded native ACP blocks delivered beside the textual provider prompt. */
export type HlidStructuredPromptSummary = {
	imageCount: number;
	imageDecodedBytes: number;
	embeddedResourceCount: number;
	embeddedResourceChars: number;
};

type HlidStructuredPromptContent =
	| { type: "image"; data: string }
	| { type: "resource"; text?: string; blob?: string };

function decodedBase64Bytes(data: string): number {
	const normalized = data.replace(/\s/g, "");
	if (normalized.length === 0) return 0;
	const padding = normalized.endsWith("==")
		? 2
		: normalized.endsWith("=")
			? 1
			: 0;
	return Math.max(0, Math.floor((normalized.length * 3) / 4) - padding);
}

/** Summarize only the native blocks a provider reports it will dispatch. */
export function summarizeHlidStructuredPrompt(
	content: readonly HlidStructuredPromptContent[],
): HlidStructuredPromptSummary | undefined {
	const summary: HlidStructuredPromptSummary = {
		imageCount: 0,
		imageDecodedBytes: 0,
		embeddedResourceCount: 0,
		embeddedResourceChars: 0,
	};
	for (const block of content) {
		if (block.type === "image") {
			summary.imageCount += 1;
			summary.imageDecodedBytes += decodedBase64Bytes(block.data);
			continue;
		}
		summary.embeddedResourceCount += 1;
		summary.embeddedResourceChars += block.text?.length ?? 0;
	}
	return summary.imageCount > 0 || summary.embeddedResourceCount > 0
		? summary
		: undefined;
}

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
	/** Optional so persisted v1 receipts from before structured ACP prompts still parse. */
	structuredPrompt?: HlidStructuredPromptSummary;
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

export function buildHlidToolLoadingSummary(
	namespace: HlidToolLoadingSummary["namespace"],
	tools: readonly HlidToolLoadingItem[],
): HlidToolLoadingSummary {
	return {
		namespace,
		total: tools.length,
		deferred: tools.filter((tool) => tool.delivery === "deferred").length,
		tools: [...tools],
	};
}

export type HlidTurnContextManifest = HlidPromptContextManifest & {
	recordedAt: number;
	delivery: "chat" | "provider-command" | "steer";
	providerId: string;
	model?: string;
	effort?: string;
	permissionMode?: string;
	/** Characters in the textual provider prompt; native ACP blocks are summarized separately. */
	providerPromptChars: number;
	providerHandoffChars: number;
	toolLoading: HlidToolLoadingSummary[];
};

export type HlidContextReceipt = {
	seq: number;
	timestamp: number;
	turnNumber?: number;
	turnId?: string;
	messagePreview?: string;
	context: HlidTurnContextManifest;
};

export type HlidContextReceiptTarget = {
	seq?: number;
	turnId?: string;
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
