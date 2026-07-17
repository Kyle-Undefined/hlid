import type { CommandAction } from "../lib/commands";
import type { ChatAttachment } from "../server/protocol";

export type QueuedChatMessage = {
	id: string;
	text: string;
	session_id: string;
	skill_context?: string;
	skill_contexts?: string[];
	command_action?: CommandAction;
	agent_cwd?: string;
	attachments?: ChatAttachment[];
	plan_mode?: boolean;
	plan_html?: boolean;
	provider?: string;
	model?: string;
	effort?: string;
	permission_mode?: string;
	/** True after the message has been delivered to the server. */
	_sent?: boolean;
	/** True while the server is interrupting the active turn to promote this one. */
	_promoting?: boolean;
};

let pendingPrompt: string | null = null;
const CHAT_QUEUE_STORAGE_KEY = "hlid:raven:chat-queue";

function loadPersistedQueue(): QueuedChatMessage[] {
	if (typeof localStorage === "undefined") return [];
	try {
		const parsed = JSON.parse(
			localStorage.getItem(CHAT_QUEUE_STORAGE_KEY) ?? "[]",
		) as unknown;
		if (!Array.isArray(parsed)) return [];
		return parsed.filter(
			(item): item is QueuedChatMessage =>
				typeof item === "object" &&
				item !== null &&
				typeof (item as QueuedChatMessage).id === "string" &&
				typeof (item as QueuedChatMessage).text === "string" &&
				typeof (item as QueuedChatMessage).session_id === "string",
		);
	} catch {
		return [];
	}
}

function persistQueue(): void {
	if (typeof localStorage === "undefined") return;
	try {
		if (chatQueue.length > 0) {
			// Promotion is only an optimistic, in-memory acknowledgement while the
			// server interrupts the current turn. A reload must rebuild that state
			// from the server instead of reviving a stale NEXT badge.
			const persistedQueue = chatQueue.map(
				({ _promoting, ...queued }) => queued,
			);
			localStorage.setItem(
				CHAT_QUEUE_STORAGE_KEY,
				JSON.stringify(persistedQueue),
			);
		} else {
			localStorage.removeItem(CHAT_QUEUE_STORAGE_KEY);
		}
	} catch {}
}

let chatQueue: QueuedChatMessage[] = loadPersistedQueue();
const subscribers = new Set<() => void>();

function notifySubscribers(): void {
	for (const subscriber of subscribers) subscriber();
}

export function enqueueLocalChat(msg: QueuedChatMessage): QueuedChatMessage {
	const item = { ...msg };
	chatQueue = [...chatQueue, item];
	persistQueue();
	notifySubscribers();
	return item;
}

export function markQueuedChatSent(id: string): void {
	const item = chatQueue.find((queued) => queued.id === id);
	if (item) {
		item._sent = true;
		persistQueue();
	}
}

/**
 * Give the promoted turn immediate UI feedback while the server interrupts the
 * active turn. The next running status takes precedence over this marker and
 * the item is removed normally when its turn completes.
 */
export function markQueuedChatPromoting(id: string): void {
	if (!chatQueue.some((queued) => queued.id === id)) return;
	let changed = false;
	chatQueue = chatQueue.map((queued) => {
		const promoting = queued.id === id;
		if (Boolean(queued._promoting) === promoting) return queued;
		changed = true;
		if (promoting) return { ...queued, _promoting: true };
		const { _promoting, ...rest } = queued;
		return rest;
	});
	if (!changed) return;
	persistQueue();
	notifySubscribers();
}

export function findQueuedChat(id: string): QueuedChatMessage | undefined {
	return chatQueue.find((queued) => queued.id === id);
}

export function removeLocalChat(id: string): QueuedChatMessage | undefined {
	const item = findQueuedChat(id);
	if (!item) return undefined;
	chatQueue = chatQueue.filter((queued) => queued.id !== id);
	persistQueue();
	notifySubscribers();
	return item;
}

export function reconcileLocalQueue(
	sessionId: string,
	pendingIds: string[],
	runningId: string | null,
	pendingTurns: QueuedChatMessage[] = [],
): void {
	const known = new Set([...pendingIds, ...(runningId ? [runningId] : [])]);
	const serverPending = new Map(pendingTurns.map((turn) => [turn.id, turn]));
	let changed = false;
	chatQueue = chatQueue
		.map((queued) => {
			if (queued.session_id !== sessionId) return queued;
			const snapshot = serverPending.get(queued.id);
			if (!snapshot) return queued;
			serverPending.delete(queued.id);
			const restored = { ...queued, ...snapshot, _sent: true };
			if (JSON.stringify(restored) !== JSON.stringify(queued)) changed = true;
			return restored;
		})
		.filter((queued) => {
			const keep =
				queued.session_id !== sessionId ||
				!queued._sent ||
				known.has(queued.id);
			if (!keep) changed = true;
			return keep;
		});
	if (serverPending.size > 0) {
		chatQueue = [
			...chatQueue,
			...Array.from(serverPending.values(), (turn) => ({
				...turn,
				session_id: sessionId,
				_sent: true,
			})),
		];
		changed = true;
	}
	if (changed) {
		persistQueue();
		notifySubscribers();
	}
}

export function getQueue(): QueuedChatMessage[] {
	return chatQueue;
}

export function subscribeQueue(fn: () => void): () => void {
	subscribers.add(fn);
	return () => subscribers.delete(fn);
}

export function clearChatQueue(): void {
	if (chatQueue.length === 0) return;
	chatQueue = [];
	persistQueue();
	notifySubscribers();
}

export function setPendingPrompt(text: string): void {
	pendingPrompt = text;
}

export function claimPendingPrompt(): string | null {
	const prompt = pendingPrompt;
	pendingPrompt = null;
	return prompt;
}

export function resetChatQueueForTesting(reloadPersisted = false): void {
	pendingPrompt = null;
	chatQueue = reloadPersisted ? loadPersistedQueue() : [];
	if (!reloadPersisted) persistQueue();
	subscribers.clear();
}
