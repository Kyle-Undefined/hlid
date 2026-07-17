import {
	type Dispatch,
	type SetStateAction,
	useCallback,
	useEffect,
	useRef,
	useState,
} from "react";

const DRAFT_PERSIST_DELAY_MS = 120;

function persistDraft(key: string, value: string): void {
	try {
		if (value) localStorage.setItem(key, value);
		else localStorage.removeItem(key);
	} catch {}
}

/**
 * Manages the chat input draft — persists to localStorage per session,
 * restores on session change, and handles seeded-prompt (URL ?prompt=) seeding.
 *
 * @param existingSessionId - current session id (null/undefined for new session)
 * @param seededPrompt - prompt value from URL search param, or undefined
 * @param onClearSeed - called once to strip the seed from the URL after consuming it
 */
export function useDraft({
	existingSessionId,
	seededPrompt,
	onClearSeed,
}: {
	existingSessionId: string | null | undefined;
	seededPrompt: string | undefined;
	onClearSeed?: () => void;
}) {
	const draftKey = existingSessionId
		? `hlid:draft:${existingSessionId}`
		: "hlid:draft:new";

	const [input, setInputState] = useState(seededPrompt ?? "");
	const activeDraftKeyRef = useRef(draftKey);
	const latestInputRef = useRef(input);
	latestInputRef.current = input;
	const setInput: Dispatch<SetStateAction<string>> = useCallback((next) => {
		if (typeof next !== "function") latestInputRef.current = next;
		setInputState((previous) => {
			const value = typeof next === "function" ? next(previous) : next;
			latestInputRef.current = value;
			return value;
		});
	}, []);

	// Strip ?prompt from URL after seeding so refresh doesn't re-fill the box.
	useEffect(() => {
		if (seededPrompt === undefined) return;
		onClearSeed?.();
	}, [seededPrompt, onClearSeed]);

	// Guards against the restore→persist race when draftKey changes: the persist
	// effect would otherwise see the previous session's `input` and stomp on the
	// new draftKey before restore runs.
	const isRestoringDraftRef = useRef(false);

	// Restore draft when the active session changes (URL prompt takes precedence).
	useEffect(() => {
		if (seededPrompt !== undefined) return;
		if (activeDraftKeyRef.current !== draftKey) {
			persistDraft(activeDraftKeyRef.current, latestInputRef.current);
			activeDraftKeyRef.current = draftKey;
		}
		isRestoringDraftRef.current = true;
		try {
			const saved = localStorage.getItem(draftKey);
			latestInputRef.current = saved ?? "";
			setInputState(saved ?? "");
		} catch {
			latestInputRef.current = "";
			setInputState("");
		}
		// Intentionally do NOT reset isRestoringDraftRef here — the persist
		// effect below clears it on the next render after setInput fires.
		// Resetting in a finally{} block would execute synchronously before
		// React re-renders, causing the guard to be false when the persist
		// effect sees the restored input value.
	}, [draftKey, seededPrompt]);

	// Debounce synchronous localStorage writes. Persisting a growing string for
	// every key-repeat event can monopolize the UI thread while Raven also streams.
	useEffect(() => {
		if (isRestoringDraftRef.current) {
			// Clear the guard set by the restore effect above and skip
			// persisting the just-restored value.
			isRestoringDraftRef.current = false;
			return;
		}
		const timer = window.setTimeout(
			() => persistDraft(draftKey, input),
			DRAFT_PERSIST_DELAY_MS,
		);
		return () => window.clearTimeout(timer);
	}, [input, draftKey]);

	// A route change can happen before the debounce expires. Flush the latest
	// value once on unmount so the draft remains durable without per-key writes.
	useEffect(
		() => () => persistDraft(activeDraftKeyRef.current, latestInputRef.current),
		[],
	);

	/** Remove the persisted draft for the current session. Call on send or clear. */
	function clearDraft() {
		latestInputRef.current = "";
		try {
			localStorage.removeItem(draftKey);
		} catch {}
	}

	return { input, setInput, draftKey, clearDraft };
}
