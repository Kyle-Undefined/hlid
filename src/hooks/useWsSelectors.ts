import { useSyncExternalStore } from "react";
import {
	getLiveStats,
	getQueue,
	type LiveStats,
	type QueuedChatMessage,
	subscribeQueue,
	subscribeStats,
} from "./wsStore";

/** Subscribe to live session stats (tokens, cost, turns, context window). */
export function useWsLiveStats(): LiveStats {
	return useSyncExternalStore(subscribeStats, getLiveStats, getLiveStats);
}

/** Subscribe to the queued chat message list. */
export function useWsChatQueue(): QueuedChatMessage[] {
	return useSyncExternalStore(subscribeQueue, getQueue, getQueue);
}
