import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("#/lib/serverFns/sessions", () => ({
	getSessionToolEventDetailFn: vi.fn(),
}));

import { getSessionToolEventDetailFn } from "#/lib/serverFns/sessions";
import {
	clearToolEventDetailCache,
	loadToolEventDetail,
} from "./toolEventDetailStore";

describe("toolEventDetailStore", () => {
	beforeEach(() => {
		clearToolEventDetailCache();
		vi.clearAllMocks();
	});

	it("deduplicates concurrent reads and keeps resolved detail warm", async () => {
		vi.mocked(getSessionToolEventDetailFn).mockResolvedValue({
			tool_id: "tool-1",
			result_text: "complete",
			is_error: 0,
		});
		const first = loadToolEventDetail("session-1", "tool-1");
		const second = loadToolEventDetail("session-1", "tool-1");
		expect(first).toBe(second);
		expect(await first).toEqual({ result: "complete", isError: false });
		expect(await loadToolEventDetail("session-1", "tool-1")).toEqual({
			result: "complete",
			isError: false,
		});
		expect(getSessionToolEventDetailFn).toHaveBeenCalledTimes(1);
	});

	it("does not cache failed reads and scopes identical tool ids by session", async () => {
		vi.mocked(getSessionToolEventDetailFn)
			.mockResolvedValueOnce(null)
			.mockResolvedValueOnce({
				tool_id: "tool-1",
				result_text: "one",
				is_error: 0,
			})
			.mockResolvedValueOnce({
				tool_id: "tool-1",
				result_text: "two",
				is_error: 1,
			});
		await expect(loadToolEventDetail("session-1", "tool-1")).rejects.toThrow(
			"no longer available",
		);
		expect(await loadToolEventDetail("session-1", "tool-1")).toEqual({
			result: "one",
			isError: false,
		});
		expect(await loadToolEventDetail("session-2", "tool-1")).toEqual({
			result: "two",
			isError: true,
		});
		expect(getSessionToolEventDetailFn).toHaveBeenCalledTimes(3);
	});
});
