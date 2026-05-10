import { query } from "@anthropic-ai/claude-agent-sdk";
import { resolveClaudeExecutable } from "../lib/claudePath";
import type {
	AgentEvent,
	AgentProvider,
	AgentQueryParams,
	AgentSession,
	McpServerStatus,
	ProviderWindowReading,
} from "./agentProvider";

type SdkQuery = ReturnType<typeof query>;

class ClaudeAgentSession implements AgentSession {
	private abortController: AbortController;
	private makeQuery: (resumeId: string | undefined) => SdkQuery;
	private sessionId: string | undefined;
	private _currentQuery: SdkQuery | null = null;

	constructor(
		makeQuery: (resumeId: string | undefined) => SdkQuery,
		abortController: AbortController,
		sessionId: string | undefined,
	) {
		this.makeQuery = makeQuery;
		this.abortController = abortController;
		this.sessionId = sessionId;
	}

	cancel(): void {
		this.abortController.abort();
	}

	async mcpServerStatus(): Promise<McpServerStatus[]> {
		if (!this._currentQuery) return [];
		return this._currentQuery.mcpServerStatus() as Promise<McpServerStatus[]>;
	}

	async *[Symbol.asyncIterator](): AsyncIterator<AgentEvent> {
		const triedResume = this.sessionId !== undefined;
		let receivedAny = false;

		let sdkQuery = this.makeQuery(this.sessionId);
		this._currentQuery = sdkQuery;

		try {
			yield* this.translateEvents(sdkQuery, (hadAny) => {
				receivedAny = hadAny;
			});
		} catch (err) {
			if (triedResume && !receivedAny) {
				// Persisted session record was rotated/wiped — retry fresh.
				sdkQuery = this.makeQuery(undefined);
				this._currentQuery = sdkQuery;
				yield* this.translateEvents(sdkQuery, () => {});
			} else {
				throw err;
			}
		}
	}

	private async *translateEvents(
		sdkQuery: SdkQuery,
		onFirst: (hadAny: boolean) => void,
	): AsyncGenerator<AgentEvent> {
		let hadText = false;
		let first = true;

		for await (const message of sdkQuery) {
			if (first) {
				first = false;
				onFirst(true);
			}

			if (message.type === "system" && message.subtype === "init") {
				yield { type: "session_start", sessionId: message.session_id };
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
						typeof info.resetsAt === "string"
							? Math.floor(new Date(info.resetsAt).getTime() / 1000)
							: null,
				};
				continue;
			}

			if (message.type === "result") {
				// Slash commands emit their output in message.result with no assistant chunks.
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

	async check(): Promise<{ available: boolean; reason?: string }> {
		const exe = resolveClaudeExecutable();
		if (exe === undefined) {
			return { available: false, reason: "Claude Code CLI not found" };
		}
		return { available: true };
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

		const makeQuery = (resumeId: string | undefined): SdkQuery =>
			query({
				prompt: params.prompt,
				options: {
					cwd: params.cwd,
					...(params.additionalDirectories?.length
						? { additionalDirectories: params.additionalDirectories }
						: {}),
					abortController,
					...(params.model ? { model: params.model } : {}),
					permissionMode: params.permissionMode ?? "default",
					effort: params.effort ?? "medium",
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
