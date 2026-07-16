import { useSyncExternalStore } from "react";
import {
	getQueue,
	type QueuedChatMessage,
	subscribeQueue,
} from "./wsChatQueueStore";
import {
	getLiveStats,
	type LiveStats,
	subscribeStats,
} from "./wsLiveStatsStore";

const EMPTY_CHAT_QUEUE: QueuedChatMessage[] = [];

/** Subscribe to live session stats (tokens, cost, turns, context window). */
export function useWsLiveStats(): LiveStats {
	return useSyncExternalStore(subscribeStats, getLiveStats, getLiveStats);
}

/** Subscribe to the queued chat message list. */
export function useWsChatQueue(): QueuedChatMessage[] {
	return useSyncExternalStore(subscribeQueue, getQueue, () => EMPTY_CHAT_QUEUE);
}
