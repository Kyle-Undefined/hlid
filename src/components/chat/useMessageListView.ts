import { useEffect, useMemo, useRef, useState } from "react";
import type { QueuedChatMessage } from "#/hooks/wsChatQueueStore";
import { approvedLabel } from "#/server/protocol";
import type { AssistantMessage, ChatMessage, UserMessage } from "./chatReducer";
import type { UserMsgQueueState } from "./UserMsg";

export type { QueuedChatMessage };

const HISTORY_RENDER_PAGE_SIZE = 100;

function mapsEqual(a: Map<string, string>, b: Map<string, string>): boolean {
	if (a.size !== b.size) return false;
	for (const [key, value] of a) {
		if (b.get(key) !== value) return false;
	}
	return true;
}

/**
 * Accepted steers belong to the assistant response they redirected. Keep them
 * in reducer/history state for persistence and correlation, but render them as
 * compact acknowledgements inside that assistant row instead of as another
 * full user-message section.
 */
export function groupAcceptedSteers(messages: ChatMessage[]): {
	messages: ChatMessage[];
	acceptedSteersByAssistantId: Map<string, UserMessage[]>;
} {
	const assistantBySequence = new Map<number, AssistantMessage>();
	const assistantByTurn = new Map<string, AssistantMessage>();
	for (const message of messages) {
		if (message.role !== "assistant") continue;
		if (message.transcriptSeq !== undefined) {
			assistantBySequence.set(message.transcriptSeq, message);
		}
		if (message.turnId !== undefined) {
			assistantByTurn.set(message.turnId, message);
		}
	}

	const acceptedSteersByAssistantId = new Map<string, UserMessage[]>();
	const groupedSteerIds = new Set<string>();
	const transcriptOrder = new Map(
		messages.map((message, index) => [message, index] as const),
	);
	for (const message of messages) {
		if (message.role !== "user") continue;
		if (
			message.steerTargetSeq === undefined &&
			message.steerTargetTurnId === undefined
		) {
			continue;
		}
		// An accepted steer is receipt data, never a second standalone user
		// section. Its target may live on an older page that is not loaded yet.
		groupedSteerIds.add(message.id);
		// Persisted sequence correlation is authoritative when that row is
		// mounted. During a live remount the exact row can exist only as a
		// synthetic turn-bound assistant, so fall back to the same turn id.
		const assistant =
			(message.steerTargetSeq !== undefined
				? assistantBySequence.get(message.steerTargetSeq)
				: undefined) ??
			(message.steerTargetTurnId !== undefined
				? assistantByTurn.get(message.steerTargetTurnId)
				: undefined);
		if (!assistant) continue;
		const steers = acceptedSteersByAssistantId.get(assistant.id) ?? [];
		steers.push(message);
		acceptedSteersByAssistantId.set(assistant.id, steers);
	}
	for (const steers of acceptedSteersByAssistantId.values()) {
		steers.sort((left, right) => {
			if (
				left.transcriptSeq !== undefined &&
				right.transcriptSeq !== undefined &&
				left.transcriptSeq !== right.transcriptSeq
			) {
				return left.transcriptSeq - right.transcriptSeq;
			}
			return (
				(transcriptOrder.get(left) ?? 0) - (transcriptOrder.get(right) ?? 0)
			);
		});
	}

	return {
		messages: messages.filter(
			(message) => message.role !== "user" || !groupedSteerIds.has(message.id),
		),
		acceptedSteersByAssistantId,
	};
}

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
	hasOlderHistory = false,
	isLoadingOlderHistory = false,
	onLoadOlderHistory,
}: {
	messages: ChatMessage[];
	chatQueue: QueuedChatMessage[];
	sessionId: string;
	sessionState: "idle" | "running" | "error";
	runningTurnId: string | null;
	hasOlderHistory?: boolean;
	isLoadingOlderHistory?: boolean;
	onLoadOlderHistory?: () => Promise<number>;
}) {
	const [visibleHistoryCount, setVisibleHistoryCount] = useState(
		HISTORY_RENDER_PAGE_SIZE,
	);
	const [isCursorLoadReserved, setIsCursorLoadReserved] = useState(false);
	const activeCursorLoadRef = useRef<object | null>(null);
	const currentSessionIdRef = useRef(sessionId);
	currentSessionIdRef.current = sessionId;
	// biome-ignore lint/correctness/useExhaustiveDependencies: changing sessions resets the bounded render window
	useEffect(() => {
		activeCursorLoadRef.current = null;
		setIsCursorLoadReserved(false);
		setVisibleHistoryCount(HISTORY_RENDER_PAGE_SIZE);
		return () => {
			activeCursorLoadRef.current = null;
		};
	}, [sessionId]);
	// Keep the DOM bounded even when cursor pages have been fetched. Loading a
	// page expands this window by the number of rows the server actually returned;
	// later live messages then displace the oldest rendered rows instead of growing
	// the mounted transcript forever.
	const { messages: groupedMessages, acceptedSteersByAssistantId } = useMemo(
		() => groupAcceptedSteers(messages),
		[messages],
	);
	const hiddenHistoryCount = isCursorLoadReserved
		? 0
		: Math.max(0, groupedMessages.length - visibleHistoryCount);
	const visibleMessages = useMemo(
		() => groupedMessages.slice(hiddenHistoryCount),
		[groupedMessages, hiddenHistoryCount],
	);

	// Approved permissions render as a chip under the matching tool block
	// (matched by toolUseID === ToolEvent.id) instead of a separate row, so a
	// long run of approvals doesn't stack up above each tool call.
	const permissionLabelsRef = useRef(new Map<string, string>());
	const nextPermissionLabels = new Map<string, string>();
	for (const m of messages) {
		if (m.role !== "permission") continue;
		const label = approvedLabel(m.decision);
		if (label) nextPermissionLabels.set(m.id, label);
	}
	if (!mapsEqual(permissionLabelsRef.current, nextPermissionLabels)) {
		permissionLabelsRef.current = nextPermissionLabels;
	}
	const permissionLabels = permissionLabelsRef.current;

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
			} else if (qm._steering) {
				map.set(qm.id, { kind: "steering" });
			} else if (qm._promoting) {
				map.set(qm.id, { kind: "promoting" });
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
	const olderHistoryCount =
		hiddenHistoryCount > 0
			? Math.min(HISTORY_RENDER_PAGE_SIZE, hiddenHistoryCount)
			: hasOlderHistory
				? HISTORY_RENDER_PAGE_SIZE
				: 0;
	const loadOlder = () => {
		if (isLoadingOlderHistory) return;
		if (hiddenHistoryCount > 0) {
			setVisibleHistoryCount((count) =>
				Math.min(groupedMessages.length, count + HISTORY_RENDER_PAGE_SIZE),
			);
			return;
		}
		if (!onLoadOlderHistory || activeCursorLoadRef.current) return;

		// Reserve the fetched state before starting the cursor request. Production wraps this
		// callback in scroll-height preservation and resolves after its animation
		// frame; reserving now lets React mount the prepended rows before that frame
		// measures the new height. The temporary unbounded window also covers pages
		// with auxiliary cards beyond the 100 message rows. Once the request reports
		// its actual row count, the lasting render cap grows by exactly N.
		const token = {};
		const loadSessionId = sessionId;
		activeCursorLoadRef.current = token;
		setIsCursorLoadReserved(true);
		void (async () => {
			let loadedCount = 0;
			try {
				const loaded = await onLoadOlderHistory();
				if (Number.isFinite(loaded)) {
					loadedCount = Math.max(0, Math.floor(loaded));
				}
			} catch {
				// The parent owns error reporting. Roll the optimistic render-window
				// reservation back so a failed page does not permanently raise the cap.
			}
			if (
				activeCursorLoadRef.current !== token ||
				currentSessionIdRef.current !== loadSessionId
			) {
				return;
			}
			activeCursorLoadRef.current = null;
			setVisibleHistoryCount((count) => count + loadedCount);
			setIsCursorLoadReserved(false);
		})();
	};

	return {
		hiddenHistoryCount,
		olderHistoryCount,
		isLoadingOlderHistory,
		visibleMessages,
		acceptedSteersByAssistantId,
		permissionLabels,
		queueStateById,
		orphanQueued,
		loadOlder,
	};
}

export { HISTORY_RENDER_PAGE_SIZE };
