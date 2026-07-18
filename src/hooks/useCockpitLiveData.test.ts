// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useWs } from "#/hooks/useWs";
import * as liveStatsStore from "#/hooks/wsLiveStatsStore";
import { getActiveSessionRowFn } from "#/lib/serverFns/sessions";
import {
	getCockpitStatsFn,
	getRecentSessionsFn,
	getThirtyDayStatsFn,
	getWeeklyStatsFn,
} from "#/lib/serverFns/stats";
import type { ServerMessage } from "#/server/protocol";
import { useCockpitLiveData } from "./useCockpitLiveData";

let onMessage: ((message: ServerMessage) => void) | undefined;
let onSessionsStatus: (() => void) | undefined;
let sessionsStatus: Array<{ db_session_id?: string | null }> = [];
let wsStatus: "connecting" | "connected" = "connected";
const wsSend = vi.fn();

vi.mock("#/hooks/useWs", () => ({
	useWs: vi.fn((callback) => {
		onMessage = callback;
		return { send: wsSend, wsStatus };
	}),
}));

vi.mock("#/hooks/wsLiveStatsStore", () => ({
	getPendingSessionToday: vi.fn(),
}));

vi.mock("#/hooks/wsSessionStatusStore", () => ({
	getSessionsStatus: vi.fn(() => sessionsStatus),
	subscribeSessionsStatus: vi.fn((callback: () => void) => {
		onSessionsStatus = callback;
		return vi.fn();
	}),
}));

vi.mock("#/lib/serverFns/sessions", () => ({
	getActiveSessionRowFn: vi.fn(),
}));

vi.mock("#/lib/serverFns/stats", () => ({
	getCockpitStatsFn: vi.fn(),
	getRecentSessionsFn: vi.fn(),
	getThirtyDayStatsFn: vi.fn(),
	getWeeklyStatsFn: vi.fn(),
}));

const initial = {
	recentSessions: [],
	agg: {
		allTime: {
			cost: 0,
			queries: 0,
			sessions: 0,
			input_tokens: 0,
			output_tokens: 0,
			cache_read_tokens: 0,
			cache_creation_tokens: 0,
			turns: 0,
		},
		today: {
			cost: 0,
			queries: 0,
			turns: 0,
			tokens: 0,
			input_tokens: 0,
			output_tokens: 0,
			cache_read_tokens: 0,
			cache_creation_tokens: 0,
		},
		thisMonth: {
			cost: 0,
			queries: 0,
			turns: 0,
			tokens: 0,
			input_tokens: 0,
			output_tokens: 0,
			cache_read_tokens: 0,
			cache_creation_tokens: 0,
		},
	},
	weeklyStats: { total: 0, days: [0, 0, 0, 0, 0, 0, 0] },
	thirtyDayStats: { total: 0, days: [] },
	activeSession: null,
	mcpServers: [],
};

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

beforeEach(() => {
	vi.clearAllMocks();
	onSessionsStatus = undefined;
	sessionsStatus = [];
	wsStatus = "connected";
	vi.mocked(liveStatsStore.getPendingSessionToday).mockReturnValue(false);
	vi.mocked(getActiveSessionRowFn).mockResolvedValue(null);
	vi.mocked(getCockpitStatsFn).mockResolvedValue({ agg: initial.agg });
	vi.mocked(getRecentSessionsFn).mockResolvedValue([]);
	vi.mocked(getThirtyDayStatsFn).mockResolvedValue(initial.thirtyDayStats);
	vi.mocked(getWeeklyStatsFn).mockResolvedValue(initial.weeklyStats);
});

describe("useCockpitLiveData refreshes", () => {
	it("requests the cross-provider MCP inventory for Cockpit", async () => {
		renderHook(() => useCockpitLiveData(initial));
		const connection = vi.mocked(useWs).mock.results.at(-1)?.value;

		await waitFor(() =>
			expect(connection?.send).toHaveBeenCalledWith({
				type: "sync_mcp_list",
				inventory: true,
			}),
		);
	});

	it("requests MCP inventory automatically when the WebSocket connects", async () => {
		wsStatus = "connecting";
		const { rerender } = renderHook(() => useCockpitLiveData(initial));
		expect(wsSend).not.toHaveBeenCalledWith(
			expect.objectContaining({ type: "sync_mcp_list" }),
		);

		wsStatus = "connected";
		rerender();

		await waitFor(() =>
			expect(wsSend).toHaveBeenCalledWith({
				type: "sync_mcp_list",
				inventory: true,
			}),
		);
	});

	it("preserves Claude inventory across Codex-scoped and loader updates", () => {
		const initialData: Parameters<typeof useCockpitLiveData>[0] = initial;
		const { result, rerender } = renderHook(
			({ data }: { data: Parameters<typeof useCockpitLiveData>[0] }) =>
				useCockpitLiveData(data),
			{ initialProps: { data: initialData } },
		);

		act(() =>
			onMessage?.({
				type: "mcp_status",
				inventory: true,
				servers: [
					{
						name: "codex_apps",
						status: "connected",
						provider_id: "codex",
					},
					{
						name: "node_repl",
						status: "connected",
						provider_id: "codex",
					},
					{
						name: "claude.ai Excalidraw",
						status: "connected",
						provider_id: "claude",
						scope: "claudeai",
					},
				],
			}),
		);
		expect(result.current.mcpServers.map((server) => server.name)).toEqual([
			"codex_apps",
			"node_repl",
			"claude.ai Excalidraw",
		]);

		act(() =>
			onMessage?.({
				type: "mcp_status",
				provider_id: "codex",
				servers: [
					{ name: "codex_apps", status: "connected" },
					{ name: "node_repl", status: "connected" },
				],
			}),
		);

		rerender({
			data: {
				...initial,
				mcpServers: [
					{
						name: "codex_apps",
						displayName: "codex_apps",
						source: "global",
						status: "connected",
					},
					{
						name: "node_repl",
						displayName: "node_repl",
						source: "global",
						status: "connected",
					},
				],
			},
		});

		expect(
			result.current.mcpServers.map((server) => server.name).sort(),
		).toEqual(["claude.ai Excalidraw", "codex_apps", "node_repl"]);
	});

	it("ignores an older completion that resolves after a newer refresh", async () => {
		const older = deferred<Awaited<ReturnType<typeof getRecentSessionsFn>>>();
		vi.mocked(getRecentSessionsFn)
			.mockReturnValueOnce(older.promise)
			.mockResolvedValueOnce([
				{ id: "newer", label: "NEWER" } as Awaited<
					ReturnType<typeof getRecentSessionsFn>
				>[number],
			]);
		const { result } = renderHook(() => useCockpitLiveData(initial));

		act(() => onMessage?.({ type: "done" } as ServerMessage));
		act(() => onMessage?.({ type: "done" } as ServerMessage));
		await waitFor(() => expect(result.current.recentRuns[0]?.id).toBe("newer"));
		older.resolve([
			{ id: "older", label: "OLDER" } as Awaited<
				ReturnType<typeof getRecentSessionsFn>
			>[number],
		]);
		await act(async () => await older.promise);

		expect(result.current.recentRuns[0]?.id).toBe("newer");
	});

	it("keeps successful refresh data when another request rejects", async () => {
		vi.mocked(getRecentSessionsFn).mockRejectedValueOnce(new Error("offline"));
		vi.mocked(getCockpitStatsFn).mockResolvedValueOnce({
			agg: {
				...initial.agg,
				allTime: { ...initial.agg.allTime, sessions: 4 },
			},
		});
		const { result } = renderHook(() => useCockpitLiveData(initial));

		act(() => onMessage?.({ type: "done" } as ServerMessage));

		await waitFor(() => expect(result.current.agg.allTime.sessions).toBe(4));
		expect(result.current.recentRuns).toEqual([]);
	});

	it("contains an initial active-session lookup failure", async () => {
		vi.mocked(getActiveSessionRowFn).mockRejectedValueOnce(
			new Error("offline"),
		);
		const { result } = renderHook(() => useCockpitLiveData(initial));
		await act(async () => await Promise.resolve());
		expect(result.current.liveActiveSession).toBeNull();
		expect(useWs).toHaveBeenCalled();
	});

	it("refreshes recent runs when a live session gains a DB session", async () => {
		vi.mocked(getRecentSessionsFn).mockResolvedValueOnce([
			{ id: "codex-run", label: "CODEX RUN" } as Awaited<
				ReturnType<typeof getRecentSessionsFn>
			>[number],
		]);
		const { result } = renderHook(() => useCockpitLiveData(initial));

		sessionsStatus = [{ db_session_id: "codex-run" }];
		act(() => onSessionsStatus?.());

		await waitFor(() =>
			expect(result.current.recentRuns[0]?.id).toBe("codex-run"),
		);
	});
});
