// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionStatusEntry } from "../../server/protocol";
import { ActiveSessionsPanel } from "./ActiveSessionsPanel";

afterEach(cleanup);

const idle: SessionStatusEntry = {
	session_id: "s1aabbcc-1234-5678-90ab-cdef01234567",
	agent_cwd: "/code/proj",
	agent_name: "Proj",
	state: "idle",
	model: "claude-sonnet",
	hasPendingPermissions: false,
	hasDbSession: true,
	db_session_id: null,
};

const running: SessionStatusEntry = {
	session_id: "s2aabbcc-1234-5678-90ab-cdef01234567",
	agent_cwd: "/vault",
	agent_name: "Vault",
	state: "running",
	model: "claude-sonnet",
	hasPendingPermissions: false,
	hasDbSession: true,
	db_session_id: null,
};

const errorSession: SessionStatusEntry = {
	session_id: "s3aabbcc-1234-5678-90ab-cdef01234567",
	agent_cwd: "/code/broken",
	agent_name: "Broken",
	state: "error",
	model: "claude-sonnet",
	hasPendingPermissions: false,
	hasDbSession: true,
	db_session_id: null,
};

/** Vault placeholder: idle + no DB session → should be filtered out. */
const vaultPlaceholder: SessionStatusEntry = {
	session_id: "vault-id",
	agent_cwd: "/vault",
	agent_name: "Vault",
	state: "idle",
	model: "claude-sonnet",
	hasPendingPermissions: false,
	hasDbSession: false,
	db_session_id: null,
};

describe("ActiveSessionsPanel", () => {
	// ── empty state ──────────────────────────────────────────────────────────

	it("shows empty-state message when sessions list is empty", () => {
		render(
			<ActiveSessionsPanel sessions={[]} onStop={vi.fn()} onClose={vi.fn()} />,
		);
		expect(screen.getByText(/no active sessions|all quiet/i)).toBeDefined();
	});

	it("does NOT show empty-state when sessions exist", () => {
		render(
			<ActiveSessionsPanel
				sessions={[idle]}
				onStop={vi.fn()}
				onClose={vi.fn()}
			/>,
		);
		expect(screen.queryByText(/no active sessions|all quiet/i)).toBeNull();
	});

	// ── rendering rows ────────────────────────────────────────────────────────

	it("renders a row for each session", () => {
		render(
			<ActiveSessionsPanel
				sessions={[idle, running]}
				onStop={vi.fn()}
				onClose={vi.fn()}
			/>,
		);
		expect(screen.getByText("Proj")).toBeDefined();
		expect(screen.getByText("Vault")).toBeDefined();
	});

	it("shows agent_cwd in each row", () => {
		render(
			<ActiveSessionsPanel
				sessions={[idle]}
				onStop={vi.fn()}
				onClose={vi.fn()}
			/>,
		);
		// CWD may appear twice (mobile + desktop responsive cells)
		expect(screen.getAllByText("/code/proj").length).toBeGreaterThan(0);
	});

	it("shows state in each row", () => {
		render(
			<ActiveSessionsPanel
				sessions={[idle, running]}
				onStop={vi.fn()}
				onClose={vi.fn()}
			/>,
		);
		expect(screen.getAllByText(/idle/i).length).toBeGreaterThan(0);
		expect(screen.getAllByText(/running/i).length).toBeGreaterThan(0);
	});

	it("shows error state", () => {
		render(
			<ActiveSessionsPanel
				sessions={[errorSession]}
				onStop={vi.fn()}
				onClose={vi.fn()}
			/>,
		);
		expect(screen.getAllByText(/error/i).length).toBeGreaterThan(0);
	});

	// ── STOP button ──────────────────────────────────────────────────────────

	it("STOP button calls onStop with session_id", () => {
		const onStop = vi.fn();
		render(
			<ActiveSessionsPanel
				sessions={[running]}
				onStop={onStop}
				onClose={vi.fn()}
			/>,
		);
		const stopBtn = screen.getByRole("button", { name: /stop s2|stop vault/i });
		fireEvent.click(stopBtn);
		expect(onStop).toHaveBeenCalledWith("s2aabbcc-1234-5678-90ab-cdef01234567");
	});

	it("STOP button is disabled when state is idle", () => {
		render(
			<ActiveSessionsPanel
				sessions={[idle]}
				onStop={vi.fn()}
				onClose={vi.fn()}
			/>,
		);
		const stopBtn = screen.getByRole("button", { name: /stop s1|stop proj/i });
		expect((stopBtn as HTMLButtonElement).disabled).toBe(true);
	});

	it("STOP button is enabled when state is running", () => {
		render(
			<ActiveSessionsPanel
				sessions={[running]}
				onStop={vi.fn()}
				onClose={vi.fn()}
			/>,
		);
		const stopBtn = screen.getByRole("button", { name: /stop s2|stop vault/i });
		expect((stopBtn as HTMLButtonElement).disabled).toBe(false);
	});

	// ── CLOSE button ─────────────────────────────────────────────────────────

	it("CLOSE button requires confirmation before calling onClose", () => {
		const onClose = vi.fn();
		render(
			<ActiveSessionsPanel
				sessions={[idle]}
				onStop={vi.fn()}
				onClose={onClose}
			/>,
		);
		const closeBtn = screen.getByRole("button", {
			name: /close s1|close proj/i,
		});
		fireEvent.click(closeBtn);
		// Close removes the session — a single click must not fire it.
		expect(onClose).not.toHaveBeenCalled();
		fireEvent.click(screen.getByRole("button", { name: "confirm" }));
		expect(onClose).toHaveBeenCalledWith(
			"s1aabbcc-1234-5678-90ab-cdef01234567",
		);
	});

	// ── column headers ────────────────────────────────────────────────────────

	it("renders column headers", () => {
		render(
			<ActiveSessionsPanel
				sessions={[idle]}
				onStop={vi.fn()}
				onClose={vi.fn()}
			/>,
		);
		expect(screen.getByText(/session|agent/i)).toBeDefined();
		expect(screen.getByText(/state/i)).toBeDefined();
	});

	// ── filtering ─────────────────────────────────────────────────────────────

	it("filters out idle sessions with no DB session (vault placeholder)", () => {
		render(
			<ActiveSessionsPanel
				sessions={[vaultPlaceholder]}
				onStop={vi.fn()}
				onClose={vi.fn()}
			/>,
		);
		expect(screen.getByText(/no active sessions|all quiet/i)).toBeDefined();
	});

	it("shows running session even if hasDbSession is false (just started)", () => {
		const justStarted: SessionStatusEntry = {
			...vaultPlaceholder,
			session_id: "just-started-id",
			state: "running",
			hasDbSession: false,
			db_session_id: null,
		};
		render(
			<ActiveSessionsPanel
				sessions={[justStarted]}
				onStop={vi.fn()}
				onClose={vi.fn()}
			/>,
		);
		expect(screen.queryByText(/no active sessions|all quiet/i)).toBeNull();
	});

	it("shows short session ID hash per row", () => {
		render(
			<ActiveSessionsPanel
				sessions={[idle]}
				onStop={vi.fn()}
				onClose={vi.fn()}
			/>,
		);
		// Last 8 hex chars of session UUID (dashes stripped)
		expect(screen.getByText(/#[0-9a-f]{8}/i)).toBeDefined();
	});

	it("shows lastLabel when present", () => {
		const withLabel: SessionStatusEntry = {
			...idle,
			lastLabel: "VAULT TEST 123",
		};
		render(
			<ActiveSessionsPanel
				sessions={[withLabel]}
				onStop={vi.fn()}
				onClose={vi.fn()}
			/>,
		);
		expect(screen.getByText("VAULT TEST 123")).toBeDefined();
	});

	it("does not render label row when lastLabel is absent", () => {
		render(
			<ActiveSessionsPanel
				sessions={[idle]}
				onStop={vi.fn()}
				onClose={vi.fn()}
			/>,
		);
		// idle fixture has no lastLabel — agent_name "Proj" should exist, no label
		expect(screen.getByText("Proj")).toBeDefined();
		expect(screen.queryByText("VAULT TEST 123")).toBeNull();
	});
});
