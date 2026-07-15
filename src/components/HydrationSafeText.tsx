import { useSyncExternalStore } from "react";

const subscribe = () => () => {};
const browserSnapshot = () => true;
const serverSnapshot = () => false;

/**
 * Render deterministic SSR text through hydration, then switch to the
 * browser-local representation. Client-side navigations use the local text
 * immediately because they do not consume the server snapshot.
 */
export function HydrationSafeText({
	serverText,
	clientText,
}: {
	serverText: string;
	clientText: string;
}) {
	const hydrated = useSyncExternalStore(
		subscribe,
		browserSnapshot,
		serverSnapshot,
	);
	return hydrated ? clientText : serverText;
}
