// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectPreviewSnapshot } from "#/lib/serverFns/projectPreviews";

const { getProjectPreviewFn } = vi.hoisted(() => ({
	getProjectPreviewFn: vi.fn(),
}));

vi.mock("#/lib/serverFns/projectPreviews", () => ({
	getProjectPreviewFn,
}));

import {
	applyProjectPreview,
	clearProjectPreview,
	requestProjectPreviewPresentation,
	useProjectPreview,
	useProjectPreviewPresentationRequest,
	useProjectPreviewUnavailable,
} from "./projectPreviewStore";

const preview: ProjectPreviewSnapshot = {
	id: "preview-1",
	session_id: "session-1",
	label: "Preview",
	command: "bun run dev",
	cwd: "/workspace",
	port: 4173,
	path: "/",
	url: "http://127.0.0.1:4173/",
	relay_url: "/api/project-previews/preview-1/relay/",
	state: "ready",
	present: true,
	started_at: "2026-07-25T00:00:00.000Z",
	expires_at: "2026-07-25T04:00:00.000Z",
	logs: [],
};

beforeEach(() => {
	getProjectPreviewFn.mockReset();
});

describe("useProjectPreview", () => {
	it("rechecks a session after an earlier no-preview result", async () => {
		getProjectPreviewFn
			.mockResolvedValueOnce(null)
			.mockResolvedValueOnce(preview);

		const first = renderHook(() => useProjectPreview("session-1"));
		await waitFor(() => expect(getProjectPreviewFn).toHaveBeenCalledTimes(1));
		expect(first.result.current).toBeNull();
		first.unmount();

		const second = renderHook(() => useProjectPreview("session-1"));
		await waitFor(() => expect(second.result.current).toEqual(preview));
		expect(getProjectPreviewFn).toHaveBeenCalledTimes(2);
	});

	it("clears a cached preview and its presentation request together", () => {
		const sessionId = "clear-preview-session";
		applyProjectPreview({
			...preview,
			id: "clear-preview",
			session_id: sessionId,
		});
		requestProjectPreviewPresentation(sessionId);
		const current = renderHook(() => ({
			preview: useProjectPreview(sessionId),
			presentationRequest: useProjectPreviewPresentationRequest(sessionId),
		}));

		expect(current.result.current.preview?.id).toBe("clear-preview");
		expect(current.result.current.presentationRequest).toBe(1);

		act(() => clearProjectPreview(sessionId));

		expect(current.result.current.preview).toBeNull();
		expect(current.result.current.presentationRequest).toBe(0);
		current.unmount();
	});

	it("clears unavailable and presentation state together", async () => {
		const sessionId = "clear-unavailable-session";
		getProjectPreviewFn.mockResolvedValueOnce(null);
		const current = renderHook(() => ({
			preview: useProjectPreview(sessionId),
			presentationRequest: useProjectPreviewPresentationRequest(sessionId),
			unavailable: useProjectPreviewUnavailable(sessionId),
		}));

		await waitFor(() => expect(current.result.current.unavailable).toBe(true));
		act(() => requestProjectPreviewPresentation(sessionId));
		expect(current.result.current.presentationRequest).toBe(1);

		act(() => clearProjectPreview(sessionId));

		expect(current.result.current.presentationRequest).toBe(0);
		expect(current.result.current.unavailable).toBe(false);
		current.unmount();
	});

	it("does not let an older manager read overwrite an authoritative clear", async () => {
		const sessionId = "stale-manager-read-session";
		let resolveRead:
			| ((value: ProjectPreviewSnapshot | null) => void)
			| undefined;
		getProjectPreviewFn.mockReturnValueOnce(
			new Promise<ProjectPreviewSnapshot | null>((resolve) => {
				resolveRead = resolve;
			}),
		);
		const current = renderHook(() => useProjectPreview(sessionId));

		await waitFor(() => expect(getProjectPreviewFn).toHaveBeenCalledTimes(1));
		act(() => clearProjectPreview(sessionId));
		await act(async () => {
			resolveRead?.({
				...preview,
				id: "stale-preview",
				session_id: sessionId,
			});
			await Promise.resolve();
		});

		expect(current.result.current).toBeNull();
		current.unmount();
	});
});
