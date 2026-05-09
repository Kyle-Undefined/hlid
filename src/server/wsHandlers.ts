import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ServerWebSocket } from "bun";
import * as db from "../db";
import { loadConfig } from "./config";
import {
	type ClientMessage,
	decisionFromScope,
	mapMcpServer,
} from "./protocol";
import { broadcast, getRunBuffer, send, wsState } from "./runState";
import type { SessionManager } from "./session";

/** Returns true if ws is not the designated session owner and should be rejected. */
function notOwner(ws: ServerWebSocket<unknown>): boolean {
	return wsState.sessionOwnerWs !== null && ws !== wsState.sessionOwnerWs;
}

export function createWsHandlers(session: SessionManager) {
	return {
		open(ws: ServerWebSocket<unknown>) {
			wsState.clients.add(ws);
			const status = session.getStatus();
			send(ws, { type: "status", ...status });
			// Re-send last error only when session is still in error state
			if (
				wsState.lastSessionError !== null &&
				session.getStatus().state === "error"
			) {
				send(ws, { type: "error", message: wsState.lastSessionError });
			}
			if (session.isRunning()) {
				// Replay buffered run events (chunks, tool_events, permission events)
				// so new connections see what happened since the run started.
				for (const msg of getRunBuffer()) {
					send(ws, msg);
				}
				// Claim ownership and replay pending prompts if no owner yet (page refresh).
				if (wsState.sessionOwnerWs === null) {
					wsState.sessionOwnerWs = ws;
					for (const req of session.getPendingPermissionRequests()) {
						send(ws, req);
					}
					for (const q of session.getPendingAskUserQuestions()) {
						send(ws, q);
					}
					for (const exit of session.getPendingPlanModeExits()) {
						send(ws, exit);
					}
				}
			}
			// Send cached MCP status so clients see server list immediately on connect
			const cachedMcp = session.getLastMcpStatus();
			if (cachedMcp) {
				send(ws, { type: "mcp_status", servers: cachedMcp.map(mapMcpServer) });
			}
		},

		close(ws: ServerWebSocket<unknown>) {
			wsState.clients.delete(ws);
			if (ws === wsState.sessionOwnerWs) wsState.sessionOwnerWs = null;
			// Session persists, no abort on disconnect
		},

		async message(ws: ServerWebSocket<unknown>, raw: string | Buffer) {
			let msg: ClientMessage;
			try {
				msg = JSON.parse(raw.toString()) as ClientMessage;
			} catch {
				send(ws, { type: "error", message: "Invalid JSON" });
				return;
			}

			if (msg.type === "sync") {
				send(ws, { type: "status", ...session.getStatus() });
				if (session.isRunning() && wsState.sessionOwnerWs === null) {
					wsState.sessionOwnerWs = ws;
					for (const req of session.getPendingPermissionRequests()) {
						send(ws, req);
					}
					for (const exit of session.getPendingPlanModeExits()) {
						send(ws, exit);
					}
				}
				return;
			}

			if (msg.type === "abort") {
				if (notOwner(ws)) return;
				session.abort();
				return;
			}

			if (msg.type === "clear") {
				if (notOwner(ws)) return;
				session.clearHistory();
				wsState.lastSessionError = null;
				return;
			}

			if (msg.type === "reload_session") {
				if (notOwner(ws)) return;
				const fresh = loadConfig();
				session.reinitialize(fresh);
				wsState.lastSessionError = null;
				broadcast({ type: "status", ...session.getStatus() });
				return;
			}

			if (msg.type === "probe_mcp") {
				void session.probeMcpStatus(broadcast);
				return;
			}

			if (msg.type === "sync_mcp_list") {
				const cfg = loadConfig();
				if (!cfg.vault.path) return;
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
				const cachedList = session.getLastMcpStatus() ?? [];
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
				const pending = session
					.getPendingPermissionRequests()
					.find((r) => r.id === msg.id);
				if (pending) {
					session.handlePermissionResponse(
						msg.id,
						msg.approved,
						msg.saveScope,
						msg.denyMessage,
					);
					const decision = decisionFromScope(msg.approved, msg.saveScope);
					broadcast({
						type: "permission_resolved",
						id: msg.id,
						toolName: pending.toolName,
						displayName: pending.displayName,
						decision,
					});
					const currentSessionId = session.getCurrentSessionId();
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
				session.handleAskUserQuestionResponse(msg.id, msg.answers);
				broadcast({
					type: "ask_user_question_resolved",
					id: msg.id,
					answers: msg.answers,
				});
				return;
			}

			if (msg.type === "plan_mode_exit_response") {
				session.handlePlanModeExitResponse(
					msg.id,
					msg.decision,
					msg.decision === "edited" ? msg.feedback : undefined,
				);
				broadcast({
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

				// L1: Only the designated session owner (first sender) may initiate chats.
				// Ownership persists until that WS disconnects, preventing other connected
				// clients from hijacking the session between turns.
				if (notOwner(ws)) {
					send(ws, { type: "error", message: "Not session owner" });
					return;
				}

				if (session.isRunning()) {
					send(ws, { type: "error", message: "Session already running" });
					return;
				}

				// Broadcast user prompt to all OTHER clients for cross-device sync
				const userEventData = JSON.stringify({
					type: "user_message",
					text: msg.text,
					session_id: msg.session_id,
				});
				for (const client of wsState.clients) {
					if (client !== ws) client.send(userEventData);
				}

				wsState.sessionOwnerWs = ws;
				try {
					await session.runQuery(
						msg.text,
						(event) => broadcast(event),
						msg.session_id,
						msg.skill_context,
						msg.attachments,
						msg.agent_cwd,
					);
				} catch (err) {
					const message = err instanceof Error ? err.message : "Unknown error";
					send(ws, { type: "error", message });
				} finally {
					// Only clear ownership if this ws still owns it. A sync from a
					// reconnecting client may have claimed ownership mid-run.
					if (wsState.sessionOwnerWs === ws) wsState.sessionOwnerWs = null;
				}
			}
		},
	};
}
