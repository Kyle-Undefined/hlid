import { useCallback, useEffect, useRef, useState } from "react";
import {
	getProjectPreviewAgentFrameFn,
	getProjectPreviewAgentFramesFn,
	type ProjectPreviewAgentFrame,
	type ProjectPreviewAgentFrameSummary,
} from "#/lib/serverFns/projectPreviews";

const AGENT_FRAME_POLL_MS = 1_500;

type AgentFrameState = {
	previewId: string;
	sessionId: string;
	frames: ProjectPreviewAgentFrameSummary[];
	frame: ProjectPreviewAgentFrame | null;
	selectedFrameId: string | null;
	error: string | null;
	navigating: boolean;
};

type AgentFrameCursor = {
	previewId: string;
	sessionId: string;
	frameId: string | null;
};

type AgentFrameNavigation = {
	position: number;
	total: number;
	previous?: () => void;
	next?: () => void;
	pending: boolean;
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
	initialFrameId = null,
	previewId,
	sessionId,
}: {
	enabled: boolean;
	initialFrameId?: string | null;
	previewId: string;
	sessionId: string;
}): {
	frame: ProjectPreviewAgentFrame | null;
	error: string | null;
	navigation: AgentFrameNavigation;
} {
	const [state, setState] = useState<AgentFrameState>(() => ({
		previewId,
		sessionId,
		frames: [],
		frame: null,
		selectedFrameId: initialFrameId,
		error: null,
		navigating: false,
	}));
	const framesRef = useRef<ProjectPreviewAgentFrameSummary[]>([]);
	const displayedFrameRef = useRef<ProjectPreviewAgentFrame | null>(null);
	const selectedFrameIdRef = useRef<string | null>(initialFrameId);
	const navigationTargetRef = useRef<string | null>(null);
	const cursorRef = useRef<AgentFrameCursor>({
		previewId,
		sessionId,
		frameId: null,
	});
	const requestGenerationRef = useRef(0);
	const navigationGenerationRef = useRef(0);

	useEffect(() => {
		requestGenerationRef.current += 1;
		navigationGenerationRef.current += 1;
		framesRef.current = [];
		displayedFrameRef.current = null;
		selectedFrameIdRef.current = initialFrameId;
		navigationTargetRef.current = null;
		cursorRef.current = {
			previewId,
			sessionId,
			frameId: null,
		};
		setState({
			previewId,
			sessionId,
			frames: [],
			frame: null,
			selectedFrameId: initialFrameId,
			error: null,
			navigating: false,
		});
	}, [initialFrameId, previewId, sessionId]);

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
				const frameWindow = await getProjectPreviewAgentFramesFn({
					data: {
						sessionId,
						previewId,
						...(afterFrameId ? { afterFrameId } : {}),
					},
				});
				if (!isCurrent()) return;
				if (!frameWindow) {
					throw new Error("Project Preview capture history is unavailable.");
				}

				const currentCursor = cursorRef.current;
				if (
					!ownsPreview(currentCursor, previewId, sessionId) ||
					currentCursor.frameId !== afterFrameId
				) {
					return;
				}

				if (
					frameWindow.preview_id !== previewId ||
					frameWindow.session_id !== sessionId
				) {
					return;
				}
				const latestFrameId = frameWindow.frames.at(-1)?.frame_id ?? null;
				const effectiveSelection =
					navigationTargetRef.current ?? selectedFrameIdRef.current;
				const wasFollowingLatest =
					navigationTargetRef.current === null &&
					(selectedFrameIdRef.current === null ||
						selectedFrameIdRef.current === afterFrameId);
				const selectionRetained = frameWindow.frames.some(
					(summary) => summary.frame_id === effectiveSelection,
				);
				if (
					initialFrameId &&
					effectiveSelection === initialFrameId &&
					!displayedFrameRef.current &&
					!selectionRetained
				) {
					throw new Error("This Preview capture is no longer available.");
				}
				const navigationWasSuperseded =
					navigationTargetRef.current !== null &&
					(!latestFrameId || !selectionRetained);
				if (navigationWasSuperseded) {
					navigationGenerationRef.current += 1;
					navigationTargetRef.current = null;
				}
				framesRef.current = frameWindow.frames;
				cursorRef.current = {
					previewId,
					sessionId,
					frameId: latestFrameId,
				};

				let reloadSelectedFrameId: string | null = null;
				if (!latestFrameId) {
					displayedFrameRef.current = null;
					selectedFrameIdRef.current = null;
					navigationTargetRef.current = null;
					setState((current) =>
						ownsPreview(current, previewId, sessionId)
							? {
									...current,
									frames: [],
									frame: null,
									selectedFrameId: null,
									error: null,
									navigating: false,
								}
							: current,
					);
				} else if (wasFollowingLatest || !selectionRetained) {
					selectedFrameIdRef.current = latestFrameId;
					navigationTargetRef.current = null;
					const latestFrame =
						frameWindow.latest_frame?.frame_id === latestFrameId
							? frameWindow.latest_frame
							: displayedFrameRef.current?.frame_id === latestFrameId
								? displayedFrameRef.current
								: null;
					displayedFrameRef.current = latestFrame;
					if (!latestFrame) reloadSelectedFrameId = latestFrameId;
					setState((current) =>
						ownsPreview(current, previewId, sessionId)
							? {
									...current,
									frames: frameWindow.frames,
									frame: latestFrame,
									selectedFrameId: latestFrameId,
									error: null,
									navigating: navigationWasSuperseded
										? false
										: current.navigating,
								}
							: current,
					);
				} else if (navigationTargetRef.current !== null) {
					setState((current) =>
						ownsPreview(current, previewId, sessionId)
							? { ...current, frames: frameWindow.frames, error: null }
							: current,
					);
				} else if (effectiveSelection) {
					selectedFrameIdRef.current = effectiveSelection;
					const selectedFrame =
						frameWindow.latest_frame?.frame_id === effectiveSelection
							? frameWindow.latest_frame
							: displayedFrameRef.current?.frame_id === effectiveSelection
								? displayedFrameRef.current
								: null;
					displayedFrameRef.current = selectedFrame;
					if (!selectedFrame) reloadSelectedFrameId = effectiveSelection;
					setState((current) =>
						ownsPreview(current, previewId, sessionId)
							? {
									...current,
									frames: frameWindow.frames,
									frame: selectedFrame,
									selectedFrameId: effectiveSelection,
									error: null,
								}
							: current,
					);
				}

				if (reloadSelectedFrameId) {
					const frame = await getProjectPreviewAgentFrameFn({
						data: {
							sessionId,
							previewId,
							frameId: reloadSelectedFrameId,
						},
					});
					if (!isCurrent()) return;
					if (
						!frame ||
						frame.preview_id !== previewId ||
						frame.session_id !== sessionId ||
						frame.frame_id !== selectedFrameIdRef.current
					) {
						throw new Error(
							"The selected Preview capture is no longer available.",
						);
					}
					displayedFrameRef.current = frame;
					setState((current) =>
						ownsPreview(current, previewId, sessionId)
							? { ...current, frame, error: null }
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
	}, [enabled, initialFrameId, previewId, sessionId]);

	const navigate = useCallback(
		async (direction: -1 | 1) => {
			const frames = framesRef.current;
			const selectedFrameId =
				selectedFrameIdRef.current ?? cursorRef.current.frameId;
			const selectedIndex = frames.findIndex(
				(summary) => summary.frame_id === selectedFrameId,
			);
			const target = frames[selectedIndex + direction];
			if (!target) return;
			const generation = ++navigationGenerationRef.current;
			navigationTargetRef.current = target.frame_id;
			setState((current) =>
				ownsPreview(current, previewId, sessionId)
					? { ...current, error: null, navigating: true }
					: current,
			);
			try {
				const frame = await getProjectPreviewAgentFrameFn({
					data: {
						sessionId,
						previewId,
						frameId: target.frame_id,
					},
				});
				if (
					navigationGenerationRef.current !== generation ||
					navigationTargetRef.current !== target.frame_id
				) {
					return;
				}
				if (!frame)
					throw new Error("This Preview capture is no longer available.");
				if (
					frame.preview_id !== previewId ||
					frame.session_id !== sessionId ||
					frame.frame_id !== target.frame_id ||
					!framesRef.current.some(
						(summary) => summary.frame_id === target.frame_id,
					)
				) {
					throw new Error("This Preview capture is no longer available.");
				}
				selectedFrameIdRef.current = target.frame_id;
				navigationTargetRef.current = null;
				displayedFrameRef.current = frame;
				setState((current) =>
					ownsPreview(current, previewId, sessionId)
						? {
								...current,
								frame,
								selectedFrameId: target.frame_id,
								error: null,
								navigating: false,
							}
						: current,
				);
			} catch (cause) {
				if (navigationGenerationRef.current !== generation) return;
				navigationTargetRef.current = null;
				setState((current) =>
					ownsPreview(current, previewId, sessionId)
						? {
								...current,
								error: cause instanceof Error ? cause.message : String(cause),
								navigating: false,
							}
						: current,
				);
			}
		},
		[previewId, sessionId],
	);

	if (!ownsPreview(state, previewId, sessionId)) {
		return {
			frame: null,
			error: null,
			navigation: { position: 0, total: 0, pending: false },
		};
	}
	const selectedIndex = state.frames.findIndex(
		(summary) => summary.frame_id === state.selectedFrameId,
	);
	return {
		frame: state.frame,
		error: state.error,
		navigation: {
			position: selectedIndex >= 0 ? selectedIndex + 1 : 0,
			total: state.frames.length,
			...(selectedIndex > 0 && !state.navigating
				? { previous: () => void navigate(-1) }
				: {}),
			...(selectedIndex >= 0 &&
			selectedIndex < state.frames.length - 1 &&
			!state.navigating
				? { next: () => void navigate(1) }
				: {}),
			pending: state.navigating,
		},
	};
}
