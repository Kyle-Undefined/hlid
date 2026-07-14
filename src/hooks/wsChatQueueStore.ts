import type { ChatAttachment } from "../server/protocol";

export type QueuedChatMessage = {
	id: string;
	text: string;
	session_id: string;
	skill_context?: string;
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
};

let pendingPrompt: string | null = null;
let chatQueue: QueuedChatMessage[] = [];
const subscribers = new Set<() => void>();

function notifySubscribers(): void {
	for (const subscriber of subscribers) subscriber();
}

export function enqueueLocalChat(msg: QueuedChatMessage): QueuedChatMessage {
	const item = { ...msg };
	chatQueue = [...chatQueue, item];
	notifySubscribers();
	return item;
}

export function markQueuedChatSent(id: string): void {
	const item = chatQueue.find((queued) => queued.id === id);
	if (item) item._sent = true;
}

export function findQueuedChat(id: string): QueuedChatMessage | undefined {
	return chatQueue.find((queued) => queued.id === id);
}

export function removeLocalChat(id: string): QueuedChatMessage | undefined {
	const item = findQueuedChat(id);
	if (!item) return undefined;
	chatQueue = chatQueue.filter((queued) => queued.id !== id);
	notifySubscribers();
	return item;
}

export function reconcileLocalQueue(
	pendingIds: string[],
	runningId: string | null,
): void {
	const known = new Set([...pendingIds, ...(runningId ? [runningId] : [])]);
	const before = chatQueue.length;
	chatQueue = chatQueue.filter(
		(queued) => !queued._sent || known.has(queued.id),
	);
	if (chatQueue.length !== before) notifySubscribers();
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

export function resetChatQueueForTesting(): void {
	pendingPrompt = null;
	chatQueue = [];
	subscribers.clear();
}
