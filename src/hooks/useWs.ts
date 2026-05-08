import { useCallback, useEffect, useSyncExternalStore } from "react";
import type { ServerMessage } from "../server/protocol";
import * as wsStore from "./wsStore";

export function useWs(onMessage?: (msg: ServerMessage) => void) {
	const { wsStatus, sessionState, model, actualModel } = useSyncExternalStore(
		wsStore.subscribeStatus,
		wsStore.getSnapshot,
		() => wsStore.INITIAL_SNAPSHOT,
	);

	useEffect(() => {
		if (!onMessage) return;
		return wsStore.subscribeMessage(onMessage);
	}, [onMessage]);

	const send = useCallback(wsStore.send, []);

	return { wsStatus, sessionState, model, actualModel, send };
}
