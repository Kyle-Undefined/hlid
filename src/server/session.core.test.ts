/**
 * SessionManager — lifecycle, state, MCP discovery, slash commands, workflows.
 * Shared module mocks and provider builders: see session.test-utils.ts.
 */
import { describe, expect, it, vi } from "vitest";

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
import { computeAllowedAgentRealPaths, isAllowedAgentPath } from "./agentPaths";
import type {
	AgentEvent,
	AgentProvider,
	AgentQueryParams,
	AgentSession,
	McpServerStatus,
} from "./agentProvider";
import { waitForClaudeWarmupSnapshot } from "./claudeWarmup";
import { resolveExecutionContext } from "./executionContext";
import { readObsidianNote } from "./obsidianCli";
import { buildPromptAsync } from "./promptBuilder";
import type { ServerMessage } from "./protocol";
import { resolveDeclaredSessionDefaults, SessionManager } from "./session";
import {
	makeCaptureProvider,
	makeConfig,
	makeProvider,
	makeProviders,
	makeSwitchableProvider,
	routinePermissionContext,
	testPromptContextManifest,
} from "./session.test-utils";

describe("SessionManager — initial state", () => {
	it("attaches first-class vault identity and an Obsidian-native exact-note reader", async () => {
		const provider: AgentProvider = {
			providerId: "claude",
			query(): AgentSession {
				return {
					async *[Symbol.asyncIterator]() {
						yield {
							type: "done",
							cost: 0,
							turns: 1,
							durationMs: 0,
							usage: { inputTokens: 1, outputTokens: 1 },
						};
					},
					cancel: vi.fn(),
					send: vi.fn().mockResolvedValue(undefined),
				};
			},
		};
		const sm = new SessionManager(makeConfig(), makeProviders(provider));

		await sm.runQuery("hello", () => {}, {
			sessionId: "vault-context-session",
		});

		const options = vi.mocked(buildPromptAsync).mock.calls.at(-1)?.[0];
		expect(options).toMatchObject({
			vaultName: "Test",
			vaultPath: "/tmp/hlid-test-vault",
		});
		await expect(
			options?.readVaultReference?.("Projects/Yggdrasil.md"),
		).resolves.toBe("# Native note");
		expect(readObsidianNote).toHaveBeenCalledWith(
			"Test",
			"Projects/Yggdrasil.md",
		);
	});

	it("persists selected Relics without re-linking their attachment rows", async () => {
		const attachment = {
			id: "relic-1",
			path: "/tmp/hlid-test-vault/report.pdf",
			filename: "report.pdf",
			mime: "application/pdf",
			kind: "vault",
			reference: "relic" as const,
		};
		vi.mocked(buildPromptAsync).mockResolvedValueOnce({
			prompt: "test prompt",
			safeAttachments: [attachment],
			resourcePaths: [attachment.path],
			safeVaultReferences: [],
			safeWorkspaceReferences: [],
			contextManifest: testPromptContextManifest(),
		});
		const provider: AgentProvider = {
			providerId: "claude",
			query(): AgentSession {
				return {
					async *[Symbol.asyncIterator]() {
						yield {
							type: "done",
							cost: 0,
							turns: 1,
							durationMs: 0,
							usage: { inputTokens: 1, outputTokens: 1 },
						};
					},
					cancel: vi.fn(),
					send: vi.fn().mockResolvedValue(undefined),
				};
			},
		};
		const linkCallsBefore = vi.mocked(dbMock.linkAttachmentToMessage).mock.calls
			.length;
		const sm = new SessionManager(makeConfig(), makeProviders(provider));
		await sm.runQuery("Review this", () => {}, {
			sessionId: "relic-session",
			attachments: [attachment],
			turnId: "relic-turn",
		});

		expect(dbMock.appendMessage).toHaveBeenCalledWith(
			"relic-session",
			expect.any(Number),
			"user",
			"Review this\n\nRelic references:\n- report.pdf",
			"relic-turn",
			undefined,
			expect.stringContaining('"contractVersion":1'),
		);
		expect(vi.mocked(dbMock.linkAttachmentToMessage).mock.calls).toHaveLength(
			linkCallsBefore,
		);
	});

	it("uses separate CLIProxy defaults for the proxied Codex route", () => {
		const config = {
			...makeConfig(),
			vault_provider: "cliproxy-codex",
			cliproxy: {
				enabled: true,
				base_url: "http://127.0.0.1:8317",
				api_key: "key",
				model: "gpt-5.6-sol",
				effort: "xhigh",
				permission_mode: "acceptEdits",
				turn_recaps: true,
			},
		} as HlidConfig;
		expect(resolveDeclaredSessionDefaults(config)).toMatchObject({
			providerId: "cliproxy-codex",
			model: "gpt-5.6-sol",
			effort: "xhigh",
			permissionMode: "acceptEdits",
			recapModel: "",
		});
	});

	it("shares CLIProxy defaults across Codex and OpenCode harness routes", () => {
		const base = {
			...makeConfig(),
			cliproxy: {
				enabled: true,
				base_url: "http://127.0.0.1:8317",
				api_key: "key",
				model: "claude-sonnet-4-6",
				effort: "high",
				permission_mode: "default",
				turn_recaps: true,
			},
		} as HlidConfig;
		for (const providerId of ["cliproxy:codex", "cliproxy:opencode"]) {
			expect(
				resolveDeclaredSessionDefaults({
					...base,
					vault_provider: providerId,
				}),
			).toMatchObject({
				providerId,
				model: "claude-sonnet-4-6",
				effort: "high",
			});
		}
	});

	it("resolves detached WSL agent defaults without filesystem access", () => {
		vi.mocked(fsMock.realpathSync).mockClear();
		const config = {
			...makeConfig(),
			vault_provider: "claude",
			agents: [
				{
					path: "\\\\wsl.localhost\\Ubuntu-24.04\\home\\kyle\\project",
					provider: "codex",
					model: "gpt-agent",
					effort: "high",
					permission_mode: "bypassPermissions",
				},
			],
		} as HlidConfig;

		expect(
			resolveDeclaredSessionDefaults(
				config,
				"\\\\wsl$\\ubuntu-24.04\\home\\kyle\\project",
			),
		).toMatchObject({
			providerId: "codex",
			model: "gpt-agent",
			effort: "high",
			permissionMode: "bypassPermissions",
		});
		expect(fsMock.realpathSync).not.toHaveBeenCalled();
	});

	it("reports idle state and configured model", () => {
		const sm = new SessionManager(
			makeConfig("model-x"),
			makeProviders(makeProvider("Bash")),
		);
		expect(sm.getStatus()).toEqual({
			state: "idle",
			model: "model-x",
			permission_mode: "default",
			effort: "medium",
		});
	});

	it("isRunning() returns false initially", () => {
		const sm = new SessionManager(
			makeConfig(),
			makeProviders(makeProvider("Bash")),
		);
		expect(sm.isRunning()).toBe(false);
	});

	it("getLastMcpStatus() returns null initially", () => {
		const sm = new SessionManager(
			makeConfig(),
			makeProviders(makeProvider("Bash")),
		);
		expect(sm.getLastMcpStatus()).toBeNull();
	});

	it("getCurrentSessionId() returns null initially", () => {
		const sm = new SessionManager(
			makeConfig(),
			makeProviders(makeProvider("Bash")),
		);
		expect(sm.getCurrentSessionId()).toBeNull();
	});

	it("getPendingPermissionRequests() returns empty array initially", () => {
		const sm = new SessionManager(
			makeConfig(),
			makeProviders(makeProvider("Bash")),
		);
		expect(sm.getPendingPermissionRequests()).toEqual([]);
	});

	it("sends the bounded operating brief once per provider conversation", async () => {
		const provider: AgentProvider = {
			providerId: "codex",
			query(): AgentSession {
				return {
					async *[Symbol.asyncIterator]() {
						yield {
							type: "done",
							cost: 0,
							turns: 1,
							durationMs: 0,
							usage: { inputTokens: 1, outputTokens: 1 },
						};
					},
					cancel: vi.fn(),
					send: vi.fn().mockResolvedValue(undefined),
				};
			},
		};
		const config = makeConfig();
		config.vault_provider = "codex";
		const sm = new SessionManager(config, makeProviders(provider));
		vi.mocked(buildPromptAsync).mockClear();

		await sm.runQuery("first", () => {}, {
			sessionId: "brief-session",
		});
		await sm.runQuery("second", () => {}, {
			sessionId: "brief-session",
		});
		await sm.runQuery("new conversation", () => {}, {
			sessionId: "brief-session-2",
		});

		const calls = vi.mocked(buildPromptAsync).mock.calls;
		expect(calls).toHaveLength(3);
		expect(calls[0][0]).toMatchObject({
			operatingBriefVersion: 1,
			operatingBriefRevision: expect.stringMatching(/^v1-[0-9a-f]{8}$/),
			operatingBriefPreview: expect.stringContaining(
				"Hlid operating brief (v1)",
			),
			operatingBriefDelivery: "included",
			operatingBrief: expect.stringContaining("Hlid operating brief (v1)"),
		});
		expect(calls[1][0]).toMatchObject({
			operatingBriefVersion: 1,
			operatingBriefRevision: calls[0][0].operatingBriefRevision,
			operatingBriefPreview: calls[0][0].operatingBriefPreview,
			operatingBriefDelivery: "already-established",
			operatingBrief: "",
		});
		expect(calls[2][0]).toMatchObject({
			operatingBriefVersion: 1,
			operatingBriefRevision: expect.stringMatching(/^v1-[0-9a-f]{8}$/),
			operatingBriefDelivery: "included",
			operatingBrief: expect.stringContaining("Hlid operating brief (v1)"),
		});
	});
});

describe("SessionManager — restoreMcpStatus", () => {
	it("sets and retrieves MCP status", () => {
		const sm = new SessionManager(
			makeConfig(),
			makeProviders(makeProvider("Bash")),
		);
		const statuses = [{ name: "my-server", status: "connected" as const }];
		sm.restoreMcpStatus(statuses);
		expect(sm.getLastMcpStatus()).toEqual(statuses);
	});

	it("replaces previous MCP status on second call", () => {
		const sm = new SessionManager(
			makeConfig(),
			makeProviders(makeProvider("Bash")),
		);
		sm.restoreMcpStatus([{ name: "a", status: "connected" }]);
		sm.restoreMcpStatus([{ name: "b", status: "failed" }]);
		const last = sm.getLastMcpStatus();
		expect(last).not.toBeNull();
		expect(last?.[0].name).toBe("b");
	});

	it("keeps cached MCP snapshots isolated by provider", () => {
		const sm = new SessionManager(
			makeConfig(),
			makeProviders(makeProvider("Bash")),
		);
		sm.restoreMcpStatus(
			[{ name: "claude.ai Excalidraw", status: "connected" }],
			"claude",
		);
		sm.restoreMcpStatus([{ name: "github", status: "connected" }], "codex");

		expect(sm.getLastMcpStatus("claude")?.[0].name).toBe(
			"claude.ai Excalidraw",
		);
		expect(sm.getLastMcpStatus("codex")?.[0].name).toBe("github");
	});
});

// ── syncConfig ────────────────────────────────────────────────────────────────

describe("SessionManager — syncConfig", () => {
	function codexProfileConfig(permissionProfile?: string): HlidConfig {
		const config = makeConfig("gpt-5.6-sol");
		config.vault_provider = "codex";
		config.codex.permission_profile = permissionProfile;
		return config;
	}

	it.each([
		["codex", true],
		["acp:test", false],
		["claude", false],
	] as const)("scopes Codex permission profiles to the exact %s provider identity", async (providerId, expectsProfile) => {
		const { provider, captured } = makeCaptureProvider(providerId);
		const config = codexProfileConfig("workspace-safe");
		config.vault_provider = providerId;
		if (providerId === "acp:test") config.acp_agents = [{ id: "test" }];
		const sm = new SessionManager(config, makeProviders(provider));

		await sm.runQuery("hello", () => {}, {
			sessionId: `permission-profile-${providerId}`,
		});

		if (expectsProfile) {
			expect(captured.params?.codex).toEqual({
				permissionProfile: "workspace-safe",
			});
		} else {
			expect(captured.params).not.toHaveProperty("codex");
		}
	});

	it("cold-resumes an idle Codex thread when its permission profile changes", async () => {
		const queryParams: AgentQueryParams[] = [];
		const cancels: Array<ReturnType<typeof vi.fn>> = [];
		const provider: AgentProvider = {
			providerId: "codex",
			query(params): AgentSession {
				queryParams.push(params);
				const cancel = vi.fn();
				cancels.push(cancel);
				const events = (async function* (): AsyncGenerator<AgentEvent> {
					yield { type: "session_start", sessionId: "codex-thread-1" };
					yield {
						type: "done",
						cost: 0,
						turns: 1,
						durationMs: 0,
						usage: { inputTokens: 10, outputTokens: 5 },
					};
				})();
				return {
					[Symbol.asyncIterator]: () => events[Symbol.asyncIterator](),
					cancel,
					send: vi.fn().mockResolvedValue(undefined),
				};
			},
		};
		const config = codexProfileConfig("workspace-safe");
		const sm = new SessionManager(config, makeProviders(provider));

		await sm.runQuery("first", () => {}, {
			sessionId: "codex-profile-config-session",
		});
		expect(queryParams[0]?.codex).toEqual({
			permissionProfile: "workspace-safe",
		});

		const changed = structuredClone(config);
		changed.codex.permission_profile = "workspace-strict";
		sm.syncConfig(changed);

		expect(cancels[0]).toHaveBeenCalledOnce();
		await sm.runQuery("second", () => {}, {
			sessionId: "codex-profile-config-session",
		});
		expect(queryParams[1]).toMatchObject({
			sessionId: "codex-thread-1",
			codex: { permissionProfile: "workspace-strict" },
		});
	});

	it("retires Codex between an active turn and an already-queued turn", async () => {
		let releaseFirstTurn = () => {};
		const firstTurnRelease = new Promise<void>((resolve) => {
			releaseFirstTurn = resolve;
		});
		let markFirstTurnActive = () => {};
		const firstTurnActive = new Promise<void>((resolve) => {
			markFirstTurnActive = resolve;
		});
		const queryParams: AgentQueryParams[] = [];
		const cancels: Array<ReturnType<typeof vi.fn>> = [];
		const setPermissionProfile = vi.fn().mockResolvedValue(undefined);
		const provider: AgentProvider = {
			providerId: "codex",
			query(params): AgentSession {
				queryParams.push(params);
				const queryIndex = queryParams.length;
				const cancel = vi.fn();
				cancels.push(cancel);
				const events = (async function* (): AsyncGenerator<AgentEvent> {
					yield { type: "session_start", sessionId: "codex-thread-1" };
					if (queryIndex === 1) {
						markFirstTurnActive();
						await firstTurnRelease;
					}
					yield {
						type: "done",
						cost: 0,
						turns: 1,
						durationMs: 0,
						usage: { inputTokens: 10, outputTokens: 5 },
					};
				})();
				return {
					[Symbol.asyncIterator]: () => events[Symbol.asyncIterator](),
					cancel,
					send: vi.fn().mockResolvedValue(undefined),
					setPermissionProfile,
				};
			},
		};
		const config = codexProfileConfig("workspace-safe");
		const sm = new SessionManager(config, makeProviders(provider));
		const firstTurn = sm.runQuery("first", () => {}, {
			sessionId: "codex-profile-active-session",
		});
		await firstTurnActive;
		const secondTurn = sm.runQuery("second", () => {}, {
			sessionId: "codex-profile-active-session",
		});

		const changed = structuredClone(config);
		changed.codex.permission_profile = "workspace-strict";
		sm.syncConfig(changed);
		expect(cancels[0]).not.toHaveBeenCalled();
		expect(queryParams).toHaveLength(1);
		expect(setPermissionProfile).toHaveBeenCalledWith("workspace-strict");

		releaseFirstTurn();
		await firstTurn;
		await secondTurn;
		expect(cancels[0]).toHaveBeenCalledOnce();
		expect(queryParams[1]).toMatchObject({
			sessionId: "codex-thread-1",
			codex: { permissionProfile: "workspace-strict" },
		});
	});

	it("defers a queued pre-change turn until Codex background work settles", async () => {
		const running = {
			providerId: "codex",
			providerSessionId: "codex-thread-queued",
			activityId: "subagent-queued",
			kind: "agent" as const,
			status: "running" as const,
			startedAtMs: 100,
			updatedAtMs: 100,
			capabilities: { clean: true },
		};
		let observed = [running];
		let releaseFirstTurn = () => {};
		const firstTurnRelease = new Promise<void>((resolve) => {
			releaseFirstTurn = resolve;
		});
		let markFirstTurnActive = () => {};
		const firstTurnActive = new Promise<void>((resolve) => {
			markFirstTurnActive = resolve;
		});
		const queryParams: AgentQueryParams[] = [];
		const cancels: Array<ReturnType<typeof vi.fn>> = [];
		const sends: Array<ReturnType<typeof vi.fn>> = [];
		const listBackgroundActivities = vi.fn(async () => observed);
		const controlBackgroundActivity = vi.fn(async () => {
			observed = [];
		});
		const provider: AgentProvider = {
			providerId: "codex",
			query(params): AgentSession {
				queryParams.push(params);
				const queryIndex = queryParams.length;
				const cancel = vi.fn();
				const send = vi.fn().mockResolvedValue(undefined);
				cancels.push(cancel);
				sends.push(send);
				const events = (async function* (): AsyncGenerator<AgentEvent> {
					yield {
						type: "session_start",
						sessionId: "codex-thread-queued",
					};
					if (queryIndex === 1) {
						markFirstTurnActive();
						await firstTurnRelease;
					}
					yield {
						type: "done",
						cost: 0,
						turns: 1,
						durationMs: 0,
						usage: { inputTokens: 10, outputTokens: 5 },
					};
				})();
				return {
					[Symbol.asyncIterator]: () => events[Symbol.asyncIterator](),
					cancel,
					send,
					listBackgroundActivities,
					controlBackgroundActivity,
				};
			},
		};
		const config = codexProfileConfig("workspace-safe");
		const sm = new SessionManager(config, makeProviders(provider));
		const firstTurn = sm.runQuery("first", () => {}, {
			sessionId: "codex-profile-queued-background",
		});
		await firstTurnActive;
		const secondEvents: ServerMessage[] = [];
		let secondSettled = false;
		const secondTurn = sm
			.runQuery("already queued", (event) => secondEvents.push(event), {
				sessionId: "codex-profile-queued-background",
				turnId: "queued-before-profile-change",
			})
			.finally(() => {
				secondSettled = true;
			});

		const changed = structuredClone(config);
		changed.codex.permission_profile = "workspace-strict";
		sm.syncConfig(changed);
		releaseFirstTurn();
		await firstTurn;
		await vi.waitFor(() => {
			expect(listBackgroundActivities).toHaveBeenCalled();
			expect(sm.getBackgroundActivities()).toEqual([running]);
		});
		await Promise.resolve();

		expect(secondSettled).toBe(false);
		expect(secondEvents.some((event) => event.type === "error")).toBe(false);
		expect(queryParams).toHaveLength(1);
		expect(sends[0]).toHaveBeenCalledOnce();
		expect(cancels[0]).not.toHaveBeenCalled();
		expect(dbMock.deletePendingSessionTurn).not.toHaveBeenCalledWith(
			"queued-before-profile-change",
		);

		await sm.controlProviderBackgroundActivity({ action: "clean" });
		await secondTurn;
		expect(cancels[0]).toHaveBeenCalledOnce();
		expect(queryParams[1]).toMatchObject({
			sessionId: "codex-thread-queued",
			codex: { permissionProfile: "workspace-strict" },
		});
		expect(sends[1]).toHaveBeenCalledOnce();
		expect(secondEvents.some((event) => event.type === "error")).toBe(false);
	});

	it("does not replace a purpose-built Codex runtime with native background work", async () => {
		const running = {
			providerId: "codex",
			providerSessionId: "codex-routine-thread",
			activityId: "routine-subagent",
			kind: "agent" as const,
			status: "running" as const,
			startedAtMs: 100,
			updatedAtMs: 100,
			capabilities: { clean: true },
		};
		let observed: (typeof running)[] = [];
		const queryParams: AgentQueryParams[] = [];
		const cancel = vi.fn();
		const send = vi.fn().mockResolvedValue(undefined);
		const listBackgroundActivities = vi.fn(async () => observed);
		const controlBackgroundActivity = vi.fn(async () => {
			observed = [];
		});
		const provider: AgentProvider = {
			providerId: "codex",
			query(params): AgentSession {
				queryParams.push(params);
				const events = (async function* (): AsyncGenerator<AgentEvent> {
					yield {
						type: "session_start",
						sessionId: "codex-routine-thread",
					};
					yield {
						type: "done",
						cost: 0,
						turns: 1,
						durationMs: 0,
						usage: { inputTokens: 10, outputTokens: 5 },
					};
				})();
				return {
					[Symbol.asyncIterator]: () => events[Symbol.asyncIterator](),
					cancel,
					send,
					listBackgroundActivities,
					controlBackgroundActivity,
				};
			},
		};
		const config = codexProfileConfig("workspace-safe");
		const sm = new SessionManager(config, makeProviders(provider));
		await sm.runQuery("routine", () => {}, {
			sessionId: "codex-purpose-built-background",
			routineContext: routinePermissionContext("codex"),
		});
		expect(queryParams[0]).not.toHaveProperty("codex");
		expect(sm.getBackgroundActivities()).toEqual([]);

		// Native activity starts before the manager's next scheduled poll. The
		// ordinary-turn boundary must refresh ownership instead of trusting [] here.
		observed = [running];
		const events: ServerMessage[] = [];
		await sm.runQuery("ordinary", (event) => events.push(event), {
			sessionId: "codex-purpose-built-background",
		});

		expect(events).toContainEqual({
			type: "error",
			message:
				"Wait for the purpose-built Codex runtime's background activity to finish before starting an ordinary turn.",
			turn_scoped: true,
		});
		expect(queryParams).toHaveLength(1);
		expect(send).toHaveBeenCalledOnce();
		expect(cancel).not.toHaveBeenCalled();
		await sm.controlProviderBackgroundActivity({ action: "clean" });
	});

	it("defers a durable ordinary turn queued behind a background-owning Routine", async () => {
		const running = {
			providerId: "codex",
			providerSessionId: "codex-routine-queued-thread",
			activityId: "routine-queued-subagent",
			kind: "agent" as const,
			status: "running" as const,
			startedAtMs: 100,
			updatedAtMs: 100,
			capabilities: { clean: true },
		};
		let observed = [running];
		let releaseRoutine = () => {};
		const routineRelease = new Promise<void>((resolve) => {
			releaseRoutine = resolve;
		});
		let markRoutineActive = () => {};
		const routineActive = new Promise<void>((resolve) => {
			markRoutineActive = resolve;
		});
		const queryParams: AgentQueryParams[] = [];
		const cancels: Array<ReturnType<typeof vi.fn>> = [];
		const sends: Array<ReturnType<typeof vi.fn>> = [];
		const listBackgroundActivities = vi.fn(async () => observed);
		const controlBackgroundActivity = vi.fn(async () => {
			observed = [];
		});
		const provider: AgentProvider = {
			providerId: "codex",
			query(params): AgentSession {
				queryParams.push(params);
				const queryIndex = queryParams.length;
				const cancel = vi.fn();
				const send = vi.fn().mockResolvedValue(undefined);
				cancels.push(cancel);
				sends.push(send);
				const events = (async function* (): AsyncGenerator<AgentEvent> {
					yield {
						type: "session_start",
						sessionId: "codex-routine-queued-thread",
					};
					if (queryIndex === 1) {
						markRoutineActive();
						await routineRelease;
					}
					yield {
						type: "done",
						cost: 0,
						turns: 1,
						durationMs: 0,
						usage: { inputTokens: 10, outputTokens: 5 },
					};
				})();
				return {
					[Symbol.asyncIterator]: () => events[Symbol.asyncIterator](),
					cancel,
					send,
					listBackgroundActivities,
					controlBackgroundActivity,
				};
			},
		};
		const config = codexProfileConfig("workspace-safe");
		const sm = new SessionManager(config, makeProviders(provider));
		const routineTurn = sm.runQuery("routine", () => {}, {
			sessionId: "codex-routine-queued-background",
			routineContext: routinePermissionContext("codex"),
		});
		await routineActive;
		const queuedEvents: ServerMessage[] = [];
		let queuedSettled = false;
		const queuedTurn = sm
			.runQuery("ordinary queued turn", (event) => queuedEvents.push(event), {
				sessionId: "codex-routine-queued-background",
				turnId: "queued-behind-purpose-built-routine",
			})
			.finally(() => {
				queuedSettled = true;
			});

		releaseRoutine();
		await routineTurn;
		await vi.waitFor(() => {
			expect(sm.getBackgroundActivities()).toEqual([running]);
		});
		await Promise.resolve();

		expect(queuedSettled).toBe(false);
		expect(queuedEvents.some((event) => event.type === "error")).toBe(false);
		expect(queryParams).toHaveLength(1);
		expect(queryParams[0]).not.toHaveProperty("codex");
		expect(sends[0]).toHaveBeenCalledOnce();
		expect(cancels[0]).not.toHaveBeenCalled();
		expect(dbMock.deletePendingSessionTurn).not.toHaveBeenCalledWith(
			"queued-behind-purpose-built-routine",
		);

		await sm.controlProviderBackgroundActivity({ action: "clean" });
		await queuedTurn;
		expect(cancels[0]).toHaveBeenCalledOnce();
		expect(queryParams[1]).toMatchObject({
			sessionId: "codex-routine-queued-thread",
			codex: { permissionProfile: "workspace-safe" },
		});
		expect(sends[1]).toHaveBeenCalledOnce();
		expect(queuedEvents.some((event) => event.type === "error")).toBe(false);
	});

	it("fails closed when authoritative Codex background refresh fails", async () => {
		let refreshFails = false;
		const queryParams: AgentQueryParams[] = [];
		const cancels: Array<ReturnType<typeof vi.fn>> = [];
		const sends: Array<ReturnType<typeof vi.fn>> = [];
		const listBackgroundActivities = vi.fn(async () => {
			if (refreshFails) throw new Error("native inventory unavailable");
			return [];
		});
		const provider: AgentProvider = {
			providerId: "codex",
			query(params): AgentSession {
				queryParams.push(params);
				const cancel = vi.fn();
				const send = vi.fn().mockResolvedValue(undefined);
				cancels.push(cancel);
				sends.push(send);
				const events = (async function* (): AsyncGenerator<AgentEvent> {
					yield { type: "session_start", sessionId: "codex-refresh-thread" };
					yield {
						type: "done",
						cost: 0,
						turns: 1,
						durationMs: 0,
						usage: { inputTokens: 10, outputTokens: 5 },
					};
				})();
				return {
					[Symbol.asyncIterator]: () => events[Symbol.asyncIterator](),
					cancel,
					send,
					listBackgroundActivities,
				};
			},
		};
		const config = codexProfileConfig("workspace-safe");
		const sm = new SessionManager(config, makeProviders(provider));
		await sm.runQuery("first", () => {}, {
			sessionId: "codex-authoritative-refresh-failure",
		});

		refreshFails = true;
		const changed = structuredClone(config);
		changed.codex.permission_profile = "workspace-strict";
		sm.syncConfig(changed);
		const blockedEvents: ServerMessage[] = [];
		await sm.runQuery("blocked", (event) => blockedEvents.push(event), {
			sessionId: "codex-authoritative-refresh-failure",
		});
		expect(blockedEvents).toContainEqual({
			type: "error",
			message:
				"Codex background ownership could not be verified. Wait for its background activity to finish before changing runtimes.",
			turn_scoped: true,
		});
		expect(queryParams).toHaveLength(1);
		expect(sends[0]).toHaveBeenCalledOnce();
		expect(cancels[0]).not.toHaveBeenCalled();

		refreshFails = false;
		await sm.runQuery("retry", () => {}, {
			sessionId: "codex-authoritative-refresh-failure",
		});
		expect(cancels[0]).toHaveBeenCalledOnce();
		expect(queryParams[1]).toMatchObject({
			sessionId: "codex-refresh-thread",
			codex: { permissionProfile: "workspace-strict" },
		});
		expect(sends[1]).toHaveBeenCalledOnce();
	});

	it("rejects stale-profile turns until provider background activity settles", async () => {
		const running = {
			providerId: "codex",
			providerSessionId: "codex-thread-1",
			activityId: "subagent-1",
			kind: "agent" as const,
			status: "running" as const,
			startedAtMs: 100,
			updatedAtMs: 100,
			capabilities: { clean: true },
		};
		let observed = [running];
		const queryParams: AgentQueryParams[] = [];
		const cancels: Array<ReturnType<typeof vi.fn>> = [];
		const sends: Array<ReturnType<typeof vi.fn>> = [];
		const listBackgroundActivities = vi.fn(async () => observed);
		const controlBackgroundActivity = vi.fn(async () => {
			observed = [];
		});
		const provider: AgentProvider = {
			providerId: "codex",
			query(params): AgentSession {
				queryParams.push(params);
				const cancel = vi.fn();
				const send = vi.fn().mockResolvedValue(undefined);
				cancels.push(cancel);
				sends.push(send);
				const events = (async function* (): AsyncGenerator<AgentEvent> {
					yield { type: "session_start", sessionId: "codex-thread-1" };
					yield {
						type: "done",
						cost: 0,
						turns: 1,
						durationMs: 0,
						usage: { inputTokens: 10, outputTokens: 5 },
					};
				})();
				return {
					[Symbol.asyncIterator]: () => events[Symbol.asyncIterator](),
					cancel,
					send,
					listBackgroundActivities,
					controlBackgroundActivity,
				};
			},
		};
		const config = codexProfileConfig("workspace-safe");
		const sm = new SessionManager(config, makeProviders(provider));
		await sm.runQuery("first", () => {}, {
			sessionId: "codex-profile-background-session",
		});
		await vi.waitFor(() => {
			expect(sm.getBackgroundActivities()).toEqual([running]);
		});
		const routineEvents: ServerMessage[] = [];
		await sm.runQuery(
			"purpose-built routine must not reuse the profile runtime",
			(event) => routineEvents.push(event),
			{
				sessionId: "codex-profile-background-session",
				routineContext: routinePermissionContext("codex"),
			},
		);
		expect(routineEvents).toContainEqual({
			type: "error",
			message:
				"Wait for Codex background activity to finish before starting this purpose-built runtime.",
			turn_scoped: true,
		});
		expect(queryParams).toHaveLength(1);
		expect(sends[0]).toHaveBeenCalledOnce();
		expect(cancels[0]).not.toHaveBeenCalled();

		const changed = structuredClone(config);
		changed.codex.permission_profile = "workspace-strict";
		sm.syncConfig(changed);
		expect(cancels[0]).not.toHaveBeenCalled();
		const blockedEvents: ServerMessage[] = [];
		await sm.runQuery(
			"must not use stale permissions",
			(event) => blockedEvents.push(event),
			{ sessionId: "codex-profile-background-session" },
		);
		expect(blockedEvents).toContainEqual({
			type: "error",
			message:
				"Wait for Codex background activity to finish before starting a turn with the updated permission profile.",
			turn_scoped: true,
		});
		expect(queryParams).toHaveLength(1);
		expect(sends[0]).toHaveBeenCalledOnce();
		expect(cancels[0]).not.toHaveBeenCalled();

		await sm.controlProviderBackgroundActivity({ action: "clean" });
		expect(cancels[0]).toHaveBeenCalledOnce();
		expect(sm.getBackgroundActivities()).toEqual([]);
		await sm.runQuery("second", () => {}, {
			sessionId: "codex-profile-background-session",
		});
		expect(queryParams[1]).toMatchObject({
			sessionId: "codex-thread-1",
			codex: { permissionProfile: "workspace-strict" },
		});
		expect(sends[1]).toHaveBeenCalledOnce();
	});

	it("refreshes realtime identity without canonicalizing WSL agent paths", async () => {
		const { provider, captured } = makeCaptureProvider("codex");
		const base = makeConfig("gpt-5.6-sol");
		const config = {
			...base,
			vault_provider: "codex",
			codex: {
				model: "gpt-5.6-sol",
				effort: "high",
				permission_mode: "default",
				turn_recaps: false,
				executable: "C:\\old\\codex.cmd",
			},
			voice: { ...base.voice, codex_live_mode: false },
			agents: [
				{
					path: "\\\\wsl.localhost\\Ubuntu-24.04\\home\\kyle\\project",
					provider: "codex",
				},
			],
		} as HlidConfig;
		vi.mocked(fsMock.realpathSync).mockClear();
		const sm = new SessionManager(
			config,
			makeProviders(provider),
			"\\\\wsl$\\ubuntu-24.04\\home\\kyle\\project\\.",
		);
		expect(fsMock.realpathSync).not.toHaveBeenCalled();
		expect(sm.getStatus().model).toBe("gpt-5.6-sol");
		expect(sm.getAgentCwd()).toBeUndefined();
		expect(sm.getProviderId()).toBe("codex");

		vi.mocked(fsMock.realpathSync).mockClear();
		vi.mocked(computeAllowedAgentRealPaths).mockClear();

		const enabled = structuredClone(config);
		enabled.voice.codex_live_mode = true;
		enabled.codex.executable = "C:\\new\\codex.cmd";
		sm.syncRealtimeConfig(enabled);

		expect(fsMock.realpathSync).not.toHaveBeenCalled();
		expect(computeAllowedAgentRealPaths).not.toHaveBeenCalled();
		vi.mocked(isAllowedAgentPath).mockReturnValueOnce(true);
		await sm.runQuery("hello", () => {}, {
			sessionId: "realtime-narrow-sync",
			agentCwd: "\\\\wsl$\\ubuntu-24.04\\home\\kyle\\project\\.",
		});
		expect(fsMock.realpathSync).toHaveBeenCalledTimes(1);
		expect(captured.params).toMatchObject({ codexRealtimeEnabled: true });
		expect(resolveExecutionContext).toHaveBeenLastCalledWith(
			expect.objectContaining({ claudeExecutable: "C:\\new\\codex.cmd" }),
		);
	});

	it("returns false when model unchanged", () => {
		const sm = new SessionManager(
			makeConfig("model-a"),
			makeProviders(makeProvider("Bash")),
		);
		expect(sm.syncConfig(makeConfig("model-a"))).toBe(false);
	});

	it("returns true when model changes", () => {
		const sm = new SessionManager(
			makeConfig("model-a"),
			makeProviders(makeProvider("Bash")),
		);
		expect(sm.syncConfig(makeConfig("model-b"))).toBe(true);
	});

	it("updates model in getStatus after syncConfig", () => {
		const sm = new SessionManager(
			makeConfig("old-model"),
			makeProviders(makeProvider("Bash")),
		);
		sm.syncConfig(makeConfig("new-model"));
		expect(sm.getStatus().model).toBe("new-model");
	});

	it("updates effort and permission defaults when no session override exists", () => {
		const sm = new SessionManager(
			makeConfig("model-a"),
			makeProviders(makeProvider("Bash")),
		);
		const next = makeConfig("model-a");
		next.claude.effort = "high";
		next.claude.permission_mode = "acceptEdits";

		expect(sm.syncConfig(next)).toBe(true);
		expect(sm.getStatus()).toMatchObject({
			model: "model-a",
			effort: "high",
			permission_mode: "acceptEdits",
		});
	});

	it("preserves explicit session picker overrides across config refreshes", async () => {
		const sm = new SessionManager(
			makeConfig("model-a"),
			makeProviders(makeProvider("Bash")),
		);
		await sm.setModel("session-model");
		await sm.setEffort("xhigh");
		await sm.setPermissionMode("bypassPermissions");
		const next = makeConfig("model-b");
		next.claude.effort = "low";
		next.claude.permission_mode = "acceptEdits";

		expect(sm.syncConfig(next)).toBe(false);
		expect(sm.getStatus()).toMatchObject({
			model: "session-model",
			effort: "xhigh",
			permission_mode: "bypassPermissions",
		});
	});

	it("does not reset session state (non-destructive update)", () => {
		const sm = new SessionManager(
			makeConfig(),
			makeProviders(makeProvider("Bash")),
		);
		sm.syncConfig(makeConfig("new-model"));
		expect(sm.getStatus().state).toBe("idle");
		expect(sm.getCurrentSessionId()).toBeNull();
	});

	it("updates Computer Use preferences on an already-open Codex session", async () => {
		const setWindowsComputerUse = vi.fn().mockResolvedValue(undefined);
		const { provider } = makeSwitchableProvider(
			{ setWindowsComputerUse },
			"codex",
		);
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
		await sm.runQuery("hi", () => {}, {
			sessionId: "live-computer-use-config",
		});

		const next = structuredClone(config);
		next.codex.windows_computer_use = { model: "gpt-5.4", effort: "high" };
		sm.syncConfig(next);

		expect(setWindowsComputerUse).toHaveBeenCalledWith({
			model: "gpt-5.4",
			effort: "high",
		});
	});

	it("cold-resumes an idle native Claude session when AI subagent summaries change", async () => {
		const queryParams: AgentQueryParams[] = [];
		const cancels: Array<ReturnType<typeof vi.fn>> = [];
		const provider: AgentProvider = {
			providerId: "claude",
			query(params): AgentSession {
				queryParams.push(params);
				const cancel = vi.fn();
				cancels.push(cancel);
				const events = (async function* (): AsyncGenerator<AgentEvent> {
					yield { type: "session_start", sessionId: "claude-thread-1" };
					yield {
						type: "done",
						cost: 0,
						turns: 1,
						durationMs: 0,
						usage: { inputTokens: 10, outputTokens: 5 },
					};
				})();
				return {
					[Symbol.asyncIterator]: () => events[Symbol.asyncIterator](),
					cancel,
					send: vi.fn().mockResolvedValue(undefined),
				};
			},
		};
		const config = makeConfig();
		const sm = new SessionManager(config, makeProviders(provider));

		await sm.runQuery("first", () => {}, {
			sessionId: "claude-progress-config-session",
		});
		expect(queryParams[0]?.claude).toEqual({
			agentProgressSummaries: false,
		});

		const enabled = structuredClone(config);
		enabled.claude.agent_progress_summaries = true;
		sm.syncConfig(enabled);

		expect(cancels[0]).toHaveBeenCalledOnce();
		await sm.runQuery("second", () => {}, {
			sessionId: "claude-progress-config-session",
		});
		expect(queryParams[1]).toMatchObject({
			sessionId: "claude-thread-1",
			claude: { agentProgressSummaries: true },
		});
	});

	it("retires native Claude between an active turn and an already-queued turn", async () => {
		let releaseFirstTurn = () => {};
		const firstTurnRelease = new Promise<void>((resolve) => {
			releaseFirstTurn = resolve;
		});
		let markFirstTurnActive = () => {};
		const firstTurnActive = new Promise<void>((resolve) => {
			markFirstTurnActive = resolve;
		});
		const queryParams: AgentQueryParams[] = [];
		const cancels: Array<ReturnType<typeof vi.fn>> = [];
		const provider: AgentProvider = {
			providerId: "claude",
			query(params): AgentSession {
				queryParams.push(params);
				const queryIndex = queryParams.length;
				const cancel = vi.fn();
				cancels.push(cancel);
				const events = (async function* (): AsyncGenerator<AgentEvent> {
					yield { type: "session_start", sessionId: "claude-thread-1" };
					if (queryIndex === 1) {
						markFirstTurnActive();
						await firstTurnRelease;
					}
					yield {
						type: "done",
						cost: 0,
						turns: 1,
						durationMs: 0,
						usage: { inputTokens: 10, outputTokens: 5 },
					};
				})();
				return {
					[Symbol.asyncIterator]: () => events[Symbol.asyncIterator](),
					cancel,
					send: vi.fn().mockResolvedValue(undefined),
				};
			},
		};
		const config = makeConfig();
		const sm = new SessionManager(config, makeProviders(provider));
		const firstTurn = sm.runQuery("first", () => {}, {
			sessionId: "claude-progress-active-session",
		});
		await firstTurnActive;
		const secondTurn = sm.runQuery("second", () => {}, {
			sessionId: "claude-progress-active-session",
		});

		const enabled = structuredClone(config);
		enabled.claude.agent_progress_summaries = true;
		sm.syncConfig(enabled);
		expect(cancels[0]).not.toHaveBeenCalled();
		expect(queryParams).toHaveLength(1);

		releaseFirstTurn();
		await firstTurn;
		await secondTurn;
		expect(cancels[0]).toHaveBeenCalledOnce();
		expect(queryParams[1]).toMatchObject({
			sessionId: "claude-thread-1",
			claude: { agentProgressSummaries: true },
		});
	});

	it("keeps native Claude alive until provider background activity settles", async () => {
		const running = {
			providerId: "claude",
			providerSessionId: "claude-thread-1",
			activityId: "subagent-1",
			kind: "agent" as const,
			status: "running" as const,
			startedAtMs: 100,
			updatedAtMs: 100,
			capabilities: { clean: true },
		};
		let observed = [running];
		const cancel = vi.fn();
		const listBackgroundActivities = vi.fn(async () => observed);
		const controlBackgroundActivity = vi.fn(async () => {
			observed = [];
		});
		const provider: AgentProvider = {
			providerId: "claude",
			query(): AgentSession {
				const events = (async function* (): AsyncGenerator<AgentEvent> {
					yield { type: "session_start", sessionId: "claude-thread-1" };
					yield {
						type: "done",
						cost: 0,
						turns: 1,
						durationMs: 0,
						usage: { inputTokens: 10, outputTokens: 5 },
					};
				})();
				return {
					[Symbol.asyncIterator]: () => events[Symbol.asyncIterator](),
					cancel,
					send: vi.fn().mockResolvedValue(undefined),
					listBackgroundActivities,
					controlBackgroundActivity,
				};
			},
		};
		const config = makeConfig();
		const sm = new SessionManager(config, makeProviders(provider));
		await sm.runQuery("first", () => {}, {
			sessionId: "claude-progress-background-session",
		});
		await vi.waitFor(() => {
			expect(sm.getBackgroundActivities()).toEqual([running]);
		});

		const enabled = structuredClone(config);
		enabled.claude.agent_progress_summaries = true;
		sm.syncConfig(enabled);
		expect(cancel).not.toHaveBeenCalled();

		await sm.controlProviderBackgroundActivity({ action: "clean" });
		expect(cancel).toHaveBeenCalledOnce();
		expect(sm.getBackgroundActivities()).toEqual([]);
	});

	it("cold-resumes an idle Codex thread after realtime preview is enabled", async () => {
		const queryParams: AgentQueryParams[] = [];
		const cancels: Array<ReturnType<typeof vi.fn>> = [];
		const provider: AgentProvider = {
			providerId: "codex",
			query(params): AgentSession {
				queryParams.push(params);
				const cancel = vi.fn();
				cancels.push(cancel);
				const events = (async function* (): AsyncGenerator<AgentEvent> {
					yield { type: "session_start", sessionId: "codex-thread-1" };
					yield {
						type: "done",
						cost: 0,
						turns: 1,
						durationMs: 0,
						usage: { inputTokens: 10, outputTokens: 5 },
					};
				})();
				return {
					[Symbol.asyncIterator]: () => events[Symbol.asyncIterator](),
					cancel,
					send: vi.fn().mockResolvedValue(undefined),
				};
			},
		};
		const base = makeConfig("gpt-5.6-sol");
		const config = {
			...base,
			vault_provider: "codex",
			codex: {
				model: "gpt-5.6-sol",
				effort: "high",
				permission_mode: "default",
				turn_recaps: false,
			},
			voice: { ...base.voice, codex_live_mode: false },
		} as HlidConfig;
		const sm = new SessionManager(config, makeProviders(provider));

		await sm.runQuery("first", () => {}, {
			sessionId: "realtime-config-session",
		});
		expect(queryParams[0]).toMatchObject({ codexRealtimeEnabled: false });
		expect(queryParams[0]).not.toHaveProperty("claude");

		const enabled = structuredClone(config);
		enabled.voice.codex_live_mode = true;
		sm.syncConfig(enabled);

		expect(cancels[0]).toHaveBeenCalledOnce();
		await sm.runQuery("second", () => {}, {
			sessionId: "realtime-config-session",
		});
		expect(queryParams).toHaveLength(2);
		expect(queryParams[1]).toMatchObject({
			codexRealtimeEnabled: true,
			sessionId: "codex-thread-1",
		});
	});

	it("cold-resumes an idle Codex thread with a changed executable", async () => {
		vi.mocked(resolveExecutionContext)
			.mockReturnValueOnce({
				activeCwd: "/tmp/hlid-test-cwd",
				extraDirs: new Set(),
				executable: "/old/codex",
			})
			.mockReturnValueOnce({
				activeCwd: "/tmp/hlid-test-cwd",
				extraDirs: new Set(),
				executable: "/new/codex",
			});
		const queryParams: AgentQueryParams[] = [];
		const cancels: Array<ReturnType<typeof vi.fn>> = [];
		const provider: AgentProvider = {
			providerId: "codex",
			query(params): AgentSession {
				queryParams.push(params);
				const cancel = vi.fn();
				cancels.push(cancel);
				const events = (async function* (): AsyncGenerator<AgentEvent> {
					yield { type: "session_start", sessionId: "codex-thread-1" };
					yield {
						type: "done",
						cost: 0,
						turns: 1,
						durationMs: 0,
						usage: { inputTokens: 10, outputTokens: 5 },
					};
				})();
				return {
					[Symbol.asyncIterator]: () => events[Symbol.asyncIterator](),
					cancel,
					send: vi.fn().mockResolvedValue(undefined),
				};
			},
		};
		const base = makeConfig("gpt-5.6-sol");
		const config = {
			...base,
			vault_provider: "codex",
			codex: {
				model: "gpt-5.6-sol",
				effort: "high",
				permission_mode: "default",
				turn_recaps: false,
				executable: "/old/codex",
			},
		} as HlidConfig;
		const sm = new SessionManager(config, makeProviders(provider));

		await sm.runQuery("first", () => {}, {
			sessionId: "executable-config-session",
		});
		expect(queryParams[0]).toMatchObject({ executable: "/old/codex" });

		const changed = structuredClone(config);
		changed.codex.executable = "/new/codex";
		sm.syncConfig(changed);

		expect(cancels[0]).toHaveBeenCalledOnce();
		await sm.runQuery("second", () => {}, {
			sessionId: "executable-config-session",
		});
		expect(queryParams[1]).toMatchObject({
			executable: "/new/codex",
			sessionId: "codex-thread-1",
		});
	});

	it("does not retire a CLIProxy Codex session when native Live preview changes", async () => {
		const { provider, getSession } = makeSwitchableProvider(
			{},
			"cliproxy:codex-native",
		);
		const base = makeConfig("gpt-5.6-sol");
		const config = {
			...base,
			vault_provider: "cliproxy:codex-native",
			voice: { ...base.voice, codex_live_mode: false },
		} as HlidConfig;
		const sm = new SessionManager(config, makeProviders(provider));

		await sm.runQuery("first", () => {}, {
			sessionId: "cliproxy-realtime-config-session",
		});
		const enabled = structuredClone(config);
		enabled.voice.codex_live_mode = true;
		sm.syncConfig(enabled);

		expect(getSession()?.cancel).not.toHaveBeenCalled();
	});
});

// ── setModel / setPermissionMode / getAccountInfo ─────────────────────────────

/** Build a fake single-turn AgentProvider whose session exposes the given optional methods. */

describe("SessionManager — getAccountInfo", () => {
	it("returns null with no active AgentSession", async () => {
		const sm = new SessionManager(
			makeConfig(),
			makeProviders(makeProvider("Bash")),
		);
		expect(await sm.getAccountInfo()).toBeNull();
	});

	it("returns null when the active provider doesn't expose accountInfo", async () => {
		const { provider } = makeSwitchableProvider();
		const sm = new SessionManager(makeConfig(), makeProviders(provider));
		await sm.runQuery("hi", () => {}, {
			sessionId: "sess-1",
		});
		expect(await sm.getAccountInfo()).toBeNull();
	});

	it("delegates to the active AgentSession's accountInfo", async () => {
		const accountInfo = vi.fn().mockResolvedValue({
			email: "kyle@example.com",
			subscriptionType: "max",
		});
		const { provider } = makeSwitchableProvider({ accountInfo });
		const sm = new SessionManager(makeConfig(), makeProviders(provider));
		await sm.runQuery("hi", () => {}, {
			sessionId: "sess-1",
		});

		expect(await sm.getAccountInfo()).toEqual({
			email: "kyle@example.com",
			subscriptionType: "max",
		});
	});

	it("returns null when the AgentSession's accountInfo call fails", async () => {
		const accountInfo = vi.fn().mockRejectedValue(new Error("not logged in"));
		const { provider } = makeSwitchableProvider({ accountInfo });
		const sm = new SessionManager(makeConfig(), makeProviders(provider));
		await sm.runQuery("hi", () => {}, {
			sessionId: "sess-1",
		});

		expect(await sm.getAccountInfo()).toBeNull();
	});
});

describe("SessionManager — provider background tasks", () => {
	it("stops a task through the active provider session", async () => {
		const stopTask = vi.fn().mockResolvedValue(undefined);
		const { provider } = makeSwitchableProvider({ stopTask });
		const sm = new SessionManager(makeConfig(), makeProviders(provider));
		await sm.runQuery("hi", () => {}, {
			sessionId: "sess-1",
		});

		await sm.stopProviderTask("workflow-task-1");

		expect(stopTask).toHaveBeenCalledWith("workflow-task-1");
	});

	it("reports unavailable control without creating a provider session", async () => {
		const sm = new SessionManager(
			makeConfig(),
			makeProviders(makeProvider("Bash")),
		);

		await expect(sm.stopProviderTask("workflow-task-1")).rejects.toThrow(
			"cannot stop background tasks from Raven",
		);
	});
});

describe("SessionManager — provider background activity", () => {
	it("cleans a Codex profile-transition waiter when its turn is aborted", async () => {
		const sm = new SessionManager(
			makeConfig(),
			makeProviders(makeProvider("Bash")),
		);
		const internals = sm as unknown as {
			backgroundActivityRevision: number;
			backgroundActivityWaiters: Set<() => void>;
			waitForBackgroundActivityRevision(
				revision: number,
				signal: AbortSignal,
			): Promise<void>;
		};
		const controller = new AbortController();
		const waiting = internals.waitForBackgroundActivityRevision(
			internals.backgroundActivityRevision,
			controller.signal,
		);
		expect(internals.backgroundActivityWaiters.size).toBe(1);

		controller.abort();

		await expect(waiting).rejects.toMatchObject({ name: "AbortError" });
		expect(internals.backgroundActivityWaiters.size).toBe(0);
	});

	it("observes, persists, controls, and safely detaches live activity", async () => {
		const running = {
			providerId: "claude",
			providerSessionId: "sdk-session-1",
			activityId: "terminal-1",
			processId: "process-1",
			kind: "terminal" as const,
			status: "running" as const,
			command: "bun run dev",
			startedAtMs: 100,
			updatedAtMs: 200,
			capabilities: { terminate: true, clean: true },
		};
		const listBackgroundActivities = vi.fn().mockResolvedValue([running]);
		const controlBackgroundActivity = vi.fn().mockResolvedValue(undefined);
		const { provider } = makeSwitchableProvider({
			listBackgroundActivities,
			controlBackgroundActivity,
		});
		const sm = new SessionManager(makeConfig(), makeProviders(provider));

		await sm.runQuery("hi", () => {}, { sessionId: "sess-1" });
		await vi.waitFor(() => {
			expect(sm.getBackgroundActivities()).toEqual([running]);
		});
		expect(dbMock.replaceSessionBackgroundActivities).toHaveBeenCalledWith(
			"sess-1",
			[running],
		);
		await sm.controlProviderBackgroundActivity({ action: "background" });
		expect(controlBackgroundActivity).toHaveBeenCalledWith({
			action: "background",
		});

		await sm.controlProviderBackgroundActivity({
			action: "terminate",
			activityId: "terminal-1",
		});
		expect(controlBackgroundActivity).toHaveBeenCalledWith({
			action: "terminate",
			activityId: "terminal-1",
		});

		listBackgroundActivities.mockResolvedValue([
			{
				...running,
				status: "completed",
				updatedAtMs: 300,
				endedAtMs: 300,
				capabilities: {},
			},
		]);
		await sm.controlProviderBackgroundActivity({ action: "clean" });
		expect(sm.getBackgroundActivities()).toEqual([]);
		expect(dbMock.replaceSessionBackgroundActivities).toHaveBeenLastCalledWith(
			"sess-1",
			[],
		);

		sm.abort();
		expect(sm.getBackgroundActivities()).toEqual([]);
	});
});

// ── abort ─────────────────────────────────────────────────────────────────────

describe("SessionManager — abort", () => {
	it("does not throw when no query is running", () => {
		const sm = new SessionManager(
			makeConfig(),
			makeProviders(makeProvider("Bash")),
		);
		expect(() => sm.abort()).not.toThrow();
	});

	it("state remains idle after abort when not running", () => {
		const sm = new SessionManager(
			makeConfig(),
			makeProviders(makeProvider("Bash")),
		);
		sm.abort();
		expect(sm.getStatus().state).toBe("idle");
	});
});

// ── reinitialize ──────────────────────────────────────────────────────────────

describe("SessionManager — reinitialize", () => {
	it("applies new config", () => {
		const sm = new SessionManager(
			makeConfig("old-model"),
			makeProviders(makeProvider("Bash")),
		);
		sm.reinitialize(makeConfig("fresh-model"));
		expect(sm.getStatus().model).toBe("fresh-model");
	});

	it("resets state to idle", () => {
		const sm = new SessionManager(
			makeConfig(),
			makeProviders(makeProvider("Bash")),
		);
		sm.reinitialize(makeConfig());
		expect(sm.getStatus().state).toBe("idle");
	});

	it("clears currentSessionId", () => {
		const sm = new SessionManager(
			makeConfig(),
			makeProviders(makeProvider("Bash")),
		);
		sm.reinitialize(makeConfig());
		expect(sm.getCurrentSessionId()).toBeNull();
	});
});

// ── AskUserQuestion support ───────────────────────────────────────────────────

describe("SessionManager — exact context usage", () => {
	it("prefers provider-reported context occupancy over turn input estimates", async () => {
		const provider: AgentProvider = {
			providerId: "codex",
			query(): AgentSession {
				const gen = (async function* (): AsyncGenerator<AgentEvent> {
					yield {
						type: "usage",
						inputTokens: 100,
						outputTokens: 20,
						model: "gpt-5.6-terra",
						contextTokens: 1_234,
						contextWindow: 8_192,
					};
					yield {
						type: "done",
						cost: 0.25,
						turns: 1,
						durationMs: 1,
						usage: { inputTokens: 4, outputTokens: 2 },
					};
				})();
				return {
					[Symbol.asyncIterator]: () => gen[Symbol.asyncIterator](),
					cancel: vi.fn(),
					send: vi.fn().mockResolvedValue(undefined),
				};
			},
		};
		const emitted: ServerMessage[] = [];
		const sm = new SessionManager(makeConfig(), makeProviders(provider));
		await sm.runQuery("hello", (message) => emitted.push(message), {
			sessionId: "sess-context",
		});
		expect(emitted).toContainEqual(
			expect.objectContaining({
				type: "usage_update",
				query_input_tokens: 100,
				query_output_tokens: 20,
				query_cache_read_tokens: 0,
				query_cache_creation_tokens: 0,
				query_estimated_cost: expect.any(Number),
				tokens_in_context: 1_234,
				context_window: 8_192,
			}),
		);
		expect(emitted).toContainEqual(
			expect.objectContaining({
				type: "done",
				tokens_in_context: 1_234,
				context_window: 8_192,
			}),
		);
	});
});

describe("SessionManager — local_command_output forwarding", () => {
	it("emits local_command_output WS message when agent yields local_command_output event", async () => {
		const provider: AgentProvider = {
			providerId: "claude",
			query(): AgentSession {
				const gen = (async function* (): AsyncGenerator<AgentEvent> {
					yield { type: "session_start", sessionId: "sdk-cmd-1" };
					yield { type: "local_command_output", content: "/help output here" };
					yield {
						type: "done",
						cost: 0,
						turns: 1,
						durationMs: 0,
						usage: { inputTokens: 5, outputTokens: 2 },
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

		const emitted: ServerMessage[] = [];
		const sm = new SessionManager(makeConfig(), makeProviders(provider));
		await sm.runQuery("hello", (m) => emitted.push(m), {
			sessionId: "sess-cmd-1",
		});

		expect(
			emitted.some(
				(m) =>
					m.type === "local_command_output" &&
					(m as { type: string; content: string }).content ===
						"/help output here",
			),
		).toBe(true);
	});

	it("does not interrupt text accumulation around local_command_output", async () => {
		const provider: AgentProvider = {
			providerId: "claude",
			query(): AgentSession {
				const gen = (async function* (): AsyncGenerator<AgentEvent> {
					yield { type: "session_start", sessionId: "sdk-cmd-2" };
					yield { type: "local_command_output", content: "cmd out" };
					yield { type: "text_delta", text: "assistant reply" };
					yield {
						type: "done",
						cost: 0,
						turns: 1,
						durationMs: 0,
						usage: { inputTokens: 5, outputTokens: 2 },
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

		const emitted: ServerMessage[] = [];
		const sm = new SessionManager(makeConfig(), makeProviders(provider));
		await sm.runQuery("hello", (m) => emitted.push(m), {
			sessionId: "sess-cmd-2",
		});

		expect(emitted.some((m) => m.type === "local_command_output")).toBe(true);
		expect(emitted.some((m) => m.type === "chunk")).toBe(true);
	});
});

describe("SessionManager — provider context reset", () => {
	it("persists the replacement native id and a visible Raven boundary", async () => {
		const provider: AgentProvider = {
			providerId: "claude",
			label: "Claude",
			query(): AgentSession {
				const gen = (async function* (): AsyncGenerator<AgentEvent> {
					yield { type: "session_start", sessionId: "sdk-before-clear" };
					yield {
						type: "provider_context_reset",
						sessionId: "sdk-after-clear",
					};
					yield {
						type: "done",
						cost: 0,
						turns: 1,
						durationMs: 0,
						usage: { inputTokens: 0, outputTokens: 0 },
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
		const providerCallCount = vi.mocked(dbMock.setSessionProviderSession).mock
			.calls.length;
		const messageCallCount = vi.mocked(dbMock.appendMessage).mock.calls.length;
		vi.mocked(dbMock.appendMessage)
			.mockResolvedValueOnce(41)
			.mockResolvedValueOnce(42);
		const emitted: ServerMessage[] = [];
		const sm = new SessionManager(makeConfig(), makeProviders(provider));

		await sm.runQuery("/clear", (message) => emitted.push(message), {
			sessionId: "sess-clear",
		});

		expect(
			vi
				.mocked(dbMock.setSessionProviderSession)
				.mock.calls.slice(providerCallCount),
		).toContainEqual(["sess-clear", "claude", "sdk-after-clear"]);
		expect(
			vi.mocked(dbMock.appendMessage).mock.calls.slice(messageCallCount),
		).toContainEqual([
			"sess-clear",
			expect.any(Number),
			"local_command_output",
			"Claude started a new native context",
		]);
		expect(emitted).toContainEqual({
			type: "local_command_output",
			id: "persisted-message:42",
			content: "Claude started a new native context",
		});
	});
});

describe("SessionManager — provider history warning", () => {
	it("warn-logs and persists a visible boundary without ending the turn", async () => {
		const provider: AgentProvider = {
			providerId: "claude",
			label: "Claude",
			query(): AgentSession {
				const gen = (async function* (): AsyncGenerator<AgentEvent> {
					yield { type: "session_start", sessionId: "sdk-history-warning" };
					yield { type: "text_delta", text: "Claude kept going." };
					yield {
						type: "provider_history_warning",
						code: "history_mirror_failed",
						reason: "timeout",
						providerSessionId: "sdk-history-warning",
						providerEventId: "11111111-1111-4111-8111-111111111111",
						scope: "subagent",
					};
					// The SDK UUID is diagnostic correlation, not a provider frame. A
					// replay of the same warning must not duplicate Raven history.
					yield {
						type: "provider_history_warning",
						code: "history_mirror_failed",
						reason: "timeout",
						providerSessionId: "sdk-history-warning",
						providerEventId: "11111111-1111-4111-8111-111111111111",
						scope: "subagent",
					};
					yield {
						type: "provider_history_warning",
						code: "history_mirror_failed",
						reason: "append_rejected",
						providerSessionId: "sdk-history-warning",
						providerEventId: "22222222-2222-4222-8222-222222222222",
						scope: "subagent",
					};
					yield {
						type: "result_text_fallback",
						text: "must not duplicate the assistant text",
					};
					yield {
						type: "done",
						cost: 0,
						turns: 1,
						durationMs: 0,
						usage: { inputTokens: 5, outputTokens: 2 },
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
		const messageCallCount = vi.mocked(dbMock.appendMessage).mock.calls.length;
		vi.mocked(dbMock.appendLog).mockClear();
		vi.mocked(dbMock.appendMessage)
			.mockResolvedValueOnce(71)
			.mockResolvedValueOnce(72)
			.mockResolvedValueOnce(73)
			.mockResolvedValueOnce(74);
		const emitted: ServerMessage[] = [];
		const sm = new SessionManager(makeConfig(), makeProviders(provider));

		await sm.runQuery("continue", (message) => emitted.push(message), {
			sessionId: "sess-history-warning",
		});

		const content =
			"Claude could not save part of its native resume history. This turn is continuing, but future Claude resume or fork history may be incomplete.";
		expect(
			vi
				.mocked(dbMock.appendMessage)
				.mock.calls.slice(messageCallCount)
				.filter((call) => call[2] === "local_command_output"),
		).toEqual([
			[
				"sess-history-warning",
				expect.any(Number),
				"local_command_output",
				content,
			],
			[
				"sess-history-warning",
				expect.any(Number),
				"local_command_output",
				content,
			],
		]);
		expect(dbMock.appendLog).toHaveBeenCalledWith(
			"warn",
			"claude",
			"Provider native history mirror failed",
			{
				sessionId: "sess-history-warning",
				providerSessionId: "sdk-history-warning",
				providerEventId: "11111111-1111-4111-8111-111111111111",
				code: "history_mirror_failed",
				reason: "timeout",
				scope: "subagent",
			},
		);
		expect(dbMock.appendLog).toHaveBeenCalledTimes(2);
		expect(emitted).toContainEqual({
			type: "local_command_output",
			id: "persisted-message:73",
			content,
		});
		expect(
			emitted.filter((message) => message.type === "local_command_output"),
		).toHaveLength(2);
		expect(emitted).toContainEqual(
			expect.objectContaining({ type: "chunk", text: "Claude kept going." }),
		);
		expect(emitted.filter((message) => message.type === "chunk")).toEqual([
			expect.objectContaining({
				type: "chunk",
				text: "Claude kept going.",
			}),
		]);
		expect(emitted).toContainEqual(expect.objectContaining({ type: "done" }));
		expect(emitted.some((message) => message.type === "error")).toBe(false);
		expect(sm.getStatus().state).toBe("idle");
	});

	it("still emits an idless warning and completes when local persistence fails", async () => {
		const provider: AgentProvider = {
			providerId: "claude",
			label: "Claude",
			query(): AgentSession {
				const gen = (async function* (): AsyncGenerator<AgentEvent> {
					yield {
						type: "provider_history_warning",
						code: "history_mirror_failed",
						reason: "append_rejected",
						providerSessionId: "sdk-history-warning-failed-write",
						providerEventId: "44444444-4444-4444-8444-444444444444",
						scope: "main",
					};
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
					send: vi.fn().mockResolvedValue(undefined),
					mcpServerStatus: () => Promise.resolve([]),
				};
			},
		};
		vi.mocked(dbMock.appendMessage)
			.mockResolvedValueOnce(70)
			.mockRejectedValueOnce(new Error("local db unavailable"));
		const emitted: ServerMessage[] = [];
		const sm = new SessionManager(makeConfig(), makeProviders(provider));

		await sm.runQuery("continue", (message) => emitted.push(message), {
			sessionId: "sess-history-warning-failed-write",
		});

		expect(emitted).toContainEqual({
			type: "local_command_output",
			content:
				"Claude could not save part of its native resume history. This turn is continuing, but future Claude resume or fork history may be incomplete.",
		});
		expect(emitted).toContainEqual(expect.objectContaining({ type: "done" }));
		expect(emitted.some((message) => message.type === "error")).toBe(false);
		expect(sm.getStatus().state).toBe("idle");
	});
});

describe("SessionManager — deferred MCP discovery", () => {
	it("refreshes Claude MCP status again when the first turn completes", async () => {
		const mcpServerStatus = vi
			.fn<() => Promise<McpServerStatus[]>>()
			.mockResolvedValueOnce([])
			.mockResolvedValueOnce([
				{
					name: "claude.ai Excalidraw",
					status: "connected" as const,
					scope: "claudeai",
				},
			]);
		const provider: AgentProvider = {
			providerId: "claude",
			probeRequiresTurn: true,
			query(): AgentSession {
				const gen = (async function* (): AsyncGenerator<AgentEvent> {
					yield { type: "session_start", sessionId: "sdk-mcp-late" };
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
					send: vi.fn().mockResolvedValue(undefined),
					mcpServerStatus,
				};
			},
		};
		const emitted: ServerMessage[] = [];
		const sm = new SessionManager(makeConfig(), makeProviders(provider));

		await sm.runQuery("hello", (message) => emitted.push(message), {
			sessionId: "sess-mcp",
		});

		expect(mcpServerStatus).toHaveBeenCalledTimes(2);
		expect(sm.getLastMcpStatus("claude")).toEqual([
			{
				name: "claude.ai Excalidraw",
				status: "connected",
				scope: "claudeai",
			},
		]);
		expect(emitted).toContainEqual(
			expect.objectContaining({
				type: "mcp_status",
				provider_id: "claude",
				servers: [
					expect.objectContaining({
						name: "claude.ai Excalidraw",
						status: "connected",
					}),
				],
			}),
		);
	});

	it("keeps checking while a Claude.ai MCP is still pending", async () => {
		vi.useFakeTimers();
		try {
			const mcpServerStatus = vi
				.fn<() => Promise<McpServerStatus[]>>()
				.mockResolvedValueOnce([])
				.mockResolvedValueOnce([
					{ name: "claude.ai Excalidraw", status: "pending" as const },
				])
				.mockResolvedValueOnce([
					{ name: "claude.ai Excalidraw", status: "connected" as const },
				]);
			const provider: AgentProvider = {
				providerId: "claude",
				probeRequiresTurn: true,
				query(): AgentSession {
					const gen = (async function* (): AsyncGenerator<AgentEvent> {
						yield { type: "session_start", sessionId: "sdk-mcp-pending" };
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
						send: vi.fn().mockResolvedValue(undefined),
						mcpServerStatus,
					};
				},
			};
			const emitted: ServerMessage[] = [];
			const sm = new SessionManager(makeConfig(), makeProviders(provider));

			await sm.runQuery("hello", (message) => emitted.push(message), {
				sessionId: "sess-mcp-pending",
			});
			expect(sm.getLastMcpStatus("claude")?.[0].status).toBe("pending");

			await vi.advanceTimersByTimeAsync(500);

			expect(sm.getLastMcpStatus("claude")?.[0].status).toBe("connected");
			expect(mcpServerStatus).toHaveBeenCalledTimes(3);
			expect(
				emitted.some(
					(message) =>
						message.type === "mcp_status" &&
						message.servers[0]?.status === "connected",
				),
			).toBe(true);
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("SessionManager — provider-native MCP controls", () => {
	it("runs Claude reconnect and toggle, then broadcasts refreshed status", async () => {
		let statuses: McpServerStatus[] = [
			{ name: "github", status: "failed", scope: "project" },
		];
		const reconnectMcpServer = vi.fn(async () => {
			statuses = [{ name: "github", status: "connected", scope: "project" }];
		});
		const toggleMcpServer = vi.fn(async (_name: string, enabled: boolean) => {
			statuses = [
				{
					name: "github",
					status: enabled ? "connected" : "disabled",
					scope: "project",
				},
			];
		});
		const setMcpPermissionModeOverride = vi.fn(
			async (_name: string, mode: "default" | "auto" | null) => {
				statuses = statuses.map((status) => ({
					...status,
					...(mode ? { permissionModeOverride: mode } : {}),
				}));
				return { warning: "Provider warning" };
			},
		);
		const provider: AgentProvider = {
			providerId: "claude",
			label: "Claude",
			probeRequiresTurn: true,
			query(): AgentSession {
				const gen = (async function* (): AsyncGenerator<AgentEvent> {
					yield { type: "session_start", sessionId: "sdk-mcp-control" };
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
					send: vi.fn().mockResolvedValue(undefined),
					mcpServerStatus: vi.fn(async () => statuses),
					reconnectMcpServer,
					toggleMcpServer,
					mcpPermissionModeOverrideAvailable: true,
					setMcpPermissionModeOverride,
				};
			},
		};
		const sm = new SessionManager(makeConfig(), makeProviders(provider));
		await sm.runQuery("hello", vi.fn(), { sessionId: "db-session" });
		expect(sm.getMcpControlOperations()).toEqual([
			"reconnect",
			"toggle",
			"permission-override",
		]);

		const emitted: ServerMessage[] = [];
		await sm.controlMcpServer(
			{ serverName: "github", action: "reconnect" },
			{ sessionId: "db-session", emit: (message) => emitted.push(message) },
		);
		await sm.controlMcpServer(
			{ serverName: "github", action: "disable" },
			{ sessionId: "db-session", emit: (message) => emitted.push(message) },
		);
		const permissionResult = await sm.controlMcpServer(
			{ serverName: "github", action: "permission-default" },
			{ sessionId: "db-session", emit: (message) => emitted.push(message) },
		);

		expect(reconnectMcpServer).toHaveBeenCalledWith("github");
		expect(toggleMcpServer).toHaveBeenCalledWith("github", false);
		expect(setMcpPermissionModeOverride).toHaveBeenCalledWith(
			"github",
			"default",
		);
		expect(permissionResult.warning).toBe("Provider warning");
		expect(sm.getLastMcpStatus("claude")?.[0].status).toBe("disabled");
		expect(emitted.at(-1)).toMatchObject({
			type: "mcp_status",
			provider_id: "claude",
			operations: ["reconnect", "toggle", "permission-override"],
			session_id: "db-session",
			servers: [
				{
					name: "github",
					status: "disabled",
					permission_mode_override: "default",
				},
			],
		});
	});

	it("fails closed when no live provider session owns the controls", async () => {
		const provider: AgentProvider = {
			providerId: "claude",
			label: "Claude",
			query: vi.fn(),
		};
		const sm = new SessionManager(makeConfig(), makeProviders(provider));

		expect(sm.getMcpControlOperations()).toEqual([]);
		await expect(
			sm.controlMcpServer(
				{ serverName: "github", action: "reconnect" },
				{ sessionId: "db-session", emit: vi.fn() },
			),
		).rejects.toThrow("Claude MCP controls require a live session");
	});
});

describe("SessionManager — Claude file checkpoints", () => {
	it("requires a matching dry-run receipt and rechecks it before rewinding", async () => {
		const rewindFiles = vi.fn().mockResolvedValue({
			canRewind: true,
			filesChanged: ["src/example.ts"],
			insertions: 2,
			deletions: 1,
		});
		const provider: AgentProvider = {
			providerId: "claude",
			query(): AgentSession {
				const gen = (async function* (): AsyncGenerator<AgentEvent> {
					yield { type: "session_start", sessionId: "native-session" };
					yield {
						type: "file_checkpoint",
						id: "checkpoint-user-id",
						providerSessionId: "native-session",
					};
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
					send: vi.fn().mockResolvedValue(undefined),
					rewindFiles,
				};
			},
		};
		vi.mocked(dbMock.getUserMessageCheckpoint).mockResolvedValue({
			seq: 0,
			checkpointUuid: "checkpoint-user-id",
			providerSessionId: "native-session",
		});
		const sm = new SessionManager(makeConfig(), makeProviders(provider));
		const emitted: ServerMessage[] = [];
		await sm.runQuery("change it", (message) => emitted.push(message), {
			sessionId: "db-session",
			turnId: "turn-1",
		});
		expect(dbMock.setMessageCheckpointUuid).toHaveBeenCalledWith(
			"db-session",
			0,
			"checkpoint-user-id",
			"native-session",
		);
		expect(emitted).toContainEqual({
			type: "file_checkpoint",
			session_id: "db-session",
			turn_id: "turn-1",
		});

		const preview = await sm.controlFileRewind(
			{ turnId: "turn-1", action: "preview" },
			{ sessionId: "db-session" },
		);
		expect(preview).toMatchObject({
			canRewind: true,
			filesChanged: ["src/example.ts"],
			previewId: expect.any(String),
		});
		await expect(
			sm.controlFileRewind(
				{
					turnId: "turn-1",
					action: "execute",
					previewId: preview.previewId,
				},
				{ sessionId: "db-session" },
			),
		).resolves.toMatchObject({ canRewind: true });
		expect(rewindFiles).toHaveBeenNthCalledWith(1, "checkpoint-user-id", {
			dryRun: true,
		});
		expect(rewindFiles).toHaveBeenNthCalledWith(2, "checkpoint-user-id", {
			dryRun: true,
		});
		expect(rewindFiles).toHaveBeenNthCalledWith(3, "checkpoint-user-id");
	});
});

describe("SessionManager — provider-native skill refresh", () => {
	it("reloads an already-live Claude session and publishes the refreshed skill catalog", async () => {
		const refreshedSkills = [
			{
				name: "voice",
				description: "Apply voice rules",
				argumentHint: "",
			},
		];
		const reloadSkills = vi.fn().mockResolvedValue(refreshedSkills);
		const staleInitializationCommands = [
			{
				name: "help",
				description: "Show help",
				argumentHint: "",
			},
		];
		const supportedCommands = vi
			.fn()
			.mockResolvedValue(staleInitializationCommands);
		const provider: AgentProvider = {
			providerId: "claude",
			label: "Claude",
			query(): AgentSession {
				const gen = (async function* (): AsyncGenerator<AgentEvent> {
					yield { type: "session_start", sessionId: "sdk-skill-refresh" };
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
					send: vi.fn().mockResolvedValue(undefined),
					reloadSkills,
					supportedCommands,
				};
			},
		};
		const sm = new SessionManager(makeConfig(), makeProviders(provider));
		await sm.runQuery("hello", vi.fn(), { sessionId: "db-session" });
		supportedCommands.mockClear();
		const emitted: ServerMessage[] = [];

		await expect(
			sm.reloadProviderSkills((message) => emitted.push(message)),
		).resolves.toEqual({
			providerId: "claude",
			status: "reloaded",
			skillCount: 1,
		});
		expect(reloadSkills).toHaveBeenCalledOnce();
		expect(emitted).toContainEqual({
			type: "slash_commands",
			provider_id: "claude",
			session_id: "db-session",
			commands: refreshedSkills,
		});
		expect(supportedCommands).not.toHaveBeenCalled();
	});

	it("reports not-live without creating a Claude provider session", async () => {
		const provider: AgentProvider = {
			providerId: "claude",
			label: "Claude",
			query: vi.fn(),
		};
		const sm = new SessionManager(makeConfig(), makeProviders(provider));

		await expect(sm.reloadProviderSkills(vi.fn())).resolves.toMatchObject({
			providerId: "claude",
			status: "not-live",
		});
		expect(provider.query).not.toHaveBeenCalled();
	});
});

describe("SessionManager — applyProviderMcpServers", () => {
	it("applies definitions through an existing Claude session and publishes status", async () => {
		const setMcpServers = vi.fn().mockResolvedValue({
			added: ["search"],
			removed: [],
			errors: {},
		});
		const mcpServerStatus = vi
			.fn()
			.mockResolvedValue([
				{ name: "search", status: "connected" as const, scope: "project" },
			]);
		const provider: AgentProvider = {
			providerId: "claude",
			label: "Claude",
			query(): AgentSession {
				return {
					async *[Symbol.asyncIterator]() {
						yield {
							type: "done" as const,
							cost: 0,
							turns: 1,
							durationMs: 0,
							usage: { inputTokens: 1, outputTokens: 1 },
						};
					},
					cancel: vi.fn(),
					send: vi.fn().mockResolvedValue(undefined),
					setMcpServers,
					mcpServerStatus,
				};
			},
		};
		const sm = new SessionManager(makeConfig(), makeProviders(provider));
		await sm.runQuery("hello", vi.fn(), { sessionId: "db-session" });
		const emitted: ServerMessage[] = [];
		const definitions = [
			{
				name: "search",
				config: { command: "bun", args: ["server.ts"] },
				disabled: false,
			},
		];

		await expect(
			sm.applyProviderMcpServers(definitions, (message) =>
				emitted.push(message),
			),
		).resolves.toEqual({
			providerId: "claude",
			status: "applied",
			result: { added: ["search"], removed: [], errors: {} },
			statuses: [{ name: "search", status: "connected", scope: "project" }],
		});
		expect(setMcpServers).toHaveBeenCalledWith(definitions);
		expect(emitted).toContainEqual({
			type: "mcp_status",
			provider_id: "claude",
			session_id: "db-session",
			servers: [{ name: "search", status: "connected", scope: "project" }],
		});
		expect(sm.getLastMcpStatus("claude")).toEqual([
			{ name: "search", status: "connected", scope: "project" },
		]);
	});

	it("reports not-live without creating a Claude provider session", async () => {
		const provider: AgentProvider = {
			providerId: "claude",
			label: "Claude",
			query: vi.fn(),
		};
		const sm = new SessionManager(makeConfig(), makeProviders(provider));

		await expect(
			sm.applyProviderMcpServers([], vi.fn()),
		).resolves.toMatchObject({
			providerId: "claude",
			status: "not-live",
		});
		expect(provider.query).not.toHaveBeenCalled();
	});
});

// ── probeSlashCommands ────────────────────────────────────────────────────────

describe("SessionManager — probeSlashCommands", () => {
	it("serializes simultaneous MCP and command probes without dropping either", async () => {
		const query = vi.fn(
			(): AgentSession => ({
				async *[Symbol.asyncIterator]() {},
				cancel: vi.fn(),
				send: vi.fn().mockResolvedValue(undefined),
				mcpServerStatus: () =>
					Promise.resolve([{ name: "github", status: "connected" as const }]),
				supportedCommands: () =>
					Promise.resolve([
						{ name: "review", description: "Review changes", argumentHint: "" },
					]),
			}),
		);
		const provider: AgentProvider = { providerId: "codex", query };
		const emitted: ServerMessage[] = [];
		const sm = new SessionManager(makeConfig(), makeProviders(provider));

		await Promise.all([
			sm.probeMcpStatus((message) => emitted.push(message), {
				agentCwd: "/tmp/project",
			}),
			sm.probeSlashCommands((message) => emitted.push(message)),
		]);

		expect(query).toHaveBeenCalledTimes(2);
		expect(emitted.some((message) => message.type === "mcp_status")).toBe(true);
		expect(emitted.some((message) => message.type === "slash_commands")).toBe(
			true,
		);
		expect(sm.getLastMcpStatus()).toBeNull();
	});

	it("answers turn-gated probes from the startup cache without creating a session", async () => {
		const query = vi.fn();
		const provider: AgentProvider = {
			providerId: "claude",
			probeRequiresTurn: true,
			query,
		};
		vi.mocked(waitForClaudeWarmupSnapshot).mockResolvedValueOnce({
			commands: [
				{ name: "review", description: "Review changes", argumentHint: "" },
			],
			agents: [],
			mcpServers: [],
			modelCount: 0,
			cwd: "/tmp/project",
			warmedAt: 1,
			durationMs: 100,
		});
		const emitted: ServerMessage[] = [];
		const sm = new SessionManager(makeConfig(), makeProviders(provider));
		await sm.probeSlashCommands((message) => emitted.push(message), {
			agentCwd: "/tmp/project",
			sessionId: "session-1",
		});
		expect(query).not.toHaveBeenCalled();
		expect(emitted).toEqual([
			{
				type: "slash_commands",
				provider_id: "claude",
				agent_cwd: "/tmp/project",
				session_id: "session-1",
				commands: [
					{ name: "review", description: "Review changes", argumentHint: "" },
				],
			},
		]);
	});

	it("serves cached Claude MCP status without creating a chat process", async () => {
		const query = vi.fn();
		const provider: AgentProvider = {
			providerId: "claude",
			probeRequiresTurn: true,
			query,
		};
		vi.mocked(waitForClaudeWarmupSnapshot).mockResolvedValueOnce({
			commands: [],
			agents: [],
			mcpServers: [{ name: "github", status: "connected" }],
			modelCount: 0,
			cwd: "/tmp/project",
			warmedAt: 1,
			durationMs: 100,
		});
		const emitted: ServerMessage[] = [];
		const sm = new SessionManager(makeConfig(), makeProviders(provider));
		await sm.probeMcpStatus((message) => emitted.push(message), {
			agentCwd: "/tmp/project",
			sessionId: "session-1",
		});

		expect(query).not.toHaveBeenCalled();
		expect(emitted).toEqual([
			{
				type: "mcp_status",
				provider_id: "claude",
				agent_cwd: "/tmp/project",
				session_id: "session-1",
				servers: [
					expect.objectContaining({
						name: "github",
						status: "connected",
					}),
				],
			},
		]);
	});

	it("uses an archived session's saved provider for cached MCP discovery", async () => {
		const codexQuery = vi.fn();
		const claudeQuery = vi.fn();
		const providers = new Map<string, AgentProvider>([
			["codex", { providerId: "codex", query: codexQuery }],
			[
				"claude",
				{
					providerId: "claude",
					probeRequiresTurn: true,
					query: claudeQuery,
				},
			],
		]);
		const config = { ...makeConfig(), vault_provider: "codex" } as HlidConfig;
		vi.mocked(waitForClaudeWarmupSnapshot).mockResolvedValueOnce({
			commands: [],
			agents: [],
			mcpServers: [{ name: "claude.ai Excalidraw", status: "connected" }],
			modelCount: 0,
			cwd: "/tmp/project",
			warmedAt: 1,
			durationMs: 100,
		});
		const emitted: ServerMessage[] = [];
		const sm = new SessionManager(config, providers);

		await sm.probeMcpStatus((message) => emitted.push(message), {
			agentCwd: "/tmp/project",
			sessionId: "archived-claude-session",
			providerId: "claude",
		});

		expect(codexQuery).not.toHaveBeenCalled();
		expect(claudeQuery).not.toHaveBeenCalled();
		expect(emitted).toEqual([
			expect.objectContaining({
				type: "mcp_status",
				provider_id: "claude",
				session_id: "archived-claude-session",
				servers: [
					expect.objectContaining({
						name: "claude.ai Excalidraw",
						status: "connected",
					}),
				],
			}),
		]);
	});

	it("emits slash_commands WS message with commands from supportedCommands()", async () => {
		const mockCommands = [
			{ name: "help", description: "Show help", argumentHint: "" },
			{ name: "usage", description: "Show token usage", argumentHint: "" },
		];

		const provider: AgentProvider = {
			providerId: "claude",
			query(): AgentSession {
				const gen = (async function* (): AsyncGenerator<AgentEvent> {
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
					send: vi.fn().mockResolvedValue(undefined),
					mcpServerStatus: () => Promise.resolve([]),
					supportedCommands: () => Promise.resolve(mockCommands),
				};
			},
		};

		const emitted: ServerMessage[] = [];
		const sm = new SessionManager(makeConfig(), makeProviders(provider));
		await sm.probeSlashCommands((m) => emitted.push(m));

		expect(
			emitted.some(
				(m) =>
					m.type === "slash_commands" &&
					(m as { type: string; commands: unknown[] }).commands.length === 2,
			),
		).toBe(true);
	});

	it("does not throw when supportedCommands is not available on provider session", async () => {
		const provider: AgentProvider = {
			providerId: "claude",
			query(): AgentSession {
				const gen = (async function* (): AsyncGenerator<AgentEvent> {
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
					send: vi.fn().mockResolvedValue(undefined),
					mcpServerStatus: () => Promise.resolve([]),
					// no supportedCommands
				};
			},
		};

		const emitted: ServerMessage[] = [];
		const sm = new SessionManager(makeConfig(), makeProviders(provider));
		await expect(
			sm.probeSlashCommands((m) => emitted.push(m)),
		).resolves.not.toThrow();
	});
});

describe("SessionManager — reusable workflows", () => {
	it("discovers provider-native workflows for the requested scope", async () => {
		const listWorkflows = vi.fn().mockResolvedValue({
			workflows: [
				{
					id: "claude-workflow:audit",
					name: "audit",
					description: "Audit the project",
					argumentHint: "[input]",
					scriptPath: "/tmp/project/.claude/workflows/audit.js",
					scope: "project",
					scopeLabel: "Project",
					availableAsCommand: true,
				},
			],
			locations: [
				{
					scope: "project",
					scopeLabel: "Project",
					path: "/tmp/project/.claude/workflows",
					available: true,
				},
			],
		});
		const provider: AgentProvider = {
			providerId: "claude",
			query: vi.fn(),
			listWorkflows,
		};
		const emitted: ServerMessage[] = [];
		const sm = new SessionManager(makeConfig(), makeProviders(provider));

		await sm.probeWorkflowCatalog((message) => emitted.push(message), {
			agentCwd: "/tmp/project",
			sessionId: "session-1",
		});

		expect(listWorkflows).toHaveBeenCalledWith({ cwd: "/tmp/project" });
		expect(emitted).toEqual([
			{
				type: "workflow_catalog",
				provider_id: "claude",
				agent_cwd: "/tmp/project",
				session_id: "session-1",
				workflows: [
					expect.objectContaining({
						name: "audit",
						scriptPath: "/tmp/project/.claude/workflows/audit.js",
					}),
				],
				locations: [
					expect.objectContaining({
						scope: "project",
						path: "/tmp/project/.claude/workflows",
					}),
				],
			},
		]);
	});

	it("keeps discovery non-blocking when the provider catalog is unavailable", async () => {
		const provider: AgentProvider = {
			providerId: "claude",
			query: vi.fn(),
			listWorkflows: vi.fn().mockRejectedValue(new Error("home unavailable")),
		};
		const emitted: ServerMessage[] = [];
		const sm = new SessionManager(makeConfig(), makeProviders(provider));

		await sm.probeWorkflowCatalog((message) => emitted.push(message));

		expect(emitted).toEqual([
			{
				type: "workflow_catalog",
				provider_id: "claude",
				workflows: [],
				locations: [],
			},
		]);
	});

	it("saves through the active provider using its runtime cwd", async () => {
		const workflow = {
			id: "claude-workflow:audit",
			name: "audit",
			description: "Audit the project",
			argumentHint: "[input]",
			scriptPath: "/tmp/project/.claude/workflows/audit.js",
			scope: "project" as const,
			scopeLabel: "Project",
			availableAsCommand: true,
		};
		const saveWorkflow = vi.fn().mockResolvedValue(workflow);
		const provider: AgentProvider = {
			providerId: "claude",
			query: vi.fn(),
			saveWorkflow,
		};
		const sm = new SessionManager(
			makeConfig(),
			makeProviders(provider),
			"/tmp/project",
		);

		await expect(
			sm.saveProviderWorkflow({
				sourceScriptPath:
					"/tmp/.claude/projects/project/session/workflows/scripts/audit.js",
				scope: "project",
				overwrite: true,
			}),
		).resolves.toEqual(workflow);
		expect(saveWorkflow).toHaveBeenCalledWith({
			cwd: "/tmp/project",
			sourceScriptPath:
				"/tmp/.claude/projects/project/session/workflows/scripts/audit.js",
			scope: "project",
			overwrite: true,
		});
	});

	it("saves through an archived session's recorded provider and cwd", async () => {
		const workflow = {
			id: "claude-workflow:archive-audit",
			name: "archive-audit",
			description: "Audit the archived project",
			argumentHint: "[input]",
			scriptPath: "/tmp/archived/.claude/workflows/archive-audit.js",
			scope: "project" as const,
			scopeLabel: "Project",
			availableAsCommand: true,
		};
		const saveWorkflow = vi.fn().mockResolvedValue(workflow);
		const codexQuery = vi.fn();
		const claudeQuery = vi.fn();
		const providers = new Map<string, AgentProvider>([
			["codex", { providerId: "codex", query: codexQuery }],
			[
				"claude",
				{
					providerId: "claude",
					query: claudeQuery,
					saveWorkflow,
				},
			],
		]);
		const config = { ...makeConfig(), vault_provider: "codex" } as HlidConfig;
		const sm = new SessionManager(config, providers);

		await expect(
			sm.saveProviderWorkflow(
				{
					sourceScriptPath:
						"/tmp/.claude/projects/archived/session/workflows/scripts/archive-audit.js",
					scope: "project",
				},
				{
					agentCwd: "/tmp/archived",
					sessionId: "archived-session",
					providerId: "claude",
				},
			),
		).resolves.toEqual(workflow);
		expect(saveWorkflow).toHaveBeenCalledWith({
			cwd: "/tmp/archived",
			sourceScriptPath:
				"/tmp/.claude/projects/archived/session/workflows/scripts/archive-audit.js",
			scope: "project",
		});
		expect(codexQuery).not.toHaveBeenCalled();
		expect(claudeQuery).not.toHaveBeenCalled();
	});

	it("deletes through an archived session's recorded provider and cwd", async () => {
		const deleteWorkflow = vi.fn().mockResolvedValue(undefined);
		const codexQuery = vi.fn();
		const claudeQuery = vi.fn();
		const providers = new Map<string, AgentProvider>([
			["codex", { providerId: "codex", query: codexQuery }],
			[
				"claude",
				{
					providerId: "claude",
					query: claudeQuery,
					deleteWorkflow,
				},
			],
		]);
		const config = { ...makeConfig(), vault_provider: "codex" } as HlidConfig;
		const sm = new SessionManager(config, providers);

		await sm.deleteProviderWorkflow(
			{
				scriptPath: "/tmp/archived/.claude/workflows/archive-audit.js",
				scope: "project",
			},
			{
				agentCwd: "/tmp/archived",
				sessionId: "archived-session",
				providerId: "claude",
			},
		);

		expect(deleteWorkflow).toHaveBeenCalledWith({
			cwd: "/tmp/archived",
			scriptPath: "/tmp/archived/.claude/workflows/archive-audit.js",
			scope: "project",
		});
		expect(codexQuery).not.toHaveBeenCalled();
		expect(claudeQuery).not.toHaveBeenCalled();
	});

	it("reads source through an archived session's recorded provider and cwd", async () => {
		const source = 'export const meta = { name: "archive-audit" }';
		const readWorkflowSource = vi.fn().mockResolvedValue(source);
		const codexQuery = vi.fn();
		const claudeQuery = vi.fn();
		const providers = new Map<string, AgentProvider>([
			["codex", { providerId: "codex", query: codexQuery }],
			[
				"claude",
				{
					providerId: "claude",
					query: claudeQuery,
					readWorkflowSource,
				},
			],
		]);
		const config = { ...makeConfig(), vault_provider: "codex" } as HlidConfig;
		const sm = new SessionManager(config, providers);

		await expect(
			sm.readProviderWorkflowSource(
				{
					scriptPath: "/tmp/archived/.claude/workflows/archive-audit.js",
					scope: "project",
				},
				{
					agentCwd: "/tmp/archived",
					sessionId: "archived-session",
					providerId: "claude",
				},
			),
		).resolves.toBe(source);
		expect(readWorkflowSource).toHaveBeenCalledWith({
			cwd: "/tmp/archived",
			scriptPath: "/tmp/archived/.claude/workflows/archive-audit.js",
			scope: "project",
		});
		expect(codexQuery).not.toHaveBeenCalled();
		expect(claudeQuery).not.toHaveBeenCalled();
	});

	it("rejects save when the active provider has no native workflow catalog", async () => {
		const provider: AgentProvider = {
			providerId: "codex",
			label: "Codex",
			query: vi.fn(),
		};
		const config = { ...makeConfig(), vault_provider: "codex" } as HlidConfig;
		const sm = new SessionManager(config, makeProviders(provider));

		await expect(
			sm.saveProviderWorkflow({
				sourceScriptPath: "/tmp/audit.js",
				scope: "personal",
			}),
		).rejects.toThrow("Codex does not expose reusable workflows");
	});
});

// providerId strings to avoid colliding with other tests.

describe("SessionManager — status:running fires after initSessionContext", () => {
	/** Provider that completes immediately (no tool permission gate). */
	function makeImmediateProvider(): AgentProvider {
		return {
			providerId: "claude",
			query(): ReturnType<AgentProvider["query"]> {
				const gen = (async function* (): AsyncGenerator<AgentEvent> {
					yield { type: "session_start", sessionId: "sdk-immediate" };
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
					send: vi.fn().mockResolvedValue(undefined),
					mcpServerStatus: () => Promise.resolve([]),
				};
			},
		};
	}

	it("getCurrentSessionId() is non-null when status:running event fires", async () => {
		const sm = new SessionManager(
			makeConfig(),
			makeProviders(makeImmediateProvider()),
		);

		let sessionIdOnRunning: string | null | undefined;

		await sm.runQuery(
			"hello",
			(event) => {
				if (event.type === "status" && event.state === "running") {
					sessionIdOnRunning = sm.getCurrentSessionId();
				}
			},
			{
				sessionId: "test-db-session-id",
			},
		);

		// status:running must have fired (undefined means it never fired)
		expect(sessionIdOnRunning).not.toBeUndefined();
		// and currentSessionId must be set at that point
		expect(sessionIdOnRunning).toBe("test-db-session-id");
	});

	it("turn_id is included in status:running when provided", async () => {
		const sm = new SessionManager(
			makeConfig(),
			makeProviders(makeImmediateProvider()),
		);

		let runningEvent: Record<string, unknown> | null = null;

		await sm.runQuery(
			"hello",
			(event) => {
				if (event.type === "status" && event.state === "running") {
					runningEvent = event as Record<string, unknown>;
				}
			},
			{
				sessionId: "test-db-session-id",
				turnId: "turn-abc-123",
			},
		);

		expect(runningEvent).not.toBeNull();
		expect((runningEvent as { turn_id?: string } | null)?.turn_id).toBe(
			"turn-abc-123",
		);
	});
});

// ── auto-sleep gates ──────────────────────────────────────────────────────────

describe("SessionManager — assistant_message_id capture", () => {
	it("stamps the assistant row with the native provider turn id", async () => {
		vi.mocked(dbMock.setMessageProviderTurnId).mockClear();
		const provider: AgentProvider = {
			providerId: "codex",
			query(_params: AgentQueryParams): AgentSession {
				const gen = (async function* (): AsyncGenerator<AgentEvent> {
					yield { type: "session_start", sessionId: "thread-1" };
					yield { type: "provider_turn_id", id: "turn-7" };
					yield { type: "text_delta", text: "Hi." };
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

		const sm = new SessionManager(makeConfig(), makeProviders(provider));
		await sm.runQuery("hello", () => {}, {
			sessionId: "sess-turn-id",
		});

		expect(dbMock.setMessageProviderTurnId).toHaveBeenCalledWith(
			"sess-turn-id",
			expect.any(Number),
			"turn-7",
		);
	});

	it("stamps the turn's row with the last of several raw SDK message uuids", async () => {
		vi.mocked(dbMock.setMessageSdkUuid).mockClear();
		const provider: AgentProvider = {
			providerId: "claude",
			query(_params: AgentQueryParams): AgentSession {
				const gen = (async function* (): AsyncGenerator<AgentEvent> {
					yield { type: "session_start", sessionId: "sdk-s1" };
					// Turn spans two raw SDK messages: text, then a tool call from a
					// second message, then more text from a third — each with its
					// own uuid, same displayed turn/row.
					yield { type: "assistant_message_id", id: "sdk-msg-uuid-1" };
					yield { type: "text_delta", text: "First. " };
					yield { type: "assistant_message_id", id: "sdk-msg-uuid-2" };
					yield { type: "tool_start", toolId: "t1", name: "Bash", input: {} };
					yield { type: "assistant_message_id", id: "sdk-msg-uuid-3" };
					yield { type: "text_delta", text: "Second." };
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

		const sm = new SessionManager(makeConfig(), makeProviders(provider));
		await sm.runQuery("hello", () => {}, {
			sessionId: "sess-uuid",
		});

		const calls = vi.mocked(dbMock.setMessageSdkUuid).mock.calls;
		expect(calls.length).toBeGreaterThanOrEqual(3);
		// Every call lands on the same (sessionId, seq) — one row for the whole
		// turn — and the row ends up holding the *last* uuid seen.
		const [sessionId, seq] = calls[0];
		for (const call of calls) {
			expect(call[0]).toBe(sessionId);
			expect(call[1]).toBe(seq);
		}
		expect(calls.at(-1)?.[2]).toBe("sdk-msg-uuid-3");
	});

	it("links the completed assistant row to its recorded query before emitting done", async () => {
		vi.mocked(dbMock.appendMessage).mockClear();
		vi.mocked(dbMock.recordQuery).mockResolvedValueOnce({
			estimatedCost: 0.125,
			queryId: 4242,
		});
		vi.mocked(dbMock.setMessageQueryId).mockClear();
		const provider: AgentProvider = {
			providerId: "codex",
			query(_params: AgentQueryParams): AgentSession {
				const gen = (async function* (): AsyncGenerator<AgentEvent> {
					yield { type: "text_delta", text: "Linked." };
					yield {
						type: "done",
						cost: 0,
						turns: 1,
						durationMs: 10,
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
		let linksObservedAtDone = -1;
		const sm = new SessionManager(makeConfig(), makeProviders(provider));

		await sm.runQuery(
			"hello",
			(message) => {
				if (message.type === "done") {
					linksObservedAtDone = vi.mocked(dbMock.setMessageQueryId).mock.calls
						.length;
				}
			},
			{ sessionId: "sess-query-link" },
		);

		const assistantAppend = vi
			.mocked(dbMock.appendMessage)
			.mock.calls.find((call) => call[2] === "assistant");
		expect(assistantAppend).toBeDefined();
		expect(dbMock.setMessageQueryId).toHaveBeenCalledWith(
			"sess-query-link",
			assistantAppend?.[1],
			4242,
		);
		expect(linksObservedAtDone).toBe(1);
	});

	it("includes db_id in the 'done' message once the assistant row is persisted, so a live message can be branched from without a reload", async () => {
		// appendMessage also fires once for the user turn before the assistant
		// placeholder row — key off `role` so 777 lands on the row we're
		// actually asserting on.
		vi.mocked(dbMock.appendMessage).mockImplementation(
			async (_s, _seq, role) => (role === "assistant" ? 777 : 1),
		);
		const provider: AgentProvider = {
			providerId: "claude",
			query(_params: AgentQueryParams): AgentSession {
				const gen = (async function* (): AsyncGenerator<AgentEvent> {
					yield { type: "session_start", sessionId: "sdk-s1" };
					yield { type: "text_delta", text: "Hi." };
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

		const emitted: ServerMessage[] = [];
		const sm = new SessionManager(makeConfig(), makeProviders(provider));
		await sm.runQuery("hello", (m) => emitted.push(m), {
			sessionId: "sess-dbid",
		});

		const done = emitted.find((m) => m.type === "done");
		expect(done).toMatchObject({ db_id: 777 });
		vi.mocked(dbMock.appendMessage).mockResolvedValue(1);
	});
});
