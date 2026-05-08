import { useEffect, useRef, useState } from "react";

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

	const [input, setInput] = useState(seededPrompt ?? "");

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
		isRestoringDraftRef.current = true;
		try {
			const saved = localStorage.getItem(draftKey);
			setInput(saved ?? "");
		} catch {
			setInput("");
		}
		// Intentionally do NOT reset isRestoringDraftRef here — the persist
		// effect below clears it on the next render after setInput fires.
		// Resetting in a finally{} block would execute synchronously before
		// React re-renders, causing the guard to be false when the persist
		// effect sees the restored input value.
	}, [draftKey, seededPrompt]);

	// Persist draft on every keystroke.
	useEffect(() => {
		if (isRestoringDraftRef.current) {
			// Clear the guard set by the restore effect above and skip
			// persisting the just-restored value.
			isRestoringDraftRef.current = false;
			return;
		}
		try {
			if (input) localStorage.setItem(draftKey, input);
			else localStorage.removeItem(draftKey);
		} catch {}
	}, [input, draftKey]);

	/** Remove the persisted draft for the current session. Call on send or clear. */
	function clearDraft() {
		try {
			localStorage.removeItem(draftKey);
		} catch {}
	}

	return { input, setInput, draftKey, clearDraft };
}
