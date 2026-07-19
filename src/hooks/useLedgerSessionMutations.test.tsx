// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { SessionRow } from "#/db";
import { useLedgerSessionMutations } from "./useLedgerSessionMutations";

function session(id: string, label = id): SessionRow {
	return {
		id,
		label,
		started_at: 1,
		ended_at: null,
		model: null,
		total_cost: 0,
		total_input_tokens: 0,
		total_output_tokens: 0,
		total_cache_read_tokens: 0,
		total_cache_creation_tokens: 0,
		query_count: 0,
		total_turns: 0,
	};
}

function dependencies() {
	return {
		deleteSession: vi.fn().mockResolvedValue(undefined),
		renameSession: vi.fn().mockResolvedValue(undefined),
		forkSession: vi.fn().mockResolvedValue(undefined),
		cleanupSessions: vi.fn().mockResolvedValue(undefined),
		navigateToPage: vi.fn(),
		reloadCurrentPage: vi.fn().mockResolvedValue(undefined),
	};
}

describe("useLedgerSessionMutations", () => {
	it("optimistically hides a delete and rolls it back on failure", async () => {
		const deps = dependencies();
		let rejectDelete: (error: Error) => void = () => {};
		deps.deleteSession.mockImplementation(
			() =>
				new Promise<void>((_resolve, reject) => {
					rejectDelete = reject;
				}),
		);
		const { result } = renderHook(() =>
			useLedgerSessionMutations({
				page: 1,
				sessionPage: { sessions: [session("one"), session("two")], total: 2 },
				dependencies: deps,
			}),
		);

		let pending!: Promise<void>;
		act(() => {
			pending = result.current.deleteSession("one");
		});
		expect(result.current.sessionsData.sessions.map(({ id }) => id)).toEqual([
			"two",
		]);

		await act(async () => {
			rejectDelete(new Error("delete failed"));
			await pending;
		});
		expect(result.current.sessionsData.sessions).toHaveLength(2);
		expect(result.current.mutationError).toBe("delete failed");
	});

	it("moves to the previous page after deleting its final row", async () => {
		const deps = dependencies();
		const { result } = renderHook(() =>
			useLedgerSessionMutations({
				page: 3,
				sessionPage: { sessions: [session("last")], total: 41 },
				dependencies: deps,
			}),
		);

		await act(() => result.current.deleteSession("last"));
		expect(deps.navigateToPage).toHaveBeenCalledWith(2);
	});

	it("rolls back a failed rename and exposes the failure", async () => {
		const deps = dependencies();
		deps.renameSession.mockRejectedValue(new Error("rename failed"));
		const { result } = renderHook(() =>
			useLedgerSessionMutations({
				page: 1,
				sessionPage: { sessions: [session("one", "Original")], total: 1 },
				dependencies: deps,
			}),
		);

		await act(() => result.current.renameSession("one", "Changed"));
		expect(result.current.sessionsData.sessions[0]?.label).toBe("Original");
		expect(result.current.mutationError).toBe("rename failed");
	});

	it("re-fetches the current page/filters (not a navigate) after a successful fork", async () => {
		const deps = dependencies();
		const { result } = renderHook(() =>
			useLedgerSessionMutations({
				page: 2,
				sessionPage: { sessions: [session("one")], total: 1 },
				dependencies: deps,
			}),
		);

		await act(() => result.current.forkSession("one"));
		expect(deps.forkSession).toHaveBeenCalledWith("one");
		expect(deps.reloadCurrentPage).toHaveBeenCalledOnce();
		// No URL navigation — a same-page navigate is a no-op under an active
		// filter, which is exactly what hid a freshly forked row before.
		expect(deps.navigateToPage).not.toHaveBeenCalled();
		expect(result.current.mutationError).toBeNull();
	});

	it("auto-dismisses the fork status banner after a few seconds", async () => {
		vi.useFakeTimers();
		try {
			const deps = dependencies();
			const { result } = renderHook(() =>
				useLedgerSessionMutations({
					page: 1,
					sessionPage: { sessions: [session("one")], total: 1 },
					dependencies: deps,
				}),
			);

			await act(() => result.current.forkSession("one"));
			expect(result.current.forkStatus).not.toBeNull();

			await act(async () => {
				vi.advanceTimersByTime(5_000);
			});
			expect(result.current.forkStatus).toBeNull();
		} finally {
			vi.useRealTimers();
		}
	});

	it("dismissForkStatus clears the banner immediately", async () => {
		const deps = dependencies();
		const { result } = renderHook(() =>
			useLedgerSessionMutations({
				page: 1,
				sessionPage: { sessions: [session("one")], total: 1 },
				dependencies: deps,
			}),
		);

		await act(() => result.current.forkSession("one"));
		expect(result.current.forkStatus).not.toBeNull();
		act(() => result.current.dismissForkStatus());
		expect(result.current.forkStatus).toBeNull();
	});

	it("surfaces a fork failure without reloading", async () => {
		const deps = dependencies();
		deps.forkSession.mockRejectedValue(new Error("fork failed"));
		const { result } = renderHook(() =>
			useLedgerSessionMutations({
				page: 1,
				sessionPage: { sessions: [session("one")], total: 1 },
				dependencies: deps,
			}),
		);

		await act(() => result.current.forkSession("one"));
		expect(result.current.mutationError).toBe("fork failed");
		expect(deps.reloadCurrentPage).not.toHaveBeenCalled();
	});

	it("navigates to page one only after cleanup succeeds", async () => {
		const deps = dependencies();
		const { result } = renderHook(() =>
			useLedgerSessionMutations({
				page: 4,
				sessionPage: { sessions: [], total: 0 },
				dependencies: deps,
			}),
		);

		await act(() => result.current.cleanupSessions(30));
		expect(deps.cleanupSessions).toHaveBeenCalledWith(30);
		expect(deps.navigateToPage).toHaveBeenCalledWith(1);
	});

	it("keeps pending optimistic state until the server confirms removal", async () => {
		const deps = dependencies();
		let sessionPage = { sessions: [session("one")], total: 1 };
		const { result, rerender } = renderHook(() =>
			useLedgerSessionMutations({
				page: 1,
				sessionPage,
				dependencies: deps,
			}),
		);

		await act(() => result.current.deleteSession("one"));
		act(() =>
			result.current.reconcile({ sessions: [session("one")], total: 1 }),
		);
		expect(result.current.sessionsData.sessions).toHaveLength(0);
		act(() => result.current.reconcile({ sessions: [], total: 0 }));
		sessionPage = { sessions: [], total: 0 };
		rerender();
		await waitFor(() => expect(result.current.sessionsData.total).toBe(0));
	});
});
