// fallow-ignore-file unused-file
/**
 * Shared mocks and provider builders for the SessionManager test suite
 * (session.*.test.ts). Each test file registers the module mocks with
 * one-line async factories:
 *
 *   vi.mock("../db", async () => (await import("./session.test-utils")).mockDbModule());
 */
import { vi } from "vitest";
import { makeConfig as makeBaseConfig } from "#/test/fixtures";
import type { Agent, HlidConfig } from "../config";
import type { RoutinePermissionContext } from "../lib/routinePermissions";
import type {
	AgentEvent,
	AgentProvider,
	AgentQueryParams,
	AgentSession,
	AgentToolDecision,
} from "./agentProvider";

// ── module mock factories ─────────────────────────────────────────────────────

export function mockConfigModule() {
	return { loadConfig: vi.fn() };
}

export function mockAgentPaths() {
	return {
		computeAllowedAgentRealPaths: vi.fn().mockReturnValue([]),
		isAllowedAgentPath: vi.fn().mockReturnValue(false),
		resolveAgentMode: vi.fn().mockReturnValue("cwd"),
	};
}

export function mockClaudePath() {
	return {
		resolveClaudeExecutable: vi.fn().mockReturnValue(undefined),
	};
}

export function mockDbModule() {
	return {
		clearCurrentSessionId: vi.fn().mockResolvedValue(undefined),
		setCurrentSessionId: vi.fn().mockResolvedValue(undefined),
		appendMessage: vi.fn().mockResolvedValue(undefined),
		getProviderMessageFrameDisposition: vi.fn().mockResolvedValue("new"),
		getProviderToolAssistantSeq: vi.fn().mockResolvedValue(null),
		linkProviderFrameToolStart: vi.fn().mockResolvedValue(true),
		recordProviderMessageFrame: vi.fn().mockResolvedValue("recorded"),
		retractProviderMessageFrames: vi.fn().mockResolvedValue([]),
		appendRealtimeTranscriptMessage: vi.fn(async (input: { seq: number }) => ({
			id: input.seq + 1_000,
			seq: input.seq,
			inserted: true,
		})),
		appendToolEvent: vi.fn().mockResolvedValue(undefined),
		appendPlanProposal: vi.fn().mockResolvedValue(undefined),
		setPlanProposalDecision: vi.fn().mockResolvedValue(undefined),
		appendAskUserQuestion: vi.fn().mockResolvedValue(undefined),
		setAskUserQuestionProvenance: vi.fn().mockResolvedValue(undefined),
		setAskUserQuestionResolution: vi.fn().mockResolvedValue(undefined),
		setMessageText: vi.fn().mockResolvedValue(undefined),
		setMessageRecap: vi.fn().mockResolvedValue(undefined),
		setMessageSdkUuid: vi.fn().mockResolvedValue(undefined),
		setMessageProviderTurnId: vi.fn().mockResolvedValue(undefined),
		setMessageCheckpointUuid: vi.fn().mockResolvedValue(undefined),
		setMessageQueryId: vi.fn().mockResolvedValue(undefined),
		setMessageSteerTargetSeq: vi.fn().mockResolvedValue(undefined),
		setToolEventResult: vi.fn().mockResolvedValue(undefined),
		setToolEventActivity: vi.fn().mockResolvedValue(undefined),
		setToolEventSubagent: vi.fn().mockResolvedValue(undefined),
		appendLog: vi.fn().mockResolvedValue(undefined),
		createSession: vi.fn().mockResolvedValue(undefined),
		recordQuery: vi.fn().mockResolvedValue({ estimatedCost: null, queryId: 1 }),
		getSessionById: vi.fn().mockResolvedValue(null),
		getSessionMessages: vi.fn().mockResolvedValue([]),
		getSessionNextMessageSeq: vi.fn().mockResolvedValue(0),
		getUserMessageSeqByTurnId: vi.fn().mockResolvedValue(null),
		getUserMessageCheckpoint: vi.fn().mockResolvedValue(null),
		getSessionAgentCwd: vi.fn().mockResolvedValue(null),
		getSessionModel: vi.fn().mockResolvedValue(null),
		getSessionProviderId: vi.fn().mockResolvedValue(null),
		getSessionProviderSession: vi.fn().mockResolvedValue(null),
		listProviderBackgroundActivities: vi.fn().mockResolvedValue([]),
		replaceSessionBackgroundActivities: vi.fn().mockResolvedValue(undefined),
		getSessionClaudeId: vi.fn().mockResolvedValue(null),
		getAttachment: vi.fn().mockResolvedValue(null),
		setSessionProviderId: vi.fn().mockResolvedValue(undefined),
		setSessionProviderSelection: vi.fn().mockResolvedValue(undefined),
		setSessionProviderSession: vi.fn().mockResolvedValue(true),
		setSessionActualModelForProvider: vi.fn().mockResolvedValue(undefined),
		setSessionAgentCwd: vi.fn().mockResolvedValue(undefined),
		setSessionModel: vi.fn().mockResolvedValue(undefined),
		setSessionEffort: vi.fn().mockResolvedValue(undefined),
		setSessionPermissionMode: vi.fn().mockResolvedValue(undefined),
		setSessionApprovalsReviewer: vi.fn().mockResolvedValue(undefined),
		enqueuePendingSessionTurn: vi.fn().mockResolvedValue(true),
		markPendingSessionTurnSleeping: vi.fn().mockResolvedValue(undefined),
		markPendingSessionTurnDispatching: vi.fn().mockResolvedValue(undefined),
		deletePendingSessionTurn: vi.fn().mockResolvedValue(undefined),
		deletePendingSessionTurns: vi.fn().mockResolvedValue(undefined),
		promotePendingSessionTurn: vi.fn().mockResolvedValue(undefined),
		saveSetting: vi.fn().mockResolvedValue(undefined),
		linkAttachmentToMessage: vi.fn().mockResolvedValue(undefined),
		recordPermissionEvent: vi.fn().mockResolvedValue(undefined),
	};
}

export function mockRecap() {
	return {
		generateTurnRecap: vi.fn().mockResolvedValue(undefined),
	};
}

export function mockClaudeWarmup() {
	return {
		waitForClaudeWarmupSnapshot: vi.fn().mockResolvedValue(null),
	};
}

export function mockUmbod() {
	return {
		authorizeHlidTool: vi.fn().mockResolvedValue(null),
		registerUmbodApprovalSession: vi.fn(() => vi.fn()),
	};
}

export function mockExecutionContext() {
	return {
		resolveExecutionContext: vi.fn().mockReturnValue({
			activeCwd: "/tmp/hlid-test-cwd",
			extraDirs: new Set(),
			executable: undefined,
		}),
	};
}

export function mockLibraryStore() {
	return {
		planStagingPath: (sessionId: string) =>
			`/tmp/hlid-test-library/staging/plans/plan-${sessionId}.html`,
		prepareLibrary: vi.fn().mockResolvedValue(undefined),
	};
}

export function mockPromptBuilder() {
	return {
		buildPlanHtmlInstructions: vi.fn((path: string) => `HTML plan: ${path}`),
		buildPrompt: vi.fn().mockReturnValue({
			prompt: "test prompt",
			safeAttachments: [],
		}),
		buildPromptAsync: vi.fn(
			async (options: {
				operatingBrief?: string;
				operatingBriefVersion?: number;
				operatingBriefRevision?: string;
				operatingBriefPreview?: string;
				operatingBriefDelivery?:
					| "included"
					| "already-established"
					| "not-delivered";
			}) => ({
				prompt: "test prompt",
				safeAttachments: [],
				resourcePaths: [],
				safeVaultReferences: [],
				safeWorkspaceReferences: [],
				contextManifest: {
					contractVersion: 1,
					userMessageChars: 0,
					promptChars: 11,
					hlidAddedChars: 11,
					estimatedHlidTokens: 3,
					blocks: [],
					agentMode: "cwd",
					skills: [],
					attachments: [],
					vaultReferences: [],
					workspaceReferences: [],
					planHtml: false,
					operatingBrief: {
						version: options.operatingBriefVersion ?? 1,
						...(options.operatingBriefRevision
							? {
									briefRevision: options.operatingBriefRevision,
								}
							: {}),
						...(options.operatingBriefPreview
							? { preview: options.operatingBriefPreview }
							: {}),
						included: Boolean(options.operatingBrief),
						delivery:
							options.operatingBriefDelivery ??
							(options.operatingBrief ? "included" : "already-established"),
						chars: options.operatingBrief?.length ?? 0,
					},
				},
			}),
		),
	};
}

export function mockObsidianCli() {
	return {
		getActiveObsidianNote: vi.fn().mockResolvedValue(null),
		readObsidianNote: vi.fn().mockResolvedValue("# Native note"),
	};
}

export function mockNodeFs() {
	return {
		mkdirSync: vi.fn(),
		readFileSync: vi.fn((path: string) => {
			if (typeof path === "string" && path.includes("settings.json")) {
				return "{}";
			}
			return "{}";
		}),
		writeFileSync: vi.fn(),
		renameSync: vi.fn(),
		rmSync: vi.fn(),
		realpathSync: vi.fn((p: string) => p),
	};
}

// ── config + provider builders ────────────────────────────────────────────────

export function testPromptContextManifest() {
	return {
		contractVersion: 1 as const,
		userMessageChars: 0,
		promptChars: 11,
		hlidAddedChars: 11,
		estimatedHlidTokens: 3,
		blocks: [],
		agentMode: "cwd" as const,
		skills: [],
		attachments: [],
		vaultReferences: [],
		workspaceReferences: [],
		planHtml: false,
	};
}

export function routinePermissionContext(
	providerId: string,
	onGrantUsed = vi.fn(),
): RoutinePermissionContext {
	return {
		routineId: "routine-1",
		runId: "run-1",
		profileId: "profile-1",
		revision: 1,
		authorizationFingerprint: "fingerprint",
		mode: "preapproved",
		providerId,
		approvedCwd: "/tmp/hlid-test-cwd",
		grants: [
			{
				id: "grant-1",
				capability: "shell.exec",
				tool: "Bash",
				command: "bun test",
			},
		],
		onGrantUsed,
	};
}

export const makeConfig = (model = "claude-test"): HlidConfig =>
	makeBaseConfig({
		claude: {
			model,
			effort: "medium",
			permission_mode: "default",
			turn_recaps: false,
		},
		vault: { path: "/tmp/hlid-test-vault", name: "Test" },
	});

/** Wrap a single AgentProvider in the Map the SessionManager constructor expects. */
export function makeProviders(
	provider: AgentProvider,
): Map<string, AgentProvider> {
	return new Map([[provider.providerId, provider]]);
}

/** Build a mock AgentProvider whose query() calls canUseTool once for toolName. */
export function makeProvider(
	toolName: string,
	toolUseID = "tid-1",
	onDecision?: (decision: AgentToolDecision) => void,
	agentID?: string,
): AgentProvider {
	return {
		providerId: "claude",
		query(params: AgentQueryParams): AgentSession {
			const gen = (async function* (): AsyncGenerator<AgentEvent> {
				yield { type: "session_start", sessionId: "sdk-session-1" };
				const decision = await params.canUseTool(
					toolName,
					{},
					{
						toolUseID,
						signal: new AbortController().signal,
						title: undefined,
						displayName: undefined,
						description: undefined,
						agentID,
					},
				);
				onDecision?.(decision);
				yield {
					type: "done",
					cost: 0,
					turns: 1,
					durationMs: 0,
					usage: { inputTokens: 10, outputTokens: 5 },
				};
			})();
			return {
				[Symbol.asyncIterator]: () => gen[Symbol.asyncIterator](),
				cancel: vi.fn(),
				send: vi.fn().mockResolvedValue(undefined),
				mcpServerStatus: () => Promise.resolve([]),
			};
		},
	};
}

export function makeSwitchableProvider(
	sessionOverrides: Partial<AgentSession> = {},
	providerId = "claude",
): {
	provider: AgentProvider;
	getSession: () => AgentSession | undefined;
} {
	let session: AgentSession | undefined;
	const provider: AgentProvider = {
		providerId,
		query(): AgentSession {
			const gen = (async function* (): AsyncGenerator<AgentEvent> {
				yield { type: "session_start", sessionId: "sdk-session-1" };
				yield {
					type: "done",
					cost: 0,
					turns: 1,
					durationMs: 0,
					usage: { inputTokens: 10, outputTokens: 5 },
				};
			})();
			session = {
				[Symbol.asyncIterator]: () => gen[Symbol.asyncIterator](),
				cancel: vi.fn(),
				send: vi.fn().mockResolvedValue(undefined),
				...sessionOverrides,
			};
			return session;
		},
	};
	return { provider, getSession: () => session };
}

export function makeRecapTriggerProvider(): AgentProvider {
	return {
		providerId: "claude",
		query(_params: AgentQueryParams): AgentSession {
			const gen = (async function* (): AsyncGenerator<AgentEvent> {
				yield { type: "session_start", sessionId: "sdk-recap-1" };
				yield { type: "tool_start", toolId: "t-r1", name: "Bash", input: {} };
				yield { type: "text_delta", text: "Done." };
				yield {
					type: "done",
					cost: 0,
					turns: 1,
					durationMs: 0,
					usage: { inputTokens: 10, outputTokens: 5 },
				};
			})();
			return {
				[Symbol.asyncIterator]: () => gen[Symbol.asyncIterator](),
				cancel: vi.fn(),
				send: vi.fn().mockResolvedValue(undefined),
				mcpServerStatus: () => Promise.resolve([]),
			};
		},
	};
}

export function makeCaptureProvider(id = "claude"): {
	provider: AgentProvider;
	captured: { params: AgentQueryParams | null };
} {
	const captured: { params: AgentQueryParams | null } = { params: null };
	const provider: AgentProvider = {
		providerId: id,
		query(params: AgentQueryParams): AgentSession {
			captured.params = params;
			const gen = (async function* (): AsyncGenerator<AgentEvent> {
				yield { type: "session_start", sessionId: "sdk-1" };
				yield {
					type: "done",
					cost: 0,
					turns: 1,
					durationMs: 0,
					usage: { inputTokens: 10, outputTokens: 5 },
				};
			})();
			return {
				[Symbol.asyncIterator]: () => gen[Symbol.asyncIterator](),
				cancel: vi.fn(),
				send: vi.fn().mockResolvedValue(undefined),
				mcpServerStatus: () => Promise.resolve([]),
			};
		},
	};
	return { provider, captured };
}

export function makeConfigWithAgent(
	agentPath: string,
	agentOverrides: Partial<Agent> = {},
): HlidConfig {
	return {
		...makeConfig(),
		vault_provider: "claude",
		agents: [
			{ path: agentPath, mode: "cwd", provider: "claude", ...agentOverrides },
		],
	} as unknown as HlidConfig;
}

// ── SessionManager — provider resolution ─────────────────────────────────────

export function makeControlledProvider(
	events: AgentEvent[],
	gateRelease: Promise<void>,
): { provider: AgentProvider; gateReached: Promise<void> } {
	let resolveGate: () => void = () => {};
	const gateReached = new Promise<void>((res) => {
		resolveGate = res;
	});
	const provider: AgentProvider = {
		providerId: "claude",
		query(_params: AgentQueryParams): AgentSession {
			const gen = (async function* (): AsyncGenerator<AgentEvent> {
				for (const e of events) yield e;
				resolveGate();
				await gateRelease;
				yield {
					type: "done",
					cost: 0,
					turns: 1,
					durationMs: 0,
					usage: { inputTokens: 10, outputTokens: 5 },
				};
			})();
			return {
				[Symbol.asyncIterator]: () => gen[Symbol.asyncIterator](),
				cancel: vi.fn(),
				send: vi.fn().mockResolvedValue(undefined),
				mcpServerStatus: () => Promise.resolve([]),
			};
		},
	};
	return { provider, gateReached };
}

export function makeControllableProvider() {
	const turns: Array<{ resolveDone: () => void }> = [];
	let queryCount = 0;
	const eventQueue: AgentEvent[] = [];
	const waiters: Array<(e: AgentEvent | null) => void> = [];
	let closed = false;

	function pushEvent(e: AgentEvent): void {
		const w = waiters.shift();
		if (w) w(e);
		else eventQueue.push(e);
	}

	const provider: AgentProvider = {
		providerId: "claude",
		query(_p: AgentQueryParams): AgentSession {
			queryCount++;
			const queryIndex = queryCount;
			let started = false;
			const cachedIter: AsyncIterator<AgentEvent> = {
				async next(): Promise<IteratorResult<AgentEvent>> {
					if (closed) return { value: undefined as never, done: true };
					if (!started) {
						started = true;
						return {
							value: {
								type: "session_start",
								sessionId: `sdk-${queryIndex}`,
							},
							done: false,
						};
					}
					if (eventQueue.length > 0) {
						return {
							value: eventQueue.shift() as AgentEvent,
							done: false,
						};
					}
					return new Promise<IteratorResult<AgentEvent>>((resolve) => {
						waiters.push((e) => {
							if (e === null) {
								resolve({ value: undefined as never, done: true });
							} else {
								resolve({ value: e, done: false });
							}
						});
					});
				},
			};
			const send = vi.fn(async () => {
				let resolveDone!: () => void;
				const donePromise = new Promise<void>((r) => {
					resolveDone = r;
				});
				turns.push({ resolveDone });
				void donePromise.then(() => {
					pushEvent({
						type: "done",
						cost: 0,
						turns: 1,
						durationMs: 0,
						usage: { inputTokens: 1, outputTokens: 1 },
					});
				});
			});
			return {
				[Symbol.asyncIterator]: () => cachedIter,
				cancel: () => {
					closed = true;
					while (waiters.length > 0) {
						const w = waiters.shift();
						w?.(null);
					}
				},
				send,
				mcpServerStatus: () => Promise.resolve([]),
			};
		},
	};
	return {
		provider,
		turns,
		pushEvent,
		getQueryCount: () => queryCount,
		getSendCount: () => turns.length,
	};
}

export function makeLongLivedProvider() {
	let queryCallCount = 0;
	const eventQueue: AgentEvent[] = [];
	const waiters: Array<(e: AgentEvent | null) => void> = [];
	let closed = false;

	function pushEvent(e: AgentEvent): void {
		if (waiters.length > 0) {
			const w = waiters.shift();
			w?.(e);
		} else {
			eventQueue.push(e);
		}
	}

	function close(): void {
		closed = true;
		while (waiters.length > 0) {
			const w = waiters.shift();
			w?.(null);
		}
	}

	const provider: AgentProvider = {
		providerId: "claude",
		query(_p: AgentQueryParams): AgentSession {
			queryCallCount++;
			const queryIndex = queryCallCount;
			let started = false;
			const cachedIter: AsyncIterator<AgentEvent> = {
				async next(): Promise<IteratorResult<AgentEvent>> {
					if (closed) return { value: undefined as never, done: true };
					if (!started) {
						started = true;
						return {
							value: {
								type: "session_start",
								sessionId: `sdk-${queryIndex}`,
							},
							done: false,
						};
					}
					if (eventQueue.length > 0) {
						const next = eventQueue.shift();
						return { value: next as AgentEvent, done: false };
					}
					return new Promise<IteratorResult<AgentEvent>>((resolve) => {
						waiters.push((e) => {
							if (e === null) {
								resolve({ value: undefined as never, done: true });
							} else {
								resolve({ value: e, done: false });
							}
						});
					});
				},
			};
			return {
				[Symbol.asyncIterator]: () => cachedIter,
				send: vi.fn(async (_msg: string) => {
					pushEvent({
						type: "done",
						cost: 0,
						turns: 1,
						durationMs: 0,
						usage: { inputTokens: 1, outputTokens: 1 },
					});
				}),
				cancel: () => close(),
				mcpServerStatus: () => Promise.resolve([]),
			};
		},
	};
	return {
		provider,
		getQueryCallCount: () => queryCallCount,
		closeStream: close,
	};
}

// Bun doesn't support waitFor() — poll until assertion passes or timeout
export async function waitFor(fn: () => void, timeout = 1000): Promise<void> {
	const deadline = Date.now() + timeout;
	while (Date.now() < deadline) {
		try {
			fn();
			return;
		} catch {
			/* keep polling */
		}
		await new Promise((r) => setTimeout(r, 10));
	}
	fn(); // final attempt — throws if still failing
}
