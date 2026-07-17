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

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

function setMobileViewport(): void {
	vi.stubGlobal(
		"matchMedia",
		vi.fn().mockImplementation((query: string) => ({
			matches: false,
			media: query,
			onchange: null,
			addEventListener: vi.fn(),
			removeEventListener: vi.fn(),
			addListener: vi.fn(),
			removeListener: vi.fn(),
			dispatchEvent: vi.fn(() => true),
		})),
	);
}

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

function openSessionActions(): void {
	fireEvent.click(screen.getByRole("button", { name: "Session actions" }));
}

function anchorBelow(element: HTMLElement): void {
	vi.spyOn(element, "getBoundingClientRect").mockReturnValue({
		x: 296,
		y: 100,
		left: 296,
		top: 100,
		right: 340,
		bottom: 144,
		width: 44,
		height: 44,
		toJSON: () => ({}),
	});
}

function openListActions(): void {
	fireEvent.click(
		screen.getAllByRole("button", { name: "More session list actions" })[0],
	);
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
	it("anchors the mobile actions below the tapped overflow button", () => {
		setMobileViewport();
		renderLedger();
		anchorBelow(screen.getByRole("button", { name: "Session actions" }));
		openSessionActions();
		const sheet = screen.getByRole("dialog", { name: "Session actions" });
		expect(sheet.parentElement).toBe(document.body);
		expect(sheet.className).toContain("fixed");
		expect(sheet.style.top).toBe("152px");
		expect(sheet.style.left).toBe("132px");
		const dismiss = screen.getByRole("button", {
			name: "Dismiss session actions",
		});
		expect(dismiss.className).toContain("bg-black/10");
		expect(dismiss.className).not.toContain("backdrop-blur");
	});

	it("navigates to the selected session", () => {
		const props = renderLedger();
		fireEvent.click(screen.getByRole("button", { name: /original name/i }));
		expect(props.onNavigate).toHaveBeenCalledWith("session-1");
	});

	it("renames in the mobile popover with an explicit Save action", () => {
		setMobileViewport();
		const props = renderLedger();
		anchorBelow(screen.getByRole("button", { name: "Session actions" }));
		openSessionActions();
		fireEvent.click(screen.getByRole("button", { name: /rename/i }));
		const sheet = screen.getByRole("dialog", { name: "Rename session" });
		expect(sheet.parentElement).toBe(document.body);
		expect(sheet.style.top).toBe("152px");
		const input = screen.getByRole("textbox", { name: "Session name" });
		fireEvent.change(input, { target: { value: "Mobile name" } });
		fireEvent.click(screen.getByRole("button", { name: "Save" }));
		expect(props.onRename).toHaveBeenCalledWith("session-1", "Mobile name");
		expect(screen.queryByRole("dialog", { name: "Rename session" })).toBeNull();
	});

	it("trims and commits a changed session name", () => {
		const props = renderLedger();
		openSessionActions();
		fireEvent.click(screen.getByRole("button", { name: /rename/i }));
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
		openSessionActions();
		fireEvent.click(screen.getByRole("button", { name: /rename/i }));
		const input = screen.getByRole("textbox", { name: "Session name" });
		fireEvent.change(input, { target: { value } });
		fireEvent.keyDown(input, { key: "Enter" });
		expect(props.onRename).not.toHaveBeenCalled();
	});

	it("cancels rename with Escape without persisting", () => {
		const props = renderLedger();
		openSessionActions();
		fireEvent.click(screen.getByRole("button", { name: /rename/i }));
		const input = screen.getByRole("textbox", { name: "Session name" });
		fireEvent.change(input, { target: { value: "Discard me" } });
		fireEvent.keyDown(input, { key: "Escape" });
		expect(props.onRename).not.toHaveBeenCalled();
		expect(screen.queryByRole("textbox", { name: "Session name" })).toBeNull();
	});

	it("requires confirmation before deleting", () => {
		const props = renderLedger();
		openSessionActions();
		fireEvent.click(screen.getByRole("button", { name: /delete/i }));
		expect(props.onDelete).not.toHaveBeenCalled();
		fireEvent.click(screen.getByRole("button", { name: "Delete" }));
		expect(props.onDelete).toHaveBeenCalledWith("session-1");
	});

	it("renders live values for the active session", () => {
		renderLedger({ activeSessionId: "session-1", liveStats });
		expect(screen.getByText("$2.5000")).toBeDefined();
		expect(screen.getByText("375 tok")).toBeDefined();
	});
});

describe("SessionsLedger header controls", () => {
	const cleanupReferenceTime = 2_000_000_000;
	it("lets the mobile search input fill the bordered row", () => {
		setMobileViewport();
		renderLedger({ onSearchChange: vi.fn() });
		fireEvent.click(screen.getByRole("button", { name: "Search" }));
		const inputs = screen.getAllByRole("textbox", { name: "Search sessions" });
		const input = inputs[inputs.length - 1];
		expect(input.parentElement?.className).toContain("w-full");
		expect(input.className).toContain("flex-1");
		fireEvent.change(input, { target: { value: "Test" } });
		const clearButtons = screen.getAllByRole("button", {
			name: "Clear session search",
		});
		expect(clearButtons[clearButtons.length - 1].className).toContain("w-10");
	});

	it("keeps the mobile secondary-actions backdrop transparent enough to retain context", () => {
		setMobileViewport();
		renderLedger({ onExport: vi.fn() });
		fireEvent.click(screen.getByRole("button", { name: "Filter" }));
		const moreButtons = screen.getAllByRole("button", {
			name: "More session list actions",
		});
		const mobileMoreButton = moreButtons[moreButtons.length - 1];
		anchorBelow(mobileMoreButton);
		fireEvent.click(mobileMoreButton);
		const dismiss = screen.getByRole("button", {
			name: "Dismiss session list actions",
		});
		expect(dismiss.className).toContain("bg-black/10");
		expect(dismiss.className).not.toContain("backdrop-blur");
		const menu = screen.getByText("Maintenance").parentElement?.parentElement;
		expect(menu?.parentElement).toBe(document.body);
		expect(menu?.style.top).toBe("152px");
		expect(menu?.style.left).toBe("20px");
	});

	it("positions filter actions directly above the trigger using their rendered height", () => {
		setMobileViewport();
		renderLedger({ onExport: vi.fn() });
		fireEvent.click(screen.getByRole("button", { name: "Filter" }));
		const moreButtons = screen.getAllByRole("button", {
			name: "More session list actions",
		});
		const mobileMoreButton = moreButtons[moreButtons.length - 1];
		vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
			function (this: HTMLElement) {
				if (this === mobileMoreButton) {
					return {
						x: 296,
						y: 700,
						left: 296,
						top: 700,
						right: 340,
						bottom: 744,
						width: 44,
						height: 44,
						toJSON: () => ({}),
					};
				}
				if (this.getAttribute("aria-label") === "Session list actions") {
					return {
						x: 20,
						y: 0,
						left: 20,
						top: 0,
						right: 340,
						bottom: 140,
						width: 320,
						height: 140,
						toJSON: () => ({}),
					};
				}
				return {
					x: 0,
					y: 0,
					left: 0,
					top: 0,
					right: 0,
					bottom: 0,
					width: 0,
					height: 0,
					toJSON: () => ({}),
				};
			},
		);
		fireEvent.click(mobileMoreButton);

		const menu = screen.getByRole("dialog", { name: "Session list actions" });
		expect(menu.style.top).toBe("552px");
		expect(menu.style.left).toBe("20px");
	});

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
		const onClearFilters = vi.fn();
		renderLedger({
			data: { sessions: [], total: 0 },
			search: "nope",
			onSearchChange,
			onClearFilters,
		});
		expect(screen.getByText(/no sessions match/)).toBeDefined();
		fireEvent.click(screen.getByRole("button", { name: "clear filters" }));
		expect(onClearFilters).toHaveBeenCalledOnce();
	});

	it("filters by agent before model", () => {
		const onAgentFilterChange = vi.fn();
		const onModelFilterChange = vi.fn();
		renderLedger({
			agentFilter: "vault",
			agentOptions: [
				{ value: "vault", label: "Vault" },
				{ value: "/agents/raven", label: "Raven" },
			],
			onAgentFilterChange,
			modelFilter: "claude-sonnet",
			modelOptions: ["claude-sonnet", "claude-opus"],
			onModelFilterChange,
		});

		const controls = screen.getAllByRole("combobox");
		const agentSelect = screen.getByRole("combobox", {
			name: "Filter sessions by agent",
		});
		const modelSelect = screen.getByRole("combobox", {
			name: "Filter sessions by model",
		});
		expect(controls.indexOf(agentSelect)).toBeLessThan(
			controls.indexOf(modelSelect),
		);
		fireEvent.change(agentSelect, { target: { value: "/agents/raven" } });
		fireEvent.change(modelSelect, { target: { value: "claude-opus" } });
		expect(onAgentFilterChange).toHaveBeenCalledWith("/agents/raven");
		expect(onModelFilterChange).toHaveBeenCalledWith("claude-opus");
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
			oldestStartedAt: cleanupReferenceTime - 40 * 86_400,
			cleanupReferenceTime,
		});
		openListActions();
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
		renderLedger({
			oldestStartedAt: cleanupReferenceTime - 3600,
			cleanupReferenceTime,
		});
		expect(
			screen.queryByRole("combobox", { name: "Clean up old sessions" }),
		).toBeNull();
	});

	it("exposes csv and json export actions", () => {
		const onExport = vi.fn();
		renderLedger({ onExport });
		openListActions();
		fireEvent.click(screen.getByRole("button", { name: "CSV" }));
		fireEvent.click(screen.getByRole("button", { name: "JSON" }));
		expect(onExport).toHaveBeenNthCalledWith(1, "csv");
		expect(onExport).toHaveBeenNthCalledWith(2, "json");
	});
});
