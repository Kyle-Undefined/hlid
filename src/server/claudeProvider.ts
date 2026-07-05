import type {
	EffortLevel as SdkEffortLevel,
	ModelInfo as SdkModelInfo,
	PermissionMode as SdkPermissionMode,
} from "@anthropic-ai/claude-agent-sdk";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { resolveClaudeExecutable } from "../lib/claudePath";
import type {
	AgentEvent,
	AgentProvider,
	AgentQueryParams,
	AgentSession,
	McpServerStatus,
	ProviderAccountInfo,
	ProviderEffortInfo,
	ProviderModelInfo,
	ProviderWindowReading,
	SendOptions,
	SlashCommand,
} from "./agentProvider";

/**
 * Permission modes hlid's AgentQueryParams/agent-agnostic layer knows about.
 * The SDK's PermissionMode also includes 'dontAsk' | 'auto', which hlid never
 * sends — setPermissionMode() rejects anything outside this set with a clear
 * error rather than silently forwarding an unsupported mode to the SDK.
 */
const KNOWN_PERMISSION_MODES = new Set<string>([
	"default",
	"acceptEdits",
	"bypassPermissions",
	"plan",
]);

type SdkQuery = ReturnType<typeof query>;

// SDKUserMessage shape per @anthropic-ai/claude-agent-sdk's sdk.d.ts. Kept
// minimal here to avoid pulling the deep SDK type — the SDK accepts any
// object matching this shape.
type SdkUserMessage = {
	type: "user";
	message: { role: "user"; content: Array<{ type: "text"; text: string }> };
	parent_tool_use_id: null;
	priority?: "now" | "next" | "later";
};

/**
 * Internal queue+waiter feeding the SDK's AsyncIterable<SDKUserMessage> input.
 * Slice B: replaces the per-turn `prompt: string` model with a long-lived
 * stream — multiple send() calls on the AgentSession push onto this queue;
 * the SDK consumes them as separate user turns.
 */
class InputStream {
	private buffer: SdkUserMessage[] = [];
	private waiters: Array<(v: SdkUserMessage | null) => void> = [];
	private closed = false;

	push(msg: SdkUserMessage): void {
		if (this.closed) return;
		const w = this.waiters.shift();
		if (w) w(msg);
		else this.buffer.push(msg);
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		while (this.waiters.length > 0) {
			const w = this.waiters.shift();
			w?.(null);
		}
	}

	async *iterate(): AsyncGenerator<SdkUserMessage> {
		while (true) {
			if (this.buffer.length > 0) {
				const next = this.buffer.shift();
				if (next) yield next;
				continue;
			}
			if (this.closed) return;
			const next = await new Promise<SdkUserMessage | null>((resolve) => {
				this.waiters.push(resolve);
			});
			if (next === null) return;
			yield next;
		}
	}
}

function buildSdkUserMessage(
	text: string,
	priority: "now" | "next" | "later",
): SdkUserMessage {
	return {
		type: "user",
		message: { role: "user", content: [{ type: "text", text }] },
		parent_tool_use_id: null,
		priority,
	};
}

class ClaudeAgentSession implements AgentSession {
	private abortController: AbortController;
	private makeQuery: (
		input: AsyncIterable<SdkUserMessage>,
		resumeId: string | undefined,
	) => SdkQuery;
	private resumeId: string | undefined;
	private inputStream: InputStream = new InputStream();
	private sdkQuery: SdkQuery | null = null;
	private cachedIter: AsyncIterator<AgentEvent> | null = null;
	private firstSend: SdkUserMessage | null = null;
	private receivedAnyEvent = false;
	private retriedWithoutResume = false;

	constructor(
		makeQuery: (
			input: AsyncIterable<SdkUserMessage>,
			resumeId: string | undefined,
		) => SdkQuery,
		abortController: AbortController,
		resumeId: string | undefined,
	) {
		this.makeQuery = makeQuery;
		this.abortController = abortController;
		this.resumeId = resumeId;
	}

	cancel(): void {
		this.inputStream.close();
		this.abortController.abort();
	}

	closeInput(): void {
		this.inputStream.close();
	}

	async interrupt(): Promise<void> {
		// SDK's Query.interrupt() is only available in streaming-input mode,
		// which we always use. Stops the current assistant turn early; the
		// session stays alive for subsequent send()s.
		if (!this.sdkQuery) return;
		await this.sdkQuery.interrupt();
	}

	async send(message: string, opts?: SendOptions): Promise<void> {
		const sdkMsg = buildSdkUserMessage(message, opts?.priority ?? "next");
		// Capture the first send so we can replay it if cold-resume retry kicks in.
		if (this.firstSend === null) this.firstSend = sdkMsg;
		// Lazily open the SDK query on first send so an empty session that's
		// never sent doesn't spawn the CLI.
		this.ensureSdkQuery();
		this.inputStream.push(sdkMsg);
	}

	async mcpServerStatus(): Promise<McpServerStatus[]> {
		if (!this.sdkQuery) return [];
		return this.sdkQuery.mcpServerStatus() as Promise<McpServerStatus[]>;
	}

	async supportedCommands(): Promise<SlashCommand[]> {
		if (!this.sdkQuery) return [];
		return this.sdkQuery.supportedCommands() as Promise<SlashCommand[]>;
	}

	/**
	 * Mid-session model switch. Delegates to the SDK Query's setModel(), only
	 * available once the stream is open (first send() has happened). No-op
	 * when the SDK query hasn't been created yet — mirrors the
	 * mcpServerStatus()/supportedCommands() null-guard pattern.
	 */
	async setModel(model?: string): Promise<void> {
		if (!this.sdkQuery) return;
		await this.sdkQuery.setModel(model);
	}

	/**
	 * Mid-session permission-mode switch. Validates against the modes hlid's
	 * AgentQueryParams supports before forwarding to the SDK — the SDK's
	 * PermissionMode is a superset ('dontAsk' | 'auto' besides ours) that
	 * hlid has no UI/config path for, so an unknown value is rejected here
	 * rather than passed through.
	 */
	async setPermissionMode(mode: string): Promise<void> {
		if (!KNOWN_PERMISSION_MODES.has(mode)) {
			throw new Error(`Unknown permission mode: ${mode}`);
		}
		if (!this.sdkQuery) return;
		await this.sdkQuery.setPermissionMode(mode as SdkPermissionMode);
	}

	/**
	 * Account info for the authenticated session. Returns null when the SDK
	 * query hasn't been created yet (mirrors the other optional methods'
	 * null-guard) or when the SDK call itself fails (e.g. not logged in).
	 */
	async accountInfo(): Promise<ProviderAccountInfo | null> {
		if (!this.sdkQuery) return null;
		try {
			const info = await this.sdkQuery.accountInfo();
			return {
				email: info.email,
				organization: info.organization,
				subscriptionType: info.subscriptionType,
			};
		} catch {
			return null;
		}
	}

	private ensureSdkQuery(): void {
		if (this.sdkQuery) return;
		this.sdkQuery = this.makeQuery(this.inputStream.iterate(), this.resumeId);
	}

	[Symbol.asyncIterator](): AsyncIterator<AgentEvent> {
		if (!this.cachedIter) {
			this.cachedIter = this.createIterator();
		}
		const inner = this.cachedIter;
		// Wrap so that `for await` breaking out of the loop (via `return` in
		// iterateConversation when a `done` event arrives) does NOT call
		// inner.return() and close the underlying AsyncGenerator. Without this
		// wrap, the cached iterator gets terminated at the first turn boundary
		// and subsequent runQuery calls receive no events forever — observed
		// as "second user message sits with no response".
		return {
			next: () => inner.next(),
			return: async () =>
				({ value: undefined, done: true }) as IteratorResult<AgentEvent>,
		};
	}

	private createIterator(): AsyncIterator<AgentEvent> {
		// Capture `this` for the generator below.
		const self = this;
		const generator = (async function* (): AsyncGenerator<AgentEvent> {
			self.ensureSdkQuery();
			try {
				yield* self.translateEvents();
			} catch (err) {
				// Cold-resume retry: if the persisted resume id was rotated/wiped
				// by the CLI, the first iteration fails before any event arrives.
				// Recreate the SDK query without resume and replay the first send.
				if (
					self.resumeId !== undefined &&
					!self.receivedAnyEvent &&
					!self.retriedWithoutResume
				) {
					self.retriedWithoutResume = true;
					self.resumeId = undefined;
					// Fresh input stream so the SDK consumes the replayed msg.
					self.inputStream.close();
					self.inputStream = new InputStream();
					self.sdkQuery = self.makeQuery(self.inputStream.iterate(), undefined);
					if (self.firstSend) self.inputStream.push(self.firstSend);
					yield* self.translateEvents();
					return;
				}
				throw err;
			}
		})();
		return generator[Symbol.asyncIterator]();
	}

	private async *translateEvents(): AsyncGenerator<AgentEvent> {
		const sdkQuery = this.sdkQuery;
		if (!sdkQuery) return;
		let hadText = false;
		for await (const message of sdkQuery) {
			this.receivedAnyEvent = true;

			if (message.type === "system" && message.subtype === "init") {
				yield { type: "session_start", sessionId: message.session_id };
				continue;
			}

			if (
				message.type === "system" &&
				(message as { subtype: string }).subtype === "local_command_output"
			) {
				yield {
					type: "local_command_output",
					content: (message as { content: string }).content,
				};
				continue;
			}

			if (message.type === "user") {
				const content = (message as { message?: { content?: unknown } }).message
					?.content;
				if (Array.isArray(content)) {
					for (const block of content as Array<Record<string, unknown>>) {
						if (block.type !== "tool_result") continue;
						const text = normalizeToolResultContent(block.content);
						const truncated = truncateToolResult(text);
						yield {
							type: "tool_result",
							toolId: String(block.tool_use_id ?? ""),
							content: truncated,
							...(block.is_error === true ? { isError: true } : {}),
						};
					}
				}
				continue;
			}

			if (message.type === "assistant") {
				if (message.message.usage) {
					const u = message.message.usage;
					yield {
						type: "usage",
						inputTokens: u.input_tokens,
						outputTokens: u.output_tokens,
						cacheReadTokens: u.cache_read_input_tokens ?? undefined,
						cacheCreationTokens: u.cache_creation_input_tokens ?? undefined,
						model: message.message.model,
					};
				}
				for (const block of message.message.content) {
					if (block.type === "text") {
						hadText = true;
						yield { type: "text_delta", text: block.text };
					} else if (block.type === "tool_use") {
						yield {
							type: "tool_start",
							toolId: block.id,
							name: block.name,
							input: block.input,
						};
					}
				}
				continue;
			}

			if (message.type === "tool_use_summary") {
				yield { type: "summary", text: message.summary };
				continue;
			}

			if (message.type === "rate_limit_event") {
				const info = message.rate_limit_info;
				yield {
					type: "rate_limit",
					status: info.status,
					rateLimitType: info.rateLimitType,
					utilization: info.utilization,
					resetsAt:
						typeof info.resetsAt === "number"
							? info.resetsAt
							: typeof info.resetsAt === "string"
								? Math.floor(new Date(info.resetsAt).getTime() / 1000)
								: null,
				};
				continue;
			}

			if (message.type === "result") {
				if (!hadText && message.subtype === "success" && message.result) {
					yield { type: "text_delta", text: message.result };
				}
				yield {
					type: "done",
					cost: message.total_cost_usd,
					turns: message.num_turns,
					durationMs: message.duration_ms ?? 0,
					stopReason: message.stop_reason ?? undefined,
					modelUsage: message.modelUsage as
						| Record<string, { contextWindow: number; maxOutputTokens: number }>
						| undefined,
					usage: message.usage
						? {
								inputTokens: message.usage.input_tokens,
								outputTokens: message.usage.output_tokens,
								cacheReadTokens:
									message.usage.cache_read_input_tokens ?? undefined,
								cacheCreationTokens:
									message.usage.cache_creation_input_tokens ?? undefined,
							}
						: undefined,
				};
				// Reset hadText so the next turn's tracking starts fresh. The
				// generator continues iterating the same SDK query for subsequent
				// turns; consumers break on `done` to release control between
				// turns and resume iteration on the next runOneTurn.
				hadText = false;
			}
		}
	}
}

const TOOL_RESULT_MAX_BYTES = 8192;

function normalizeToolResultContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const block of content as Array<Record<string, unknown>>) {
		if (block.type === "text" && typeof block.text === "string") {
			parts.push(block.text);
		} else if (block.type === "image") {
			parts.push("[image]");
		}
	}
	return parts.join("");
}

function truncateToolResult(s: string): string {
	if (s.length <= TOOL_RESULT_MAX_BYTES) return s;
	const dropped = s.length - TOOL_RESULT_MAX_BYTES;
	return `${s.slice(0, TOOL_RESULT_MAX_BYTES)}\n\n[truncated ${dropped} chars]`;
}

/** Static effortLevels label/desc text, reused by mapClaudeModels for per-model effort entries. */
const EFFORT_TEXT: Record<string, { label: string; desc: string }> = {
	low: { label: "Low", desc: "minimal thinking, quick turnaround" },
	medium: { label: "Medium", desc: "some thinking, pretty balanced" },
	high: { label: "High", desc: "solid reasoning, this is the default" },
	xhigh: { label: "X-High", desc: "goes deeper, Opus only" },
	max: { label: "Max", desc: "everything Claude has, Opus only" },
};

/**
 * Pure mapper from the SDK's Query.supportedModels() ModelInfo[] shape to the
 * provider-agnostic ProviderModelInfo[]. No isDefault — the SDK has no
 * default-model marker.
 */
export function mapClaudeModels(models: SdkModelInfo[]): ProviderModelInfo[] {
	return models.map((m) => {
		const efforts: ProviderEffortInfo[] | undefined =
			m.supportsEffort && m.supportedEffortLevels?.length
				? m.supportedEffortLevels.map((value) => {
						const text = EFFORT_TEXT[value];
						return {
							value,
							label: text?.label ?? value,
							desc: text?.desc,
						};
					})
				: undefined;
		return {
			value: m.value,
			label: m.displayName || m.value,
			description: m.description,
			efforts,
		};
	});
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
	return Promise.race([
		promise,
		new Promise<T>((_, reject) => {
			setTimeout(
				() => reject(new Error("Claude supportedModels() timed out")),
				timeoutMs,
			);
		}),
	]);
}

/** Parse Anthropic rate-limit utilization headers from an API response. */
function parseAnthropicHeaders(headers: Headers): ProviderWindowReading[] {
	const readings: ProviderWindowReading[] = [];

	function toUnix(s: string | null): number | null {
		if (!s) return null;
		const t = parseInt(s, 10);
		return Number.isFinite(t) ? t : null;
	}

	const windows = [
		[
			"anthropic-ratelimit-unified-5h-utilization",
			"anthropic-ratelimit-unified-5h-reset",
			"five_hour",
			"5-HOUR",
		],
		[
			"anthropic-ratelimit-unified-7d-utilization",
			"anthropic-ratelimit-unified-7d-reset",
			"weekly",
			"7-DAY",
		],
		[
			"anthropic-ratelimit-unified-7d_sonnet-utilization",
			"anthropic-ratelimit-unified-7d_sonnet-reset",
			"weekly_sonnet",
			"SONNET",
		],
	] as const;

	for (const [utilHeader, resetHeader, windowId, label] of windows) {
		const h = headers.get(utilHeader);
		if (h === null) continue;
		const raw = parseFloat(h);
		if (!Number.isFinite(raw)) continue;
		readings.push({
			windowId,
			label,
			utilization: raw >= 1 ? raw / 100 : raw,
			remaining: null,
			limit: null,
			resetsAt: toUnix(headers.get(resetHeader)),
		});
	}

	return readings;
}

export class ClaudeProvider implements AgentProvider {
	readonly providerId = "claude";
	readonly label = "Claude";

	readonly models = [
		{ value: "claude-opus-4-8", label: "Opus 4.8" },
		{ value: "claude-opus-4-7", label: "Opus 4.7" },
		{ value: "claude-sonnet-4-6", label: "Sonnet 4.6" },
		{ value: "claude-haiku-4-5-20251001", label: "Haiku 4.5" },
	] as const;

	readonly effortLevels = [
		{ value: "low", label: "Low", desc: "minimal thinking, quick turnaround" },
		{
			value: "medium",
			label: "Medium",
			desc: "some thinking, pretty balanced",
		},
		{
			value: "high",
			label: "High",
			desc: "solid reasoning, this is the default",
		},
		{ value: "xhigh", label: "X-High", desc: "goes deeper, Opus only" },
		{
			value: "max",
			label: "Max",
			desc: "everything Claude has, Opus only",
		},
	] as const;

	readonly permissionModes = [
		{
			value: "default",
			label: "Ask for approval",
			desc: "asks before doing anything",
		},
		{
			value: "acceptEdits",
			label: "Auto-approve edits",
			desc: "edits go through automatically, everything else still asks",
		},
		{
			value: "bypassPermissions",
			label: "Auto-approve all",
			desc: "everything goes through, no interruptions",
		},
	] as const;

	readonly usageWindows = [
		{ windowId: "five_hour", label: "5-HOUR", windowSecs: 5 * 3600 },
		{ windowId: "weekly", label: "7-DAY", windowSecs: 7 * 86400 },
		{ windowId: "weekly_sonnet", label: "SONNET", windowSecs: 7 * 86400 },
	] as const;

	async check(): Promise<{ available: boolean; reason?: string }> {
		const exe = resolveClaudeExecutable();
		if (exe === undefined) {
			return { available: false, reason: "Claude Code CLI not found" };
		}
		return { available: true };
	}

	/**
	 * Live-fetch the model catalog via a throwaway SDK query — no real prompt
	 * is ever sent; the stream stays open until abort() and canUseTool denies
	 * everything as a defensive backstop. Falls back to the static `models`
	 * array on failure (handled by callers).
	 */
	async listModels(): Promise<ProviderModelInfo[]> {
		const exe = resolveClaudeExecutable();
		const ac = new AbortController();
		// biome-ignore lint/suspicious/noExplicitAny: SDK canUseTool type changed between versions
		const denyAllCanUseTool: any = async () => ({
			behavior: "deny",
			message: "catalog probe",
		});
		const q = query({
			prompt: (async function* (): AsyncGenerator<SdkUserMessage> {
				// Never yields — the probe never sends a real user turn.
				await new Promise<never>(() => {});
			})(),
			options: {
				cwd: process.cwd(),
				abortController: ac,
				persistSession: false,
				settingSources: [],
				maxTurns: 1,
				...(exe ? { pathToClaudeCodeExecutable: exe } : {}),
				canUseTool: denyAllCanUseTool,
			},
		});
		try {
			return mapClaudeModels(await withTimeout(q.supportedModels(), 10_000));
		} finally {
			ac.abort();
		}
	}

	readonly proxyConfig = {
		envVar: "ANTHROPIC_BASE_URL",
		windowIds: ["five_hour", "weekly", "weekly_sonnet"],
		parseHeaders: parseAnthropicHeaders,
	};

	query(params: AgentQueryParams): AgentSession {
		const abortController = new AbortController();

		if (params.signal) {
			if (params.signal.aborted) {
				abortController.abort();
			} else {
				params.signal.addEventListener("abort", () => abortController.abort(), {
					once: true,
				});
			}
		}

		const makeQuery = (
			input: AsyncIterable<SdkUserMessage>,
			resumeId: string | undefined,
		): SdkQuery =>
			query({
				prompt: input as unknown as Parameters<typeof query>[0]["prompt"],
				options: {
					cwd: params.cwd,
					...(params.additionalDirectories?.length
						? { additionalDirectories: params.additionalDirectories }
						: {}),
					abortController,
					...(params.model ? { model: params.model } : {}),
					permissionMode: params.permissionMode ?? "default",
					effort: (params.effort ?? "medium") as SdkEffortLevel,
					...(params.maxTurns !== undefined
						? { maxTurns: params.maxTurns }
						: {}),
					...(params.executable
						? { pathToClaudeCodeExecutable: params.executable }
						: {}),
					allowDangerouslySkipPermissions:
						params.permissionMode === "bypassPermissions",
					settingSources: params.settingSources ?? ["user", "project", "local"],
					...(resumeId !== undefined ? { resume: resumeId } : {}),
					...(params.persistSession === false ? { persistSession: false } : {}),
					// biome-ignore lint/suspicious/noExplicitAny: SDK canUseTool type changed between versions
					canUseTool: params.canUseTool as any,
				},
			});

		return new ClaudeAgentSession(makeQuery, abortController, params.sessionId);
	}
}
