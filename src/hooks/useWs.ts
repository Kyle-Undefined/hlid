import { useCallback, useEffect, useSyncExternalStore } from "react";
import type { ServerMessage } from "../server/protocol";
import * as wsStore from "./wsStore";

export type { WsStatus } from "./wsStore";

const SERVER_SNAPSHOT = {
	wsStatus: "connecting" as const,
	sessionState: "idle" as const,
	model: "",
	hasPendingPermissions: false,
};

export function useWs(onMessage?: (msg: ServerMessage) => void) {
	const { wsStatus, sessionState, model } = useSyncExternalStore(
		wsStore.subscribeStatus,
		wsStore.getSnapshot,
		() => SERVER_SNAPSHOT,
	);

	useEffect(() => {
		if (!onMessage) return;
		return wsStore.subscribeMessage(onMessage);
	}, [onMessage]);

	const send = useCallback(wsStore.send, []);

	return { wsStatus, sessionState, model, send };
}
