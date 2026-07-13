// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type * as wsStoreModule from "../../hooks/wsStore";

type Snapshot = ReturnType<typeof wsStoreModule.getSnapshot>;
type AggStatus = ReturnType<typeof wsStoreModule.getAggregateNavStatus>;

const snapshot: Snapshot = {
	wsStatus: "connected",
	sessionState: "idle",
	hasPendingPermissions: false,
} as Snapshot;

const agg: AggStatus = {
	state: "idle",
	runningCount: 0,
	pendingPermissions: false,
};

vi.mock("../../hooks/wsStore", () => ({
	subscribeStatus: () => () => {},
	subscribeSessionsStatus: () => () => {},
	getSnapshot: () => snapshot,
	getAggregateNavStatus: () => agg,
	INITIAL_SNAPSHOT: {
		wsStatus: "disconnected",
		sessionState: "idle",
		hasPendingPermissions: false,
	},
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
		runningCount: 0,
		pendingPermissions: false,
		...aggPatch,
	});
}

function dot(): HTMLElement {
	return screen.getByRole("img");
}

afterEach(cleanup);

describe("WsStatusDot", () => {
	it("muted dot while disconnected", () => {
		setState({ wsStatus: "disconnected" } as Partial<Snapshot>);
		render(<WsStatusDot />);
		expect(dot().className).toContain("bg-muted-foreground/25");
		expect(dot().getAttribute("aria-label")).toBe("Connecting to system");
	});

	it("destructive dot on aggregate error", () => {
		setState({}, { state: "error" });
		render(<WsStatusDot />);
		expect(dot().className).toContain("bg-destructive");
		expect(dot().getAttribute("aria-label")).toBe("System error");
	});

	it("warning dot when permissions pending", () => {
		setState({}, { pendingPermissions: true });
		render(<WsStatusDot />);
		expect(dot().className).toContain("bg-status-warning");
		expect(dot().getAttribute("aria-label")).toBe("Waiting for permissions");
	});

	it("primary dot while aggregate running", () => {
		setState({}, { state: "running", runningCount: 2 });
		render(<WsStatusDot />);
		expect(dot().className).toContain("bg-primary");
		expect(dot().getAttribute("aria-label")).toBe("System running");
	});

	it("falls back to single-session state when pool idle", () => {
		setState({ sessionState: "running" } as Partial<Snapshot>);
		render(<WsStatusDot />);
		expect(dot().className).toContain("bg-primary");
		expect(dot().getAttribute("aria-label")).toBe("System running");
	});

	it("falls back to single-session pending permissions", () => {
		setState({ hasPendingPermissions: true } as Partial<Snapshot>);
		render(<WsStatusDot />);
		expect(dot().className).toContain("bg-status-warning");
	});

	it("success dot when connected and idle", () => {
		setState({});
		render(<WsStatusDot />);
		expect(dot().className).toContain("bg-status-success");
		expect(dot().getAttribute("aria-label")).toBe("System connected");
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
