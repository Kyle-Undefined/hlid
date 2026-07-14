// @vitest-environment jsdom
import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionRow } from "#/db";
import type { LiveStats } from "#/hooks/wsLiveStatsStore";
import { SessionsLedger, sessionDisplayUsage } from "./SessionsLedger";

afterEach(cleanup);

const session: SessionRow = {
	id: "session-1",
	label: "Original name",
	model: "model",
	started_at: 1_700_000_000,
	ended_at: null,
	query_count: 2,
	total_cost: 1.25,
	total_input_tokens: 100,
	total_output_tokens: 50,
	total_cache_read_tokens: 0,
	total_cache_creation_tokens: 0,
	total_turns: 2,
};

const liveStats: LiveStats = {
	turns: 1,
	cost: 2.5,
	duration_ms: 100,
	input_tokens: 300,
	output_tokens: 75,
	cache_read_tokens: 0,
	cache_creation_tokens: 0,
	context_window: null,
	max_output_tokens: null,
	last_context_used: null,
	last_output_tokens: null,
	queries: 1,
};

function renderLedger(
	overrides: Partial<Parameters<typeof SessionsLedger>[0]> = {},
) {
	const props: Parameters<typeof SessionsLedger>[0] = {
		data: { sessions: [session], total: 1 },
		page: 1,
		pageSize: 20,
		pageSizeOptions: [10, 20, 50],
		totalPages: 1,
		loading: false,
		onPageChange: vi.fn(),
		onPageSizeChange: vi.fn(),
		onDelete: vi.fn(),
		onRename: vi.fn(),
		onNavigate: vi.fn(),
		onCleanup: vi.fn(),
		...overrides,
	};
	render(<SessionsLedger {...props} />);
	return props;
}

describe("sessionDisplayUsage", () => {
	it("uses persisted values for inactive sessions", () => {
		expect(sessionDisplayUsage(session, false, liveStats)).toEqual({
			cost: 1.25,
			tokens: 150,
		});
	});

	it("uses live values only after an active session has a query", () => {
		expect(sessionDisplayUsage(session, true, liveStats)).toEqual({
			cost: 2.5,
			tokens: 375,
		});
		expect(
			sessionDisplayUsage(session, true, { ...liveStats, queries: 0 }),
		).toEqual({ cost: 1.25, tokens: 150 });
	});
});

describe("SessionsLedger session actions", () => {
	it("navigates to the selected session", () => {
		const props = renderLedger();
		fireEvent.click(screen.getByRole("button", { name: /original name/i }));
		expect(props.onNavigate).toHaveBeenCalledWith("session-1");
	});

	it("trims and commits a changed session name", () => {
		const props = renderLedger();
		fireEvent.click(screen.getByRole("button", { name: "Rename session" }));
		const input = screen.getByRole("textbox", { name: "Session name" });
		fireEvent.change(input, { target: { value: "  Updated name  " } });
		fireEvent.keyDown(input, { key: "Enter" });
		expect(props.onRename).toHaveBeenCalledWith("session-1", "Updated name");
		expect(screen.queryByRole("textbox", { name: "Session name" })).toBeNull();
	});

	it.each([
		"Original name",
		"   ",
	])("does not persist the non-change %j", (value) => {
		const props = renderLedger();
		fireEvent.click(screen.getByRole("button", { name: "Rename session" }));
		const input = screen.getByRole("textbox", { name: "Session name" });
		fireEvent.change(input, { target: { value } });
		fireEvent.keyDown(input, { key: "Enter" });
		expect(props.onRename).not.toHaveBeenCalled();
	});

	it("cancels rename with Escape without persisting", () => {
		const props = renderLedger();
		fireEvent.click(screen.getByRole("button", { name: "Rename session" }));
		const input = screen.getByRole("textbox", { name: "Session name" });
		fireEvent.change(input, { target: { value: "Discard me" } });
		fireEvent.keyDown(input, { key: "Escape" });
		expect(props.onRename).not.toHaveBeenCalled();
		expect(screen.queryByRole("textbox", { name: "Session name" })).toBeNull();
	});

	it("requires confirmation before deleting", () => {
		const props = renderLedger();
		fireEvent.click(screen.getByRole("button", { name: "Delete session" }));
		expect(props.onDelete).not.toHaveBeenCalled();
		fireEvent.click(screen.getByRole("button", { name: "delete" }));
		expect(props.onDelete).toHaveBeenCalledWith("session-1");
	});

	it("renders live values for the active session", () => {
		renderLedger({ activeSessionId: "session-1", liveStats });
		expect(screen.getByText("$2.5000")).toBeDefined();
		expect(screen.getByText("375 tok")).toBeDefined();
	});
});

describe("SessionsLedger header controls", () => {
	it("commits search on Enter and clears via the button", () => {
		const onSearchChange = vi.fn();
		renderLedger({ onSearchChange });
		const input = screen.getByRole("textbox", { name: "Search sessions" });
		fireEvent.change(input, { target: { value: "  foo  " } });
		fireEvent.keyDown(input, { key: "Enter" });
		expect(onSearchChange).toHaveBeenCalledWith("foo");
		fireEvent.click(
			screen.getByRole("button", { name: "Clear session search" }),
		);
		expect(onSearchChange).toHaveBeenLastCalledWith("");
	});

	it("commits search live after a typing pause", async () => {
		const onSearchChange = vi.fn();
		renderLedger({ onSearchChange });
		fireEvent.change(screen.getByRole("textbox", { name: "Search sessions" }), {
			target: { value: "foo" },
		});
		await waitFor(() => expect(onSearchChange).toHaveBeenCalledWith("foo"));
	});

	it("does not re-commit stale text when the search is cleared externally", async () => {
		const onSearchChange = vi.fn();
		const { rerender } = (() => {
			const props: Parameters<typeof SessionsLedger>[0] = {
				data: { sessions: [session], total: 1 },
				page: 1,
				pageSize: 20,
				pageSizeOptions: [10, 20, 50],
				totalPages: 1,
				loading: false,
				onPageChange: vi.fn(),
				onPageSizeChange: vi.fn(),
				onDelete: vi.fn(),
				onRename: vi.fn(),
				onNavigate: vi.fn(),
				onCleanup: vi.fn(),
				search: "old",
				onSearchChange,
			};
			const utils = render(<SessionsLedger {...props} />);
			return {
				rerender: (search: string) =>
					utils.rerender(<SessionsLedger {...props} search={search} />),
			};
		})();
		// Committed value cleared elsewhere (e.g. empty-state clear button).
		rerender("");
		const input = screen.getByRole("textbox", {
			name: "Search sessions",
		}) as HTMLInputElement;
		await waitFor(() => expect(input.value).toBe(""));
		// Debounce window passes without the old text being re-committed.
		await new Promise((resolve) => setTimeout(resolve, 400));
		expect(onSearchChange).not.toHaveBeenCalledWith("old");
	});

	it("offers clearing the search from the empty state", () => {
		const onSearchChange = vi.fn();
		renderLedger({
			data: { sessions: [], total: 0 },
			search: "nope",
			onSearchChange,
		});
		expect(screen.getByText(/no sessions match/)).toBeDefined();
		fireEvent.click(screen.getByRole("button", { name: "clear search" }));
		expect(onSearchChange).toHaveBeenCalledWith("");
	});

	it("changes sort through the select", () => {
		const onSortChange = vi.fn();
		renderLedger({ sort: "recent", onSortChange });
		fireEvent.change(screen.getByRole("combobox", { name: "Sort sessions" }), {
			target: { value: "cost" },
		});
		expect(onSortChange).toHaveBeenCalledWith("cost");
	});

	it("drives cleanup options from the oldest session, with confirmation", () => {
		const props = renderLedger({
			// ~40 days old → 7d and 30d cleanups available, 90d hidden.
			oldestStartedAt: Math.floor(Date.now() / 1000) - 40 * 86_400,
		});
		const select = screen.getByRole("combobox", {
			name: "Clean up old sessions",
		});
		const options = Array.from(select.querySelectorAll("option")).map(
			(o) => o.value,
		);
		expect(options).toEqual(["", "7", "30"]);
		fireEvent.change(select, { target: { value: "30" } });
		expect(props.onCleanup).not.toHaveBeenCalled();
		fireEvent.click(screen.getByRole("button", { name: "confirm" }));
		expect(props.onCleanup).toHaveBeenCalledWith(30);
	});

	it("hides cleanup entirely when no sessions are old enough", () => {
		renderLedger({ oldestStartedAt: Math.floor(Date.now() / 1000) - 3600 });
		expect(
			screen.queryByRole("combobox", { name: "Clean up old sessions" }),
		).toBeNull();
	});

	it("exposes csv and json export actions", () => {
		const onExport = vi.fn();
		renderLedger({ onExport });
		fireEvent.click(screen.getByRole("button", { name: "csv" }));
		fireEvent.click(screen.getByRole("button", { name: "json" }));
		expect(onExport).toHaveBeenNthCalledWith(1, "csv");
		expect(onExport).toHaveBeenNthCalledWith(2, "json");
	});
});
