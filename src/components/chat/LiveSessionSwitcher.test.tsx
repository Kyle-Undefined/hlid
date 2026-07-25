// @vitest-environment jsdom
import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
	within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	replaceSessionsStatus,
	resetSessionStatusForTesting,
} from "#/hooks/wsSessionStatusStore";
import type { SessionStatusEntry } from "#/server/protocol";
import { LiveSessionSwitcher, LiveSessionToggle } from "./LiveSessionSwitcher";

function session(
	id: string,
	overrides: Partial<SessionStatusEntry> = {},
): SessionStatusEntry {
	return {
		session_id: `pool-${id}`,
		agent_cwd: `/work/${id}`,
		agent_name: `${id} agent`,
		state: "idle",
		provider_id: "claude",
		model: "sonnet",
		hasPendingPermissions: false,
		hasDbSession: true,
		db_session_id: `chat-${id}`,
		lastLabel: id,
		...overrides,
	};
}

function renderSwitcher(
	currentSessionId = "chat-ready",
	options: { hotkey?: string; voiceHotkey?: string } = {},
) {
	const onSelectSession = vi.fn();
	const onOpenLedger = vi.fn();
	const result = render(
		<LiveSessionSwitcher
			currentSessionId={currentSessionId}
			hotkey={options.hotkey ?? "Alt+Shift+KeyS"}
			voiceHotkey={options.voiceHotkey}
			onSelectSession={onSelectSession}
			onOpenLedger={onOpenLedger}
		>
			<LiveSessionToggle />
		</LiveSessionSwitcher>,
	);
	return { ...result, onSelectSession, onOpenLedger };
}

function sessionButtons(): HTMLButtonElement[] {
	return screen
		.getAllByRole("button")
		.filter((button) =>
			/^Open .+ session$/.test(button.getAttribute("aria-label") ?? ""),
		) as HTMLButtonElement[];
}

beforeEach(() => {
	resetSessionStatusForTesting();
});

afterEach(() => {
	cleanup();
	resetSessionStatusForTesting();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe("LiveSessionSwitcher", () => {
	it("shows only real live chats ordered by attention with compact context", () => {
		replaceSessionsStatus([
			session("placeholder", {
				hasDbSession: false,
				db_session_id: null,
			}),
			session("ready"),
			session("working", {
				state: "running",
				provider_id: "codex",
				model: "gpt-5.6-sol",
			}),
			session("approval", {
				state: "running",
				hasPendingPermissions: true,
			}),
			session("error", { state: "error" }),
		]);
		const { onSelectSession } = renderSwitcher();

		const toggle = screen.getByRole("button", {
			name: "Open live sessions, 4 total, attention needed",
		});
		expect(toggle.textContent).toContain("›");
		expect(toggle.title).toBe("Live sessions (Alt + Shift + S)");
		expect(toggle.className).toContain("relative");
		expect(toggle.className).not.toContain("absolute");
		fireEvent.click(toggle);

		expect(screen.getByRole("dialog", { name: "Live sessions" })).toBeTruthy();
		const close = screen.getByRole("button", {
			name: "Close live sessions, 4 total, attention needed",
		});
		expect(close.textContent).toBe("‹");
		expect(close.previousElementSibling?.className).toContain("w-10");
		expect(close.parentElement).toBe(
			screen.getByRole("button", { name: "Open Ledger" }).parentElement,
		);
		const rows = sessionButtons();
		expect(rows.map((row) => row.getAttribute("aria-label"))).toEqual([
			"Open approval session",
			"Open error session",
			"Open working session",
			"Open ready session",
		]);
		expect(rows.map((row) => row.textContent)).toEqual([
			expect.stringContaining("Approval"),
			expect.stringContaining("Error"),
			expect.stringContaining("Working"),
			expect.stringContaining("Ready"),
		]);
		expect(rows[2].textContent).toContain("codex · gpt-5.6-sol");
		expect(rows[3].getAttribute("aria-current")).toBe("page");
		expect(within(rows[3]).getByText("Current")).not.toBeNull();
		expect(within(rows[3]).getByText("Ready")).not.toBeNull();

		fireEvent.click(rows[2]);
		expect(onSelectSession).toHaveBeenCalledWith("chat-working", false);
		expect(screen.queryByRole("dialog", { name: "Live sessions" })).toBeNull();
	});

	it("toggles from the configured desktop hotkey unless voice owns it", () => {
		replaceSessionsStatus([session("ready")]);
		renderSwitcher();

		fireEvent.keyDown(window, {
			altKey: true,
			shiftKey: true,
			code: "KeyS",
		});
		expect(screen.getByRole("dialog", { name: "Live sessions" })).toBeTruthy();
		fireEvent.keyDown(window, {
			altKey: true,
			shiftKey: true,
			code: "KeyS",
		});
		expect(screen.queryByRole("dialog", { name: "Live sessions" })).toBeNull();

		cleanup();
		renderSwitcher("chat-ready", {
			voiceHotkey: "Alt+Shift+KeyS",
		});
		fireEvent.keyDown(window, {
			altKey: true,
			shiftKey: true,
			code: "KeyS",
		});
		expect(screen.queryByRole("dialog", { name: "Live sessions" })).toBeNull();
	});

	it("updates attention groups and row order while open", () => {
		replaceSessionsStatus([
			session("alpha", { state: "running" }),
			session("beta"),
		]);
		renderSwitcher();
		fireEvent.click(
			screen.getByRole("button", {
				name: "Open live sessions, 2 total, work in progress",
			}),
		);
		expect(sessionButtons().map((row) => row.textContent)).toEqual([
			expect.stringContaining("alpha"),
			expect.stringContaining("beta"),
		]);

		act(() => {
			replaceSessionsStatus([
				session("alpha"),
				session("beta", { state: "running" }),
			]);
		});
		const updatedRows = sessionButtons();
		expect(updatedRows.map((row) => row.textContent)).toEqual([
			expect.stringContaining("beta"),
			expect.stringContaining("alpha"),
		]);
		expect(updatedRows[0].textContent).toContain("Working");
		expect(updatedRows[1].textContent).toContain("Ready");
		expect(screen.getByText("Working", { selector: "div" })).not.toBeNull();
		expect(screen.getByText("Recent", { selector: "div" })).not.toBeNull();
	});

	it("keeps pins inside attention groups and shows compact provenance", () => {
		replaceSessionsStatus([
			session("ready", {
				lastLabel: "Review",
				agent_cwd: "/work/alpha",
			}),
			session("pinned", {
				lastLabel: "Review",
				agent_cwd: "/work/beta",
				pinned: true,
				fork_parent_session_id: "source",
				fork_parent_label: "Original",
				fork_kind: "exact",
			}),
			session("urgent", {
				state: "error",
				lastLabel: "Urgent",
			}),
		]);
		renderSwitcher();
		fireEvent.click(
			screen.getByRole("button", {
				name: "Open live sessions, 3 total, attention needed",
			}),
		);

		const rows = sessionButtons();
		expect(rows.map((row) => row.getAttribute("aria-label"))).toEqual([
			"Open Urgent session",
			"Open Review session",
			"Open Review session",
		]);
		expect(rows[1].textContent).toContain("Pinned");
		expect(rows[1].textContent).toContain("beta · claude · sonnet");
		expect(rows[1].textContent).toContain("Fork of Original");
		expect(rows[2].textContent).toContain("alpha · claude · sonnet");
	});

	it("retains a closed row until the drawer closes", () => {
		replaceSessionsStatus([session("closing"), session("ready")]);
		renderSwitcher();
		fireEvent.click(
			screen.getByRole("button", {
				name: "Open live sessions, 2 total, all ready",
			}),
		);

		act(() => replaceSessionsStatus([session("ready")]));

		const closed = screen.getByRole("button", {
			name: "Open closing session",
		}) as HTMLButtonElement;
		expect(closed.disabled).toBe(true);
		expect(closed.textContent).toContain("Closed");

		fireEvent.keyDown(window, { key: "Escape" });
		fireEvent.click(
			screen.getByRole("button", {
				name: "Open live sessions, 1 total, all ready",
			}),
		);
		expect(
			screen.queryByRole("button", { name: "Open closing session" }),
		).toBeNull();
	});

	it("dismisses from the scrim and keeps lifecycle controls in Ledger", () => {
		replaceSessionsStatus([session("ready")]);
		const { onOpenLedger } = renderSwitcher();
		fireEvent.click(
			screen.getByRole("button", {
				name: "Open live sessions, 1 total, all ready",
			}),
		);
		expect(screen.queryByText(/^stop$/i)).toBeNull();
		expect(screen.queryByText(/^archive$/i)).toBeNull();

		fireEvent.click(screen.getByRole("button", { name: "Open Ledger" }));
		expect(onOpenLedger).toHaveBeenCalledWith(false);

		fireEvent.click(
			screen.getByRole("button", {
				name: "Open live sessions, 1 total, all ready",
			}),
		);
		fireEvent.click(
			screen.getByRole("button", { name: "Dismiss live sessions" }),
		);
		expect(screen.queryByRole("dialog", { name: "Live sessions" })).toBeNull();
	});

	it("uses mobile history for Back and replaces that marker on selection", () => {
		vi.stubGlobal(
			"matchMedia",
			vi.fn(() => ({
				matches: false,
				addEventListener: vi.fn(),
				removeEventListener: vi.fn(),
			})),
		);
		const pushState = vi.spyOn(window.history, "pushState");
		const replaceState = vi.spyOn(window.history, "replaceState");
		const back = vi.spyOn(window.history, "back").mockImplementation(() => {});
		replaceSessionsStatus([session("mobile")]);
		const { onSelectSession } = renderSwitcher("chat-other");
		const composer = document.createElement("textarea");
		document.body.append(composer);
		composer.focus();

		fireEvent.keyDown(window, {
			altKey: true,
			shiftKey: true,
			code: "KeyS",
		});
		expect(screen.queryByRole("dialog", { name: "Live sessions" })).toBeNull();

		fireEvent.click(
			screen.getByRole("button", {
				name: "Open live sessions, 1 total, all ready",
			}),
		);
		expect(pushState).toHaveBeenCalled();
		expect(document.activeElement).not.toBe(composer);
		const drawer = screen.getByRole("dialog", { name: "Live sessions" });
		expect(drawer.className).toContain("w-[88vw]");
		expect(
			within(drawer).getByRole("button", { name: "Open Ledger" }).parentElement
				?.className,
		).toContain("safe-area-inset-bottom");

		fireEvent.click(
			within(drawer).getByRole("button", { name: "Open mobile session" }),
		);
		expect(replaceState).toHaveBeenCalled();
		expect(onSelectSession).toHaveBeenCalledWith("chat-mobile", true);
		expect(back).not.toHaveBeenCalled();

		fireEvent.click(
			screen.getByRole("button", {
				name: "Open live sessions, 1 total, all ready",
			}),
		);
		act(() => window.dispatchEvent(new PopStateEvent("popstate")));
		expect(screen.queryByRole("dialog", { name: "Live sessions" })).toBeNull();
	});
});
