/**
 * SessionManager — model/provider/effort/permission settings, recap + provider resolution.
 * Shared module mocks and provider builders: see session.test-utils.ts.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./config", async () =>
	(await import("./session.test-utils")).mockConfigModule(),
);
vi.mock("./agentPaths", async () =>
	(await import("./session.test-utils")).mockAgentPaths(),
);
vi.mock("../lib/claudePath", async () =>
	(await import("./session.test-utils")).mockClaudePath(),
);
vi.mock("../db", async () =>
	(await import("./session.test-utils")).mockDbModule(),
);
vi.mock("./recap", async () =>
	(await import("./session.test-utils")).mockRecap(),
);
vi.mock("./claudeWarmup", async () =>
	(await import("./session.test-utils")).mockClaudeWarmup(),
);
vi.mock("./umbod", async () =>
	(await import("./session.test-utils")).mockUmbod(),
);
vi.mock("./executionContext", async () =>
	(await import("./session.test-utils")).mockExecutionContext(),
);
vi.mock("./libraryStore", async () =>
	(await import("./session.test-utils")).mockLibraryStore(),
);
vi.mock("./promptBuilder", async () =>
	(await import("./session.test-utils")).mockPromptBuilder(),
);
vi.mock("./obsidianCli", async () =>
	(await import("./session.test-utils")).mockObsidianCli(),
);
vi.mock("node:fs", async () =>
	(await import("./session.test-utils")).mockNodeFs(),
);

import * as fsMock from "node:fs";
import type { HlidConfig } from "../config";
import * as dbMock from "../db";
import * as agentPathsMock from "./agentPaths";
import type {
	AgentEvent,
	AgentProvider,
	AgentQueryParams,
	AgentSession,
} from "./agentProvider";
import { resolveExecutionContext } from "./executionContext";
import { generateTurnRecap } from "./recap";
import { SessionManager } from "./session";
import {
	makeCaptureProvider,
	makeConfig,
	makeConfigWithAgent,
	makeControlledProvider,
	makeProvider,
	makeProviders,
	makeRecapTriggerProvider,
	makeSwitchableProvider,
} from "./session.test-utils";

describe("SessionManager — setModel", () => {
	it("updates getStatus().model with no active AgentSession (no-op delegate)", async () => {
		const sm = new SessionManager(
			makeConfig("model-a"),
			makeProviders(makeProvider("Bash")),
		);
		await sm.setModel("model-b");
		expect(sm.getStatus().model).toBe("model-b");
	});

	it("resets to the provider default (empty string) when called with undefined", async () => {
		const sm = new SessionManager(
			makeConfig("model-a"),
			makeProviders(makeProvider("Bash")),
		);
		await sm.setModel(undefined);
		expect(sm.getStatus().model).toBe("");
	});

	it("delegates to the active AgentSession's setModel", async () => {
		const setModel = vi.fn().mockResolvedValue(undefined);
		const { provider, getSession } = makeSwitchableProvider({ setModel });
		const sm = new SessionManager(
			makeConfig("model-a"),
			makeProviders(provider),
		);
		await sm.runQuery("hi", () => {}, {
			sessionId: "sess-1",
		});

		await sm.setModel("model-b");
		expect(getSession()?.setModel).toHaveBeenCalledWith("model-b");
		expect(sm.getStatus().model).toBe("model-b");
		expect(dbMock.setSessionModel).toHaveBeenCalledWith("sess-1", "model-b");
	});

	it("restores a saved session model instead of the current config model", async () => {
		const { provider, captured } = makeCaptureProvider("claude");
		vi.mocked(dbMock.getSessionModel).mockResolvedValueOnce("claude-fable-5");
		vi.mocked(dbMock.getSessionMessages).mockResolvedValueOnce([
			{ role: "user", text: "prior" },
		] as never);
		const sm = new SessionManager(
			makeConfig("gpt-5.6-sol"),
			makeProviders(provider),
		);

		await sm.runQuery("continue", () => {}, {
			sessionId: "saved-session",
		});

		expect(captured.params?.model).toBe("claude-fable-5");
		expect(sm.getStatus().model).toBe("claude-fable-5");
	});

	it("does not replace the globally focused session for a background turn", async () => {
		const { provider } = makeCaptureProvider("claude");
		vi.mocked(dbMock.getSessionById).mockResolvedValueOnce({
			id: "delegated-child",
			label: "Delegated child",
		} as never);
		vi.mocked(dbMock.setCurrentSessionId).mockClear();
		const sm = new SessionManager(makeConfig(), makeProviders(provider));

		await sm.runQuery("continue in the background", () => {}, {
			sessionId: "delegated-child",
			backgroundSession: true,
		});

		expect(dbMock.setCurrentSessionId).not.toHaveBeenCalled();
		expect(sm.getCurrentSessionId()).toBe("delegated-child");
	});

	it("rejects imported provider history before making it a live session", async () => {
		const query = vi.fn<AgentProvider["query"]>();
		const provider: AgentProvider = { providerId: "claude", query };
		vi.mocked(dbMock.getSessionById).mockResolvedValueOnce({
			id: "history:claude:old-session",
			label: "IMPORTED CLAUDE SESSION",
			history_imported: 1,
		} as never);
		vi.mocked(dbMock.setCurrentSessionId).mockClear();
		vi.mocked(dbMock.appendMessage).mockClear();
		const sm = new SessionManager(makeConfig(), makeProviders(provider));

		await expect(
			sm.runQuery("continue", () => {}, {
				sessionId: "history:claude:old-session",
			}),
		).rejects.toThrow(
			"This imported provider history has accounting data only and cannot be resumed.",
		);

		expect(query).not.toHaveBeenCalled();
		expect(dbMock.setCurrentSessionId).not.toHaveBeenCalled();
		expect(dbMock.appendMessage).not.toHaveBeenCalled();
		expect(sm.getCurrentSessionId()).toBeNull();
		expect(sm.getStatus().state).toBe("idle");
	});

	it("resumes an imported session when provider resume metadata is present", async () => {
		const { provider, captured } = makeCaptureProvider("claude");
		vi.mocked(dbMock.getSessionById).mockResolvedValueOnce({
			id: "history:claude:resumable",
			label: "Imported Claude CLI",
			history_imported: 1,
			history_resume_mode: "session-store",
		} as never);
		vi.mocked(dbMock.getSessionProviderId).mockResolvedValueOnce("claude");
		vi.mocked(dbMock.getSessionProviderSession).mockResolvedValueOnce(
			"claude-native-id",
		);
		vi.mocked(dbMock.getSessionMessages).mockResolvedValueOnce([
			{ role: "user", text: "prior" },
		] as never);
		const sm = new SessionManager(makeConfig(), makeProviders(provider));

		await sm.runQuery("continue", () => {}, {
			sessionId: "history:claude:resumable",
		});

		expect(captured.params?.sessionId).toBe("claude-native-id");
		expect(captured.params?.historyResumeMode).toBe("session-store");
	});

	it("restores saved effort and permission instead of current config defaults", async () => {
		const { provider, captured } = makeCaptureProvider("claude");
		vi.mocked(dbMock.getSessionById).mockResolvedValueOnce({
			id: "saved-session",
			label: "SAVED",
			selected_effort: "high",
			selected_permission_mode: "bypassPermissions",
		} as never);
		vi.mocked(dbMock.getSessionMessages).mockResolvedValueOnce([
			{ role: "user", text: "prior" },
		] as never);
		const sm = new SessionManager(makeConfig(), makeProviders(provider));

		await sm.runQuery("continue", () => {}, {
			sessionId: "saved-session",
		});

		expect(captured.params).toMatchObject({
			effort: "high",
			permissionMode: "bypassPermissions",
		});
		expect(sm.getStatus()).toMatchObject({
			effort: "high",
			permission_mode: "bypassPermissions",
		});
	});

	it("restores a saved session label into live status", async () => {
		const { provider } = makeCaptureProvider("claude");
		vi.mocked(dbMock.getSessionById).mockResolvedValueOnce({
			id: "saved-session",
			label: "MY SAVED NAME",
		} as never);
		vi.mocked(dbMock.getSessionMessages).mockResolvedValueOnce([
			{ role: "user", text: "prior" },
		] as never);
		const sm = new SessionManager(makeConfig(), makeProviders(provider));
		let labelWhileRunning: string | null | undefined;

		await sm.runQuery(
			"continue",
			(event) => {
				if (event.type === "status" && event.state === "running") {
					labelWhileRunning = sm.getSessionLabel();
				}
			},
			{
				sessionId: "saved-session",
			},
		);

		expect(labelWhileRunning).toBe("MY SAVED NAME");
		expect(sm.getSessionLabel()).toBe("MY SAVED NAME");
	});

	it("restores and refreshes live pin, fork, and delegation presentation", async () => {
		const { provider } = makeCaptureProvider("claude");
		vi.mocked(dbMock.getSessionById).mockResolvedValueOnce({
			id: "saved-session",
			label: "CHILD",
			pinned: 1,
			fork_parent_session_id: "source",
			fork_parent_label: "Original",
			fork_kind: "exact",
			delegation_parent_session_id: "delegator",
			delegation_parent_label: "Parent task",
			delegation_parent_turn_id: "parent-turn",
			delegation_depth: 1,
		} as never);
		vi.mocked(dbMock.getSessionMessages).mockResolvedValueOnce([
			{ role: "user", text: "prior" },
		] as never);
		const sm = new SessionManager(makeConfig(), makeProviders(provider));

		await sm.runQuery("continue", () => {}, {
			sessionId: "saved-session",
		});
		expect(sm.getSessionPresentation()).toEqual({
			pinned: true,
			forkParentSessionId: "source",
			forkParentLabel: "Original",
			forkKind: "exact",
			delegationParentSessionId: "delegator",
			delegationParentLabel: "Parent task",
			delegationParentTurnId: "parent-turn",
			delegationDepth: 1,
		});

		sm.setSessionPinned(false);
		sm.setForkParentLabel("source", "Renamed source");
		sm.setForkParentLabel("delegator", "Renamed parent");
		expect(sm.getSessionPresentation()).toEqual({
			pinned: false,
			forkParentSessionId: "source",
			forkParentLabel: "Renamed source",
			forkKind: "exact",
			delegationParentSessionId: "delegator",
			delegationParentLabel: "Renamed parent",
			delegationParentTurnId: "parent-turn",
			delegationDepth: 1,
		});
	});

	it("resumes after the maximum persisted transcript sequence", async () => {
		const { provider } = makeCaptureProvider("claude");
		vi.mocked(dbMock.getSessionMessages).mockResolvedValueOnce([
			{ role: "user", text: "prior" },
		] as never);
		vi.mocked(dbMock.getSessionNextMessageSeq).mockResolvedValueOnce(8);
		vi.mocked(dbMock.appendMessage).mockClear();
		const sm = new SessionManager(makeConfig(), makeProviders(provider));

		await sm.runQuery("continue", () => {}, {
			sessionId: "saved-session",
		});

		expect(dbMock.getSessionMessages).toHaveBeenCalledWith(
			"saved-session",
			undefined,
			1,
		);
		expect(dbMock.appendMessage).toHaveBeenCalledWith(
			"saved-session",
			8,
			"user",
			"continue",
			undefined,
			undefined,
			expect.stringContaining('"contractVersion":1'),
		);
	});
});

describe("SessionManager — setProvider", () => {
	it("switches CLI per chat and hands the persisted transcript to the new provider", async () => {
		const claudeSend = vi.fn().mockResolvedValue(undefined);
		const piSend = vi.fn().mockResolvedValue(undefined);
		const makeCli = (providerId: string, send: AgentSession["send"]) => ({
			providerId,
			query: (): AgentSession => {
				const gen = (async function* (): AsyncGenerator<AgentEvent> {
					yield { type: "session_start", sessionId: `${providerId}-session` };
					yield {
						type: "done",
						cost: 0,
						turns: 1,
						durationMs: 0,
						usage: { inputTokens: 1, outputTokens: 1 },
					};
				})();
				return {
					[Symbol.asyncIterator]: () => gen[Symbol.asyncIterator](),
					cancel: vi.fn(),
					send,
				};
			},
		});
		const sm = new SessionManager(
			makeConfig("claude-sonnet-4-6"),
			new Map([
				["claude", makeCli("claude", claudeSend)],
				["pi", makeCli("pi", piSend)],
			]),
		);

		await sm.runQuery("first", () => {}, {
			sessionId: "switch-chat",
		});
		vi.mocked(dbMock.getSessionMessages).mockResolvedValueOnce([
			{ role: "user", text: "first", seq: 0 },
			{ role: "assistant", text: "prior answer", seq: 1 },
			{
				role: "user",
				text: "steered direction",
				seq: 2,
				steer_target_seq: 1,
			},
		] as never);
		await sm.setProvider("pi", {
			model: "pi-pro",
			effort: "medium",
			permissionMode: "default",
		});
		await sm.runQuery("continue", () => {}, {
			sessionId: "switch-chat",
		});

		expect(claudeSend).toHaveBeenCalledTimes(1);
		expect(piSend).toHaveBeenCalledTimes(1);
		expect(piSend.mock.calls[0]?.[0]).toContain("<hlid_provider_handoff>");
		expect(piSend.mock.calls[0]?.[0]).toContain("USER: first");
		expect(piSend.mock.calls[0]?.[0]).toContain("ASSISTANT: prior answer");
		const handoff = String(piSend.mock.calls[0]?.[0]);
		expect(handoff.indexOf("USER: steered direction")).toBeLessThan(
			handoff.indexOf("ASSISTANT: prior answer"),
		);
		expect(piSend.mock.calls[0]?.[0]).toContain("test prompt");
		expect(dbMock.setSessionProviderId).toHaveBeenCalledWith(
			"switch-chat",
			"pi",
		);
		expect(dbMock.setSessionModel).toHaveBeenCalledWith(
			"switch-chat",
			"pi-pro",
		);
		expect(dbMock.setSessionEffort).toHaveBeenCalledWith(
			"switch-chat",
			"medium",
		);
		expect(dbMock.setSessionPermissionMode).toHaveBeenCalledWith(
			"switch-chat",
			"default",
		);
	});

	it("rejects unavailable CLI identifiers", async () => {
		const sm = new SessionManager(
			makeConfig(),
			makeProviders(makeProvider("Bash")),
		);
		await expect(sm.setProvider("missing")).rejects.toThrow(
			"Unknown or unavailable provider: missing",
		);
	});

	it("retires a live CLIProxy session and falls back to the configured provider", async () => {
		const proxyCancel = vi.fn();
		const makeCli = (providerId: string, cancel = vi.fn()) => ({
			providerId,
			query: (): AgentSession => {
				const gen = (async function* (): AsyncGenerator<AgentEvent> {
					yield { type: "session_start", sessionId: `${providerId}-session` };
					yield {
						type: "done",
						cost: 0,
						turns: 1,
						durationMs: 0,
						usage: { inputTokens: 1, outputTokens: 1 },
					};
				})();
				return {
					[Symbol.asyncIterator]: () => gen[Symbol.asyncIterator](),
					cancel,
					send: vi.fn().mockResolvedValue(undefined),
				};
			},
		});
		const providers = new Map([
			["claude", makeCli("claude")],
			["cliproxy-codex", makeCli("cliproxy-codex", proxyCancel)],
		]);
		const sm = new SessionManager(makeConfig("claude-sonnet-4-6"), providers);
		await sm.setProvider("cliproxy-codex", { model: "gpt-5.6-sol" });
		await sm.runQuery("first", () => {}, {
			sessionId: "retire-proxy-chat",
		});

		providers.delete("cliproxy-codex");
		expect(sm.retireProviderSessions(new Set(["cliproxy-codex"]))).toBe(true);
		sm.syncConfig(makeConfig("claude-sonnet-4-6"));

		expect(proxyCancel).toHaveBeenCalledOnce();
		expect(sm.getProviderId()).toBe("claude");
		expect(sm.getStatus().model).toBe("claude-sonnet-4-6");
	});
});

describe("SessionManager — setEffort", () => {
	it("updates getStatus().effort with no active AgentSession", async () => {
		const sm = new SessionManager(
			makeConfig(),
			makeProviders(makeProvider("Bash")),
		);
		await sm.setEffort("xhigh");
		expect(sm.getStatus().effort).toBe("xhigh");
	});

	it("delegates live effort changes without rebuilding a capable provider", async () => {
		const setEffort = vi.fn().mockResolvedValue(undefined);
		const { provider, getSession } = makeSwitchableProvider({ setEffort });
		const sm = new SessionManager(makeConfig(), makeProviders(provider));
		await sm.runQuery("first", () => {}, {
			sessionId: "live-effort",
		});
		const firstSession = getSession();

		await sm.setEffort("xhigh");
		await sm.runQuery("second", () => {}, {
			sessionId: "live-effort",
		});

		expect(getSession()?.setEffort).toHaveBeenCalledWith("xhigh");
		expect(getSession()).toBe(firstSession);
		expect(dbMock.setSessionEffort).toHaveBeenCalledWith(
			"live-effort",
			"xhigh",
		);
	});

	it("rebuilds and resumes Claude on the next turn when effort changes", async () => {
		const params: AgentQueryParams[] = [];
		const cancels: ReturnType<typeof vi.fn>[] = [];
		const provider: AgentProvider = {
			providerId: "claude",
			query(queryParams): AgentSession {
				params.push(queryParams);
				const index = params.length;
				const gen = (async function* (): AsyncGenerator<AgentEvent> {
					yield { type: "session_start", sessionId: `claude-session-${index}` };
					yield {
						type: "done",
						cost: 0,
						turns: 1,
						durationMs: 0,
						usage: { inputTokens: 10, outputTokens: 5 },
					};
				})();
				const cancel = vi.fn();
				cancels.push(cancel);
				return {
					[Symbol.asyncIterator]: () => gen[Symbol.asyncIterator](),
					cancel,
					send: vi.fn().mockResolvedValue(undefined),
				};
			},
		};
		const sm = new SessionManager(makeConfig(), makeProviders(provider));
		await sm.runQuery("first", () => {}, {
			sessionId: "claude-effort",
		});

		await sm.setEffort("max");
		await sm.runQuery("second", () => {}, {
			sessionId: "claude-effort",
		});

		expect(params).toHaveLength(2);
		expect(cancels[0]).toHaveBeenCalledOnce();
		expect(params[1]).toMatchObject({
			effort: "max",
			sessionId: "claude-session-1",
		});
	});
});

describe("SessionManager — per-turn plan mode", () => {
	it("synchronizes plan mode on a cached provider session", async () => {
		const setPermissionMode = vi.fn().mockResolvedValue(undefined);
		const setPlanHtmlPath = vi.fn();
		const { provider } = makeSwitchableProvider({
			setPermissionMode,
			setPlanHtmlPath,
		});
		const sm = new SessionManager(makeConfig(), makeProviders(provider));

		await sm.runQuery("plan this", () => {}, {
			sessionId: "session-plan-toggle",
			planMode: true,
			planHtml: true,
		});
		await sm.runQuery("continue normally", () => {}, {
			sessionId: "session-plan-toggle",
			planMode: false,
		});

		expect(setPermissionMode).toHaveBeenNthCalledWith(1, "plan");
		expect(setPermissionMode).toHaveBeenNthCalledWith(2, "default");
		expect(setPlanHtmlPath).toHaveBeenNthCalledWith(
			1,
			"/tmp/hlid-test-library/staging/plans/plan-session-plan-toggle.html",
		);
		expect(setPlanHtmlPath).toHaveBeenNthCalledWith(2, undefined);
	});
});

describe("SessionManager — setPermissionMode", () => {
	it("rejects an unknown mode without mutating state", async () => {
		const sm = new SessionManager(
			makeConfig(),
			makeProviders(makeProvider("Bash")),
		);
		await expect(sm.setPermissionMode("bogus")).rejects.toThrow(
			"Unknown permission mode: bogus",
		);
		expect(sm.getStatus().permission_mode).toBe("default");
	});

	it("updates getStatus().permission_mode and delegates to the active AgentSession", async () => {
		const setPermissionMode = vi.fn().mockResolvedValue(undefined);
		const { provider, getSession } = makeSwitchableProvider({
			setPermissionMode,
		});
		const sm = new SessionManager(makeConfig(), makeProviders(provider));
		await sm.runQuery("hi", () => {}, {
			sessionId: "sess-1",
		});

		await sm.setPermissionMode("acceptEdits");
		expect(getSession()?.setPermissionMode).toHaveBeenCalledWith("acceptEdits");
		expect(sm.getStatus().permission_mode).toBe("acceptEdits");
		expect(dbMock.setSessionPermissionMode).toHaveBeenCalledWith(
			"sess-1",
			"acceptEdits",
		);
	});
});

describe("SessionManager — summary passed to recap", () => {
	it("passes summary to generateTurnRecap as sdkSummary", async () => {
		const config = makeConfig();
		config.claude.turn_recaps = true;

		const provider: AgentProvider = {
			providerId: "claude",
			query(_params: AgentQueryParams): AgentSession {
				const gen = (async function* (): AsyncGenerator<AgentEvent> {
					yield { type: "session_start", sessionId: "sdk-s1" };
					yield {
						type: "tool_start",
						toolId: "t1",
						name: "Bash",
						input: {},
					};
					yield { type: "summary", text: "Ran lint and fixed 2 warnings." };
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

		const sm = new SessionManager(config, makeProviders(provider));
		await sm.runQuery("fix lint", () => {}, {
			sessionId: "sess-sdk",
		});

		const recapMock = vi.mocked(generateTurnRecap);
		expect(recapMock).toHaveBeenCalled();
		const lastCall = recapMock.mock.calls[recapMock.mock.calls.length - 1];
		expect(lastCall[0].sdkSummary).toBe("Ran lint and fixed 2 warnings.");
	});

	it("passes null sdkSummary when no summary event emitted", async () => {
		const config = makeConfig();
		config.claude.turn_recaps = true;

		const provider: AgentProvider = {
			providerId: "claude",
			query(_params: AgentQueryParams): AgentSession {
				const gen = (async function* (): AsyncGenerator<AgentEvent> {
					yield { type: "session_start", sessionId: "sdk-s2" };
					yield { type: "tool_start", toolId: "t2", name: "Bash", input: {} };
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

		const sm = new SessionManager(config, makeProviders(provider));
		vi.mocked(generateTurnRecap).mockClear();
		await sm.runQuery("hello", () => {}, {
			sessionId: "sess-no-sdk",
		});

		const recapMock = vi.mocked(generateTurnRecap);
		expect(recapMock).toHaveBeenCalled();
		const lastCall = recapMock.mock.calls[recapMock.mock.calls.length - 1];
		expect(lastCall[0].sdkSummary).toBeNull();
	});
});

// ── recap model resolution ────────────────────────────────────────────────────

/** Provider that emits tool_start + text_delta to satisfy recap trigger conditions. */

describe("SessionManager — recap model resolution", () => {
	it("uses claude-haiku-4-5 when no recap_model set in config", async () => {
		const config = makeConfig();
		config.claude.turn_recaps = true;
		const sm = new SessionManager(
			config,
			makeProviders(makeRecapTriggerProvider()),
		);
		vi.mocked(generateTurnRecap).mockClear();
		await sm.runQuery("hello", () => {}, {
			sessionId: "sess-rm-default",
		});

		const recapMock = vi.mocked(generateTurnRecap);
		expect(recapMock).toHaveBeenCalled();
		const lastCall = recapMock.mock.calls[recapMock.mock.calls.length - 1];
		expect(lastCall[0].recapModel).toBe("claude-haiku-4-5");
	});

	it("uses global recap_model from config when set", async () => {
		const config = makeConfig();
		config.claude.turn_recaps = true;
		config.claude.recap_model = "claude-sonnet-4-6";
		const sm = new SessionManager(
			config,
			makeProviders(makeRecapTriggerProvider()),
		);
		vi.mocked(generateTurnRecap).mockClear();
		await sm.runQuery("hello", () => {}, {
			sessionId: "sess-rm-global",
		});

		const recapMock = vi.mocked(generateTurnRecap);
		expect(recapMock).toHaveBeenCalled();
		const lastCall = recapMock.mock.calls[recapMock.mock.calls.length - 1];
		expect(lastCall[0].recapModel).toBe("claude-sonnet-4-6");
	});
});

describe("SessionManager — per-agent recap model", () => {
	const AGENT_PATH = "/tmp/test-agent-recap";

	beforeEach(() => {
		vi.mocked(agentPathsMock.isAllowedAgentPath).mockReturnValue(true);
		vi.mocked(agentPathsMock.computeAllowedAgentRealPaths).mockReturnValue([
			AGENT_PATH,
		]);
		// biome-ignore lint/suspicious/noExplicitAny: PathLike vs string mock type mismatch
		vi.mocked(fsMock.realpathSync).mockImplementation((p: any) => p as string);
	});

	it("uses agent recap_model overriding global", async () => {
		const config = makeConfigWithAgent(AGENT_PATH, {
			recap_model: "claude-haiku-4-5-20251001",
		});
		config.claude.turn_recaps = true;
		config.claude.recap_model = "claude-sonnet-4-6";
		const sm = new SessionManager(
			config,
			makeProviders(makeRecapTriggerProvider()),
		);
		vi.mocked(generateTurnRecap).mockClear();
		await sm.runQuery("hello", () => {}, {
			sessionId: "sess-rm-agent",
			agentCwd: AGENT_PATH,
		});

		const recapMock = vi.mocked(generateTurnRecap);
		expect(recapMock).toHaveBeenCalled();
		const lastCall = recapMock.mock.calls[recapMock.mock.calls.length - 1];
		expect(lastCall[0].recapModel).toBe("claude-haiku-4-5-20251001");
	});

	it("falls back to global recap_model when agent has none", async () => {
		const config = makeConfigWithAgent(AGENT_PATH);
		config.claude.turn_recaps = true;
		config.claude.recap_model = "claude-sonnet-4-6";
		const sm = new SessionManager(
			config,
			makeProviders(makeRecapTriggerProvider()),
		);
		vi.mocked(generateTurnRecap).mockClear();
		await sm.runQuery("hello", () => {}, {
			sessionId: "sess-rm-fallback",
			agentCwd: AGENT_PATH,
		});

		const recapMock = vi.mocked(generateTurnRecap);
		expect(recapMock).toHaveBeenCalled();
		const lastCall = recapMock.mock.calls[recapMock.mock.calls.length - 1];
		expect(lastCall[0].recapModel).toBe("claude-sonnet-4-6");
	});
});

// ── helpers for provider resolution / per-agent settings tests ────────────────

/** Build a provider that captures query params. Returns provider + captured-ref. */

describe("SessionManager — provider resolution", () => {
	const AGENT_PATH = "/tmp/test-agent";

	beforeEach(() => {
		vi.mocked(agentPathsMock.isAllowedAgentPath).mockReturnValue(false);
		vi.mocked(agentPathsMock.computeAllowedAgentRealPaths).mockReturnValue([]);
		// biome-ignore lint/suspicious/noExplicitAny: PathLike vs string mock type mismatch
		vi.mocked(fsMock.realpathSync).mockImplementation((p: any) => p as string);
	});

	it("vault query uses vaultProviderId from config", async () => {
		const { provider, captured } = makeCaptureProvider("claude");
		const config: HlidConfig = {
			...makeConfig(),
			vault_provider: "claude",
		} as unknown as HlidConfig;
		const sm = new SessionManager(config, makeProviders(provider));
		await sm.runQuery("hello", () => {}, {
			sessionId: "sess-v",
		});
		expect(captured.params).not.toBeNull();
		// vault query: model should be the vault model
		expect(captured.params).toMatchObject({
			providerId: "claude",
			vaultName: "Test",
			agentMode: "cwd",
			model: "claude-test",
		});
	});

	it("agent query uses provider from agentProviderMap when set", async () => {
		const { provider: claudeProvider, captured: claudeCaptured } =
			makeCaptureProvider("claude");
		const { provider: altProvider, captured: altCaptured } =
			makeCaptureProvider("alt");
		const config = makeConfigWithAgent(AGENT_PATH, { provider: "alt" });
		const providers = new Map([
			["claude", claudeProvider],
			["alt", altProvider],
		]);
		vi.mocked(agentPathsMock.isAllowedAgentPath).mockReturnValue(true);
		vi.mocked(agentPathsMock.computeAllowedAgentRealPaths).mockReturnValue([
			AGENT_PATH,
		]);
		const sm = new SessionManager(config, providers);
		await sm.runQuery("hello", () => {}, {
			sessionId: "sess-a",
			agentCwd: AGENT_PATH,
		});
		expect(altCaptured.params).not.toBeNull();
		expect(claudeCaptured.params).toBeNull();
	});

	it("restored session keeps its saved provider after agent config changes", async () => {
		const { provider: claudeProvider, captured: claudeCaptured } =
			makeCaptureProvider("claude");
		const { provider: codexProvider, captured: codexCaptured } =
			makeCaptureProvider("codex");
		const config = makeConfigWithAgent(AGENT_PATH, {
			provider: "codex",
			model: "gpt-5.6-sol",
		});
		const providers = new Map([
			["claude", claudeProvider],
			["codex", codexProvider],
		]);
		vi.mocked(dbMock.getSessionMessages).mockResolvedValueOnce([
			{ role: "user", text: "prior" },
		] as never);
		vi.mocked(dbMock.getSessionAgentCwd).mockResolvedValueOnce(AGENT_PATH);
		vi.mocked(dbMock.getSessionModel).mockResolvedValueOnce("claude-fable-5");
		vi.mocked(dbMock.getSessionProviderId).mockResolvedValueOnce("claude");
		vi.mocked(dbMock.getSessionProviderSession).mockResolvedValueOnce(
			"claude-session-id",
		);

		const sm = new SessionManager(config, providers);
		await sm.runQuery("continue", () => {}, {
			sessionId: "saved-session",
		});

		expect(claudeCaptured.params).toMatchObject({
			model: "claude-fable-5",
			sessionId: "claude-session-id",
		});
		expect(codexCaptured.params).toBeNull();
		expect(dbMock.setSessionProviderId).toHaveBeenCalledWith(
			"saved-session",
			"claude",
		);
	});

	it("agent query falls back to vaultProviderId when agent not in map", async () => {
		// Agent config has no provider set — should fall back to vault provider ("claude").
		// Register two providers; only the vault one should be called.
		const { provider: claudeProvider, captured: claudeCaptured } =
			makeCaptureProvider("claude");
		const { provider: altProvider, captured: altCaptured } =
			makeCaptureProvider("alt");
		// Agent entry omits provider so it maps to "claude" (vault default)
		const config = makeConfigWithAgent(AGENT_PATH);
		const providers = new Map([
			["claude", claudeProvider],
			["alt", altProvider],
		]);
		vi.mocked(agentPathsMock.isAllowedAgentPath).mockReturnValue(true);
		vi.mocked(agentPathsMock.computeAllowedAgentRealPaths).mockReturnValue([
			AGENT_PATH,
		]);
		const sm = new SessionManager(config, providers);
		await sm.runQuery("hello", () => {}, {
			sessionId: "sess-b",
			agentCwd: AGENT_PATH,
		});
		expect(claudeCaptured.params).not.toBeNull(); // vault provider was used
		expect(altCaptured.params).toBeNull(); // alt provider was NOT used
	});

	it("rejects with 'No providers' when no providers registered", async () => {
		const sm = new SessionManager(makeConfig(), new Map());
		await expect(
			sm.runQuery("hello", () => {}, {
				sessionId: "sess-c",
			}),
		).rejects.toThrow(/No providers/);
	});

	it("passes Windows Computer Use preferences into Codex sessions", async () => {
		const { provider, captured } = makeCaptureProvider("codex");
		const config = {
			...makeConfig("gpt-5.5"),
			vault_provider: "codex",
			codex: {
				model: "gpt-5.5",
				effort: "high",
				permission_mode: "default",
				turn_recaps: false,
				windows_computer_use: { model: "inherit", effort: "medium" },
			},
		} as HlidConfig;
		const sm = new SessionManager(config, makeProviders(provider));

		await sm.runQuery("hello", () => {}, {
			sessionId: "computer-use-settings",
		});

		expect(captured.params?.windowsComputerUse).toEqual({
			model: "inherit",
			effort: "medium",
		});
	});

	it("translates Windows sandbox roots for a WSL-backed Codex session", async () => {
		vi.mocked(resolveExecutionContext).mockReturnValueOnce({
			activeCwd:
				"\\\\wsl.localhost\\Ubuntu-24.04\\home\\kyle\\development\\repos\\seidr",
			extraDirs: new Set(["C:\\Users\\kyleu\\Documents\\Obsidian\\Fornbok"]),
			executable: "C:\\Users\\kyleu\\AppData\\Local\\Hlid\\wrappers\\codex.cmd",
		});
		const { provider, captured } = makeCaptureProvider("codex");
		const config = {
			...makeConfig("gpt-5.6-sol"),
			vault_provider: "codex",
			codex: {
				model: "gpt-5.6-sol",
				effort: "low",
				permission_mode: "default",
				turn_recaps: false,
			},
		} as HlidConfig;
		const sm = new SessionManager(config, makeProviders(provider));

		await sm.runQuery("CU isolation test", () => {}, {
			sessionId: "wsl-codex-default",
		});

		expect(captured.params?.permissionMode).toBe("default");
		expect(captured.params?.additionalDirectories).toEqual([
			"/mnt/c/Users/kyleu/Documents/Obsidian/Fornbok",
		]);
	});
});

// ── SessionManager — per-agent settings ──────────────────────────────────────

describe("SessionManager — per-agent settings", () => {
	const AGENT_PATH = "/tmp/test-agent-settings";

	beforeEach(() => {
		vi.mocked(agentPathsMock.isAllowedAgentPath).mockReturnValue(true);
		vi.mocked(agentPathsMock.computeAllowedAgentRealPaths).mockReturnValue([
			AGENT_PATH,
		]);
		// biome-ignore lint/suspicious/noExplicitAny: PathLike vs string mock type mismatch
		vi.mocked(fsMock.realpathSync).mockImplementation((p: any) => p as string);
	});

	it("agent query uses agent-specific model when configured", async () => {
		const { provider, captured } = makeCaptureProvider("claude");
		const config = makeConfigWithAgent(AGENT_PATH, {
			model: "claude-opus-4-7",
		});
		const sm = new SessionManager(config, makeProviders(provider));
		await sm.runQuery("hello", () => {}, {
			sessionId: "sess-m",
			agentCwd: AGENT_PATH,
		});
		expect(captured.params?.model).toBe("claude-opus-4-7");
		expect(dbMock.createSession).toHaveBeenCalledWith(
			"sess-m",
			"HELLO",
			"claude-opus-4-7",
			{ effort: "medium", permissionMode: "default" },
		);
	});

	it("seeds idle pool status from the configured agent", () => {
		const config = makeConfigWithAgent(AGENT_PATH, {
			model: "claude-opus-4-7",
			effort: "high",
			permission_mode: "bypassPermissions",
		});

		const sm = new SessionManager(
			config,
			makeProviders(makeProvider("Bash")),
			AGENT_PATH,
		);

		expect(sm.getStatus()).toMatchObject({
			model: "claude-opus-4-7",
			effort: "high",
			permission_mode: "bypassPermissions",
		});
	});

	it("agent query uses agent-specific effort when configured", async () => {
		const { provider, captured } = makeCaptureProvider("claude");
		const config = makeConfigWithAgent(AGENT_PATH, { effort: "low" });
		const sm = new SessionManager(config, makeProviders(provider));
		await sm.runQuery("hello", () => {}, {
			sessionId: "sess-e",
			agentCwd: AGENT_PATH,
		});
		expect(captured.params?.effort).toBe("low");
	});

	it("keeps WSL caller settings ahead of unrelated vault defaults for Computer Use inheritance", async () => {
		const { provider, captured } = makeCaptureProvider("codex");
		const config = makeConfigWithAgent(AGENT_PATH, {
			provider: "codex",
			model: "gpt-5.6-sol",
			effort: "high",
		});
		config.vault_provider = "codex";
		config.codex = {
			model: "gpt-5.6-terra",
			effort: "medium",
			permission_mode: "default",
			turn_recaps: false,
			windows_computer_use: { model: "inherit", effort: "inherit" },
		};
		const sm = new SessionManager(config, makeProviders(provider));

		await sm.runQuery("hello", () => {}, {
			sessionId: "wsl-caller-inheritance",
			agentCwd: AGENT_PATH,
		});

		expect(captured.params).toMatchObject({
			model: "gpt-5.6-sol",
			effort: "high",
			windowsComputerUse: { model: "inherit", effort: "inherit" },
		});
	});

	it("agent query uses agent-specific permissionMode when configured", async () => {
		const { provider, captured } = makeCaptureProvider("claude");
		const config = makeConfigWithAgent(AGENT_PATH, {
			permission_mode: "bypassPermissions",
		});
		const sm = new SessionManager(config, makeProviders(provider));
		await sm.runQuery("hello", () => {}, {
			sessionId: "sess-pm",
			agentCwd: AGENT_PATH,
		});
		expect(captured.params?.permissionMode).toBe("bypassPermissions");
	});

	it.each([
		"claude",
		"codex",
	])("session picker overrides outrank %s agent defaults on the first turn", async (providerId) => {
		const { provider, captured } = makeCaptureProvider(providerId);
		const config = makeConfigWithAgent(AGENT_PATH, {
			provider: providerId,
			model: "configured-model",
			effort: "high",
			permission_mode: "default",
		});
		const sm = new SessionManager(config, makeProviders(provider));
		await sm.setModel("picked-model");
		await sm.setEffort("xhigh");
		await sm.setPermissionMode("bypassPermissions");

		await sm.runQuery("hello", () => {}, {
			sessionId: `sess-overrides-${providerId}`,
			agentCwd: AGENT_PATH,
		});

		expect(captured.params).toMatchObject({
			model: "picked-model",
			effort: "xhigh",
			permissionMode: "bypassPermissions",
		});
	});

	it("plan_mode=true overrides permissionMode to 'plan' without mutating config", async () => {
		const { provider, captured } = makeCaptureProvider("claude");
		const config: HlidConfig = {
			...makeConfig(),
			vault_provider: "claude",
		} as unknown as HlidConfig;
		const sm = new SessionManager(config, makeProviders(provider));
		await sm.runQuery("hello", () => {}, {
			sessionId: "sess-plan",
			planMode: true,
		});
		expect(captured.params?.permissionMode).toBe("plan");
		expect(captured.params?.implementationPermissionMode).toBe("default");
		// config-level default remains unchanged
		expect(config.claude.permission_mode).toBe("default");
	});

	it("exposes the effective plan boundary only while that turn is active", async () => {
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const { provider, gateReached } = makeControlledProvider(
			[{ type: "session_start", sessionId: "sdk-plan-active" }],
			gate,
		);
		const sm = new SessionManager(makeConfig(), makeProviders(provider));
		const running = sm.runQuery("inspect only", () => {}, {
			sessionId: "sess-plan-active",
			turnId: "turn-plan-active",
			planMode: true,
		});

		await gateReached;
		expect(sm.getCurrentTurnPermissionMode()).toBe("plan");
		release();
		await running;
		expect(sm.getCurrentTurnPermissionMode()).toBeNull();
	});

	it("preserves auto-approve all as the post-plan implementation mode", async () => {
		const { provider, captured } = makeCaptureProvider("codex");
		const base = makeConfig();
		const config: HlidConfig = {
			...base,
			vault_provider: "codex",
			codex: { ...base.codex, permission_mode: "bypassPermissions" },
		};
		const sm = new SessionManager(config, makeProviders(provider));
		await sm.runQuery("hello", () => {}, {
			sessionId: "sess-plan-bypass",
			planMode: true,
		});
		expect(captured.params?.permissionMode).toBe("plan");
		expect(captured.params?.implementationPermissionMode).toBe(
			"bypassPermissions",
		);
	});

	it("agent query uses agent-specific maxTurns when configured", async () => {
		const { provider, captured } = makeCaptureProvider("claude");
		const config = makeConfigWithAgent(AGENT_PATH, { max_turns: 5 });
		const sm = new SessionManager(config, makeProviders(provider));
		await sm.runQuery("hello", () => {}, {
			sessionId: "sess-mt",
			agentCwd: AGENT_PATH,
		});
		expect(captured.params?.maxTurns).toBe(5);
	});

	it("agent query passes undefined model when agent has no model override (defers to CLAUDE.md)", async () => {
		const { provider, captured } = makeCaptureProvider("claude");
		const config = makeConfigWithAgent(AGENT_PATH);
		const sm = new SessionManager(config, makeProviders(provider));
		await sm.runQuery("hello", () => {}, {
			sessionId: "sess-nomodel",
			agentCwd: AGENT_PATH,
		});
		expect(captured.params?.model).toBeUndefined();
	});

	it("vault query always uses vault model (this.model)", async () => {
		const { provider, captured } = makeCaptureProvider("claude");
		const config: HlidConfig = {
			...makeConfig("vault-model-x"),
			vault_provider: "claude",
		} as unknown as HlidConfig;
		const sm = new SessionManager(config, makeProviders(provider));
		// No agentCwd — vault query
		await sm.runQuery("hello", () => {}, {
			sessionId: "sess-vault",
		});
		expect(captured.params?.model).toBe("vault-model-x");
	});
});

// ── Live tool_event persistence ────────────────────────────────────────────────
// Background: tool_event rows used to be persisted only at handleDone, alongside
// the assistant message row. SPA navigation away from /raven and back during a
// running query lost the in-memory reducer state, and the DB was empty for the
// in-flight turn — so tool calls vanished until the query finished AND the user
// did a full refresh. The current behavior pre-inserts an empty assistant
// message + tool_event rows on the first tool_start so a mid-turn reload sees
// them. Tool results UPDATE the row live as they arrive.

/**
 * Provider that surfaces controllable hooks for "in-flight" tests:
 *   - resolves a promise once each named milestone has been emitted
 *   - blocks the generator on `gateRelease` so the test can inspect DB state
 *     mid-turn before letting the generator emit `done`
 */
