import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import type { ServerWebSocket } from "bun";
import * as db from "../db";
import { expandTilde } from "../lib/paths";
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

		async message(ws: ServerWebSocket<WsData>, raw: string | Buffer) {
			let msg: ClientMessage;
			try {
				msg = JSON.parse(raw.toString()) as ClientMessage;
			} catch {
				send(ws, { type: "error", message: "Invalid JSON" });
				return;
			}

			// ── Multi-session routing messages ──────────────────────────────────

			if (msg.type === "new_session") {
				const vault = pool.vaultEntry();
				const agentCwd = msg.agent_cwd ?? vault.agentCwd;
				const agentName = msg.agent_name ?? vault.agentName;
				let entry: PoolEntry;
				try {
					entry = pool.create(agentCwd, agentName);
				} catch (err) {
					send(ws, {
						type: "error",
						message:
							err instanceof Error ? err.message : "Failed to create session",
					});
					return;
				}
				// Subscribe the requesting WS to the new session.
				const oldEntry = pool.get(ws.data.subscribedSessionId);
				if (oldEntry) oldEntry.runState.removeSubscriber(ws);
				entry.runState.addSubscriber(ws);
				ws.data.subscribedSessionId = entry.sessionId;
				send(ws, {
					type: "session_created",
					session_id: entry.sessionId,
					agent_cwd: entry.agentCwd,
					agent_name: entry.agentName,
				});
				send(ws, { type: "status", ...entry.manager.getStatus() });
				send(ws, { type: "queue_state", ...entry.manager.getQueueState() });
				broadcast({
					type: "sessions_status",
					sessions: getLiveSessionsStatus(pool, terminalPool),
				});
				return;
			}

			if (msg.type === "subscribe_session") {
				// Cancel any pending "new session" intent — user is explicitly
				// navigating to an existing session instead.
				ws.data.pendingNewSession = false;
				// Unsubscribe from current session.
				const oldEntry = pool.get(ws.data.subscribedSessionId);
				if (oldEntry) {
					oldEntry.runState.removeSubscriber(ws);
				}
				// Subscribe to requested session (fall back to vault if not found).
				const newEntry = pool.get(msg.session_id) ?? pool.vaultEntry();
				newEntry.runState.addSubscriber(ws);
				ws.data.subscribedSessionId = newEntry.sessionId;

				// Send new session's current state.
				send(ws, { type: "status", ...newEntry.manager.getStatus() });
				if (newEntry.manager.isRunning()) {
					for (const buffered of newEntry.runState.getReplayBuffer()) {
						send(ws, buffered);
					}
				}
				send(ws, { type: "queue_state", ...newEntry.manager.getQueueState() });
				return;
			}

			if (msg.type === "stop_session") {
				const sdkEntry = pool.get(msg.session_id);
				if (sdkEntry) {
					sdkEntry.manager.abort();
				} else {
					// Terminal session: send Ctrl+C to interrupt the running command.
					terminalPool?.write(msg.session_id, "\x03");
				}
				return;
			}

			if (msg.type === "close_session") {
				if (msg.session_id === pool.vaultSessionId()) {
					send(ws, {
						type: "error",
						message: "Cannot close the vault session",
					});
					return;
				}
				const sdkEntry = pool.get(msg.session_id);
				if (sdkEntry) {
					pool.close(msg.session_id);
					// Re-subscribe any chat WS clients focused on this session → vault.
					const vault = pool.vaultEntry();
					for (const client of wsState.clients) {
						const clientWs = client as ServerWebSocket<WsData>;
						if (clientWs.data?.subscribedSessionId === msg.session_id) {
							vault.runState.addSubscriber(clientWs);
							clientWs.data.subscribedSessionId = vault.sessionId;
						}
					}
				} else {
					// Terminal session: kill the PTY.
					terminalPool?.close(msg.session_id);
				}
				broadcast({ type: "session_closed", session_id: msg.session_id });
				broadcast({
					type: "sessions_status",
					sessions: getLiveSessionsStatus(pool, terminalPool),
				});
				return;
			}

			// ── Per-session handlers — resolved against the subscribed session ──

			const entry = pool.get(ws.data.subscribedSessionId) ?? pool.vaultEntry();

			if (msg.type === "sync") {
				send(ws, { type: "status", ...entry.manager.getStatus() });
				send(ws, { type: "queue_state", ...entry.manager.getQueueState() });
				if (entry.manager.isRunning() && entry.runState.ownerWs === null) {
					entry.runState.ownerWs = ws;
					for (const req of entry.manager.getPendingPermissionRequests()) {
						entry.runState.send(ws, req);
					}
					for (const exit of entry.manager.getPendingPlanModeExits()) {
						entry.runState.send(ws, exit);
					}
				}
				return;
			}

			if (msg.type === "abort") {
				entry.manager.abort();
				return;
			}

			if (msg.type === "cancel_queued") {
				entry.manager.cancelQueued(msg.turn_id);
				return;
			}

			if (msg.type === "promote_queued") {
				entry.manager.promoteQueued(msg.turn_id);
				return;
			}

			if (msg.type === "clear") {
				// Flag the next "chat" to spawn a fresh pool entry instead of
				// continuing in this one. We intentionally do NOT call
				// clearHistory() here — that would cancel the existing subprocess.
				// The current pool entry stays alive so it remains visible on the
				// ledger and can finish any in-flight work.
				ws.data.pendingNewSession = true;
				entry.runState.clearError();
				return;
			}

			if (msg.type === "reload_session") {
				const fresh = loadConfig();
				entry.manager.reinitialize(fresh);
				pool.syncConfig(fresh);
				entry.runState.clearError();
				entry.runState.broadcast({
					type: "status",
					...entry.manager.getStatus(),
				});
				broadcast({
					type: "sessions_status",
					sessions: getLiveSessionsStatus(pool, terminalPool),
				});
				return;
			}

			if (msg.type === "probe_mcp") {
				void entry.manager.probeMcpStatus((e) => entry.runState.broadcast(e));
				return;
			}

			if (msg.type === "probe_slash_commands") {
				void entry.manager.probeSlashCommands((e) =>
					entry.runState.broadcast(e),
				);
				return;
			}

			if (msg.type === "sync_mcp_list") {
				const cfg = loadConfig();

				// ── agent-cwd branch: send only to requesting client ──────────────
				if (msg.agent_cwd) {
					// Validate that the requested path is a registered agent
					const allowedRealPaths = computeAllowedAgentRealPaths(cfg);
					let resolvedAgent: string;
					try {
						resolvedAgent = realpathSync(expandTilde(msg.agent_cwd));
					} catch {
						return; // path doesn't exist — silently ignore
					}
					if (!isAllowedAgentPath(allowedRealPaths, resolvedAgent)) return;

					let agentNames = new Set<string>();
					try {
						agentNames = new Set(
							Object.keys(
								(
									JSON.parse(
										readFileSync(join(resolvedAgent, ".mcp.json"), "utf8"),
									) as { mcpServers?: Record<string, unknown> }
								).mcpServers ?? {},
							),
						);
					} catch {}
					let agentDisabled: string[] = [];
					try {
						agentDisabled =
							(
								JSON.parse(
									readFileSync(
										join(resolvedAgent, ".claude", "settings.local.json"),
										"utf8",
									),
								) as { disabledMcpjsonServers?: string[] }
							).disabledMcpjsonServers ?? [];
					} catch {}

					const agentServers = [...agentNames].map((name) => {
						if (agentDisabled.includes(name))
							return mapMcpServer({
								name,
								status: "disabled",
								scope: "project",
							});
						return mapMcpServer({
							name,
							status: "pending",
							scope: "project",
						});
					});
					// Use send (not broadcast) — agent MCP is a per-client view,
					// not shared session state. Tag with agent_cwd so the vault
					// McpSection can ignore it.
					send(ws, {
						type: "mcp_status",
						servers: agentServers,
						agent_cwd: resolvedAgent,
					});
					return;
				}

				// ── vault branch: broadcast to all clients (existing behaviour) ───
				if (!cfg.vault.path) return;
				const vaultEntry = pool.vaultEntry();
				let vaultNames = new Set<string>();
				try {
					vaultNames = new Set(
						Object.keys(
							(
								JSON.parse(
									readFileSync(join(cfg.vault.path, ".mcp.json"), "utf8"),
								) as { mcpServers?: Record<string, unknown> }
							).mcpServers ?? {},
						),
					);
				} catch {}
				let disabled: string[] = [];
				try {
					disabled =
						(
							JSON.parse(
								readFileSync(
									join(cfg.vault.path, ".claude", "settings.local.json"),
									"utf8",
								),
							) as { disabledMcpjsonServers?: string[] }
						).disabledMcpjsonServers ?? [];
				} catch {}
				const cachedList = vaultEntry.manager.getLastMcpStatus() ?? [];
				const cachedMap = new Map(cachedList.map((s) => [s.name, s]));
				// Preserve cloud/global entries from cache unchanged
				const preserved = cachedList
					.filter((s) => s.scope !== "project")
					.map(mapMcpServer);
				// Vault entries: current .mcp.json + cached status
				const vault = [...vaultNames].map((name) => {
					if (disabled.includes(name))
						return mapMcpServer({ name, status: "disabled", scope: "project" });
					const c = cachedMap.get(name);
					return mapMcpServer({
						name,
						status: c?.status ?? "pending",
						scope: "project",
						error: c?.error,
					});
				});
				broadcast({ type: "mcp_status", servers: [...preserved, ...vault] });
				return;
			}

			if (msg.type === "permission_response") {
				const pending = entry.manager
					.getPendingPermissionRequests()
					.find((r) => r.id === msg.id);
				if (pending) {
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
					const currentSessionId = entry.manager.getCurrentSessionId();
					if (currentSessionId) {
						void db
							.recordPermissionEvent(
								currentSessionId,
								msg.id,
								pending.toolName,
								pending.displayName,
								decision,
							)
							.catch((e) => {
								console.error("[db] recordPermissionEvent failed:", e);
							});
					}
				}
				return;
			}

			if (msg.type === "ask_user_question_response") {
				entry.manager.handleAskUserQuestionResponse(
					msg.id,
					msg.answers,
					msg.notes,
				);
				entry.runState.broadcast({
					type: "ask_user_question_resolved",
					id: msg.id,
					answers: msg.answers,
					...(msg.notes !== undefined ? { notes: msg.notes } : {}),
				});
				const aukSessionId = entry.manager.getCurrentSessionId();
				if (aukSessionId) {
					void db
						.setAskUserQuestionResolution(
							aukSessionId,
							msg.id,
							JSON.stringify(msg.answers),
							msg.notes !== undefined ? JSON.stringify(msg.notes) : null,
						)
						.catch((e) => {
							console.error("[db] setAskUserQuestionResolution failed:", e);
						});
				}
				return;
			}

			if (msg.type === "plan_mode_exit_response") {
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
				return;
			}

			if (msg.type === "chat") {
				if (typeof msg.text !== "string" || !msg.text.trim()) {
					send(ws, { type: "error", message: "Invalid message" });
					return;
				}

				// Auto-create a new pool session for a fresh chat. Triggers when:
				//   (a) current session has no DB history yet (fresh / after clear), OR
				//   (b) user switched to a different agent (msg.agent_cwd !== entry's cwd)
				//       while the session is idle — e.g. picking a new agent without
				//       pressing "New Chat" first.
				// Follow-up messages in an ongoing conversation continue in the same
				// pool session via the turn queue (isRunning guard keeps them there).
				//
				// When no agent_cwd is specified, default to vault — NOT entry.agentCwd.
				// This ensures that after "New Chat" (which flags pendingNewSession but
				// keeps the WS subscribed to the previous pool entry), the next submit
				// creates a vault session rather than silently inheriting the agent dir.
				const targetCwd = msg.agent_cwd ?? pool.vaultEntry().agentCwd;
				const agentSwitched =
					msg.agent_cwd !== undefined && msg.agent_cwd !== entry.agentCwd;
				// Resuming a different DB session — msg.session_id is the DB chat ID
				// the client wants to continue. If it differs from what the current pool
				// entry is tracking (or entry has no DB session), we need a fresh pool
				// entry so the resumed session gets its own subprocess and history.
				const resumingDifferentDbSession =
					msg.session_id !== undefined &&
					msg.session_id !== entry.manager.getCurrentSessionId();
				// "New Chat" sets this flag so we spawn a fresh entry without
				// disturbing the current subprocess.
				const needsNewSession = ws.data.pendingNewSession === true;
				if (needsNewSession) ws.data.pendingNewSession = false;
				let chatEntry = entry;

				// Before auto-creating, check if an existing pool entry already owns
				// this DB session (e.g. after back-navigation to a previous chat).
				// Reuse it instead of spawning a duplicate subprocess.
				if (
					msg.session_id &&
					entry.manager.getCurrentSessionId() !== msg.session_id
				) {
					const existingEntry = pool.findByDbSessionId(msg.session_id);
					if (existingEntry && existingEntry.sessionId !== entry.sessionId) {
						entry.runState.removeSubscriber(ws);
						existingEntry.runState.addSubscriber(ws);
						ws.data.subscribedSessionId = existingEntry.sessionId;
						chatEntry = existingEntry;
					}
				}

				if (
					chatEntry === entry &&
					(!entry.manager.isRunning() || needsNewSession) &&
					(entry.manager.getCurrentSessionId() === null ||
						agentSwitched ||
						resumingDifferentDbSession ||
						needsNewSession)
				) {
					const agentName = resolveAgentName(targetCwd);
					let newEntry: PoolEntry;
					try {
						newEntry = pool.create(targetCwd, agentName);
					} catch (err) {
						send(ws, {
							type: "error",
							message:
								err instanceof Error ? err.message : "Failed to create session",
						});
						return;
					}
					entry.runState.removeSubscriber(ws);
					newEntry.runState.addSubscriber(ws);
					ws.data.subscribedSessionId = newEntry.sessionId;
					chatEntry = newEntry;
					send(ws, {
						type: "session_created",
						session_id: newEntry.sessionId,
						agent_cwd: newEntry.agentCwd,
						agent_name: newEntry.agentName,
					});
					broadcast({
						type: "sessions_status",
						sessions: getLiveSessionsStatus(pool, terminalPool),
					});
					send(ws, { type: "status", ...newEntry.manager.getStatus() });
				}

				// Echo user prompt to all OTHER clients subscribed to this session.
				// Use chatEntry.sessionId (pool UUID) so client-side session filtering works.
				const userEventData = JSON.stringify({
					type: "user_message",
					text: msg.text,
					session_id: chatEntry.sessionId,
					...(msg.turn_id !== undefined ? { id: msg.turn_id } : {}),
				});
				for (const client of wsState.clients) {
					if (client === ws) continue;
					const clientWs = client as ServerWebSocket<WsData>;
					if (clientWs.data?.subscribedSessionId === chatEntry.sessionId) {
						clientWs.send(userEventData);
					}
				}

				chatEntry.runState.ownerWs = ws;
				// Track in-flight chats per ws so ownership only releases when this
				// ws's last queued chat completes.
				chatEntry.runState.inFlightChatCount.set(
					ws,
					(chatEntry.runState.inFlightChatCount.get(ws) ?? 0) + 1,
				);
				try {
					// Pick up config changes without requiring a server restart.
					const modelChanged = chatEntry.manager.syncConfig(loadConfig());
					if (modelChanged) {
						chatEntry.runState.broadcast({
							type: "status",
							...chatEntry.manager.getStatus(),
						});
					}
					await chatEntry.manager.runQuery(
						msg.text,
						(event) => {
							chatEntry.runState.broadcast(event);
							// Propagate per-session state transitions to all clients'
							// session lists so LEDGER dots update live.
							if (event.type === "status") {
								broadcast({
									type: "sessions_status",
									sessions: getLiveSessionsStatus(pool, terminalPool),
								});
							}
						},
						msg.session_id,
						msg.skill_context,
						msg.attachments,
						msg.agent_cwd,
						msg.turn_id,
						msg.plan_mode,
					);
				} catch (err) {
					const message = err instanceof Error ? err.message : "Unknown error";
					send(ws, { type: "error", message });
				} finally {
					const remaining =
						(chatEntry.runState.inFlightChatCount.get(ws) ?? 1) - 1;
					if (remaining <= 0) {
						chatEntry.runState.inFlightChatCount.delete(ws);
						if (chatEntry.runState.ownerWs === ws)
							chatEntry.runState.ownerWs = null;
					} else {
						chatEntry.runState.inFlightChatCount.set(ws, remaining);
					}
					// Final sync — catches idle/error state after run completes.
					broadcast({
						type: "sessions_status",
						sessions: getLiveSessionsStatus(pool, terminalPool),
					});
				}
			}
		},
	};
}
