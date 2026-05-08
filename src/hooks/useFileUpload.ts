import { useCallback, useRef, useState } from "react";
import { uid } from "#/lib/utils";
import type { ChatAttachment } from "#/server/protocol";

type UploadResponse = ChatAttachment & {
	size_bytes: number;
	gitignore_suggestion?: { agent_root: string };
};

export interface UseFileUploadOptions {
	/** Agent working dir, appended to each upload. */
	agentCwd?: string | null;
	/**
	 * Session ID for uploads. If omitted the hook auto-generates one on first
	 * upload and reuses it — expose via `uploadSessionIdRef` to the caller
	 * (index.tsx pattern). Pass an explicit string when the session already
	 * exists (raven.tsx pattern).
	 */
	sessionId?: string | null;
}

export interface UseFileUploadReturn {
	pendingAttachments: ChatAttachment[];
	uploadingCount: number;
	uploadError: string | null;
	gitignoreHint: { agent_root: string } | null;
	/** Ref holding the auto-generated session ID (only meaningful when
	 * `sessionId` is not provided). Caller can read + clear on send. */
	uploadSessionIdRef: React.RefObject<string | null>;
	uploadFiles: (files: FileList | File[]) => Promise<void>;
	removePending: (id: string) => void;
	clearPending: () => void;
	setPendingAttachments: React.Dispatch<React.SetStateAction<ChatAttachment[]>>;
	dismissGitignoreHint: () => void;
}

export function useFileUpload({
	agentCwd,
	sessionId,
}: UseFileUploadOptions): UseFileUploadReturn {
	const [pendingAttachments, setPendingAttachments] = useState<
		ChatAttachment[]
	>([]);
	const [uploadingCount, setUploadingCount] = useState(0);
	const [uploadError, setUploadError] = useState<string | null>(null);
	const [gitignoreHint, setGitignoreHint] = useState<{
		agent_root: string;
	} | null>(null);

	// Auto-generated session ID for callers that don't have an existing session
	const uploadSessionIdRef = useRef<string | null>(null);

	const uploadFiles = useCallback(
		async (files: FileList | File[]) => {
			const list = Array.from(files);
			if (list.length === 0) return;
			setUploadError(null);

			// Resolve session ID: explicit > auto-generated
			if (!sessionId && !uploadSessionIdRef.current) {
				uploadSessionIdRef.current = uid();
			}
			const resolvedSessionId =
				sessionId ?? uploadSessionIdRef.current ?? uid();

			setUploadingCount((c) => c + list.length);
			try {
				const results = await Promise.allSettled(
					list.map(async (file) => {
						const fd = new FormData();
						fd.append("file", file);
						fd.append("kind", "ephemeral");
						fd.append("session_id", resolvedSessionId);
						if (agentCwd) fd.append("agent_cwd", agentCwd);
						const res = await fetch("/api/attachments/upload", {
							method: "POST",
							body: fd,
						});
						if (!res.ok) {
							let msg = `upload failed (${res.status})`;
							try {
								const body = (await res.json()) as { error?: string };
								if (body.error) msg = body.error;
							} catch {}
							throw new Error(`${file.name}: ${msg}`);
						}
						return (await res.json()) as UploadResponse;
					}),
				);

				const fulfilled = results
					.filter(
						(r): r is PromiseFulfilledResult<UploadResponse> =>
							r.status === "fulfilled",
					)
					.map((r) => r.value);

				// Show gitignore hint once per agent root (can be dismissed)
				const suggestion = fulfilled.find(
					(u) => u.gitignore_suggestion,
				)?.gitignore_suggestion;
				if (suggestion) {
					const dismissKey = `hlid:gitignore-hint:${suggestion.agent_root}`;
					if (
						typeof localStorage !== "undefined" &&
						localStorage.getItem(dismissKey) !== "dismissed"
					) {
						setGitignoreHint({ agent_root: suggestion.agent_root });
					}
				}

				if (fulfilled.length > 0) {
					setPendingAttachments((prev) => [
						...prev,
						...fulfilled.map(
							(u): ChatAttachment => ({
								id: u.id,
								path: u.path,
								filename: u.filename,
								mime: u.mime,
								kind: u.kind,
							}),
						),
					]);
				}

				const failed = results
					.filter((r): r is PromiseRejectedResult => r.status === "rejected")
					.map((r) =>
						r.reason instanceof Error ? r.reason.message : "upload failed",
					);
				if (failed.length > 0) setUploadError(failed.join("; "));
			} catch (err) {
				setUploadError(err instanceof Error ? err.message : "upload failed");
			} finally {
				setUploadingCount((c) => Math.max(0, c - list.length));
			}
		},
		[agentCwd, sessionId],
	);

	const removePending = useCallback((id: string) => {
		setPendingAttachments((prev) => prev.filter((a) => a.id !== id));
	}, []);

	const clearPending = useCallback(() => {
		setPendingAttachments([]);
		setUploadError(null);
	}, []);

	const dismissGitignoreHint = useCallback(() => {
		if (!gitignoreHint) return;
		if (typeof localStorage !== "undefined") {
			localStorage.setItem(
				`hlid:gitignore-hint:${gitignoreHint.agent_root}`,
				"dismissed",
			);
		}
		setGitignoreHint(null);
	}, [gitignoreHint]);

	return {
		pendingAttachments,
		uploadingCount,
		uploadError,
		gitignoreHint,
		uploadSessionIdRef,
		uploadFiles,
		removePending,
		clearPending,
		setPendingAttachments,
		dismissGitignoreHint,
	};
}
