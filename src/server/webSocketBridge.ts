import type { ServerWebSocket } from "bun";

export type WebSocketBridgeData = {
	wsTarget: string;
	back: WebSocket | null;
	queue: Array<string | ArrayBuffer>;
	protocols?: string[];
};

type WebSocketBridgeOptions<T extends WebSocketBridgeData> = {
	headers: (data: T) => Record<string, string>;
	maxQueuedMessages?: number;
	connectTimeoutMs?: number;
};

export function createWebSocketBridgeHandlers<T extends WebSocketBridgeData>({
	headers,
	maxQueuedMessages = 100,
	connectTimeoutMs = 10_000,
}: WebSocketBridgeOptions<T>) {
	return {
		open(ws: ServerWebSocket<T>) {
			const BunWebSocket = WebSocket as unknown as new (
				url: string,
				options: {
					headers: Record<string, string>;
					protocols?: string[];
				},
			) => WebSocket;
			const back = new BunWebSocket(ws.data.wsTarget, {
				headers: headers(ws.data),
				protocols: ws.data.protocols,
			});
			ws.data.back = back;
			const connectTimeout = setTimeout(() => {
				if (back.readyState === WebSocket.CONNECTING) {
					ws.data.queue = [];
					back.close();
					ws.close();
				}
			}, connectTimeoutMs);
			back.onopen = () => {
				clearTimeout(connectTimeout);
				for (const message of ws.data.queue) back.send(message);
				ws.data.queue = [];
			};
			back.onmessage = (event) => {
				if (ws.readyState === WebSocket.OPEN) ws.send(event.data);
			};
			back.onclose = () => {
				clearTimeout(connectTimeout);
				ws.close();
			};
			back.onerror = () => {
				clearTimeout(connectTimeout);
				ws.close();
			};
		},
		message(ws: ServerWebSocket<T>, data: string | Buffer) {
			const payload: string | ArrayBuffer =
				typeof data === "string"
					? data
					: (data.buffer.slice(
							data.byteOffset,
							data.byteOffset + data.byteLength,
						) as ArrayBuffer);
			if (ws.data.back?.readyState === WebSocket.OPEN) {
				ws.data.back.send(payload);
			} else if (ws.data.back?.readyState === WebSocket.CONNECTING) {
				if (ws.data.queue.length >= maxQueuedMessages) ws.data.queue.shift();
				ws.data.queue.push(payload);
			} else {
				ws.close();
			}
		},
		close(ws: ServerWebSocket<T>) {
			ws.data.back?.close();
		},
	};
}
