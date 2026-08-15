import type { ProviderApprovalsReviewer } from "../server/agentProvider";
import type { ClientMessage, ServerMessage } from "../server/protocol";
import type { SessionState } from "../server/session";
import {
	applyProjectPreview,
	clearProjectPreview,
} from "./projectPreviewStore";
import { forgetRavenTerminal } from "./ravenTerminalStore";
import {
	clearChatQueue,
	enqueueLocalChat,
	findQueuedChat,
	getQueue,
	markQueuedChatPromoting,
	markQueuedChatSent,
	markQueuedChatSteering,
	type QueuedChatMessage,
	reconcileLocalQueue,
	removeLocalChat,
	resetChatQueueForTesting,
} from "./wsChatQueueStore";
import {
	replaceDataRevisions,
	resetDataRevisionsForTesting,
} from "./wsDataRevisionStore";
import {
	applyContextUpdate,
	applyDone,
	applyUsageUpdate,
	clearPendingUsage,
	resetLiveStatsForTesting,
	setPendingSessionToday,
	switchStatsContext,
} from "./wsLiveStatsStore";
import {
	canonicalSessionId,
	focusPendingNewSession,
	focusSession,
	getSessionsStatus,
	getSubscribedSessionId,
	reconcileSessionStatus,
	removeSessionStatus,
	replaceSessionsStatus,
	resetSessionStatusForTesting,
} from "./wsSessionStatusStore";

// WebSocket readyState constants — avoid referencing WebSocket global directly
// so tests running in Node.js (where WebSocket may be undefined) don't throw.
const WS_CONNECTING = 0;
const WS_OPEN = 1;
// A cold Tailscale route can take several seconds to establish, and the
// same-origin UI bridge intentionally allows its backend socket up to 10s.
// Give both the browser transport and the end-to-end readiness probe their
// own budget so a slow but healthy resume is not aborted at the old 3s limit.
const TRANSPORT_CONNECT_TIMEOUT_MS = 12_000;
const HANDSHAKE_TIMEOUT_MS = 12_000;
const LIVENESS_TIMEOUT_MS = 3_000;
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;
const LIFECYCLE_RECOVERY_DEBOUNCE_MS = 250;
const REPLAY_BATCH_QUERY = "replay_batch=1";

// ─── Types ───────────────────────────────────────────────────────────────────

export type WsStatus = "connecting" | "connected" | "disconnected";

/** Auto-sleep banner state from the latest agent_sleep message. */
export type SleepBanner = {
	providerId: string;
	windowId: string | null;
	/** Epoch seconds the sleep is expected to end, when known. */
	until: number | null;
	reason: "threshold" | "limit_reached" | null;
	/** Provider-window utilization 0–1 behind a threshold sleep. */
	utilization: number | null;
};

type Snapshot = {
	wsStatus: WsStatus;
	sessionState: SessionState;
	model: string;
	// The model the CLI actually used on the most recent inference for the
	// current chat. May differ from `model` (configured vault model) when an
	// agent's CLAUDE.md frontmatter, slash command, or subagent overrode it.
	// Reset to null only when a new run starts (state === "running") so the
	// mismatch badge persists after the run completes.
	actualModel: string | null;
	/**
	 * Chunk 6: current permission mode for the subscribed session. Session-
	 * scoped (never persisted to hlid.config.toml) — reflects config defaults
	 * until a `set_permission_mode` message overrides it. Null until the
	 * first status message arrives.
	 */
	permissionMode: string | null;
	/** Codex-native reviewer for interactive approval requests. */
	approvalsReviewer: ProviderApprovalsReviewer | null;
	/**
	 * Current effort/thinking level for the subscribed session. Same
	 * session-scoped semantics as permissionMode — null until the first
	 * status message arrives.
	 */
	effort: string | null;
	hasPendingPermissions: boolean;
	/**
	 * Slice C: turn_id of the turn the server is currently processing
	 * (when sessionState === "running"). Used by MessageList to mark the
	 * matching chatQueue entry as "RUN" (no cancel/promote buttons) and
	 * leave the rest as cancellable / promotable.
	 */
	runningTurnId: string | null;
	/**
	 * Non-null while the session is auto-sleeping on a usage limit. Transient —
	 * derived from agent_sleep messages (replayed on sync), never buffered
	 * into the transcript.
	 */
	sleepState: SleepBanner | null;
};

type PendingConnectionProbe = {
	socket: WebSocket;
	generation: number;
	requestId: string;
	kind: "handshake" | "liveness";
};

// ─── Module state ────────────────────────────────────────────────────────────
// All mutable state lives here as module-level variables. These are private;
// consumers interact through the exported functions below.

/** SSR/server-rendered snapshot default. Exported so consumers
 *  (useWs, StatusDot, Sidebar) can pass it as the SSR fallback to
 *  useSyncExternalStore. */
export const INITIAL_SNAPSHOT: Snapshot = {
	wsStatus: "connecting",
	sessionState: "idle",
	model: "",
	actualModel: null,
	permissionMode: null,
	approvalsReviewer: null,
	effort: null,
	hasPendingPermissions: false,
	runningTurnId: null,
	sleepState: null,
};

let _snap: Snapshot = { ...INITIAL_SNAPSHOT };
let _ws: WebSocket | null = null;
let _reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let _connectDeadlineTimer: ReturnType<typeof setTimeout> | null = null;
let _reconnectAttempts = 0;
let _socketGeneration = 0;
let _connectStartedAt: number | null = null;
let _readySocketGeneration: number | null = null;
let _connectionProbeSequence = 0;
let _pendingConnectionProbe: PendingConnectionProbe | null = null;
let _deferredClientMessages: ClientMessage[] = [];
let _foregroundRecoveryPending = false;
let _lastForcedRecoveryAt: number | null = null;
let _lastLivenessProbeAt: number | null = null;
// Buffers in-flight chunks/tool_events for the current run so they survive SPA navigation.
// Always written (even when subscribers exist), cleared on run end or new run start.
let _messageBuffer: ServerMessage[] = [];
let _bufferingEnabled = true;
const _pendingInteractionKeys = new Set<string>();

// Subscriber sets — connection and message concerns stay with the transport.
const statusSubs = new Set<() => void>();
const messageSubs = new Set<(msg: ServerMessage) => void>();

function getReadySocket(): WebSocket | null {
	if (
		_ws?.readyState !== WS_OPEN ||
		_readySocketGeneration !== _socketGeneration
	) {
		return null;
	}
	return _ws;
}

/**
 * Slice A: server-side queueing. Enqueued messages are sent to the server
 * IMMEDIATELY (not batched on idle). The server accepts mid-run and queues
 * FIFO at the SessionManager level. The client queue mirrors work that has not
 * started yet: items remain visible until the server reports them as running.
 *
 * Items added while the WS is closed remain in the queue and drain after the
 * next end-to-end readiness acknowledgement.
 */
function sendChatToServer(msg: QueuedChatMessage): boolean {
	const socket = getReadySocket();
	if (!socket) return false;
	const userEvent: ServerMessage = {
		type: "user_message",
		text: msg.text,
		session_id: msg.session_id,
		id: msg.id,
		...(msg.attachments ? { attachments: msg.attachments } : {}),
		...(msg.vault_references ? { vault_references: msg.vault_references } : {}),
		...(msg.workspace_references
			? { workspace_references: msg.workspace_references }
			: {}),
	};
	for (const fn of messageSubs) fn(userEvent);
	setPendingSessionToday(true);
	_messageBuffer = [];
	const payload: Record<string, unknown> = {
		type: "chat",
		text: msg.text,
		session_id: msg.session_id,
		// Slice C: pass the client-generated id as turn_id so the server
		// echoes it back in `done` for FIFO correlation, and so the client
		// can reference it in cancel_queued.
		turn_id: msg.id,
	};
	if (msg.agent_cwd) payload.agent_cwd = msg.agent_cwd;
	if (msg.skill_context) payload.skill_context = msg.skill_context;
	if (msg.skill_contexts?.length) payload.skill_contexts = msg.skill_contexts;
	if (msg.attachments && msg.attachments.length > 0) {
		payload.attachments = msg.attachments;
	}
	if (msg.vault_references && msg.vault_references.length > 0) {
		payload.vault_references = msg.vault_references;
	}
	if (msg.workspace_references && msg.workspace_references.length > 0) {
		payload.workspace_references = msg.workspace_references;
	}
	if (msg.plan_mode) payload.plan_mode = true;
	if (msg.plan_html) payload.plan_html = true;
	if (msg.provider) payload.provider = msg.provider;
	if (msg.model) payload.model = msg.model;
	if (msg.effort) payload.effort = msg.effort;
	if (msg.permission_mode) payload.permission_mode = msg.permission_mode;
	if (msg.approvals_reviewer) {
		payload.approvals_reviewer = msg.approvals_reviewer;
	}
	if (msg.notification_policy) {
		payload.notification_policy = msg.notification_policy;
	}
	if (msg.goal) payload.goal = msg.goal;
	try {
		socket.send(JSON.stringify(payload));
		return true;
	} catch {
		return false;
	}
}

/**
 * Send any queued items that haven't yet been delivered to the server. Used
 * after readiness to flush the backlog accumulated while the connection was
 * down. Items are tagged with `_sent` once delivered so we don't re-send them
 * on subsequent reconnects (the server won't have erased them).
 */
function drainPendingToServer(): void {
	if (!getReadySocket()) return;
	for (const item of getQueue()) {
		if (item._sent) continue;
		if (sendChatToServer(item)) markQueuedChatSent(item.id);
		else break;
	}
}

/**
 * Re-promote a locally queued prompt when the server starts that turn.
 *
 * The first synthetic user_message is delivered when the prompt is enqueued,
 * but the chat reducer is component-local and is lost across SPA navigation.
 * The queue survives that navigation, so a server running status gives us a
 * reliable second chance to restore the prompt before its queue card changes
 * to the running state. ADD_USER is idempotent by turn id, making this harmless
 * for clients that never unmounted.
 */
function consumeRunningQueuedUser(turnId: string | undefined): void {
	if (!turnId) return;
	const queued = findQueuedChat(turnId);
	if (!queued) return;
	const userEvent: ServerMessage = {
		type: "user_message",
		text: queued.text,
		session_id: queued.session_id,
		id: queued.id,
		...(queued.attachments ? { attachments: queued.attachments } : {}),
		...(queued.vault_references
			? { vault_references: queued.vault_references }
			: {}),
		...(queued.workspace_references
			? { workspace_references: queued.workspace_references }
			: {}),
	};
	if (_bufferingEnabled) _messageBuffer.push(userEvent);
	for (const subscriber of messageSubs) subscriber(userEvent);
	// A running turn is no longer queued. Remove it only after re-emitting its
	// prompt so a Raven reducer that remounted during navigation can restore the
	// user row before the durable queue copy disappears. `done` retains the same
	// removal as an idempotent fallback for missed status frames.
	removeLocalChat(turnId);
}

/**
 * Slice C polish: reconcile chatQueue against the server's authoritative
 * queue state. Sent items not in the server's pending list (and not the
 * currently running one) are orphans and get pruned. Not-yet-sent items
 * (still in the local outbox awaiting ws connect) are preserved.
 */
// ─── WebSocket connection ─────────────────────────────────────────────────────

function getWsUrl(): string {
	const wsPort =
		typeof import.meta !== "undefined"
			? (import.meta as { env?: { VITE_WS_PORT?: string } }).env?.VITE_WS_PORT
			: undefined;

	if (wsPort) {
		const proto = window.location.protocol === "https:" ? "wss" : "ws";
		return `${proto}://${window.location.hostname}:${wsPort}/ws?${REPLAY_BATCH_QUERY}`;
	}

	// HTTPS (e.g. Tailscale serve): same-origin, proxy routes /ws
	if (window.location.protocol === "https:") {
		return `wss://${window.location.host}/ws?${REPLAY_BATCH_QUERY}`;
	}

	// Compiled build over plain HTTP: same-origin — the UI server bridges /ws
	// to the API port. Cross-port ws:// is a known adblocker kill target.
	if (!(import.meta as { env?: { DEV?: boolean } }).env?.DEV) {
		return `ws://${window.location.host}/ws?${REPLAY_BATCH_QUERY}`;
	}

	// Vite dev over plain HTTP (no /ws proxy): WS server runs on app port + 1
	const appPort = Number(window.location.port) || 80;
	return `ws://${window.location.hostname}:${appPort + 1}/ws?${REPLAY_BATCH_QUERY}`;
}

function setSnap(next: Partial<Snapshot>) {
	_snap = { ..._snap, ...next };
	for (const fn of statusSubs) fn();
}

// ─── Message handlers ────────────────────────────────────────────────────────

function onStatus(msg: Extract<ServerMessage, { type: "status" }>): void {
	if (msg.state !== "running") clearPendingUsage();
	// Do not clear actualModel on run start — let usage_update update it
	// naturally. This preserves the mismatch badge across submits so it only
	// changes when the actual model actually changes. handleClear calls
	// seedActualModel(null) explicitly for true new-session resets.
	//
	// Pending interactions own their lifecycle through their resolved events.
	// An idle status can race with plan artifact preparation or modal delivery;
	// clearing here would incorrectly flash the status green. Errors terminate
	// the interaction and can safely clear it.
	if (msg.state === "error") {
		_pendingInteractionKeys.clear();
	}
	// Slice C: track the running turn_id so MessageList can render the
	// correct queue chip on chatQueue entries. When state is not running,
	// clear it.
	const runningTurnId = msg.state === "running" ? (msg.turn_id ?? null) : null;
	setSnap({
		sessionState: msg.state,
		model: msg.model,
		permissionMode: msg.permission_mode ?? _snap.permissionMode,
		approvalsReviewer: msg.approvals_reviewer ?? _snap.approvalsReviewer,
		effort: msg.effort ?? _snap.effort,
		hasPendingPermissions: _pendingInteractionKeys.size > 0,
		runningTurnId,
		// Sleeping only happens while running; a non-running status means any
		// banner is stale (e.g. the resumed event raced a disconnect).
		...(msg.state !== "running" ? { sleepState: null } : {}),
	});
	// Slice A: server-side queue manages drain order. Client no longer batches
	// or sends on state=idle — items are dispatched immediately on enqueue and
	// consumed from the local queue when their turn starts running.
}

function onAgentSleep(
	msg: Extract<ServerMessage, { type: "agent_sleep" }>,
): void {
	setSnap({
		sleepState:
			msg.state === "sleeping"
				? {
						providerId: msg.providerId,
						windowId: msg.windowId ?? null,
						until: msg.until ?? null,
						reason: msg.reason ?? null,
						utilization: msg.utilization ?? null,
					}
				: null,
	});
}

function pendingInteractionKey(
	msg: Extract<
		ServerMessage,
		{
			type:
				| "permission_request"
				| "permission_resolved"
				| "ask_user_question"
				| "ask_user_question_resolved"
				| "plan_mode_exit"
				| "plan_mode_exit_resolved";
		}
	>,
): string {
	switch (msg.type) {
		case "permission_request":
		case "permission_resolved":
			return `permission:${msg.id}`;
		case "ask_user_question":
		case "ask_user_question_resolved":
			return `question:${msg.id}`;
		case "plan_mode_exit":
		case "plan_mode_exit_resolved":
			return `plan:${msg.id}`;
	}
}

function onPermissionRequest(
	msg: Extract<
		ServerMessage,
		{ type: "permission_request" | "ask_user_question" | "plan_mode_exit" }
	>,
): void {
	_pendingInteractionKeys.add(pendingInteractionKey(msg));
	setSnap({ hasPendingPermissions: true });
}

function onPermissionResolved(
	msg: Extract<
		ServerMessage,
		{
			type:
				| "permission_resolved"
				| "ask_user_question_resolved"
				| "plan_mode_exit_resolved";
		}
	>,
): void {
	_pendingInteractionKeys.delete(pendingInteractionKey(msg));
	setSnap({ hasPendingPermissions: _pendingInteractionKeys.size > 0 });
}

function onUsageUpdate(
	msg: Extract<ServerMessage, { type: "usage_update" }>,
): void {
	applyUsageUpdate(msg);
	// actualModel rides on usage_update because it's reported per inference.
	// Surface via the status snapshot so the model badge can compare against
	// the configured vault model.
	if (msg.actualModel && msg.actualModel !== _snap.actualModel) {
		setSnap({ actualModel: msg.actualModel });
	}
}

function onContextUpdate(
	msg: Extract<ServerMessage, { type: "context_update" }>,
): void {
	applyContextUpdate(msg);
	if (msg.actualModel && msg.actualModel !== _snap.actualModel) {
		setSnap({ actualModel: msg.actualModel });
	}
}

/** Returns false if the message is from a stale session and should be dropped. */
function onDone(msg: Extract<ServerMessage, { type: "done" }>): boolean {
	// Note: stale-session filtering is handled by the per-session filter in
	// onmessage (focused-session gate).
	// here — that's a DB session ID and doesn't match the pool UUID carried by
	// done events broadcast from entry.runState.broadcast().
	// Slice C: pop the queue item matching this done's turn_id. Match by
	// id (not head position) because promote can reorder the server queue,
	// so the just-finished turn might not be at the head of the client's
	// insertion-order queue. Done events for turns NOT in the local queue
	// (e.g. the first idle-path submission from raven, sent via direct
	// ws.send instead of enqueueChat) leave the queue alone.
	if (msg.turn_id) {
		removeLocalChat(msg.turn_id);
	}
	applyDone(msg);
	return true;
}

function handleGlobalMessage(msg: ServerMessage): boolean {
	switch (msg.type) {
		case "sessions_status":
			replaceSessionsStatus(msg.sessions);
			return true;
		case "session_closed":
			for (const session of getSessionsStatus()) {
				if (session.session_id !== msg.session_id) continue;
				if (session.db_session_id) forgetRavenTerminal(session.db_session_id);
				break;
			}
			forgetRavenTerminal(msg.session_id);
			removeSessionStatus(msg.session_id);
			clearProjectPreview(msg.session_id);
			return true;
		case "session_created":
			switchStatsContext(msg.session_id);
			focusSession(msg.session_id);
			_messageBuffer = [];
			for (const subscriber of statusSubs) subscriber();
			return true;
		case "data_revisions":
			replaceDataRevisions(msg.revisions);
			return true;
		case "project_preview_status":
			if (msg.preview) {
				applyProjectPreview(msg.preview);
			} else {
				clearProjectPreview(msg.session_id);
			}
			return true;
		default:
			return false;
	}
}

function isMessageFromAnotherSession(msg: ServerMessage): boolean {
	// Goal responses carry the durable DB chat ID because that is what Raven
	// addresses, while a newly created live entry temporarily focuses the pool
	// UUID. The Raven goal consumer performs its own canonical session check, so
	// let these events reach it instead of dropping a valid first-turn goal here.
	if (msg.type === "goal_state" || msg.type === "goal_error") return false;
	const messageSessionId = (msg as { session_id?: string }).session_id;
	const subscribedSessionId = getSubscribedSessionId();
	return (
		subscribedSessionId !== "" &&
		messageSessionId !== undefined &&
		canonicalSessionId(messageSessionId) !==
			canonicalSessionId(subscribedSessionId)
	);
}

function applySessionMessage(msg: ServerMessage): boolean {
	switch (msg.type) {
		case "status":
			onStatus(msg);
			break;
		case "permission_request":
		case "ask_user_question":
		case "plan_mode_exit":
			onPermissionRequest(msg);
			break;
		case "permission_resolved":
		case "ask_user_question_resolved":
		case "plan_mode_exit_resolved":
			onPermissionResolved(msg);
			break;
		case "usage_update":
			onUsageUpdate(msg);
			break;
		case "context_update":
			onContextUpdate(msg);
			break;
		case "agent_sleep":
			onAgentSleep(msg);
			break;
		case "done":
			return onDone(msg);
		case "queue_state":
			// Queue snapshots are session-scoped. Without that scope, the empty
			// snapshot for a newly selected chat (or the vault snapshot sent before
			// reconnect re-subscription) prunes durable queued prompts belonging to
			// every other chat.
			{
				const rawSessionId = msg.session_id ?? getSubscribedSessionId();
				const sessionId = rawSessionId ? canonicalSessionId(rawSessionId) : "";
				if (sessionId) {
					const durableTurns = [
						...(msg.pending_turns ?? []),
						...(msg.running_turn ? [msg.running_turn] : []),
					];
					reconcileLocalQueue(
						sessionId,
						msg.pending_turn_ids,
						msg.running_turn_id,
						durableTurns.map((turn) => ({
							...turn,
							session_id: canonicalSessionId(turn.session_id),
							_sent: true,
						})),
					);
				}
			}
			break;
	}
	return true;
}

const BUFFERED_MESSAGE_TYPES: ReadonlySet<ServerMessage["type"]> = new Set([
	"user_message",
	"turn_steered",
	"done",
	"chunk",
	"assistant_revision",
	"tool_event",
	"tool_update",
	"tool_activity_update",
	"tool_progress_update",
	"tool_result",
	"permission_request",
	"permission_resolved",
	"provider_permission_denied",
	"ask_user_question",
	"ask_user_question_resolved",
	"ask_user_question_provenance_updated",
	"plan_mode_exit",
	"plan_mode_exit_resolved",
	"realtime_transcript",
	"realtime_state",
	"realtime_error",
]);

function updateMessageBuffer(msg: ServerMessage): void {
	if (msg.type === "error") {
		setPendingSessionToday(false);
		if (_bufferingEnabled && msg.turn_scoped) _messageBuffer.push(msg);
		else if (!_bufferingEnabled) _messageBuffer = [];
		return;
	}
	if (BUFFERED_MESSAGE_TYPES.has(msg.type)) {
		if (_bufferingEnabled) _messageBuffer.push(msg);
		else if (msg.type === "done") _messageBuffer = [];
		return;
	}
	if (msg.type !== "done") return;
	if (!_bufferingEnabled) _messageBuffer = [];
}

function handleParsedSocketMessage(msg: ServerMessage): void {
	if (msg.type === "status") {
		const sessionId =
			(msg as typeof msg & { session_id?: string }).session_id ??
			getSubscribedSessionId();
		if (sessionId) reconcileSessionStatus(sessionId, msg);
	}
	if (handleGlobalMessage(msg) || isMessageFromAnotherSession(msg)) return;
	if (!applySessionMessage(msg)) return;
	updateMessageBuffer(msg);
	if (msg.type === "status" && msg.state === "running") {
		consumeRunningQueuedUser(msg.turn_id);
	} else if (msg.type === "queue_state") {
		consumeRunningQueuedUser(msg.running_turn_id ?? undefined);
	}
	for (const subscriber of messageSubs) subscriber(msg);
}

function handleSocketMessage(
	event: MessageEvent,
	socket: WebSocket,
	generation: number,
): void {
	if (!isCurrentSocket(socket, generation)) return;
	let msg: ServerMessage;
	try {
		msg = JSON.parse(event.data as string) as ServerMessage;
	} catch {
		return;
	}
	// Readiness acknowledgements are transport control frames. Consume them
	// before normal routing so they never enter transcript buffers/subscribers.
	if (msg.type === "connection_ack") {
		completeConnectionProbe(socket, generation, msg.request_id);
		return;
	}
	if (msg.type !== "session_replay") {
		handleParsedSocketMessage(msg);
		return;
	}
	// Reject an unrelated focused-session replay before walking its potentially
	// large payload. Accepted envelopes are flattened synchronously through the
	// ordinary path so ordering, buffering, and filtering semantics stay exact
	// while React can batch the resulting reducer work per envelope.
	if (isMessageFromAnotherSession(msg)) return;
	for (const replayed of msg.messages) {
		handleParsedSocketMessage(
			msg.session_id === undefined
				? replayed
				: ({
						...replayed,
						session_id: msg.session_id,
					} as unknown as ServerMessage),
		);
	}
}

function clearReconnectTimer(): void {
	if (_reconnectTimer === null) return;
	clearTimeout(_reconnectTimer);
	_reconnectTimer = null;
}

function clearConnectDeadline(): void {
	if (_connectDeadlineTimer === null) return;
	clearTimeout(_connectDeadlineTimer);
	_connectDeadlineTimer = null;
}

function armTransportConnectDeadline(
	socket: WebSocket,
	generation: number,
): void {
	clearConnectDeadline();
	const elapsed =
		_connectStartedAt === null ? 0 : Date.now() - _connectStartedAt;
	_connectDeadlineTimer = setTimeout(
		() => {
			_connectDeadlineTimer = null;
			failCurrentSocket(socket, generation);
		},
		Math.max(0, TRANSPORT_CONNECT_TIMEOUT_MS - elapsed),
	);
}

function isCurrentSocket(socket: WebSocket, generation: number): boolean {
	return _ws === socket && _socketGeneration === generation;
}

function retireCurrentSocket(socket: WebSocket, generation: number): boolean {
	if (!isCurrentSocket(socket, generation)) return false;
	clearConnectDeadline();
	if (_pendingConnectionProbe?.generation === generation) {
		if (_pendingConnectionProbe.kind === "liveness") {
			retainReconnectSafeDeferredMessages();
		}
		_pendingConnectionProbe = null;
	}
	if (_readySocketGeneration === generation) {
		_readySocketGeneration = null;
	}
	_ws = null;
	_connectStartedAt = null;
	_socketGeneration++;
	socket.onopen = null;
	socket.onerror = null;
	socket.onclose = null;
	socket.onmessage = null;
	if (socket.readyState === WS_CONNECTING || socket.readyState === WS_OPEN) {
		try {
			socket.close();
		} catch {
			// The attempt is already retired locally.
		}
	}
	return true;
}

function scheduleReconnect(): void {
	if (
		_reconnectTimer !== null ||
		typeof document === "undefined" ||
		document.visibilityState !== "visible"
	)
		return;
	const delay = Math.min(
		RECONNECT_BASE_MS * 2 ** _reconnectAttempts,
		RECONNECT_MAX_MS,
	);
	_reconnectAttempts++;
	_reconnectTimer = setTimeout(() => {
		_reconnectTimer = null;
		connect();
	}, delay);
}

function failCurrentSocket(socket: WebSocket, generation: number): void {
	if (!retireCurrentSocket(socket, generation)) return;
	setSnap({ wsStatus: "disconnected" });
	scheduleReconnect();
}

function nextConnectionProbeId(): string {
	_connectionProbeSequence++;
	if (
		typeof crypto !== "undefined" &&
		typeof crypto.randomUUID === "function"
	) {
		return crypto.randomUUID();
	}
	return `${Date.now()}-${_socketGeneration}-${_connectionProbeSequence}`;
}

function sendClientMessageNow(msg: ClientMessage): boolean {
	const socket = getReadySocket();
	if (!socket) return false;
	try {
		socket.send(JSON.stringify(msg));
		return true;
	} catch {
		return false;
	}
}

/**
 * A missed mobile background signal leaves the UI briefly showing connected
 * while its existing socket is validated. Preserve an explicitly scoped chat,
 * focused-session changes, and same-socket sync, but reject transient controls
 * whose meaning can expire or move before a replacement connection is ready.
 */
function sendClientMessageOrDefer(msg: ClientMessage): boolean {
	if (sendClientMessageNow(msg)) return true;
	const probe = _pendingConnectionProbe;
	if (
		probe?.kind === "liveness" &&
		isCurrentSocket(probe.socket, probe.generation)
	) {
		if (
			msg.type === "subscribe_session" ||
			msg.type === "sync" ||
			(msg.type === "chat" && Boolean(msg.session_id))
		) {
			_deferredClientMessages.push(msg);
			return true;
		}
	}
	return false;
}

function retainReconnectSafeDeferredMessages(): void {
	_deferredClientMessages = _deferredClientMessages.filter(
		(message) => message.type === "chat" && Boolean(message.session_id),
	);
}

function flushDeferredClientMessages(): boolean {
	while (_deferredClientMessages.length > 0) {
		const message = _deferredClientMessages[0];
		if (!sendClientMessageNow(message)) return false;
		_deferredClientMessages.shift();
	}
	return true;
}

function takeMatchingConnectionProbe(
	socket: WebSocket,
	generation: number,
	requestId: string,
): PendingConnectionProbe | null {
	const probe = _pendingConnectionProbe;
	if (
		!probe ||
		probe.socket !== socket ||
		probe.generation !== generation ||
		probe.requestId !== requestId
	) {
		return null;
	}
	_pendingConnectionProbe = null;
	clearConnectDeadline();
	return probe;
}

function failConnectionProbe(
	socket: WebSocket,
	generation: number,
	requestId: string,
): void {
	const probe = takeMatchingConnectionProbe(socket, generation, requestId);
	if (!probe) return;
	if (probe.kind === "handshake") {
		failCurrentSocket(socket, generation);
		return;
	}
	retainReconnectSafeDeferredMessages();
	if (!retireCurrentSocket(socket, generation)) return;
	setSnap({ wsStatus: "disconnected" });
	clearReconnectTimer();
	_reconnectAttempts = 0;
	connect();
}

function startConnectionProbe(
	socket: WebSocket,
	generation: number,
	kind: "handshake" | "liveness",
): void {
	if (!isCurrentSocket(socket, generation) || socket.readyState !== WS_OPEN) {
		return;
	}
	const existing = _pendingConnectionProbe;
	if (existing?.socket === socket && existing.generation === generation) {
		return;
	}
	if (kind === "liveness") {
		if (_readySocketGeneration !== generation) return;
		const now = Date.now();
		if (
			_lastLivenessProbeAt !== null &&
			now - _lastLivenessProbeAt < LIFECYCLE_RECOVERY_DEBOUNCE_MS
		) {
			return;
		}
		_lastLivenessProbeAt = now;
	}

	const requestId = nextConnectionProbeId();
	_pendingConnectionProbe = { socket, generation, requestId, kind };
	_readySocketGeneration = null;
	clearConnectDeadline();
	try {
		socket.send(
			JSON.stringify({ type: "connection_probe", request_id: requestId }),
		);
	} catch {
		failConnectionProbe(socket, generation, requestId);
		return;
	}
	_connectDeadlineTimer = setTimeout(
		() => {
			_connectDeadlineTimer = null;
			failConnectionProbe(socket, generation, requestId);
		},
		kind === "handshake" ? HANDSHAKE_TIMEOUT_MS : LIVENESS_TIMEOUT_MS,
	);
}

function completeConnectionProbe(
	socket: WebSocket,
	generation: number,
	requestId: string,
): void {
	const probe = takeMatchingConnectionProbe(socket, generation, requestId);
	if (!probe) return;
	_readySocketGeneration = generation;

	if (probe.kind === "handshake") {
		_connectStartedAt = null;
		clearReconnectTimer();
		_reconnectAttempts = 0;
		// The focused subscription reconstructs every interaction still pending.
		// Drop keys from the previous connection so a resolution missed while the
		// app was suspended cannot leave the local attention state stuck.
		_pendingInteractionKeys.clear();
		setSnap({ wsStatus: "connected", hasPendingPermissions: false });
		const subscribedSessionId = getSubscribedSessionId();
		if (
			subscribedSessionId &&
			!sendClientMessageNow({
				type: "subscribe_session",
				session_id: subscribedSessionId,
			})
		) {
			failCurrentSocket(socket, generation);
			return;
		}
		// The latest focused session was restored above. Drop any subscription
		// deferred during a failed liveness check so it is not replayed twice.
		_deferredClientMessages = _deferredClientMessages.filter(
			(message) => message.type !== "subscribe_session",
		);
	}

	if (!flushDeferredClientMessages()) {
		retainReconnectSafeDeferredMessages();
		failCurrentSocket(socket, generation);
		return;
	}
	// Flush items enqueued while the connection was down or under validation.
	// Already-sent items are skipped via the _sent flag.
	drainPendingToServer();
}

function connect() {
	if (typeof window === "undefined") return;
	if (
		window.location.pathname === "/login" ||
		window.location.pathname === "/login/"
	) {
		return;
	}
	if (_ws && (_ws.readyState === WS_CONNECTING || _ws.readyState === WS_OPEN)) {
		return;
	}
	if (_ws) {
		retireCurrentSocket(_ws, _socketGeneration);
	}

	let socket: WebSocket;
	try {
		socket = new WebSocket(getWsUrl());
	} catch {
		setSnap({ wsStatus: "disconnected" });
		scheduleReconnect();
		return;
	}
	const generation = ++_socketGeneration;
	_ws = socket;
	_connectStartedAt = Date.now();
	setSnap({ wsStatus: "connecting" });

	socket.onopen = () => {
		if (!isCurrentSocket(socket, generation)) return;
		clearConnectDeadline();
		_connectStartedAt = null;
		startConnectionProbe(socket, generation, "handshake");
	};
	socket.onerror = () => failCurrentSocket(socket, generation);
	socket.onclose = () => failCurrentSocket(socket, generation);
	socket.onmessage = (event) => handleSocketMessage(event, socket, generation);
	armTransportConnectDeadline(socket, generation);
}

/**
 * Explicit lifecycle recovery resets stale backoff. Visibility resume, network
 * restoration, and BFCache restoration replace sockets that mobile browsers
 * may still report as OPEN or CONNECTING. Focus and ordinary pageshow only
 * ensure a connection, avoiding an expensive transcript reload on every focus.
 */
function recoverConnection(
	forceReplace: boolean,
	bypassForceDebounce = false,
): void {
	if (
		typeof document === "undefined" ||
		document.visibilityState !== "visible"
	) {
		return;
	}
	clearReconnectTimer();
	_reconnectAttempts = 0;
	const now = Date.now();
	const forceCurrentSocket =
		forceReplace &&
		(bypassForceDebounce ||
			_lastForcedRecoveryAt === null ||
			now - _lastForcedRecoveryAt >= LIFECYCLE_RECOVERY_DEBOUNCE_MS);
	const socketBeforeRecovery = _ws;
	const connectingTooLong =
		_ws?.readyState === WS_CONNECTING &&
		(_connectStartedAt === null ||
			now - _connectStartedAt >= TRANSPORT_CONNECT_TIMEOUT_MS);
	if (_ws && (forceCurrentSocket || connectingTooLong)) {
		retireCurrentSocket(_ws, _socketGeneration);
	}
	if (forceCurrentSocket) _lastForcedRecoveryAt = now;
	connect();
	if (_ws?.readyState === WS_CONNECTING && _connectDeadlineTimer === null) {
		armTransportConnectDeadline(_ws, _socketGeneration);
		return;
	}
	if (
		!forceReplace &&
		_ws === socketBeforeRecovery &&
		_ws?.readyState === WS_OPEN
	) {
		startConnectionProbe(
			_ws,
			_socketGeneration,
			_readySocketGeneration === _socketGeneration ? "liveness" : "handshake",
		);
	}
}

function handleVisibilityChange(): void {
	if (typeof document === "undefined") return;
	if (document.visibilityState !== "visible") {
		_foregroundRecoveryPending = true;
		clearReconnectTimer();
		clearConnectDeadline();
		return;
	}
	const wasBackgrounded = _foregroundRecoveryPending;
	_foregroundRecoveryPending = false;
	recoverConnection(true, wasBackgrounded);
}

function handlePageHide(): void {
	_foregroundRecoveryPending = true;
	clearReconnectTimer();
	clearConnectDeadline();
}

function handleFreeze(): void {
	_foregroundRecoveryPending = true;
	clearReconnectTimer();
	clearConnectDeadline();
	if (_ws && retireCurrentSocket(_ws, _socketGeneration)) {
		setSnap({ wsStatus: "disconnected" });
	}
}

function handleResume(): void {
	if (document.visibilityState !== "visible") return;
	const wasBackgrounded = _foregroundRecoveryPending;
	_foregroundRecoveryPending = false;
	recoverConnection(true, wasBackgrounded);
}

function handleOnline(): void {
	if (document.visibilityState !== "visible") return;
	const wasBackgrounded = _foregroundRecoveryPending;
	_foregroundRecoveryPending = false;
	recoverConnection(true, wasBackgrounded);
}

function handlePageShow(event: PageTransitionEvent): void {
	if (document.visibilityState !== "visible") return;
	const forceReplace = event.persisted || _foregroundRecoveryPending;
	const wasBackgrounded = _foregroundRecoveryPending;
	_foregroundRecoveryPending = false;
	recoverConnection(forceReplace, wasBackgrounded);
}

function handleFocus(): void {
	if (document.visibilityState !== "visible") return;
	const forceReplace = _foregroundRecoveryPending;
	_foregroundRecoveryPending = false;
	recoverConnection(forceReplace, forceReplace);
}

if (typeof window !== "undefined") {
	connect();
	document.addEventListener("visibilitychange", handleVisibilityChange);
	document.addEventListener("freeze", handleFreeze);
	document.addEventListener("resume", handleResume);
	window.addEventListener("pagehide", handlePageHide);
	window.addEventListener("online", handleOnline);
	window.addEventListener("pageshow", handlePageShow);
	window.addEventListener("focus", handleFocus);
}

// ─── Public API — Connection & snapshot ──────────────────────────────────────

export function getSnapshot(): Snapshot {
	return _snap;
}

export function subscribeStatus(fn: () => void): () => void {
	statusSubs.add(fn);
	return () => statusSubs.delete(fn);
}

export function subscribeMessage(fn: (msg: ServerMessage) => void): () => void {
	messageSubs.add(fn);
	return () => messageSubs.delete(fn);
}

/** Send immediately, or defer briefly while a foreground liveness check runs. */
export function send(msg: ClientMessage): boolean {
	if (msg.type === "chat") setPendingSessionToday(true);
	if (msg.type === "chat" || msg.type === "clear") _messageBuffer = [];
	if (msg.type === "clear") {
		focusPendingNewSession();
		setPendingSessionToday(false);
		_pendingInteractionKeys.clear();
		setSnap({
			sessionState: "idle",
			hasPendingPermissions: false,
			runningTurnId: null,
		});
		clearChatQueue();
	}
	// Do not pre-resolve pending interactions here. The server broadcasts
	// `permission_resolved` back to all clients (including the sender), and
	// onPermissionResolved() removes the matching interaction id then.
	return sendClientMessageOrDefer(msg);
}

// ─── Public API — Message buffer ─────────────────────────────────────────────

export function drainMessageBuffer(): ServerMessage[] {
	const msgs = _messageBuffer;
	_messageBuffer = [];
	return msgs;
}

export function clearMessageBuffer(): void {
	_messageBuffer = [];
}

export function setBufferingEnabled(enabled: boolean): void {
	_bufferingEnabled = enabled;
	if (!enabled) _messageBuffer = [];
}

/** Seed the actual model from DB so the model badge is correct before any new query. */
export function seedActualModel(actualModel: string | null): void {
	if (actualModel === _snap.actualModel) return;
	setSnap({ actualModel });
}

// ─── Public API — Chat queue ──────────────────────────────────────────────────

export function enqueueChat(msg: QueuedChatMessage): void {
	const item = enqueueLocalChat(msg);
	if (sendChatToServer(item)) markQueuedChatSent(item.id);
}

/**
 * Slice C: ask the server to promote a queued msg — interrupts the current
 * running turn so this msg runs next. The server may decline (returns false)
 * if the id is unknown or refers to the running turn; the client doesn't
 * need to track that distinction since the UI only shows the button on
 * non-running queue items.
 */
export function promoteQueued(id: string): void {
	if (sendClientMessageOrDefer({ type: "promote_queued", turn_id: id })) {
		markQueuedChatPromoting(id);
	}
}

export function steerQueued(id: string): void {
	if (sendClientMessageOrDefer({ type: "steer_queued", turn_id: id })) {
		markQueuedChatSteering(id);
	}
}

export function removeFromQueue(id: string): QueuedChatMessage | undefined {
	const item = findQueuedChat(id);
	if (!item) return undefined;
	// Slice C: if the item was already sent to the server, ask the server
	// to cancel it. The server only cancels pending (not-yet-running) turns;
	// the running turn is unaffected and produces its done as usual. Local
	// removal happens regardless so the UI updates instantly.
	if (item._sent) {
		sendClientMessageOrDefer({ type: "cancel_queued", turn_id: id });
	}
	return removeLocalChat(id);
}

/**
 * Switch the client's focused session.
 * Updates the local subscription ID, sends `subscribe_session` to the server,
 * and notifies status subscribers so the UI can re-render.
 */
export function subscribeToSession(sessionId: string): void {
	const sessionChanged = getSubscribedSessionId() !== sessionId;
	if (!sessionChanged) return;
	switchStatsContext(sessionId);
	focusSession(sessionId);
	// The replay buffer belongs to the previously focused session. Keep replay
	// during snapshot/reconnect reads, but never carry those events across a
	// chat switch. Events from the newly subscribed session can refill it while
	// that session's history is loading.
	_messageBuffer = [];
	// Session controls and run state are scoped to the focused chat. Do not
	// display the previous chat's model/effort/permissions while waiting for
	// the subscribed session's status response.
	_snap = {
		..._snap,
		sessionState: "idle",
		model: "",
		actualModel: null,
		permissionMode: null,
		approvalsReviewer: null,
		effort: null,
		hasPendingPermissions: false,
		runningTurnId: null,
		sleepState: null,
	};
	_pendingInteractionKeys.clear();
	sendClientMessageOrDefer({
		type: "subscribe_session",
		session_id: sessionId,
	});
	// Notify so snapshot consumers know the active session changed.
	for (const fn of statusSubs) fn();
}

/** @internal — resets all module state to initial values; for testing only. */
export function __resetForTesting(): void {
	clearReconnectTimer();
	if (_ws) retireCurrentSocket(_ws, _socketGeneration);
	else {
		clearConnectDeadline();
		_socketGeneration++;
		_connectStartedAt = null;
	}
	_foregroundRecoveryPending = false;
	_lastForcedRecoveryAt = null;
	_lastLivenessProbeAt = null;
	_snap = { ...INITIAL_SNAPSHOT };
	_reconnectAttempts = 0;
	_readySocketGeneration = null;
	_connectionProbeSequence = 0;
	_pendingConnectionProbe = null;
	_deferredClientMessages = [];
	_messageBuffer = [];
	_bufferingEnabled = true;
	_pendingInteractionKeys.clear();
	resetChatQueueForTesting();
	resetLiveStatsForTesting();
	resetSessionStatusForTesting();
	resetDataRevisionsForTesting();
	statusSubs.clear();
	messageSubs.clear();
}

/** @internal — routes an already-parsed server frame through production buffering. */
export function __handleParsedMessageForTesting(msg: ServerMessage): void {
	handleParsedSocketMessage(msg);
}
