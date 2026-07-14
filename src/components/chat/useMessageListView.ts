import { useEffect, useMemo, useState } from "react";
import type { QueuedChatMessage } from "#/hooks/wsChatQueueStore";
import { approvedLabel } from "#/server/protocol";
import type { ChatMessage } from "./chatReducer";
import type { UserMsgQueueState } from "./UserMsg";

const HISTORY_RENDER_PAGE_SIZE = 200;

/**
 * Derives everything MessageList needs to render from the raw transcript +
 * queue: the bounded "load older" window, which permission cards fold into
 * their tool block, per-queued-message running/queued state, and queued
 * messages not yet reflected in the transcript (see inline notes below).
 */
export function useMessageListView({
	messages,
	chatQueue,
	sessionId,
	sessionState,
	runningTurnId,
}: {
	messages: ChatMessage[];
	chatQueue: QueuedChatMessage[];
	sessionId: string;
	sessionState: "idle" | "running" | "error";
	runningTurnId: string | null;
}) {
	const [visibleHistoryCount, setVisibleHistoryCount] = useState(
		HISTORY_RENDER_PAGE_SIZE,
	);
	// biome-ignore lint/correctness/useExhaustiveDependencies: changing sessions resets the bounded render window
	useEffect(() => {
		setVisibleHistoryCount(HISTORY_RENDER_PAGE_SIZE);
	}, [sessionId]);
	const hiddenHistoryCount = Math.max(0, messages.length - visibleHistoryCount);
	const visibleMessages = useMemo(
		() => messages.slice(hiddenHistoryCount),
		[messages, hiddenHistoryCount],
	);

	// Approved permissions render as a chip under the matching tool block
	// (matched by toolUseID === ToolEvent.id) instead of a separate row, so a
	// long run of approvals doesn't stack up above each tool call.
	const permissionLabels = useMemo(() => {
		const map = new Map<string, string>();
		for (const m of messages) {
			if (m.role !== "permission") continue;
			const label = approvedLabel(m.decision);
			if (label) map.set(m.id, label);
		}
		return map;
	}, [messages]);

	// Slice C: build a lookup from queue.id → state. Match against the
	// server-reported runningTurnId for "currently running" — positional
	// heuristics are unreliable because chatQueue[0] can be either the
	// running turn (after a previous turn's done popped its predecessor) OR
	// a not-yet-running turn queued behind an idle-path msg.
	const queueStateById = useMemo(() => {
		const map = new Map<string, UserMsgQueueState>();
		const filtered = chatQueue.filter((qm) => qm.session_id === sessionId);
		let queuedIndex = 0;
		for (const qm of filtered) {
			if (qm.id === runningTurnId && sessionState === "running") {
				map.set(qm.id, { kind: "running" });
			} else {
				map.set(qm.id, { kind: "queued", index: queuedIndex });
				queuedIndex++;
			}
		}
		return map;
	}, [chatQueue, sessionId, sessionState, runningTurnId]);

	// Queued msgs live in wsStore._chatQueue (module state, survives SPA nav)
	// but the reducer transcript does not. On remount, history reloads from DB
	// — which has no row for a not-yet-running queued turn (server persists
	// the user row only when drainTurnQueue starts processing it) — so the
	// queued msg would vanish until processed. Re-surface any queued item not
	// already in the transcript:
	//   - skip ids already rendered (live case: synthetic user_message
	//     dispatched ADD_USER with id === queue.id)
	//   - skip the running turn (its user row is in DB with a fresh uid, so
	//     rendering the queue copy would double it)
	const orphanQueued = useMemo(() => {
		const renderedUserIds = new Set(
			messages.filter((m) => m.role === "user").map((m) => m.id),
		);
		return chatQueue.filter(
			(qm) =>
				qm.session_id === sessionId &&
				!renderedUserIds.has(qm.id) &&
				qm.id !== runningTurnId,
		);
	}, [messages, chatQueue, sessionId, runningTurnId]);

	return {
		hiddenHistoryCount,
		visibleMessages,
		permissionLabels,
		queueStateById,
		orphanQueued,
		loadOlder: () =>
			setVisibleHistoryCount((count) =>
				Math.min(messages.length, count + HISTORY_RENDER_PAGE_SIZE),
			),
	};
}

export { HISTORY_RENDER_PAGE_SIZE };
