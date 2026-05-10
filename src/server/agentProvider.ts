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

/** Normalized MCP server status — compatible with protocol.ts mapMcpServer input. */
export type McpServerStatus = {
	name: string;
	status: "connected" | "failed" | "needs-auth" | "pending" | "disabled";
	scope?: string;
	error?: string;
};

export type AgentEvent =
	| { type: "session_start"; sessionId: string }
	| { type: "text_delta"; text: string }
	| { type: "tool_start"; toolId: string; name: string; input: unknown }
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
			model?: string;
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
	| { behavior: "allow"; updatedInput?: unknown }
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

export type AgentQueryParams = {
	prompt: string;
	cwd: string;
	/** Resume token from a prior session; undefined starts fresh. */
	sessionId?: string;
	additionalDirectories?: string[];
	model?: string;
	effort?: "low" | "medium" | "high" | "xhigh" | "max";
	maxTurns?: number;
	permissionMode?: "default" | "acceptEdits" | "bypassPermissions" | "plan";
	/** false = ephemeral session (recap queries). */
	persistSession?: boolean;
	signal?: AbortSignal;
	canUseTool: CanUseTool;
	settingSources?: ("user" | "project" | "local")[];
	executable?: string;
};

export interface AgentSession extends AsyncIterable<AgentEvent> {
	cancel(): void;
	/** Available on providers that expose MCP server connectivity info. */
	mcpServerStatus?(): Promise<McpServerStatus[]>;
}

export interface AgentProvider {
	/** Stable identifier used to namespace DB keys and UI tabs, e.g. "claude". */
	readonly providerId: string;
	/** Human-readable display name, e.g. "Claude". Defaults to providerId. */
	readonly label?: string;
	/** Optional availability check. Returns false + reason if provider can't run. */
	check?(): Promise<{ available: boolean; reason?: string }>;
	query(params: AgentQueryParams): AgentSession;
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
