// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type * as wsSessionStatusStoreModule from "../../hooks/wsSessionStatusStore";
import type * as wsStoreModule from "../../hooks/wsStore";

type Snapshot = ReturnType<typeof wsStoreModule.getSnapshot>;
type AggStatus = ReturnType<
	typeof wsSessionStatusStoreModule.getAggregateNavStatus
>;

const snapshot: Snapshot = {
	wsStatus: "connected",
	sessionState: "idle",
	hasPendingPermissions: false,
} as Snapshot;

const agg: AggStatus = {
	state: "idle",
	sessionCount: 0,
	runningCount: 0,
	pendingPermissions: false,
	attentionSessionCount: 0,
	needsAttentionCount: 0,
	workingCount: 0,
	queuedCount: 0,
	recentCount: 0,
};

vi.mock("../../hooks/wsStore", () => ({
	subscribeStatus: () => () => {},
	getSnapshot: () => snapshot,
	INITIAL_SNAPSHOT: {
		wsStatus: "disconnected",
		sessionState: "idle",
		hasPendingPermissions: false,
	},
}));

vi.mock("../../hooks/wsSessionStatusStore", () => ({
	subscribeSessionsStatus: () => () => {},
	getAggregateNavStatus: () => agg,
}));

import { sessionEntryDotClass, WsStatusDot } from "./SystemStatusDot";

function setState(snap: Partial<Snapshot>, aggPatch: Partial<AggStatus> = {}) {
	Object.assign(snapshot, {
		wsStatus: "connected",
		sessionState: "idle",
		hasPendingPermissions: false,
		...snap,
	});
	Object.assign(agg, {
		state: "idle",
		sessionCount: 0,
		runningCount: 0,
		pendingPermissions: false,
		attentionSessionCount: 0,
		needsAttentionCount: 0,
		workingCount: 0,
		queuedCount: 0,
		recentCount: 0,
		...aggPatch,
	});
}

function dot(): HTMLElement {
	return screen.getByRole("img");
}

function statusDot(): HTMLElement {
	return screen.getByTestId("system-status-dot");
}

afterEach(cleanup);

describe("WsStatusDot", () => {
	it("muted dot while disconnected", () => {
		setState({ wsStatus: "disconnected" } as Partial<Snapshot>);
		render(<WsStatusDot />);
		expect(statusDot().className).toContain("bg-muted-foreground/25");
		expect(dot().getAttribute("aria-label")).toBe("Connecting to system");
	});

	it("destructive dot on aggregate error", () => {
		setState({}, { state: "error", sessionCount: 1 });
		render(<WsStatusDot />);
		expect(statusDot().className).toContain("bg-destructive");
		expect(dot().getAttribute("aria-label")).toBe("System error");
	});

	it("warning dot when permissions pending", () => {
		setState({}, { pendingPermissions: true, sessionCount: 1 });
		render(<WsStatusDot />);
		expect(statusDot().className).toContain("bg-status-warning");
		expect(dot().getAttribute("aria-label")).toBe("1 session needs attention");
	});

	it("primary dot while aggregate running", () => {
		setState(
			{},
			{
				state: "running",
				sessionCount: 2,
				runningCount: 2,
				attentionSessionCount: 2,
				workingCount: 2,
			},
		);
		render(<WsStatusDot />);
		expect(statusDot().className).toContain("bg-primary");
		expect(dot().getAttribute("aria-label")).toBe("2 sessions working");
		expect(dot().textContent).toBe("2");
	});

	it("falls back to single-session state when the pool snapshot is empty", () => {
		setState({ sessionState: "running" } as Partial<Snapshot>);
		render(<WsStatusDot />);
		expect(statusDot().className).toContain("bg-primary");
		expect(dot().getAttribute("aria-label")).toBe("1 session working");
	});

	it("keeps an authoritative pool idle over a stale focused running state", () => {
		setState({ sessionState: "running" } as Partial<Snapshot>, {
			sessionCount: 1,
		});
		render(<WsStatusDot />);
		expect(statusDot().className).toContain("bg-status-success");
		expect(dot().getAttribute("aria-label")).toBe("System connected");
	});

	it("falls back to single-session permissions when the pool snapshot is empty", () => {
		setState({ hasPendingPermissions: true } as Partial<Snapshot>);
		render(<WsStatusDot />);
		expect(statusDot().className).toContain("bg-status-warning");
	});

	it("success dot when connected and idle", () => {
		setState({});
		render(<WsStatusDot />);
		expect(statusDot().className).toContain("bg-status-success");
		expect(dot().getAttribute("aria-label")).toBe("System connected");
	});

	it("shows the dominant attention count and queue tone", () => {
		setState(
			{},
			{
				sessionCount: 3,
				attentionSessionCount: 3,
				queuedCount: 3,
			},
		);
		render(<WsStatusDot />);
		expect(statusDot().className).toContain("bg-sky-400");
		expect(dot().getAttribute("aria-label")).toBe("3 sessions queued");
		expect(dot().textContent).toBe("3");
	});
});

describe("sessionEntryDotClass", () => {
	const base = {
		state: "idle",
		hasPendingPermissions: false,
	};

	it("covers error, pending, running, and idle states", () => {
		expect(
			sessionEntryDotClass({ ...base, state: "error" } as never),
		).toContain("bg-destructive");
		expect(
			sessionEntryDotClass({
				...base,
				hasPendingPermissions: true,
			} as never),
		).toContain("bg-status-warning");
		expect(
			sessionEntryDotClass({ ...base, state: "running" } as never),
		).toContain("bg-primary");
		expect(sessionEntryDotClass({ ...base } as never)).toContain(
			"bg-muted-foreground/40",
		);
	});
});
