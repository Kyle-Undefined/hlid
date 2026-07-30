import { useEffect, useRef, useState } from "react";
import {
	getProjectPreviewAgentFrameFn,
	type ProjectPreviewAgentFrame,
} from "#/lib/serverFns/projectPreviews";

const AGENT_FRAME_POLL_MS = 1_500;

type AgentFrameState = {
	previewId: string;
	sessionId: string;
	frame: ProjectPreviewAgentFrame | null;
	error: string | null;
};

type AgentFrameCursor = {
	previewId: string;
	sessionId: string;
	frameId: string | null;
};

function ownsPreview(
	value: { previewId: string; sessionId: string },
	previewId: string,
	sessionId: string,
): boolean {
	return value.previewId === previewId && value.sessionId === sessionId;
}

/**
 * Owns the lifecycle and request cursor for the Project Preview agent surface.
 * A completed request schedules the next poll, so a slow response can never
 * overlap another request from the same polling generation.
 */
export function useProjectPreviewAgentFrame({
	enabled,
	previewId,
	sessionId,
}: {
	enabled: boolean;
	previewId: string;
	sessionId: string;
}): {
	frame: ProjectPreviewAgentFrame | null;
	error: string | null;
} {
	const [state, setState] = useState<AgentFrameState>(() => ({
		previewId,
		sessionId,
		frame: null,
		error: null,
	}));
	const cursorRef = useRef<AgentFrameCursor>({
		previewId,
		sessionId,
		frameId: null,
	});
	const requestGenerationRef = useRef(0);

	useEffect(() => {
		requestGenerationRef.current += 1;
		cursorRef.current = {
			previewId,
			sessionId,
			frameId: null,
		};
		setState((current) => {
			if (
				ownsPreview(current, previewId, sessionId) &&
				current.frame === null &&
				current.error === null
			) {
				return current;
			}
			return {
				previewId,
				sessionId,
				frame: null,
				error: null,
			};
		});
	}, [previewId, sessionId]);

	useEffect(() => {
		if (!enabled) return;

		const generation = ++requestGenerationRef.current;
		let disposed = false;
		let timer: number | null = null;

		const isCurrent = () =>
			!disposed && requestGenerationRef.current === generation;

		const poll = async () => {
			const cursor = cursorRef.current;
			const afterFrameId = ownsPreview(cursor, previewId, sessionId)
				? cursor.frameId
				: null;
			try {
				const frame = await getProjectPreviewAgentFrameFn({
					data: {
						sessionId,
						previewId,
						...(afterFrameId ? { afterFrameId } : {}),
					},
				});
				if (!isCurrent()) return;

				const currentCursor = cursorRef.current;
				if (
					!ownsPreview(currentCursor, previewId, sessionId) ||
					currentCursor.frameId !== afterFrameId
				) {
					return;
				}

				if (frame) {
					const isOwnedFrame =
						frame.preview_id === previewId && frame.session_id === sessionId;
					const isNewFrame = frame.frame_id !== currentCursor.frameId;
					if (!isOwnedFrame || !isNewFrame) return;

					cursorRef.current = {
						previewId,
						sessionId,
						frameId: frame.frame_id,
					};
					setState({
						previewId,
						sessionId,
						frame,
						error: null,
					});
				} else {
					setState((current) =>
						ownsPreview(current, previewId, sessionId)
							? { ...current, error: null }
							: current,
					);
				}
			} catch (cause) {
				if (!isCurrent()) return;
				setState((current) =>
					ownsPreview(current, previewId, sessionId)
						? {
								...current,
								error: cause instanceof Error ? cause.message : String(cause),
							}
						: current,
				);
			} finally {
				if (isCurrent()) {
					timer = window.setTimeout(() => {
						void poll();
					}, AGENT_FRAME_POLL_MS);
				}
			}
		};

		void poll();
		return () => {
			disposed = true;
			if (requestGenerationRef.current === generation) {
				requestGenerationRef.current += 1;
			}
			if (timer !== null) window.clearTimeout(timer);
		};
	}, [enabled, previewId, sessionId]);

	if (!ownsPreview(state, previewId, sessionId)) {
		return { frame: null, error: null };
	}
	return { frame: state.frame, error: state.error };
}
