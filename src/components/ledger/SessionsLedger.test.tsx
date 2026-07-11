// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionRow } from "#/db";
import type { LiveStats } from "#/hooks/wsStore";
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
