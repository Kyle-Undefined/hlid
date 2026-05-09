import { useCallback, useRef, useState } from "react";

/**
 * Returns { copy, copied } where copied briefly flips true then resets after 2s.
 * Uses navigator.clipboard.writeText — no fallback needed (modern browsers only).
 */
export function useCopyToClipboard() {
	const [copied, setCopied] = useState(false);
	const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	const copy = useCallback((text: string) => {
		navigator.clipboard
			.writeText(text)
			.then(() => {
				if (timerRef.current) clearTimeout(timerRef.current);
				setCopied(true);
				timerRef.current = setTimeout(() => setCopied(false), 2000);
			})
			.catch(() => {
				// clipboard write failed (e.g. permissions denied) — leave copied = false
			});
	}, []);

	return { copy, copied };
}
