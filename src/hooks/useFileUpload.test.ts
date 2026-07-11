// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useFileUpload } from "./useFileUpload";

const fetchMock = vi.fn<typeof fetch>();

function uploaded(id: string, filename = `${id}.txt`) {
	return Response.json({
		id,
		path: `/tmp/${filename}`,
		filename,
		mime: "text/plain",
		kind: "ephemeral",
		size_bytes: 4,
	});
}

beforeEach(() => {
	fetchMock.mockReset();
	vi.stubGlobal("fetch", fetchMock);
	localStorage.clear();
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("useFileUpload", () => {
	it("uploads through the real form contract and records the attachment", async () => {
		fetchMock.mockResolvedValueOnce(uploaded("a1", "note.txt"));
		const { result } = renderHook(() =>
			useFileUpload({ agentCwd: "/repo", sessionId: "session-1" }),
		);
		await act(() =>
			result.current.uploadFiles([new File(["note"], "note.txt")]),
		);

		expect(result.current.uploadingCount).toBe(0);
		expect(result.current.uploadError).toBeNull();
		expect(result.current.pendingAttachments).toEqual([
			expect.objectContaining({ id: "a1", filename: "note.txt" }),
		]);
		const [, init] = fetchMock.mock.calls[0];
		const body = init?.body as FormData;
		expect(body.get("kind")).toBe("ephemeral");
		expect(body.get("session_id")).toBe("session-1");
		expect(body.get("agent_cwd")).toBe("/repo");
	});

	it("keeps successful files and surfaces failed files in one batch", async () => {
		fetchMock
			.mockResolvedValueOnce(uploaded("good"))
			.mockResolvedValueOnce(
				Response.json({ error: "type not allowed" }, { status: 415 }),
			);
		const { result } = renderHook(() => useFileUpload({ sessionId: "s1" }));
		await act(() =>
			result.current.uploadFiles([
				new File(["ok"], "good.txt"),
				new File(["bad"], "bad.exe"),
			]),
		);
		expect(result.current.pendingAttachments).toHaveLength(1);
		expect(result.current.uploadError).toBe("bad.exe: type not allowed");
		expect(result.current.uploadingCount).toBe(0);
	});

	it("reuses one generated session id until the caller sends", async () => {
		fetchMock
			.mockResolvedValueOnce(uploaded("one"))
			.mockResolvedValueOnce(uploaded("two"));
		const { result } = renderHook(() => useFileUpload({}));
		await act(() => result.current.uploadFiles([new File(["1"], "one.txt")]));
		const generated = result.current.uploadSessionIdRef.current;
		await act(() => result.current.uploadFiles([new File(["2"], "two.txt")]));
		expect(generated).toBeTruthy();
		for (const [, init] of fetchMock.mock.calls) {
			expect((init?.body as FormData).get("session_id")).toBe(generated);
		}
	});

	it("shows and persistently dismisses a gitignore suggestion", async () => {
		fetchMock.mockResolvedValueOnce(
			Response.json({
				id: "a1",
				path: "/repo/.hlid/attachments/a.txt",
				filename: "a.txt",
				mime: "text/plain",
				kind: "ephemeral",
				size_bytes: 1,
				gitignore_suggestion: { agent_root: "/repo" },
			}),
		);
		const { result } = renderHook(() => useFileUpload({ sessionId: "s1" }));
		await act(() => result.current.uploadFiles([new File(["a"], "a.txt")]));
		await waitFor(() =>
			expect(result.current.gitignoreHint).toEqual({ agent_root: "/repo" }),
		);
		act(() => result.current.dismissGitignoreHint());
		expect(result.current.gitignoreHint).toBeNull();
		expect(localStorage.getItem("hlid:gitignore-hint:/repo")).toBe("dismissed");
	});
});
