// @vitest-environment jsdom
import { renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ProjectPreviewSnapshot } from "#/lib/serverFns/projectPreviews";

const { getProjectPreviewFn } = vi.hoisted(() => ({
	getProjectPreviewFn: vi.fn(),
}));

vi.mock("#/lib/serverFns/projectPreviews", () => ({
	getProjectPreviewFn,
}));

import { useProjectPreview } from "./projectPreviewStore";

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
});
