// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionStatusEntry } from "../../server/protocol";
import { ActiveSessionsPanel } from "./ActiveSessionsPanel";

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

function openMobileSessions(): HTMLElement {
	const toggle = screen.getByRole("button", {
		name: /show \d+ live sessions?/i,
	});
	anchorBelow(toggle);
	fireEvent.click(toggle);
	return screen.getByRole("dialog", { name: "Live sessions" });
}

const idle: SessionStatusEntry = {
	session_id: "s1aabbcc-1234-5678-90ab-cdef01234567",
	agent_cwd: "/code/proj",
	agent_name: "Proj",
	state: "idle",
	provider_id: "claude",
	model: "claude-sonnet",
	effort: "medium",
	permission_mode: "default",
	hasPendingPermissions: false,
	hasDbSession: true,
	db_session_id: null,
};

const running: SessionStatusEntry = {
	session_id: "s2aabbcc-1234-5678-90ab-cdef01234567",
	agent_cwd: "/vault",
	agent_name: "Vault",
	state: "running",
	provider_id: "codex",
	model: "claude-sonnet",
	effort: "high",
	permission_mode: "acceptEdits",
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

	it("keeps the desktop session table open by default and lets it collapse", () => {
		render(
			<ActiveSessionsPanel
				sessions={[idle, running]}
				onStop={vi.fn()}
				onClose={vi.fn()}
			/>,
		);

		const toggle = screen.getByRole("button", {
			name: "Hide 2 live sessions",
		});
		expect(toggle.getAttribute("aria-expanded")).toBe("true");
		expect(screen.getByText("Session / Agent")).toBeDefined();

		fireEvent.click(toggle);

		expect(
			screen
				.getByRole("button", { name: "Show 2 live sessions" })
				.getAttribute("aria-expanded"),
		).toBe("false");
		expect(screen.queryByText("Session / Agent")).toBeNull();
		expect(screen.getByText("1 running · 1 idle")).toBeDefined();
	});

	it("moves a resumed live session ahead of sessions that were already running", () => {
		const { rerender } = render(
			<ActiveSessionsPanel
				sessions={[running, idle]}
				onStop={vi.fn()}
				onClose={vi.fn()}
			/>,
		);
		const rowLabels = () =>
			screen
				.getAllByRole("row")
				.slice(1)
				.map((row) => row.textContent);
		expect(rowLabels()[0]).toContain("Vault");

		rerender(
			<ActiveSessionsPanel
				sessions={[running, { ...idle, state: "running" }]}
				onStop={vi.fn()}
				onClose={vi.fn()}
			/>,
		);

		expect(rowLabels()[0]).toContain("Proj");
	});

	it("opens a persisted session from the keyboard", () => {
		const onNavigate = vi.fn();
		render(
			<ActiveSessionsPanel
				sessions={[{ ...idle, db_session_id: "db-session-1" }]}
				onStop={vi.fn()}
				onClose={vi.fn()}
				onNavigate={onNavigate}
			/>,
		);
		const row = screen.getByLabelText("Open Proj session");
		fireEvent.keyDown(row, { key: "Enter" });
		fireEvent.keyDown(row, { key: " " });
		expect(onNavigate).toHaveBeenNthCalledWith(1, "db-session-1");
		expect(onNavigate).toHaveBeenNthCalledWith(2, "db-session-1");
	});

	it("does not open a session when the row click finishes text selection", () => {
		const onNavigate = vi.fn();
		vi.spyOn(window, "getSelection").mockReturnValue({
			toString: () => "claude-sonnet",
		} as Selection);
		render(
			<ActiveSessionsPanel
				sessions={[{ ...idle, db_session_id: "db-session-1" }]}
				onStop={vi.fn()}
				onClose={vi.fn()}
				onNavigate={onNavigate}
			/>,
		);

		fireEvent.click(screen.getByLabelText("Open Proj session"));

		expect(onNavigate).not.toHaveBeenCalled();
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

	it("shows provider, model, effort, and permission configuration", () => {
		render(
			<ActiveSessionsPanel
				sessions={[idle, running]}
				onStop={vi.fn()}
				onClose={vi.fn()}
			/>,
		);
		expect(
			screen.getByText(
				"claude · claude-sonnet · medium effort · default approvals",
			),
		).toBeDefined();
		expect(
			screen.getByText("codex · claude-sonnet · high effort · accept edits"),
		).toBeDefined();
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

	it("CLOSE button closes the session directly from the secondary menu", () => {
		const onClose = vi.fn();
		render(
			<ActiveSessionsPanel
				sessions={[idle]}
				onStop={vi.fn()}
				onClose={onClose}
			/>,
		);
		fireEvent.click(
			screen.getByRole("button", { name: /more actions for proj/i }),
		);
		const closeBtn = screen.getByRole("button", {
			name: /close s1|close proj/i,
		});
		fireEvent.click(closeBtn);
		expect(onClose).toHaveBeenCalledWith(
			"s1aabbcc-1234-5678-90ab-cdef01234567",
		);
		expect(
			screen.queryByRole("dialog", { name: "Active session actions" }),
		).toBeNull();
	});

	it("keeps CLOSE in the secondary menu", () => {
		render(
			<ActiveSessionsPanel
				sessions={[idle]}
				onStop={vi.fn()}
				onClose={vi.fn()}
			/>,
		);
		expect(screen.queryByRole("button", { name: /close proj/i })).toBeNull();
		const more = screen.getByRole("button", { name: /more actions for proj/i });
		fireEvent.click(more);
		const closeBtn = screen.getByRole("button", {
			name: /close s1|close proj/i,
		});
		expect(closeBtn).toBeDefined();
	});

	it("portals desktop actions outside the clipped table", () => {
		render(
			<ActiveSessionsPanel
				sessions={[idle]}
				onStop={vi.fn()}
				onClose={vi.fn()}
			/>,
		);
		anchorBelow(screen.getByRole("button", { name: /more actions for proj/i }));
		fireEvent.click(
			screen.getByRole("button", { name: /more actions for proj/i }),
		);
		const menu = screen.getByRole("dialog", {
			name: "Active session actions",
		});
		expect(menu.parentElement).toBe(document.body);
		expect(menu.className).toContain("fixed");
		expect(menu.style.top).toBe("152px");
		expect(menu.style.left).toBe("164px");
		expect(
			screen.getByRole("button", {
				name: "Dismiss active session actions",
			}).className,
		).toContain("bg-transparent");
	});

	it("anchors mobile actions below the tapped overflow button", () => {
		setMobileViewport();
		render(
			<ActiveSessionsPanel
				sessions={[idle]}
				onStop={vi.fn()}
				onClose={vi.fn()}
			/>,
		);
		openMobileSessions();
		anchorBelow(screen.getByRole("button", { name: /more actions for proj/i }));
		fireEvent.click(
			screen.getByRole("button", { name: /more actions for proj/i }),
		);
		const sheet = screen.getByRole("dialog", {
			name: "Active session actions",
		});
		expect(sheet.parentElement).toBe(document.body);
		expect(sheet.className).toContain("fixed");
		expect(sheet.style.top).toBe("152px");
		expect(sheet.style.left).toBe("132px");
		const dismiss = screen.getByRole("button", {
			name: "Dismiss active session actions",
		});
		expect(dismiss.className).toContain("bg-black/10");
		expect(dismiss.className).not.toContain("backdrop-blur");
	});

	// ── mobile sticky summary ─────────────────────────────────────────────────

	it("collapses mobile sessions into a compact status summary", () => {
		setMobileViewport();
		render(
			<ActiveSessionsPanel
				sessions={[idle, running, errorSession]}
				onStop={vi.fn()}
				onClose={vi.fn()}
			/>,
		);

		const toggle = screen.getByRole("button", {
			name: "Show 3 live sessions",
		});
		expect(toggle.className).toContain("min-h-12");
		expect(screen.getByText("1 running · 1 error · 1 idle")).toBeDefined();
		expect(screen.queryByText("Proj")).toBeNull();
		expect(screen.queryByRole("button", { name: /stop vault/i })).toBeNull();
	});

	it("opens mobile sessions in a capped, internally scrollable sheet", () => {
		setMobileViewport();
		render(
			<ActiveSessionsPanel
				sessions={[idle, running, errorSession]}
				onStop={vi.fn()}
				onClose={vi.fn()}
			/>,
		);

		const sheet = openMobileSessions();
		expect(sheet.parentElement).toBe(document.body);
		expect(sheet.className).toContain("fixed");
		expect(sheet.style.maxHeight).not.toBe("");
		expect(sheet.querySelector(".overflow-y-auto")?.className).toContain(
			"overscroll-contain",
		);
		expect(screen.getByText("Proj")).toBeDefined();
		expect(screen.getByText("Vault")).toBeDefined();
		expect(screen.getByText("Broken")).toBeDefined();
		expect(screen.queryByText("/code/proj")).toBeNull();
		expect(screen.queryByText(/#[0-9a-f]{8}/i)).toBeNull();
	});

	it("closes the mobile sheet when navigating to a session", () => {
		setMobileViewport();
		const onNavigate = vi.fn();
		render(
			<ActiveSessionsPanel
				sessions={[{ ...idle, db_session_id: "db-session-1" }]}
				onStop={vi.fn()}
				onClose={vi.fn()}
				onNavigate={onNavigate}
			/>,
		);

		openMobileSessions();
		fireEvent.click(screen.getByRole("button", { name: "Open Proj session" }));
		expect(onNavigate).toHaveBeenCalledWith("db-session-1");
		expect(screen.queryByRole("dialog", { name: "Live sessions" })).toBeNull();
	});

	it("dismisses the mobile sessions sheet with Escape", () => {
		setMobileViewport();
		render(
			<ActiveSessionsPanel
				sessions={[running]}
				onStop={vi.fn()}
				onClose={vi.fn()}
			/>,
		);

		openMobileSessions();
		fireEvent.keyDown(window, { key: "Escape" });
		expect(screen.queryByRole("dialog", { name: "Live sessions" })).toBeNull();
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
		expect(screen.getByText("Session / Agent")).toBeDefined();
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
