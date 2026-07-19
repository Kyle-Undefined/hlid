/**
 * A single rate-limit window reading parsed from a provider's HTTP response headers.
 * Returned by AgentProvider.proxyConfig.parseHeaders and forwarded to DB + WS broadcast.
 */
export type ProviderWindowReading = {
	/** Stable identifier matching the settings key suffix, e.g. "five_hour", "weekly". */
	windowId: string;
	/** Short display label shown in the UI, e.g. "5-HOUR", "7-DAY". */
	label: string;
	/** Plan utilization 0–1 (Anthropic style). Null if provider doesn't expose this. */
	utilization: number | null;
	/** Tokens remaining in window (OpenAI/Google style). Null if not available. */
	remaining: number | null;
	/** Total token cap for the window. Null if not available. */
	limit: number | null;
	/** Unix epoch seconds when this window resets. Null if unknown. */
	resetsAt: number | null;
};

/** Exact live context occupancy reported by a provider control API. */
export type ProviderContextUsage = {
	contextTokens: number;
	contextWindow: number;
	model?: string;
};

/** Normalized MCP server status — compatible with protocol.ts mapMcpServer input. */
export type McpServerStatus = {
	name: string;
	status: "connected" | "failed" | "needs-auth" | "pending" | "disabled";
	scope?: string;
	error?: string;
};

/**
 * A slash command exposed by the underlying agent (e.g. /help, /usage).
 * Mirrors the SDK's SlashCommand shape but kept provider-agnostic here.
 */
export type SlashCommand = {
	name: string;
	description: string;
	argumentHint: string;
	aliases?: string[];
	/** Hlid capability action. Omitted commands are sent as provider-native prompts. */
	action?: "review" | "computer-use";
};

/** Provider-native skill metadata used by Hlid's review-before-import catalog. */
export type ProviderSkillInfo = {
	name: string;
	description: string;
	/** Present when the provider SDK exposes the package's SKILL.md location. */
	path?: string;
	scope?: string;
	enabled?: boolean;
};

/**
 * Provider-agnostic account info shape — a subset of the SDK's AccountInfo
 * (email, organization, subscriptionType only; tokenSource/apiKeySource/
 * apiProvider are SDK-internal and not surfaced to the UI).
 */
export type ProviderAccountInfo = {
	email?: string;
	organization?: string;
	subscriptionType?: string;
};

/** A single effort/thinking level entry as reported by a provider's live model catalog. */
export type ProviderEffortInfo = {
	value: string;
	label: string;
	desc?: string;
	isDefault?: boolean;
};

/**
 * A single model entry as reported by a provider's live model catalog
 * (AgentProvider.listModels). Strict superset of the existing static
 * `models` item shape {value,label} — backward compatible.
 */
export type ProviderModelInfo = {
	value: string;
	label: string;
	description?: string;
	isDefault?: boolean;
	hidden?: boolean;
	efforts?: ProviderEffortInfo[];
};

export type SubagentStatus =
	| "pending"
	| "running"
	| "paused"
	| "completed"
	| "failed"
	| "interrupted";

/** Provider-neutral snapshot rendered inside the originating spawn tool call. */
export type SubagentSnapshot = {
	provider: "codex" | "claude";
	agentId: string;
	taskId?: string;
	/** Provider-assigned display name (for example a Claude teammate name). */
	name?: string;
	/** Agent type/path when it is distinct from the provider-assigned name. */
	label?: string;
	prompt?: string;
	description?: string;
	model?: string;
	effort?: string;
	status: SubagentStatus;
	currentStep?: string;
	lastTool?: string;
	startedAtMs: number;
	endedAtMs?: number;
	usage?: {
		totalTokens?: number;
		toolUses?: number;
		durationMs?: number;
	};
};

export type AgentEvent =
	| { type: "session_start"; sessionId: string }
	| { type: "commands_changed"; commands: SlashCommand[] }
	| { type: "transport_error"; message: string }
	| { type: "text_delta"; text: string }
	/**
	 * Native transcript id of the raw provider message currently contributing
	 * to this turn. Claude-only today (SDKAssistantMessage.uuid) — used to
	 * persist a fork cutoff (forkSession's upToMessageId) per displayed
	 * assistant row. Other providers simply never emit this.
	 */
	| { type: "assistant_message_id"; id: string }
	| { type: "local_command_output"; content: string }
	| {
			type: "tool_start";
			toolId: string;
			name: string;
			input: unknown;
			subagent?: SubagentSnapshot;
	  }
	| { type: "tool_update"; toolId: string; subagent: SubagentSnapshot }
	| {
			type: "tool_result";
			toolId: string;
			content: string;
			isError?: boolean;
	  }
	| { type: "summary"; text: string }
	| {
			type: "usage";
			inputTokens: number;
			outputTokens: number;
			cacheReadTokens?: number;
			cacheCreationTokens?: number;
			/** Authoritative cumulative usage for the active query, when available. */
			queryUsage?: {
				inputTokens: number;
				outputTokens: number;
				cacheReadTokens: number;
				cacheCreationTokens: number;
			};
			model?: string;
			/** Context window of the model serving this turn, when the provider reports it. */
			contextWindow?: number;
			/** Exact tokens currently occupying context, when distinct from turn input. */
			contextTokens?: number;
	  }
	| {
			type: "rate_limit";
			status: string;
			rateLimitType?: string;
			utilization?: number;
			resetsAt?: number | null;
	  }
	| { type: "mcp_status"; servers: McpServerStatus[] }
	| {
			type: "done";
			cost?: number;
			/** Whether `cost` is provider-reported, including a genuine known zero. */
			costKnown?: boolean;
			/** API-equivalent estimate when the provider does not report actual cost. */
			estimatedCost?: number | null;
			turns: number;
			durationMs: number;
			stopReason?: string;
			modelUsage?: Record<
				string,
				{ contextWindow: number; maxOutputTokens: number }
			>;
			usage?: {
				inputTokens: number;
				outputTokens: number;
				cacheReadTokens?: number;
				cacheCreationTokens?: number;
			};
	  };

export type AgentToolDecision =
	| {
			behavior: "allow";
			updatedInput?: unknown;
			/** Hlid approval-card persistence chosen by the user. */
			saveScope?: "session" | "local";
	  }
	| { behavior: "deny"; message?: string };

export type ToolMeta = {
	toolUseID: string;
	signal: AbortSignal;
	title?: string;
	displayName?: string;
	description?: string;
	suggestions?: unknown[];
	blockedPath?: string;
	decisionReason?: string;
	agentID?: string;
};

export type CanUseTool = (
	toolName: string,
	input: unknown,
	meta: ToolMeta,
) => Promise<AgentToolDecision>;

export type BeforeToolUse = (
	toolName: string,
	input: unknown,
	meta: { toolUseID?: string; signal?: AbortSignal },
) => Promise<"proceeded" | "aborted">;

export type AgentQueryParams = {
	cwd: string;
	/** Resume token from a prior session; undefined starts fresh. */
	sessionId?: string;
	/** Imported Claude transcripts are resumed through the SDK SessionStore adapter. */
	historyResumeMode?: "none" | "native" | "session-store";
	additionalDirectories?: string[];
	model?: string;
	effort?: string;
	maxTurns?: number;
	permissionMode?: "default" | "acceptEdits" | "bypassPermissions" | "plan";
	/** A host policy layer must see calls even when interactive prompts are bypassed. */
	policyEnforced?: boolean;
	/** Keep provider host boundaries active so auto-sleep can gate continuation. */
	usageGateEnforced?: boolean;
	/** Provider-native pre-tool boundary used to pause before autonomous tools. */
	beforeToolUse?: BeforeToolUse;
	/** Permission mode to restore after a provider-specific plan is approved. */
	implementationPermissionMode?:
		| "default"
		| "acceptEdits"
		| "bypassPermissions";
	/** Exact server-owned HTML plan path when the HTML handoff is enabled. */
	planHtmlPath?: string;
	/** false = ephemeral session (recap queries). */
	persistSession?: boolean;
	signal?: AbortSignal;
	canUseTool: CanUseTool;
	settingSources?: ("user" | "project" | "local")[];
	executable?: string;
	/** Windows-native Codex Computer Use delegation preferences. */
	windowsComputerUse?: { model: string; effort: string };
};

/**
 * Options controlling how a sent message is delivered into the long-lived
 * SDK stream. Slice B: defaults to "next" (queue at next turn boundary,
 * matching CLI semantics). "now" interrupts the current turn (pending
 * verification in Slice C). "later" appends to end of queue.
 */
export type SendOptions = {
	priority?: "now" | "next" | "later";
};

export interface AgentSession extends AsyncIterable<AgentEvent> {
	/**
	 * Push a user message into the long-lived agent stream. Resolves once the
	 * message has been accepted by the provider (not when the assistant turn
	 * completes — for that, await the next `done` AgentEvent).
	 */
	send(message: string, opts?: SendOptions): Promise<void>;
	cancel(): void;
	/**
	 * Slice C: stop the currently running assistant turn early and return
	 * control to the caller. The session stays alive for subsequent send()s
	 * (unlike cancel(), which tears down the SDK process). Used by the
	 * "promote queued msg to now" UX — interrupts current, drain proceeds
	 * to the next queued turn.
	 */
	interrupt?(): Promise<void>;
	/**
	 * Close the input stream without aborting the session. Use for one-shot
	 * queries (e.g. recap) after the final send() so the SDK process sees EOF
	 * on stdin and exits cleanly after its turn instead of waiting indefinitely.
	 */
	closeInput?(): void;
	/** Available on providers that expose MCP server connectivity info. */
	mcpServerStatus?(): Promise<McpServerStatus[]>;
	/** Available on providers that expose the list of supported slash commands. */
	supportedCommands?(): Promise<SlashCommand[]>;
	/** Execute a provider capability without relying on prompt-parsed CLI syntax. */
	executeCommand?(
		action: "review" | "computer-use",
		args?: string,
	): Promise<void>;
	/**
	 * Fetch the provider's current subscription/rate-limit windows. Unlike
	 * passive rate-limit events, this can return a reading even when the
	 * provider has not crossed a warning threshold during the current turn.
	 */
	usageWindows?(): Promise<ProviderWindowReading[]>;
	/**
	 * Fetch the provider's current context occupancy and model window. This is
	 * separate from per-inference token usage because some providers only expose
	 * the authoritative window through a live control API.
	 */
	contextUsage?(): Promise<ProviderContextUsage | null>;
	/**
	 * Switch the model used for subsequent turns in this already-running
	 * session. `undefined` resets to the provider's default. No-op (absent)
	 * on providers that can't change model mid-session.
	 */
	setModel?(model?: string): Promise<void>;
	/**
	 * Switch the permission mode used for subsequent turns in this
	 * already-running session. No-op (absent) on providers that can't change
	 * permission mode mid-session.
	 */
	setPermissionMode?(mode: string): Promise<void>;
	/**
	 * Switch the effort/thinking level used for subsequent turns in this
	 * already-running session. No-op (absent) on providers that can't change
	 * effort mid-session — e.g. Claude's SDK Query exposes setModel but no
	 * live effort setter, so a Claude session only picks up a new effort on
	 * its next fresh AgentSession, not the current stream.
	 */
	setEffort?(effort: string): Promise<void>;
	/** Update preferences used by the next Windows-native Computer Use worker. */
	setWindowsComputerUse?(settings: {
		model: string;
		effort: string;
	}): Promise<void>;
	/** Update the per-turn HTML plan handoff without recreating the conversation. */
	setPlanHtmlPath?(path: string | undefined): void;
	/**
	 * Fetch info about the authenticated account backing this session, or
	 * null when unavailable (no live session, not authenticated via a
	 * provider that exposes this, or the lookup failed). Available on
	 * providers that expose account info.
	 */
	accountInfo?(): Promise<ProviderAccountInfo | null>;
}

/** Params for AgentProvider.forkSession — branch a session's transcript into a new one. */
export type ForkSessionParams = {
	/** Native provider session id to fork from (not hlid's own session id). */
	sessionId: string;
	/**
	 * Project working directory the source session belongs to, when known.
	 * Not required for lookup — providers that key sessions by UUID (Claude)
	 * can and should search across all project directories rather than
	 * trusting this to exactly match the on-disk indexed path (it often
	 * doesn't, e.g. WSL UNC vs POSIX form). Kept optional for providers that
	 * need it to scope the fork.
	 */
	cwd?: string;
	/** From SessionRow.history_resume_mode — selects the right transcript source. */
	historyResumeMode?: "none" | "native" | "session-store";
	/** Custom title for the forked session. If omitted, the provider picks a default. */
	title?: string;
	/**
	 * Slice the transcript up to (and including) this native message id
	 * instead of copying the whole session. Claude-native SDK message uuid,
	 * captured per assistant row via the `assistant_message_id` AgentEvent —
	 * see src/db/messages.ts's setMessageSdkUuid. Omit for a whole-session
	 * fork.
	 */
	upToMessageId?: string;
};

export type ForkSessionResult = {
	/** New native provider session id, resumable like any other. */
	sessionId: string;
	/**
	 * Best-effort transcript hydration for hlid's own DB. forkSession() only
	 * writes the native provider transcript file — hlid's own `messages`
	 * table (what Raven actually renders from) has no rows for the new
	 * session otherwise. Undefined/empty means the caller should leave the
	 * new hlid session row message-less; it'll backfill from a live turn or
	 * a manual history reload, same as before this existed.
	 */
	messages?: { role: "user" | "assistant"; text: string; uuid?: string }[];
};

export interface AgentProvider {
	/** Stable identifier used to namespace DB keys and UI tabs, e.g. "claude". */
	readonly providerId: string;
	/** Human-readable display name, e.g. "Claude". Defaults to providerId. */
	readonly label?: string;
	/**
	 * Models this provider supports. UI uses this to populate the model picker.
	 * Omit for providers with fully dynamic or unconstrained model lists.
	 */
	readonly models?: ReadonlyArray<{ value: string; label: string }>;
	/**
	 * Effort / thinking levels this provider supports.
	 * Omit if the provider has no such concept (e.g. OpenAI doesn't expose it).
	 */
	readonly effortLevels?: ReadonlyArray<{
		value: string;
		label: string;
		desc?: string;
	}>;
	/**
	 * Permission gate modes this provider honours.
	 * Omit if the provider ignores permissionMode entirely.
	 */
	readonly permissionModes?: ReadonlyArray<{
		value: string;
		label: string;
		desc?: string;
	}>;
	/** Rolling usage windows shown in Cockpit/Ledger for this provider. */
	readonly usageWindows?: ReadonlyArray<{
		windowId: string;
		label: string;
		windowSecs: number;
	}>;
	/**
	 * True when mcpServerStatus()/supportedCommands() require an initialized
	 * chat process. Public metadata probes must use a provider cache when no
	 * live session exists rather than creating a hidden chat process.
	 */
	readonly probeRequiresTurn?: boolean;
	/** Optional availability check. Returns false + reason if provider can't run. */
	check?(): Promise<{ available: boolean; reason?: string }>;
	/** Optional host-only capabilities surfaced in Forge diagnostics. */
	hostCapabilities?(): Promise<
		Record<string, { label: string; available: boolean; reason?: string }>
	>;
	/** Live-fetch the provider's model catalog. Falls back to the static `models` list on failure. */
	listModels?(): Promise<ProviderModelInfo[]>;
	/** Discover skills visible to this provider for a concrete working directory. */
	listSkills?(context: {
		cwd: string;
		executable?: string;
	}): Promise<ProviderSkillInfo[]>;
	query(params: AgentQueryParams): AgentSession;
	/**
	 * Fork an existing (typically idle) session's transcript into a brand-new
	 * session without a live query. Providers that can't do this omit the
	 * method entirely — callers must feature-detect with
	 * `typeof provider.forkSession === "function"`.
	 */
	forkSession?(params: ForkSessionParams): Promise<ForkSessionResult>;
	/**
	 * When present, the generic proxy infra will spin up an HTTP proxy for this
	 * provider, set `envVar` in the environment, and call `parseHeaders` on every
	 * upstream response to extract rate-limit window readings.
	 */
	proxyConfig?: {
		/** Environment variable the provider SDK reads for its base URL. */
		envVar: string;
		/** Window IDs this provider can report on (used for cold-start DB seeding). */
		windowIds: string[];
		/** Parse provider-specific response headers into zero or more window readings. */
		parseHeaders(headers: Headers): ProviderWindowReading[];
	};
}
