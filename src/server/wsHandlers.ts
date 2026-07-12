import { realpathSync } from "node:fs";
import type { ServerWebSocket } from "bun";
import * as db from "../db";
import { readAgentMcpFile } from "../lib/agentMcp";
import { expandTilde } from "../lib/paths";
import { readVaultMcpFile } from "../lib/vaultMcp";
import { computeAllowedAgentRealPaths, isAllowedAgentPath } from "./agentPaths";
import { loadConfig } from "./config";
import { getLiveSessionsStatus } from "./liveSessions";
import {
	type ClientMessage,
	decisionFromScope,
	mapMcpServer,
} from "./protocol";
import { broadcast, send, wsState } from "./runState";
import type { PoolEntry, SessionPool } from "./sessionPool";
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
	send(context.ws, { type: "queue_state", ...entry.manager.getQueueState() });
	broadcastSessionsStatus(context);
}

function handleSubscribeSession(
	{ ws, pool }: MessageContext,
	msg: MessageOf<"subscribe_session">,
): void {
	ws.data.pendingNewSession = false;
	pool.get(ws.data.subscribedSessionId)?.runState.removeSubscriber(ws);
	const entry =
		pool.get(msg.session_id) ?? pool.findByDbSessionId(msg.session_id);
	if (!entry) {
		// Keep archived/unknown DB sessions detached from every live pool entry.
		// Falling back to the vault here leaks the vault's in-flight events into
		// whichever transcript Raven is displaying.
		ws.data.subscribedSessionId = msg.session_id;
		send(ws, {
			type: "status",
			state: "idle",
			model: pool.vaultEntry().manager.getStatus().model,
		});
		send(ws, {
			type: "queue_state",
			pending_turn_ids: [],
			running_turn_id: null,
		});
		return;
	}
	entry.runState.addSubscriber(ws);
	ws.data.subscribedSessionId = entry.sessionId;
	send(ws, { type: "status", ...entry.manager.getStatus() });
	if (entry.manager.isRunning()) {
		for (const buffered of entry.runState.getReplayBuffer()) send(ws, buffered);
	}
	send(ws, { type: "queue_state", ...entry.manager.getQueueState() });
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
	const { ws, pool, terminalPool } = context;
	if (msg.session_id === pool.vaultSessionId()) {
		send(ws, { type: "error", message: "Cannot close the vault session" });
		return;
	}
	if (pool.get(msg.session_id)) {
		pool.close(msg.session_id);
		resubscribeClosedSessionClients(pool, msg.session_id);
	} else {
		terminalPool?.close(msg.session_id);
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
		case "subscribe_session":
			handleSubscribeSession(context, msg);
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
	send(ws, { type: "queue_state", ...entry.manager.getQueueState() });
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

function syncAgentMcpList(ws: ServerWebSocket<WsData>, agentCwd: string): void {
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
	send(ws, { type: "mcp_status", servers, agent_cwd: resolvedAgent });
}

function readVaultServers(vaultPath: string) {
	try {
		return readVaultMcpFile(vaultPath).servers;
	} catch {
		return [];
	}
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
	broadcast({ type: "mcp_status", servers: [...preserved, ...vault] });
}

function handlePermissionResponse(
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
	if (entry.manager.isRunning() && !needsNewSession) return false;
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
): PoolEntry | null {
	const needsNewSession = context.ws.data.pendingNewSession === true;
	if (needsNewSession) context.ws.data.pendingNewSession = false;
	const reused = reuseExistingChatEntry(context, entry, msg.session_id);
	if (!shouldCreateChatEntry(entry, reused, msg, needsNewSession))
		return reused;
	const targetCwd = msg.agent_cwd ?? context.pool.vaultEntry().agentCwd;
	const created = createPoolEntry(
		context,
		targetCwd,
		resolveAgentName(targetCwd),
	);
	if (!created) return null;
	subscribeToEntry(context, created);
	sendSessionCreated(context, created);
	broadcastSessionsStatus(context);
	send(context.ws, { type: "status", ...created.manager.getStatus() });
	return created;
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
		await entry.manager.runQuery(
			msg.text,
			(event) => {
				entry.runState.broadcast(event);
				if (event.type === "status") broadcastSessionsStatus(context);
			},
			msg.session_id,
			msg.skill_context,
			msg.attachments,
			msg.agent_cwd,
			msg.turn_id,
			msg.plan_mode,
			msg.plan_html,
		);
	} catch (error) {
		send(context.ws, {
			type: "error",
			message: error instanceof Error ? error.message : "Unknown error",
		});
	} finally {
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
	const chatEntry = resolveChatEntry(context, entry, msg);
	if (!chatEntry) return;
	broadcastUserMessage(context.ws, chatEntry, msg);
	claimChatOwnership(context.ws, chatEntry);
	await runChatQuery(context, chatEntry, msg);
}

async function handleSessionMessage(
	context: MessageContext,
	entry: PoolEntry,
	msg: ClientMessage,
): Promise<void> {
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
			entry.manager.cancelQueued(msg.turn_id);
			return;
		case "promote_queued":
			entry.manager.promoteQueued(msg.turn_id);
			return;
		case "clear":
			context.ws.data.pendingNewSession = true;
			entry.runState.clearError();
			return;
		case "reload_session":
			handleReloadSession(context.pool, context.terminalPool, entry);
			return;
		case "probe_mcp":
			void entry.manager.probeMcpStatus((event) =>
				entry.runState.broadcast(event),
			);
			return;
		case "probe_slash_commands":
			void entry.manager.probeSlashCommands((event) =>
				entry.runState.broadcast(event),
			);
			return;
		case "set_model":
			await entry.manager.setModel(msg.model);
			entry.runState.broadcast({
				type: "status",
				...entry.manager.getStatus(),
			});
			return;
		case "set_permission_mode":
			await handlePermissionMode(context.ws, entry, msg);
			return;
		case "sync_mcp_list":
			if (msg.agent_cwd) syncAgentMcpList(context.ws, msg.agent_cwd);
			else syncVaultMcpList(context.pool);
			return;
		case "permission_response":
			handlePermissionResponse(entry, msg);
			return;
		case "ask_user_question_response":
			handleAskUserQuestionResponse(entry, msg);
			return;
		case "plan_mode_exit_response":
			handlePlanModeExitResponse(entry, msg);
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
	if (handleRoutingMessage(context, msg)) return;
	const entry =
		context.pool.get(context.ws.data.subscribedSessionId) ??
		context.pool.vaultEntry();
	await handleSessionMessage(context, entry, msg);
}

export function createWsHandlers(
	pool: SessionPool,
	terminalPool?: TerminalSessionPool,
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

			// Send vault session status and (if relevant) last error.
			const status = vault.manager.getStatus();
			send(ws, { type: "status", ...status });
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
				send(ws, { type: "mcp_status", servers: cachedMcp.map(mapMcpServer) });
			}

			// Send queue state so the client can prune any orphan chatQueue items.
			send(ws, { type: "queue_state", ...vault.manager.getQueueState() });
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
			return handleMessage({ ws, pool, terminalPool }, raw);
		},
	};
}
