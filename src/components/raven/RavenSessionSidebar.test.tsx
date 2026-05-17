// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionStatusEntry } from "../../server/protocol";
import { RavenSessionSidebar } from "./RavenSessionSidebar";

afterEach(cleanup);

const idle: SessionStatusEntry = {
	session_id: "s1",
	agent_cwd: "/code/proj",
	agent_name: "Proj",
	state: "idle",
	model: "claude-sonnet",
	hasPendingPermissions: false,
	hasDbSession: true,
	db_session_id: null,
};

const running: SessionStatusEntry = {
	session_id: "s2",
	agent_cwd: "/vault",
	agent_name: "Vault",
	state: "running",
	model: "claude-sonnet",
	hasPendingPermissions: false,
	hasDbSession: true,
	db_session_id: null,
};

const error: SessionStatusEntry = {
	session_id: "s3",
	agent_cwd: "/code/other",
	agent_name: "Other",
	state: "error",
	model: "claude-sonnet",
	hasPendingPermissions: false,
	hasDbSession: true,
	db_session_id: null,
};

const withPerms: SessionStatusEntry = {
	session_id: "s4",
	agent_cwd: "/code/perms",
	agent_name: "Perms",
	state: "running",
	model: "claude-sonnet",
	hasPendingPermissions: true,
	hasDbSession: true,
	db_session_id: null,
};

function defaultProps(
	overrides: Partial<Parameters<typeof RavenSessionSidebar>[0]> = {},
) {
	return {
		sessions: [idle, running],
		subscribedSessionId: "s1",
		onSubscribe: vi.fn(),
		onStop: vi.fn(),
		onClose: vi.fn(),
		onNewSession: vi.fn(),
		isCollapsed: false,
		onToggle: vi.fn(),
		...overrides,
	};
}

describe("RavenSessionSidebar", () => {
	// ── render ──────────────────────────────────────────────────────────────────

	it("renders a row for each session", () => {
		render(<RavenSessionSidebar {...defaultProps()} />);
		expect(screen.getByText("Proj")).toBeDefined();
		expect(screen.getByText("Vault")).toBeDefined();
	});

	it("renders nothing (or collapsed shell) when isCollapsed=true", () => {
		render(<RavenSessionSidebar {...defaultProps({ isCollapsed: true })} />);
		// Session names should NOT be visible
		expect(screen.queryByText("Proj")).toBeNull();
		expect(screen.queryByText("Vault")).toBeNull();
	});

	it("renders New Session button when not collapsed", () => {
		render(<RavenSessionSidebar {...defaultProps()} />);
		expect(screen.getByRole("button", { name: /new session/i })).toBeDefined();
	});

	it("renders toggle button", () => {
		render(<RavenSessionSidebar {...defaultProps()} />);
		expect(
			screen.getByRole("button", { name: /toggle sidebar|collapse|expand/i }),
		).toBeDefined();
	});

	// ── active session highlighting ─────────────────────────────────────────────

	it("active session row has aria-current=true", () => {
		render(
			<RavenSessionSidebar {...defaultProps({ subscribedSessionId: "s1" })} />,
		);
		const activeRow = screen.getByRole("button", { name: "Proj" });
		expect(activeRow.getAttribute("aria-current")).toBe("true");
	});

	it("inactive session row does NOT have aria-current=true", () => {
		render(
			<RavenSessionSidebar {...defaultProps({ subscribedSessionId: "s1" })} />,
		);
		const inactiveRow = screen.getByRole("button", { name: "Vault" });
		expect(inactiveRow.getAttribute("aria-current")).not.toBe("true");
	});

	// ── click to subscribe ────────────────────────────────────────────────────

	it("clicking a session row calls onSubscribe with its session_id", () => {
		const onSubscribe = vi.fn();
		render(<RavenSessionSidebar {...defaultProps({ onSubscribe })} />);
		fireEvent.click(screen.getByRole("button", { name: "Vault" }));
		expect(onSubscribe).toHaveBeenCalledWith("s2");
	});

	it("clicking the active row still calls onSubscribe", () => {
		const onSubscribe = vi.fn();
		render(
			<RavenSessionSidebar
				{...defaultProps({ onSubscribe, subscribedSessionId: "s1" })}
			/>,
		);
		fireEvent.click(screen.getByRole("button", { name: "Proj" }));
		expect(onSubscribe).toHaveBeenCalledWith("s1");
	});

	// ── stop button ──────────────────────────────────────────────────────────

	it("stop button calls onStop with session_id", () => {
		const onStop = vi.fn();
		render(
			<RavenSessionSidebar
				{...defaultProps({ sessions: [running], onStop })}
			/>,
		);
		const stopBtn = screen.getByRole("button", { name: /stop/i });
		fireEvent.click(stopBtn);
		expect(onStop).toHaveBeenCalledWith("s2");
	});

	it("stop button is disabled when session is idle", () => {
		render(<RavenSessionSidebar {...defaultProps({ sessions: [idle] })} />);
		const stopBtn = screen.getByRole("button", { name: /stop/i });
		expect((stopBtn as HTMLButtonElement).disabled).toBe(true);
	});

	it("stop button is enabled when session is running", () => {
		render(<RavenSessionSidebar {...defaultProps({ sessions: [running] })} />);
		const stopBtn = screen.getByRole("button", { name: /stop/i });
		expect((stopBtn as HTMLButtonElement).disabled).toBe(false);
	});

	// ── close button ─────────────────────────────────────────────────────────

	it("close button calls onClose with session_id", () => {
		const onClose = vi.fn();
		render(
			<RavenSessionSidebar {...defaultProps({ sessions: [idle], onClose })} />,
		);
		const closeBtn = screen.getByRole("button", { name: /close/i });
		fireEvent.click(closeBtn);
		expect(onClose).toHaveBeenCalledWith("s1");
	});

	// ── new session ──────────────────────────────────────────────────────────

	it("New Session button calls onNewSession", () => {
		const onNewSession = vi.fn();
		render(<RavenSessionSidebar {...defaultProps({ onNewSession })} />);
		fireEvent.click(screen.getByRole("button", { name: /new session/i }));
		expect(onNewSession).toHaveBeenCalledOnce();
	});

	// ── collapse toggle ──────────────────────────────────────────────────────

	it("toggle button calls onToggle", () => {
		const onToggle = vi.fn();
		render(<RavenSessionSidebar {...defaultProps({ onToggle })} />);
		fireEvent.click(
			screen.getByRole("button", { name: /toggle sidebar|collapse|expand/i }),
		);
		expect(onToggle).toHaveBeenCalledOnce();
	});

	// ── status dots ──────────────────────────────────────────────────────────

	it("running session row has running status indicator", () => {
		render(<RavenSessionSidebar {...defaultProps({ sessions: [running] })} />);
		const dot = screen.getByLabelText(/running/i);
		expect(dot).toBeDefined();
	});

	it("error session row has error status indicator", () => {
		render(<RavenSessionSidebar {...defaultProps({ sessions: [error] })} />);
		const dot = screen.getByLabelText(/error/i);
		expect(dot).toBeDefined();
	});

	it("idle session row has idle status indicator", () => {
		render(<RavenSessionSidebar {...defaultProps({ sessions: [idle] })} />);
		const dot = screen.getByLabelText(/idle/i);
		expect(dot).toBeDefined();
	});

	it("session with pending permissions has permissions indicator", () => {
		render(
			<RavenSessionSidebar {...defaultProps({ sessions: [withPerms] })} />,
		);
		const dot = screen.getByLabelText(/permission/i);
		expect(dot).toBeDefined();
	});

	// ── empty state ──────────────────────────────────────────────────────────

	it("renders with empty sessions list without crashing", () => {
		render(<RavenSessionSidebar {...defaultProps({ sessions: [] })} />);
		// Just ensure it renders without throwing
		expect(
			screen.queryByRole("button", { name: /new session/i }),
		).toBeDefined();
	});

	// ── lastLabel ────────────────────────────────────────────────────────────

	it("shows lastLabel when present", () => {
		const withLabel: SessionStatusEntry = { ...idle, lastLabel: "Fix the bug" };
		render(
			<RavenSessionSidebar {...defaultProps({ sessions: [withLabel] })} />,
		);
		expect(screen.getByText("Fix the bug")).toBeDefined();
	});
});
