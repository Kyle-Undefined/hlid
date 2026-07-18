import { realpathSync } from "node:fs";
import type { ServerWebSocket } from "bun";
import * as db from "../db";
import { readAgentMcpFile } from "../lib/agentMcp";
import { expandTilde } from "../lib/paths";
import { readVaultMcpFile } from "../lib/vaultMcp";
import { computeAllowedAgentRealPaths, isAllowedAgentPath } from "./agentPaths";
import {
	waitForAllClaudeWarmupSnapshots,
	waitForClaudeWarmupSnapshot,
} from "./claudeWarmup";
import { loadConfig } from "./config";
import { getDataRevisions } from "./dataRevision";
import { getLiveSessionsStatus } from "./liveSessions";
import {
	type ClientMessage,
	decisionFromScope,
	mapMcpServer,
	type QueueStateMessage,
	type StatusMessage,
} from "./protocol";
import { broadcast, send, wsState } from "./runState";
import { resolveConfiguredSessionDefaults } from "./session";
import type { PoolEntry, SessionPool } from "./sessionPool";
import type { ShellSessionPool } from "./shellSessionPool";
import type { TerminalSessionPool } from "./terminalSessionPool";
import { parseClientMessage } from "./wsSchemas";

/** Per-connection data stored on the Bun WS object. */
export type WsData = {
	isTerminal?: false;
	subscribedSessionId: string;
	/** Set by "clear" so the next "chat" spawns a fresh pool entry without
	 *  cancelling the current subprocess. */
	pendingNewSession?: boolean;
};

/**
 * Resolve the display name for a given agent working directory.
 * Checks vault path first, then registered agents in config.
 * Falls back to the last path component when no match is found.
 */
function resolveAgentName(agentCwd: string): string {
	try {
		const cfg = loadConfig();
		if (cfg.vault.path && agentCwd === cfg.vault.path) {
			return cfg.vault.name ?? "Vault";
		}
		const agent = cfg.agents?.find((a) => a.path === agentCwd);
		if (agent?.name) return agent.name;
	} catch {
		// loadConfig failure — fall through to path-based fallback
	}
	return agentCwd.split("/").filter(Boolean).pop() ?? agentCwd;
}

type MessageOf<T extends ClientMessage["type"]> = Extract<
	ClientMessage,
	{ type: T }
>;

interface MessageContext {
	ws: ServerWebSocket<WsData>;
	pool: SessionPool;
	terminalPool?: TerminalSessionPool;
	shellPool?: ShellSessionPool;
}

function broadcastSessionsStatus({ pool, terminalPool }: MessageContext): void {
	broadcast({
		type: "sessions_status",
		sessions: getLiveSessionsStatus(pool, terminalPool),
	});
}

function createPoolEntry(
	context: MessageContext,
	agentCwd: string,
	agentName: string,
): PoolEntry | null {
	try {
		return context.pool.create(agentCwd, agentName);
	} catch (error) {
		send(context.ws, {
			type: "error",
			message:
				error instanceof Error ? error.message : "Failed to create session",
		});
		return null;
	}
}

function subscribeToEntry(
	{ ws, pool }: MessageContext,
	entry: PoolEntry,
): void {
	pool.get(ws.data.subscribedSessionId)?.runState.removeSubscriber(ws);
	entry.runState.addSubscriber(ws);
	ws.data.subscribedSessionId = entry.sessionId;
}

function sendSessionCreated({ ws }: MessageContext, entry: PoolEntry): void {
	send(ws, {
		type: "session_created",
		session_id: entry.sessionId,
		agent_cwd: entry.agentCwd,
		agent_name: entry.agentName,
	});
}

function queueStateMessage(entry: PoolEntry): QueueStateMessage {
	return {
		type: "queue_state",
		session_id: entry.manager.getCurrentSessionId() ?? entry.sessionId,
		...entry.manager.getQueueState(),
	};
}

function sendQueueState(ws: ServerWebSocket<WsData>, entry: PoolEntry): void {
	send(ws, queueStateMessage(entry));
}

function broadcastQueueState(entry: PoolEntry): void {
	entry.runState.broadcast(queueStateMessage(entry));
}

function handleNewSession(
	context: MessageContext,
	msg: MessageOf<"new_session">,
): void {
	const vault = context.pool.vaultEntry();
	const entry = createPoolEntry(
		context,
		msg.agent_cwd ?? vault.agentCwd,
		msg.agent_name ?? vault.agentName,
	);
	if (!entry) return;
	subscribeToEntry(context, entry);
	sendSessionCreated(context, entry);
	send(context.ws, { type: "status", ...entry.manager.getStatus() });
	sendQueueState(context.ws, entry);
	broadcastSessionsStatus(context);
}

async function handleSubscribeSession(
	{ ws, pool }: MessageContext,
	msg: MessageOf<"subscribe_session">,
): Promise<void> {
	ws.data.pendingNewSession = false;
	pool.get(ws.data.subscribedSessionId)?.runState.removeSubscriber(ws);
	const entry =
		pool.get(msg.session_id) ?? pool.findByDbSessionId(msg.session_id);
	if (!entry) {
		// Keep archived/unknown DB sessions detached from every live pool entry.
		// Falling back to the vault here leaks the vault's in-flight events into
		// whichever transcript Raven is displaying.
		ws.data.subscribedSessionId = msg.session_id;
		const vaultStatus = pool.vaultEntry().manager.getStatus();
		let detachedStatus: Omit<StatusMessage, "type"> = {
			...vaultStatus,
			state: "idle",
		};
		try {
			const savedSelection = await db.getSessionSelection(msg.session_id);
			const configured = resolveConfiguredSessionDefaults(
				loadConfig(),
				savedSelection?.agentCwd ?? undefined,
			);
			detachedStatus = {
				state: "idle",
				model: savedSelection?.model ?? configured.model,
				effort: savedSelection?.effort ?? configured.effort,
				permission_mode:
					savedSelection?.permissionMode ?? configured.permissionMode,
			};
		} catch {
			// A missing/corrupt archived row still gets a safe idle vault snapshot.
		}
		send(ws, {
			type: "status",
			...detachedStatus,
		});
		send(ws, {
			type: "queue_state",
			session_id: msg.session_id,
			pending_turn_ids: [],
			running_turn_id: null,
		});
		return;
	}
	entry.runState.addSubscriber(ws);
	ws.data.subscribedSessionId = entry.sessionId;
	send(ws, { type: "status", ...entry.manager.getStatus() });
	const cachedMcp = entry.manager.getLastMcpStatus();
	if (cachedMcp) {
		const providerId = entry.manager.getProviderId();
		const agentCwd = entry.manager.getAgentCwd();
		send(ws, {
			type: "mcp_status",
			...(providerId ? { provider_id: providerId } : {}),
			...(agentCwd ? { agent_cwd: agentCwd } : {}),
			...(entry.manager.getCurrentSessionId()
				? { session_id: entry.manager.getCurrentSessionId() ?? undefined }
				: {}),
			servers: cachedMcp.map(mapMcpServer),
		});
	}
	const context = entry.runState.getContextSnapshot?.();
	if (context) entry.runState.send(ws, context);
	if (entry.manager.isRunning()) {
		for (const buffered of entry.runState.getReplayBuffer()) send(ws, buffered);
	}
	// Auto-sleep is transient session state rather than a transcript event, so
	// it is not part of the normal replay buffer. Re-send it when Raven switches
	// to an already-sleeping live session just as we do on connect and sync.
	const sleep = entry.manager.getSleepState();
	if (sleep) send(ws, sleep);
	sendQueueState(ws, entry);
}

function handleStopSession(
	{ pool, terminalPool }: MessageContext,
	msg: MessageOf<"stop_session">,
): void {
	const entry = pool.get(msg.session_id);
	if (entry) entry.manager.abort();
	else terminalPool?.write(msg.session_id, "\x03");
}

function resubscribeClosedSessionClients(
	pool: SessionPool,
	sessionId: string,
): void {
	const vault = pool.vaultEntry();
	for (const client of wsState.clients) {
		const clientWs = client as ServerWebSocket<WsData>;
		if (clientWs.data?.subscribedSessionId !== sessionId) continue;
		vault.runState.addSubscriber(clientWs);
		clientWs.data.subscribedSessionId = vault.sessionId;
	}
}

function handleCloseSession(
	context: MessageContext,
	msg: MessageOf<"close_session">,
): void {
	const { ws, pool, terminalPool, shellPool } = context;
	if (msg.session_id === pool.vaultSessionId()) {
		send(ws, { type: "error", message: "Cannot close the vault session" });
		return;
	}
	const entry = pool.get(msg.session_id);
	const dbSessionId = entry?.manager.getCurrentSessionId() ?? null;
	if (entry) {
		pool.close(msg.session_id);
		resubscribeClosedSessionClients(pool, msg.session_id);
	} else {
		terminalPool?.close(msg.session_id);
	}
	shellPool?.close(msg.session_id);
	if (dbSessionId && dbSessionId !== msg.session_id) {
		shellPool?.close(dbSessionId);
	}
	broadcast({ type: "session_closed", session_id: msg.session_id });
	broadcastSessionsStatus(context);
}

function handleRoutingMessage(
	context: MessageContext,
	msg: ClientMessage,
): boolean {
	switch (msg.type) {
		case "new_session":
			handleNewSession(context, msg);
			return true;
		case "stop_session":
			handleStopSession(context, msg);
			return true;
		case "close_session":
			handleCloseSession(context, msg);
			return true;
		default:
			return false;
	}
}

function handleSync(ws: ServerWebSocket<WsData>, entry: PoolEntry): void {
	send(ws, { type: "status", ...entry.manager.getStatus() });
	sendQueueState(ws, entry);
	const context = entry.runState.getContextSnapshot?.();
	if (context) entry.runState.send(ws, context);
	// Informational — every syncing client gets the sleep banner, not just the
	// prompt owner.
	const sleep = entry.manager.getSleepState();
	if (sleep) send(ws, sleep);
	if (!entry.manager.isRunning() || entry.runState.ownerWs !== null) return;
	entry.runState.ownerWs = ws;
	for (const request of entry.manager.getPendingPermissionRequests())
		entry.runState.send(ws, request);
	for (const exit of entry.manager.getPendingPlanModeExits())
		entry.runState.send(ws, exit);
}

function handleReloadSession(
	pool: SessionPool,
	terminalPool: TerminalSessionPool | undefined,
	entry: PoolEntry,
): void {
	const fresh = loadConfig();
	entry.manager.reinitialize(fresh);
	pool.syncConfig(fresh);
	entry.runState.clearError();
	entry.runState.broadcast({ type: "status", ...entry.manager.getStatus() });
	broadcast({
		type: "sessions_status",
		sessions: getLiveSessionsStatus(pool, terminalPool),
	});
}

async function handlePermissionMode(
	ws: ServerWebSocket<WsData>,
	entry: PoolEntry,
	msg: MessageOf<"set_permission_mode">,
): Promise<void> {
	try {
		await entry.manager.setPermissionMode(msg.mode);
	} catch (error) {
		send(ws, {
			type: "error",
			message:
				error instanceof Error ? error.message : "Invalid permission mode",
		});
		return;
	}
	entry.runState.broadcast({ type: "status", ...entry.manager.getStatus() });
}

function readAgentServers(resolvedAgent: string) {
	try {
		return readAgentMcpFile(resolvedAgent).servers;
	} catch {
		return [];
	}
}

function syncAgentMcpList(
	ws: ServerWebSocket<WsData>,
	entry: PoolEntry,
	agentCwd: string,
): void {
	const config = loadConfig();
	let resolvedAgent: string;
	try {
		resolvedAgent = realpathSync(expandTilde(agentCwd));
	} catch {
		return;
	}
	if (!isAllowedAgentPath(computeAllowedAgentRealPaths(config), resolvedAgent))
		return;
	const servers = readAgentServers(resolvedAgent).map(({ name, disabled }) =>
		mapMcpServer({
			name,
			status: disabled ? "disabled" : "pending",
			scope: "project",
		}),
	);
	send(ws, {
		type: "mcp_status",
		...(entry.manager.getProviderId(resolvedAgent)
			? { provider_id: entry.manager.getProviderId(resolvedAgent) }
			: {}),
		servers,
		agent_cwd: agentCwd,
	});
}

function readVaultServers(vaultPath: string) {
	try {
		return readVaultMcpFile(vaultPath).servers;
	} catch {
		return [];
	}
}

async function syncMcpInventory(
	ws: ServerWebSocket<WsData>,
	pool: SessionPool,
	agentCwd?: string,
): Promise<void> {
	const config = loadConfig();
	let resolvedAgent: string | undefined;
	if (agentCwd) {
		try {
			resolvedAgent = realpathSync(expandTilde(agentCwd));
		} catch {
			return;
		}
		if (
			!isAllowedAgentPath(computeAllowedAgentRealPaths(config), resolvedAgent)
		)
			return;
	}

	const inventory = new Map<string, ReturnType<typeof mapMcpServer>>();
	const configuredProvider = pool
		.vaultEntry()
		.manager.getProviderId(resolvedAgent);
	const configuredServers = resolvedAgent
		? readAgentServers(resolvedAgent)
		: config.vault.path
			? readVaultServers(config.vault.path)
			: [];
	for (const { name, disabled } of configuredServers) {
		inventory.set(
			`${configuredProvider}:${name}`,
			mapMcpServer({
				name,
				providerId: configuredProvider,
				status: disabled ? "disabled" : "pending",
				scope: "project",
			}),
		);
	}

	// Claude metadata is discovered and cached at startup independently of chat
	// sessions. Cockpit is a cross-provider inventory, so include that cache even
	// when no Claude SessionManager has ever been started.
	const claudeSnapshots = resolvedAgent
		? [await waitForClaudeWarmupSnapshot(resolvedAgent)]
		: await waitForAllClaudeWarmupSnapshots();
	for (const snapshot of claudeSnapshots) {
		for (const server of snapshot?.mcpServers ?? []) {
			inventory.set(
				`claude:${server.name}`,
				mapMcpServer({ ...server, providerId: "claude" }),
			);
		}
	}

	for (const entry of pool.getAllEntries()) {
		if (resolvedAgent && entry.agentCwd !== resolvedAgent) continue;
		for (const snapshot of entry.manager.getMcpSnapshots()) {
			for (const server of snapshot.servers) {
				inventory.set(
					`${snapshot.providerId}:${server.name}`,
					mapMcpServer({ ...server, providerId: snapshot.providerId }),
				);
			}
		}
	}

	send(ws, {
		type: "mcp_status",
		inventory: true,
		...(agentCwd ? { agent_cwd: agentCwd } : {}),
		servers: [...inventory.values()],
	});
}

function syncVaultMcpList(pool: SessionPool): void {
	const config = loadConfig();
	if (!config.vault.path) return;
	const cached = pool.vaultEntry().manager.getLastMcpStatus() ?? [];
	const cachedByName = new Map(cached.map((server) => [server.name, server]));
	const preserved = cached
		.filter((server) => server.scope !== "project")
		.map(mapMcpServer);
	const vault = readVaultServers(config.vault.path).map(
		({ name, disabled }) => {
			const known = cachedByName.get(name);
			return mapMcpServer({
				name,
				status: disabled ? "disabled" : (known?.status ?? "pending"),
				scope: "project",
				error: disabled ? undefined : known?.error,
			});
		},
	);
	const providerId = pool.vaultEntry().manager.getProviderId();
	broadcast({
		type: "mcp_status",
		...(providerId ? { provider_id: providerId } : {}),
		servers: [...preserved, ...vault],
	});
}

function handlePermissionResponse(
	context: MessageContext,
	entry: PoolEntry,
	msg: MessageOf<"permission_response">,
): void {
	const pending = entry.manager
		.getPendingPermissionRequests()
		.find((request) => request.id === msg.id);
	if (!pending) return;
	entry.manager.handlePermissionResponse(
		msg.id,
		msg.approved,
		msg.saveScope,
		msg.denyMessage,
	);
	const decision = decisionFromScope(msg.approved, msg.saveScope);
	entry.runState.broadcast({
		type: "permission_resolved",
		id: msg.id,
		toolName: pending.toolName,
		displayName: pending.displayName,
		decision,
	});
	broadcastSessionsStatus(context);
	const sessionId = entry.manager.getCurrentSessionId();
	if (!sessionId) return;
	void db
		.recordPermissionEvent(
			sessionId,
			msg.id,
			pending.toolName,
			pending.displayName,
			decision,
		)
		.catch((error) => {
			console.error("[db] recordPermissionEvent failed:", error);
		});
}

function handleAskUserQuestionResponse(
	context: MessageContext,
	entry: PoolEntry,
	msg: MessageOf<"ask_user_question_response">,
): void {
	entry.manager.handleAskUserQuestionResponse(msg.id, msg.answers, msg.notes);
	entry.runState.broadcast({
		type: "ask_user_question_resolved",
		id: msg.id,
		answers: msg.answers,
		...(msg.notes !== undefined ? { notes: msg.notes } : {}),
	});
	broadcastSessionsStatus(context);
	const sessionId = entry.manager.getCurrentSessionId();
	if (!sessionId) return;
	void db
		.setAskUserQuestionResolution(
			sessionId,
			msg.id,
			JSON.stringify(msg.answers),
			msg.notes !== undefined ? JSON.stringify(msg.notes) : null,
		)
		.catch((error) => {
			console.error("[db] setAskUserQuestionResolution failed:", error);
		});
}

function handlePlanModeExitResponse(
	context: MessageContext,
	entry: PoolEntry,
	msg: MessageOf<"plan_mode_exit_response">,
): void {
	entry.manager.handlePlanModeExitResponse(
		msg.id,
		msg.decision,
		msg.decision === "edited" ? msg.feedback : undefined,
	);
	entry.runState.broadcast({
		type: "plan_mode_exit_resolved",
		id: msg.id,
		decision: msg.decision,
	});
	broadcastSessionsStatus(context);
}

function reuseExistingChatEntry(
	context: MessageContext,
	entry: PoolEntry,
	sessionId: string | undefined,
): PoolEntry {
	if (!sessionId || entry.manager.getCurrentSessionId() === sessionId)
		return entry;
	const existing = context.pool.findByDbSessionId(sessionId);
	if (!existing || existing.sessionId === entry.sessionId) return entry;
	entry.runState.removeSubscriber(context.ws);
	existing.runState.addSubscriber(context.ws);
	context.ws.data.subscribedSessionId = existing.sessionId;
	return existing;
}

function shouldCreateChatEntry(
	entry: PoolEntry,
	chatEntry: PoolEntry,
	msg: MessageOf<"chat">,
	needsNewSession: boolean,
): boolean {
	if (chatEntry !== entry) return false;
	if (entry.manager.isRunning() && !needsNewSession) {
		const currentSessionId = entry.manager.getCurrentSessionId();
		// Missing/same IDs are follow-ups and belong in this session's queue.
		// A different explicit ID is a parallel new chat and needs its own entry.
		if (!msg.session_id || msg.session_id === currentSessionId) return false;
	}
	return (
		entry.manager.getCurrentSessionId() === null ||
		(msg.agent_cwd !== undefined && msg.agent_cwd !== entry.agentCwd) ||
		(msg.session_id !== undefined &&
			msg.session_id !== entry.manager.getCurrentSessionId()) ||
		needsNewSession
	);
}

function resolveChatEntry(
	context: MessageContext,
	entry: PoolEntry,
	msg: MessageOf<"chat">,
): { entry: PoolEntry; created: boolean } | null {
	const needsNewSession = context.ws.data.pendingNewSession === true;
	if (needsNewSession) context.ws.data.pendingNewSession = false;
	const reused = reuseExistingChatEntry(context, entry, msg.session_id);
	if (!shouldCreateChatEntry(entry, reused, msg, needsNewSession))
		return { entry: reused, created: false };
	const targetCwd = msg.agent_cwd ?? context.pool.vaultEntry().agentCwd;
	const created = createPoolEntry(
		context,
		targetCwd,
		resolveAgentName(targetCwd),
	);
	if (!created) return null;
	subscribeToEntry(context, created);
	sendSessionCreated(context, created);
	return { entry: created, created: true };
}

function broadcastUserMessage(
	ws: ServerWebSocket<WsData>,
	entry: PoolEntry,
	msg: MessageOf<"chat">,
): void {
	const data = JSON.stringify({
		type: "user_message",
		text: msg.text,
		session_id: entry.sessionId,
		...(msg.turn_id !== undefined ? { id: msg.turn_id } : {}),
		...(msg.attachments !== undefined ? { attachments: msg.attachments } : {}),
	});
	for (const client of wsState.clients) {
		if (client === ws) continue;
		const clientWs = client as ServerWebSocket<WsData>;
		if (clientWs.data?.subscribedSessionId === entry.sessionId)
			clientWs.send(data);
	}
}

function claimChatOwnership(
	ws: ServerWebSocket<WsData>,
	entry: PoolEntry,
): void {
	entry.runState.ownerWs = ws;
	entry.runState.inFlightChatCount.set(
		ws,
		(entry.runState.inFlightChatCount.get(ws) ?? 0) + 1,
	);
}

function releaseChatOwnership(
	ws: ServerWebSocket<WsData>,
	entry: PoolEntry,
): void {
	const remaining = (entry.runState.inFlightChatCount.get(ws) ?? 1) - 1;
	if (remaining > 0) {
		entry.runState.inFlightChatCount.set(ws, remaining);
		return;
	}
	entry.runState.inFlightChatCount.delete(ws);
	if (entry.runState.ownerWs === ws) entry.runState.ownerWs = null;
}

async function runChatQuery(
	context: MessageContext,
	entry: PoolEntry,
	msg: MessageOf<"chat">,
): Promise<void> {
	try {
		const modelChanged = entry.manager.syncConfig(loadConfig());
		if (modelChanged)
			entry.runState.broadcast({
				type: "status",
				...entry.manager.getStatus(),
			});
		const queryArgs = [
			msg.text,
			(event) => {
				entry.runState.broadcast(event);
				if (event.type === "status") broadcastSessionsStatus(context);
			},
			msg.session_id,
			msg.skill_contexts ?? msg.skill_context,
			msg.attachments,
			msg.agent_cwd,
			msg.turn_id,
			msg.plan_mode,
			msg.plan_html,
		] as Parameters<typeof entry.manager.runQuery>;
		if (msg.command_action) queryArgs.push(msg.command_action);
		const completion = entry.manager.runQuery(...queryArgs);
		// Publish the queued content immediately. Other tabs/devices can now render
		// it without relying on the originating browser's localStorage copy.
		broadcastQueueState(entry);
		await completion;
	} catch (error) {
		send(context.ws, {
			type: "error",
			message: error instanceof Error ? error.message : "Unknown error",
		});
	} finally {
		broadcastQueueState(entry);
		releaseChatOwnership(context.ws, entry);
		broadcastSessionsStatus(context);
	}
}

async function handleChat(
	context: MessageContext,
	entry: PoolEntry,
	msg: MessageOf<"chat">,
): Promise<void> {
	if (typeof msg.text !== "string" || !msg.text.trim()) {
		send(context.ws, { type: "error", message: "Invalid message" });
		return;
	}
	const resolved = resolveChatEntry(context, entry, msg);
	if (!resolved) return;
	const { entry: chatEntry, created } = resolved;
	const currentSessionId = chatEntry.manager.getCurrentSessionId();
	const providerChanged =
		msg.provider !== undefined &&
		msg.provider !== chatEntry.manager.getProviderId();
	// The chat payload repeats the composer's controls so a detached archive or
	// brand-new chat can apply them atomically when its live manager is created.
	// Once a chat is already live, the dedicated set_* messages are authoritative.
	// Reapplying an older render's payload here can race a just-clicked effort/model
	// change and visibly snap the control back as the turn starts.
	if (
		msg.provider &&
		!chatEntry.manager.isRunning() &&
		(currentSessionId === null || providerChanged)
	) {
		await chatEntry.manager.setProvider(msg.provider, {
			model: msg.model,
			effort: msg.effort,
			permissionMode: msg.permission_mode,
		});
	} else if (currentSessionId === null && !chatEntry.manager.isRunning()) {
		// Picker changes made before the first submission are addressed to the
		// not-yet-created DB chat. Apply every repeated control carried by the chat
		// payload even when the provider itself was left at its configured default.
		await Promise.all([
			msg.model !== undefined
				? chatEntry.manager.setModel(msg.model)
				: Promise.resolve(),
			msg.effort !== undefined
				? chatEntry.manager.setEffort(msg.effort)
				: Promise.resolve(),
			msg.permission_mode !== undefined
				? chatEntry.manager.setPermissionMode(msg.permission_mode)
				: Promise.resolve(),
		]);
	}
	if (created) {
		// Do not publish the manager's configured defaults between session_created
		// and the first-turn overrides; that transient status resets Raven's picker.
		send(context.ws, { type: "status", ...chatEntry.manager.getStatus() });
		broadcastSessionsStatus(context);
	}
	broadcastUserMessage(context.ws, chatEntry, msg);
	claimChatOwnership(context.ws, chatEntry);
	await runChatQuery(context, chatEntry, msg);
}

async function handleSessionMessage(
	context: MessageContext,
	entry: PoolEntry,
	msg: ClientMessage,
): Promise<void> {
	const sendProbeResult = (event: Parameters<typeof send>[1]) => {
		// Live-entry messages must carry the pool session ID so the client WS
		// router accepts them. Detached archived probes retain the requested DB
		// session ID because there is no live pool subscription for them.
		if (context.ws.data.subscribedSessionId === entry.sessionId) {
			entry.runState.send(context.ws, event);
		} else {
			send(context.ws, event);
		}
	};
	const resolveProbeScope = async (scope: {
		agent_cwd?: string;
		session_id?: string;
	}) => {
		const selection = scope.session_id
			? await db.getSessionSelection(scope.session_id).catch(() => null)
			: null;
		return {
			agentCwd: scope.agent_cwd ?? selection?.agentCwd ?? undefined,
			sessionId: scope.session_id,
			providerId: selection?.providerId ?? undefined,
		};
	};
	switch (msg.type) {
		case "sync":
			handleSync(context.ws, entry);
			return;
		case "abort":
			entry.manager.abort();
			return;
		case "skip_sleep":
			entry.manager.skipSleep();
			return;
		case "cancel_queued":
			if (entry.manager.cancelQueued(msg.turn_id)) broadcastQueueState(entry);
			return;
		case "promote_queued":
			if (entry.manager.promoteQueued(msg.turn_id)) broadcastQueueState(entry);
			return;
		case "clear":
			context.ws.data.pendingNewSession = true;
			entry.runState.clearError();
			return;
		case "reload_session":
			handleReloadSession(context.pool, context.terminalPool, entry);
			return;
		case "probe_mcp":
			await entry.manager.probeMcpStatus(
				sendProbeResult,
				await resolveProbeScope(msg),
			);
			return;
		case "probe_slash_commands":
			await entry.manager.probeSlashCommands(
				sendProbeResult,
				await resolveProbeScope(msg),
			);
			return;
		case "set_provider": {
			await entry.manager.setProvider(msg.provider, {
				model: msg.model,
				effort: msg.effort,
				permissionMode: msg.permission_mode,
			});
			entry.runState.broadcast({
				type: "status",
				...entry.manager.getStatus(),
			});
			const providerId = entry.manager.getProviderId();
			const agentCwd = entry.manager.getAgentCwd();
			const cachedMcp = entry.manager.getLastMcpStatus(providerId) ?? [];
			entry.runState.broadcast({
				type: "mcp_status",
				...(providerId ? { provider_id: providerId } : {}),
				...(agentCwd ? { agent_cwd: agentCwd } : {}),
				servers: cachedMcp.map(mapMcpServer),
			});
			void entry.manager.probeMcpStatus?.((event) =>
				entry.runState.broadcast(event),
			);
			void entry.manager.probeSlashCommands?.((event) =>
				entry.runState.broadcast(event),
			);
			broadcastSessionsStatus(context);
			return;
		}
		case "set_model":
			await entry.manager.setModel(msg.model);
			entry.runState.broadcast({
				type: "status",
				...entry.manager.getStatus(),
			});
			broadcastSessionsStatus(context);
			return;
		case "set_permission_mode":
			await handlePermissionMode(context.ws, entry, msg);
			broadcastSessionsStatus(context);
			return;
		case "set_effort":
			await entry.manager.setEffort(msg.effort);
			entry.runState.broadcast({
				type: "status",
				...entry.manager.getStatus(),
			});
			broadcastSessionsStatus(context);
			return;
		case "sync_mcp_list":
			if (msg.inventory)
				await syncMcpInventory(context.ws, context.pool, msg.agent_cwd);
			else if (msg.agent_cwd)
				syncAgentMcpList(context.ws, entry, msg.agent_cwd);
			else syncVaultMcpList(context.pool);
			return;
		case "permission_response":
			handlePermissionResponse(context, entry, msg);
			return;
		case "ask_user_question_response":
			handleAskUserQuestionResponse(context, entry, msg);
			return;
		case "plan_mode_exit_response":
			handlePlanModeExitResponse(context, entry, msg);
			return;
		case "chat":
			await handleChat(context, entry, msg);
	}
}

async function handleMessage(
	context: MessageContext,
	raw: string | Buffer,
): Promise<void> {
	const msg = parseClientMessage(raw.toString());
	if (!msg) {
		send(context.ws, { type: "error", message: "Invalid JSON" });
		return;
	}
	if (msg.type === "subscribe_session") {
		await handleSubscribeSession(context, msg);
		return;
	}
	if (handleRoutingMessage(context, msg)) return;
	if (msg.type === "sync") {
		const subscribedSessionId = context.ws.data.subscribedSessionId;
		const subscribedEntry =
			context.pool.get(subscribedSessionId) ??
			context.pool.findByDbSessionId(subscribedSessionId);
		if (!subscribedEntry) {
			// Raven syncs immediately after archived history finishes loading. Keep
			// that DB-only chat detached and idle instead of routing the sync through
			// the live vault fallback, whose running state can make the archive look
			// permanently hung.
			await handleSubscribeSession(context, {
				type: "subscribe_session",
				session_id: subscribedSessionId,
			});
			return;
		}
	}
	const requestedSettingsSession =
		(msg.type === "set_provider" ||
			msg.type === "set_model" ||
			msg.type === "set_effort" ||
			msg.type === "set_permission_mode") &&
		msg.session_id
			? msg.session_id
			: null;
	if (requestedSettingsSession) {
		const requestedEntry =
			context.pool.get(requestedSettingsSession) ??
			context.pool.findByDbSessionId(requestedSettingsSession);
		// Archived/new chats have no live manager yet. Their chat payload repeats
		// the selection and applies it atomically after the entry is created.
		if (!requestedEntry) return;
		await handleSessionMessage(context, requestedEntry, msg);
		return;
	}
	const entry =
		context.pool.get(context.ws.data.subscribedSessionId) ??
		context.pool.vaultEntry();
	await handleSessionMessage(context, entry, msg);
}

export function createWsHandlers(
	pool: SessionPool,
	terminalPool?: TerminalSessionPool,
	shellPool?: ShellSessionPool,
) {
	return {
		open(ws: ServerWebSocket<WsData>) {
			wsState.clients.add(ws);

			// Ensure vault exists; subscribe this connection to it by default.
			const vault = pool.vaultEntry();
			ws.data.subscribedSessionId = vault.sessionId;
			vault.runState.addSubscriber(ws);

			// Broadcast pool-wide status so client can render session list.
			send(ws, {
				type: "sessions_status",
				sessions: getLiveSessionsStatus(pool, terminalPool),
			});
			send(ws, { type: "data_revisions", revisions: getDataRevisions() });

			// Send vault session status and (if relevant) last error.
			const status = vault.manager.getStatus();
			send(ws, { type: "status", ...status });
			const context = vault.runState.getContextSnapshot?.();
			if (context) vault.runState.send(ws, context);
			if (vault.runState.lastError !== null && status.state === "error") {
				send(ws, { type: "error", message: vault.runState.lastError });
			}

			if (vault.manager.isRunning()) {
				// Replay buffered run events (chunks, tool_events, permission events)
				// so new connections see what happened since the run started.
				for (const msg of vault.runState.getReplayBuffer()) {
					send(ws, msg);
				}
				const sleep = vault.manager.getSleepState();
				if (sleep) send(ws, sleep);
				// Claim ownership and replay pending prompts if no owner yet (page refresh).
				if (vault.runState.ownerWs === null) {
					vault.runState.ownerWs = ws;
					for (const req of vault.manager.getPendingPermissionRequests()) {
						send(ws, req);
					}
					for (const q of vault.manager.getPendingAskUserQuestions()) {
						send(ws, q);
					}
					for (const exit of vault.manager.getPendingPlanModeExits()) {
						send(ws, exit);
					}
				}
			}

			// Send cached MCP status so clients see server list immediately on connect.
			const cachedMcp = vault.manager.getLastMcpStatus();
			if (cachedMcp) {
				const providerId = vault.manager.getProviderId();
				send(ws, {
					type: "mcp_status",
					...(providerId ? { provider_id: providerId } : {}),
					servers: cachedMcp.map(mapMcpServer),
				});
			}

			// Send queue state so the client can prune any orphan chatQueue items.
			sendQueueState(ws, vault);
		},

		close(ws: ServerWebSocket<WsData>) {
			wsState.clients.delete(ws);
			// Remove from subscribed session's subscriber set.
			// SessionRunState.removeSubscriber also clears ownerWs/inFlightChatCount.
			const entry = pool.get(ws.data.subscribedSessionId);
			if (entry) {
				entry.runState.removeSubscriber(ws);
			}
		},

		message(ws: ServerWebSocket<WsData>, raw: string | Buffer) {
			return handleMessage({ ws, pool, terminalPool, shellPool }, raw);
		},
	};
}
