// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	getProjectPreviewAgentFrameFn,
	type ProjectPreviewAgentFrame,
} from "#/lib/serverFns/projectPreviews";
import { useProjectPreviewAgentFrame } from "./useProjectPreviewAgentFrame";

vi.mock("#/lib/serverFns/projectPreviews", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("#/lib/serverFns/projectPreviews")>();
	return {
		...actual,
		getProjectPreviewAgentFrameFn: vi.fn(),
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
});

afterEach(() => {
	cleanup();
	vi.useRealTimers();
	vi.clearAllMocks();
});

describe("useProjectPreviewAgentFrame", () => {
	it("waits for a slow request to settle before scheduling another poll", async () => {
		const first = deferred<ProjectPreviewAgentFrame | null>();
		vi.mocked(getProjectPreviewAgentFrameFn)
			.mockReturnValueOnce(first.promise)
			.mockResolvedValue(null);
		renderHook(() =>
			useProjectPreviewAgentFrame({
				enabled: true,
				previewId: "preview-a",
				sessionId: "session-a",
			}),
		);

		expect(getProjectPreviewAgentFrameFn).toHaveBeenCalledOnce();
		await advance(10_000);
		expect(getProjectPreviewAgentFrameFn).toHaveBeenCalledOnce();

		await act(async () => first.resolve(null));
		await advance(1_499);
		expect(getProjectPreviewAgentFrameFn).toHaveBeenCalledOnce();
		await advance(1);
		expect(getProjectPreviewAgentFrameFn).toHaveBeenCalledTimes(2);
	});

	it("clears frame, error, and cursor when the active preview is replaced", async () => {
		const firstFrame = frame({ capturedAt: 10, frameId: "frame-a" });
		const replacement = deferred<ProjectPreviewAgentFrame | null>();
		vi.mocked(getProjectPreviewAgentFrameFn)
			.mockResolvedValueOnce(firstFrame)
			.mockRejectedValueOnce(new Error("Preview A unavailable"))
			.mockReturnValueOnce(replacement.promise);
		const { result, rerender } = renderHook(
			({ previewId, sessionId }: { previewId: string; sessionId: string }) =>
				useProjectPreviewAgentFrame({
					enabled: true,
					previewId,
					sessionId,
				}),
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
		expect(result.current).toEqual({ frame: null, error: null });
		expect(getProjectPreviewAgentFrameFn).toHaveBeenLastCalledWith({
			data: {
				previewId: "preview-b",
				sessionId: "session-b",
			},
		});

		await act(async () =>
			replacement.resolve(
				frame({
					capturedAt: 20,
					frameId: "frame-b",
					previewId: "preview-b",
					sessionId: "session-b",
				}),
			),
		);
		expect(result.current.frame?.frame_id).toBe("frame-b");
	});

	it("rejects a late result from an obsolete polling generation", async () => {
		const obsolete = deferred<ProjectPreviewAgentFrame | null>();
		const current = deferred<ProjectPreviewAgentFrame | null>();
		vi.mocked(getProjectPreviewAgentFrameFn)
			.mockReturnValueOnce(obsolete.promise)
			.mockReturnValueOnce(current.promise)
			.mockResolvedValue(null);
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
		expect(getProjectPreviewAgentFrameFn).toHaveBeenCalledTimes(2);

		await act(async () =>
			current.resolve(frame({ capturedAt: 20, frameId: "current-frame" })),
		);
		expect(result.current.frame?.frame_id).toBe("current-frame");

		await act(async () =>
			obsolete.resolve(frame({ capturedAt: 10, frameId: "obsolete-frame" })),
		);
		expect(result.current.frame?.frame_id).toBe("current-frame");

		await advance(1_500);
		expect(getProjectPreviewAgentFrameFn).toHaveBeenLastCalledWith({
			data: {
				previewId: "preview-a",
				sessionId: "session-a",
				afterFrameId: "current-frame",
			},
		});
	});

	it("accepts a new frame ID when its capture clock moves backward", async () => {
		vi.mocked(getProjectPreviewAgentFrameFn)
			.mockResolvedValueOnce(frame({ capturedAt: 20, frameId: "frame-a" }))
			.mockResolvedValueOnce(frame({ capturedAt: 10, frameId: "frame-b" }))
			.mockResolvedValue(null);
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
		expect(getProjectPreviewAgentFrameFn).toHaveBeenLastCalledWith({
			data: {
				previewId: "preview-a",
				sessionId: "session-a",
				afterFrameId: "frame-a",
			},
		});
		expect(result.current.frame?.frame_id).toBe("frame-b");
	});

	it("does not apply or reschedule a request after unmount", async () => {
		const pending = deferred<ProjectPreviewAgentFrame | null>();
		vi.mocked(getProjectPreviewAgentFrameFn).mockReturnValue(pending.promise);
		const { unmount } = renderHook(() =>
			useProjectPreviewAgentFrame({
				enabled: true,
				previewId: "preview-a",
				sessionId: "session-a",
			}),
		);
		expect(getProjectPreviewAgentFrameFn).toHaveBeenCalledOnce();

		unmount();
		await act(async () =>
			pending.resolve(frame({ capturedAt: 10, frameId: "late-frame" })),
		);
		await advance(10_000);
		expect(getProjectPreviewAgentFrameFn).toHaveBeenCalledOnce();
	});
});
