// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	getProjectPreviewAgentFrameFn,
	getProjectPreviewAgentFramesFn,
	type ProjectPreviewAgentFrame,
} from "#/lib/serverFns/projectPreviews";
import type { ProjectPreviewAgentFrameWindow } from "#/server/protocol";
import { useProjectPreviewAgentFrame } from "./useProjectPreviewAgentFrame";

vi.mock("#/lib/serverFns/projectPreviews", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("#/lib/serverFns/projectPreviews")>();
	return {
		...actual,
		getProjectPreviewAgentFrameFn: vi.fn(),
		getProjectPreviewAgentFramesFn: vi.fn(),
	};
});

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (cause: unknown) => void;
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, reject, resolve };
}

function frame({
	capturedAt,
	frameId,
	previewId = "preview-a",
	sessionId = "session-a",
}: {
	capturedAt: number;
	frameId: string;
	previewId?: string;
	sessionId?: string;
}): ProjectPreviewAgentFrame {
	return {
		preview_id: previewId,
		session_id: sessionId,
		path: `/${frameId}`,
		viewport: "desktop",
		width: 1440,
		height: 1000,
		full_page: false,
		captured_at: capturedAt,
		mime: "image/png",
		size_bytes: 3,
		image_base64: "AQID",
		frame_id: frameId,
		title: "Preview",
		elements: [],
		console_messages: [],
		failed_requests: [],
	};
}

function frameWindow(
	frames: ProjectPreviewAgentFrame[],
	{
		includeLatest = true,
		previewId = frames.at(-1)?.preview_id ?? "preview-a",
		sessionId = frames.at(-1)?.session_id ?? "session-a",
	}: {
		includeLatest?: boolean;
		previewId?: string;
		sessionId?: string;
	} = {},
): ProjectPreviewAgentFrameWindow {
	return {
		preview_id: previewId,
		session_id: sessionId,
		frames: frames.map((candidate) => ({
			frame_id: candidate.frame_id,
			captured_at: candidate.captured_at,
			path: candidate.path,
			viewport: candidate.viewport,
			width: candidate.width,
			height: candidate.height,
			full_page: candidate.full_page,
			...(candidate.last_action ? { last_action: candidate.last_action } : {}),
		})),
		latest_frame: includeLatest ? (frames.at(-1) ?? null) : null,
	};
}

async function flush(): Promise<void> {
	await act(async () => {
		await Promise.resolve();
	});
}

async function advance(milliseconds: number): Promise<void> {
	await act(async () => {
		await vi.advanceTimersByTimeAsync(milliseconds);
	});
}

beforeEach(() => {
	vi.useFakeTimers();
	vi.mocked(getProjectPreviewAgentFramesFn).mockResolvedValue(frameWindow([]));
	vi.mocked(getProjectPreviewAgentFrameFn).mockResolvedValue(null);
});

afterEach(() => {
	cleanup();
	vi.useRealTimers();
	vi.clearAllMocks();
});

describe("useProjectPreviewAgentFrame", () => {
	it("waits for a slow request to settle before scheduling another poll", async () => {
		const first = deferred<ProjectPreviewAgentFrameWindow>();
		vi.mocked(getProjectPreviewAgentFramesFn)
			.mockReturnValueOnce(first.promise)
			.mockResolvedValue(frameWindow([]));
		renderHook(() =>
			useProjectPreviewAgentFrame({
				enabled: true,
				previewId: "preview-a",
				sessionId: "session-a",
			}),
		);

		expect(getProjectPreviewAgentFramesFn).toHaveBeenCalledOnce();
		await advance(10_000);
		expect(getProjectPreviewAgentFramesFn).toHaveBeenCalledOnce();

		await act(async () => first.resolve(frameWindow([])));
		await advance(1_499);
		expect(getProjectPreviewAgentFramesFn).toHaveBeenCalledOnce();
		await advance(1);
		expect(getProjectPreviewAgentFramesFn).toHaveBeenCalledTimes(2);
	});

	it("clears frame, error, history, and cursor when the Preview is replaced", async () => {
		const firstFrame = frame({ capturedAt: 10, frameId: "frame-a" });
		const replacement = deferred<ProjectPreviewAgentFrameWindow>();
		vi.mocked(getProjectPreviewAgentFramesFn)
			.mockResolvedValueOnce(frameWindow([firstFrame]))
			.mockRejectedValueOnce(new Error("Preview A unavailable"))
			.mockReturnValueOnce(replacement.promise);
		const { result, rerender } = renderHook(
			({ previewId, sessionId }: { previewId: string; sessionId: string }) =>
				useProjectPreviewAgentFrame({ enabled: true, previewId, sessionId }),
			{
				initialProps: {
					previewId: "preview-a",
					sessionId: "session-a",
				},
			},
		);
		await flush();
		expect(result.current.frame?.frame_id).toBe("frame-a");

		await advance(1_500);
		expect(result.current.frame?.frame_id).toBe("frame-a");
		expect(result.current.error).toBe("Preview A unavailable");

		rerender({ previewId: "preview-b", sessionId: "session-b" });
		expect(result.current.frame).toBeNull();
		expect(result.current.error).toBeNull();
		expect(result.current.navigation).toMatchObject({ position: 0, total: 0 });
		expect(getProjectPreviewAgentFramesFn).toHaveBeenLastCalledWith({
			data: {
				previewId: "preview-b",
				sessionId: "session-b",
			},
		});

		const replacementFrame = frame({
			capturedAt: 20,
			frameId: "frame-b",
			previewId: "preview-b",
			sessionId: "session-b",
		});
		await act(async () => replacement.resolve(frameWindow([replacementFrame])));
		expect(result.current.frame?.frame_id).toBe("frame-b");
	});

	it("rejects a late result from an obsolete polling generation", async () => {
		const obsolete = deferred<ProjectPreviewAgentFrameWindow>();
		const current = deferred<ProjectPreviewAgentFrameWindow>();
		vi.mocked(getProjectPreviewAgentFramesFn)
			.mockReturnValueOnce(obsolete.promise)
			.mockReturnValueOnce(current.promise)
			.mockResolvedValue(frameWindow([]));
		const { result, rerender } = renderHook(
			({ enabled }: { enabled: boolean }) =>
				useProjectPreviewAgentFrame({
					enabled,
					previewId: "preview-a",
					sessionId: "session-a",
				}),
			{ initialProps: { enabled: true } },
		);

		rerender({ enabled: false });
		rerender({ enabled: true });
		expect(getProjectPreviewAgentFramesFn).toHaveBeenCalledTimes(2);

		const currentFrame = frame({
			capturedAt: 20,
			frameId: "current-frame",
		});
		await act(async () => current.resolve(frameWindow([currentFrame])));
		expect(result.current.frame?.frame_id).toBe("current-frame");

		const obsoleteFrame = frame({
			capturedAt: 10,
			frameId: "obsolete-frame",
		});
		await act(async () => obsolete.resolve(frameWindow([obsoleteFrame])));
		expect(result.current.frame?.frame_id).toBe("current-frame");

		await advance(1_500);
		expect(getProjectPreviewAgentFramesFn).toHaveBeenLastCalledWith({
			data: {
				previewId: "preview-a",
				sessionId: "session-a",
				afterFrameId: "current-frame",
			},
		});
	});

	it("follows the newest frame even when its capture clock moves backward", async () => {
		const first = frame({ capturedAt: 20, frameId: "frame-a" });
		const second = frame({ capturedAt: 10, frameId: "frame-b" });
		vi.mocked(getProjectPreviewAgentFramesFn)
			.mockResolvedValueOnce(frameWindow([first]))
			.mockResolvedValueOnce(frameWindow([first, second]))
			.mockResolvedValue(
				frameWindow([first, second], { includeLatest: false }),
			);
		const { result } = renderHook(() =>
			useProjectPreviewAgentFrame({
				enabled: true,
				previewId: "preview-a",
				sessionId: "session-a",
			}),
		);

		await flush();
		expect(result.current.frame?.frame_id).toBe("frame-a");

		await advance(1_500);
		expect(getProjectPreviewAgentFramesFn).toHaveBeenLastCalledWith({
			data: {
				previewId: "preview-a",
				sessionId: "session-a",
				afterFrameId: "frame-a",
			},
		});
		expect(result.current.frame?.frame_id).toBe("frame-b");
		expect(result.current.navigation).toMatchObject({ position: 2, total: 2 });
	});

	it("anchors a Raven viewer on the capture that was opened", async () => {
		const first = frame({ capturedAt: 10, frameId: "frame-a" });
		const selected = frame({ capturedAt: 20, frameId: "frame-b" });
		const latest = frame({ capturedAt: 30, frameId: "frame-c" });
		vi.mocked(getProjectPreviewAgentFramesFn).mockResolvedValue(
			frameWindow([first, selected, latest]),
		);
		vi.mocked(getProjectPreviewAgentFrameFn).mockImplementation(
			async (options) => {
				if (!options?.data) {
					throw new Error("Expected Project Preview frame input.");
				}
				const data = options.data as { frameId?: string };
				return (
					[first, selected, latest].find(
						(candidate) => candidate.frame_id === data.frameId,
					) ?? null
				);
			},
		);

		const { result } = renderHook(() =>
			useProjectPreviewAgentFrame({
				enabled: true,
				initialFrameId: selected.frame_id,
				previewId: "preview-a",
				sessionId: "session-a",
			}),
		);
		await flush();

		expect(result.current.frame?.frame_id).toBe(selected.frame_id);
		expect(result.current.navigation).toMatchObject({ position: 2, total: 3 });
		act(() => result.current.navigation.previous?.());
		await flush();
		expect(result.current.frame?.frame_id).toBe(first.frame_id);
	});

	it("does not replace a missing Raven capture with the latest frame", async () => {
		const latest = frame({ capturedAt: 30, frameId: "frame-c" });
		vi.mocked(getProjectPreviewAgentFramesFn).mockResolvedValue(
			frameWindow([latest]),
		);

		const { result } = renderHook(() =>
			useProjectPreviewAgentFrame({
				enabled: true,
				initialFrameId: "missing-frame",
				previewId: "preview-a",
				sessionId: "session-a",
			}),
		);
		await flush();

		expect(result.current.frame).toBeNull();
		expect(result.current.error).toBe(
			"This Preview capture is no longer available.",
		);
	});

	it("pins an older capture until navigation returns to the newest frame", async () => {
		const first = frame({ capturedAt: 10, frameId: "frame-a" });
		const second = frame({ capturedAt: 20, frameId: "frame-b" });
		const third = frame({ capturedAt: 30, frameId: "frame-c" });
		const fourth = frame({ capturedAt: 40, frameId: "frame-d" });
		vi.mocked(getProjectPreviewAgentFramesFn)
			.mockResolvedValueOnce(frameWindow([first, second]))
			.mockResolvedValueOnce(frameWindow([first, second, third]))
			.mockResolvedValueOnce(frameWindow([first, second, third, fourth]));
		vi.mocked(getProjectPreviewAgentFrameFn).mockImplementation(
			async (options) => {
				if (!options?.data) {
					throw new Error("Expected Project Preview frame input.");
				}
				const data = options.data as { frameId?: string };
				return (
					[first, second, third].find(
						(candidate) => candidate.frame_id === data.frameId,
					) ?? null
				);
			},
		);
		const { result } = renderHook(() =>
			useProjectPreviewAgentFrame({
				enabled: true,
				previewId: "preview-a",
				sessionId: "session-a",
			}),
		);
		await flush();
		expect(result.current.frame?.frame_id).toBe("frame-b");

		act(() => result.current.navigation.previous?.());
		await flush();
		expect(result.current.frame?.frame_id).toBe("frame-a");
		expect(result.current.navigation).toMatchObject({ position: 1, total: 2 });

		await advance(1_500);
		expect(result.current.frame?.frame_id).toBe("frame-a");
		expect(result.current.navigation).toMatchObject({ position: 1, total: 3 });

		act(() => result.current.navigation.next?.());
		await flush();
		expect(result.current.frame?.frame_id).toBe("frame-b");
		act(() => result.current.navigation.next?.());
		await flush();
		expect(result.current.frame?.frame_id).toBe("frame-c");

		await advance(1_500);
		expect(result.current.frame?.frame_id).toBe("frame-d");
		expect(result.current.navigation).toMatchObject({ position: 4, total: 4 });
	});

	it("does not apply or reschedule a request after unmount", async () => {
		const pending = deferred<ProjectPreviewAgentFrameWindow>();
		vi.mocked(getProjectPreviewAgentFramesFn).mockReturnValue(pending.promise);
		const { unmount } = renderHook(() =>
			useProjectPreviewAgentFrame({
				enabled: true,
				previewId: "preview-a",
				sessionId: "session-a",
			}),
		);
		expect(getProjectPreviewAgentFramesFn).toHaveBeenCalledOnce();

		unmount();
		await act(async () =>
			pending.resolve(
				frameWindow([frame({ capturedAt: 10, frameId: "late-frame" })]),
			),
		);
		await advance(10_000);
		expect(getProjectPreviewAgentFramesFn).toHaveBeenCalledOnce();
	});
});
