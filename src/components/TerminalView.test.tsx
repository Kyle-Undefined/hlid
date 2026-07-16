// @vitest-environment jsdom
/**
 * TerminalView unit tests — TDD.
 *
 * Verifies: WS URL construction, binary frame → terminal.write(),
 * resize → WS send + fitAddon.fit(), active=false → ws.close(),
 * exit/ready control frames.
 */
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TerminalView } from "./TerminalView";

// ── mock @xterm/xterm ─────────────────────────────────────────────────────────

function makeMockTerminal() {
	return {
		open: vi.fn(),
		write: vi.fn(),
		focus: vi.fn(),
		dispose: vi.fn(),
		loadAddon: vi.fn(),
		attachCustomKeyEventHandler: vi.fn(),
		hasSelection: vi.fn(() => false),
		input: vi.fn(),
		onData: vi.fn(),
		options: {},
	};
}

let mockTerminal = makeMockTerminal();

vi.mock("@xterm/xterm", () => ({
	// biome-ignore lint/complexity/useArrowFunction: constructor mock for Vitest 4
	Terminal: vi.fn(function () {
		return mockTerminal;
	}),
}));

// ── mock @xterm/addon-fit ─────────────────────────────────────────────────────

function makeMockFitAddon() {
	return {
		fit: vi.fn(),
		proposeDimensions: vi.fn(() => ({ cols: 80, rows: 24 })),
	};
}

let mockFitAddon = makeMockFitAddon();

vi.mock("@xterm/addon-fit", () => ({
	// biome-ignore lint/complexity/useArrowFunction: constructor mock for Vitest 4
	FitAddon: vi.fn(function () {
		return mockFitAddon;
	}),
}));

// ── mock @xterm/addon-web-links ───────────────────────────────────────────────

let mockWebLinkHandler: ((event: MouseEvent, uri: string) => void) | undefined;
const mockWebLinksAddon = { dispose: vi.fn() };

vi.mock("@xterm/addon-web-links", () => ({
	// biome-ignore lint/complexity/useArrowFunction: constructor mock for Vitest 4
	WebLinksAddon: vi.fn(function (
		handler: (event: MouseEvent, uri: string) => void,
	) {
		mockWebLinkHandler = handler;
		return mockWebLinksAddon;
	}),
}));

// ── mock WebSocket ────────────────────────────────────────────────────────────

function makeMockWs() {
	return {
		send: vi.fn(),
		close: vi.fn(),
		onmessage: null as ((e: MessageEvent) => void) | null,
		onopen: null as (() => void) | null,
		onclose: null as (() => void) | null,
		readyState: 1, // OPEN so that sends work in tests
		binaryType: "arraybuffer",
	};
}

let mockWsInstance = makeMockWs();

// biome-ignore lint/complexity/useArrowFunction: constructor mock for Vitest 4
const WebSocketMock = vi.fn().mockImplementation(function () {
	mockWsInstance = makeMockWs();
	return mockWsInstance;
});
// Expose constants so component can use WebSocket.OPEN etc.
Object.assign(WebSocketMock, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 });
// vi.stubGlobal is not available in this Bun vitest version; assign directly
// biome-ignore lint/suspicious/noExplicitAny: test global override
(globalThis as any).WebSocket = WebSocketMock;

// Also stub ResizeObserver so jsdom doesn't throw
let capturedRoCallback: ((entries: unknown[]) => void) | null = null;
// biome-ignore lint/complexity/useArrowFunction: constructor mock for Vitest 4
const mockResizeObserver = vi.fn().mockImplementation(function (cb) {
	capturedRoCallback = cb;
	return {
		observe: vi.fn(),
		unobserve: vi.fn(),
		disconnect: vi.fn(),
	};
});
// biome-ignore lint/suspicious/noExplicitAny: test global override
(globalThis as any).ResizeObserver = mockResizeObserver;

// ── helpers ───────────────────────────────────────────────────────────────────

function defaultProps(
	overrides: Partial<React.ComponentProps<typeof TerminalView>> = {},
) {
	return {
		sessionId: "sess-abc",
		cwd: "/home/user/project",
		token: "test-token",
		active: true,
		...overrides,
	};
}

function getLastWsUrl(): string {
	const calls = WebSocketMock.mock.calls;
	return calls[calls.length - 1]?.[0] ?? "";
}

function getTerminalKeyHandler(): (event: KeyboardEvent) => boolean {
	const handler = mockTerminal.attachCustomKeyEventHandler.mock.calls[0]?.[0];
	if (!handler) throw new Error("terminal key handler was not attached");
	return handler;
}

function terminalKeyEvent(
	key: string,
	overrides: Partial<KeyboardEvent> = {},
): KeyboardEvent {
	return {
		type: "keydown",
		key,
		ctrlKey: true,
		altKey: false,
		...overrides,
	} as KeyboardEvent;
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe("TerminalView — WS URL construction", () => {
	beforeEach(() => {
		mockTerminal = makeMockTerminal();
		mockFitAddon = makeMockFitAddon();
		WebSocketMock.mockClear();
	});
	afterEach(cleanup);

	it("connects with session_id and cwd params without exposing auth in the URL", () => {
		render(
			<TerminalView sessionId="sess-123" cwd="/home/user/proj" active={true} />,
		);
		const url = getLastWsUrl();
		expect(url).not.toContain("token=");
		expect(url).toContain("session_id=sess-123");
		expect(url).toContain("cwd=");
	});

	it("connects to /ws/terminal path by default", () => {
		render(<TerminalView {...defaultProps()} />);
		const url = getLastWsUrl();
		expect(url).toContain("/ws/terminal");
	});

	it("connects to a custom wsPath when provided", () => {
		render(<TerminalView {...defaultProps({ wsPath: "/ws/shell" })} />);
		const url = getLastWsUrl();
		expect(url).toContain("/ws/shell");
		expect(url).not.toContain("/ws/terminal");
	});
});

describe("TerminalView — terminal data handling", () => {
	beforeEach(() => {
		mockTerminal = makeMockTerminal();
		mockFitAddon = makeMockFitAddon();
		WebSocketMock.mockClear();
		capturedRoCallback = null;
	});
	afterEach(cleanup);

	it("binary WS message → terminal.write() called", () => {
		render(<TerminalView {...defaultProps()} />);

		// Use a raw ArrayBuffer to test the binary code path
		const data = new ArrayBuffer(5);
		act(() => {
			mockWsInstance.onmessage?.({ data } as MessageEvent);
		});

		expect(mockTerminal.write).toHaveBeenCalled();
	});

	it("plain text WS frame falls through to terminal.write()", () => {
		render(<TerminalView {...defaultProps()} />);

		act(() => {
			mockWsInstance.onmessage?.({ data: "raw text" } as MessageEvent);
		});

		expect(mockTerminal.write).toHaveBeenCalledWith("raw text");
	});

	it("{type:'ready'} text frame → terminal.focus() called", () => {
		render(<TerminalView {...defaultProps()} />);

		act(() => {
			mockWsInstance.onmessage?.({
				data: JSON.stringify({ type: "ready" }),
			} as MessageEvent);
		});

		expect(mockTerminal.focus).toHaveBeenCalled();
	});

	it("{type:'exit'} text frame → exit overlay shown", () => {
		render(<TerminalView {...defaultProps()} />);

		act(() => {
			mockWsInstance.onmessage?.({
				data: JSON.stringify({ type: "exit", code: 0 }),
			} as MessageEvent);
		});

		// Look for the exit message text
		expect(screen.getByText(/session ended/i)).toBeDefined();
	});
});

describe("TerminalView — clipboard shortcuts", () => {
	beforeEach(() => {
		mockTerminal = makeMockTerminal();
		mockFitAddon = makeMockFitAddon();
		WebSocketMock.mockClear();
	});
	afterEach(cleanup);

	it("yields selected Ctrl+C to the browser instead of sending SIGINT", () => {
		mockTerminal.hasSelection.mockReturnValue(true);
		render(<TerminalView {...defaultProps()} />);

		expect(getTerminalKeyHandler()(terminalKeyEvent("c"))).toBe(false);
	});

	it("keeps Ctrl+C as SIGINT when the terminal has no selection", () => {
		render(<TerminalView {...defaultProps()} />);

		expect(getTerminalKeyHandler()(terminalKeyEvent("c"))).toBe(true);
	});

	it("yields Ctrl+V to xterm's browser paste handler", () => {
		render(<TerminalView {...defaultProps()} />);

		expect(getTerminalKeyHandler()(terminalKeyEvent("V"))).toBe(false);
	});

	it("does not intercept modified or non-keydown clipboard keys", () => {
		render(<TerminalView {...defaultProps()} />);
		const handler = getTerminalKeyHandler();

		expect(handler(terminalKeyEvent("v", { altKey: true }))).toBe(true);
		expect(handler(terminalKeyEvent("v", { type: "keyup" }))).toBe(true);
	});

	it("clears the complete prompt input on an unmodified Escape", () => {
		render(<TerminalView {...defaultProps()} />);

		expect(
			getTerminalKeyHandler()(
				terminalKeyEvent("Escape", {
					ctrlKey: false,
					shiftKey: false,
					metaKey: false,
				}),
			),
		).toBe(false);
		expect(mockTerminal.input).toHaveBeenCalledWith("\x05\x15", true);
	});

	it("leaves modified Escape combinations to the terminal", () => {
		render(<TerminalView {...defaultProps()} />);

		expect(
			getTerminalKeyHandler()(
				terminalKeyEvent("Escape", { ctrlKey: false, shiftKey: true }),
			),
		).toBe(true);
		expect(mockTerminal.input).not.toHaveBeenCalled();
	});
});

describe("TerminalView — web links", () => {
	beforeEach(() => {
		mockTerminal = makeMockTerminal();
		mockFitAddon = makeMockFitAddon();
		mockWebLinkHandler = undefined;
		WebSocketMock.mockClear();
	});
	afterEach(cleanup);

	it("loads web-link detection into the terminal", () => {
		render(<TerminalView {...defaultProps()} />);

		expect(mockTerminal.loadAddon).toHaveBeenCalledWith(mockWebLinksAddon);
	});

	it("opens detected links in a protected new tab on Ctrl+click", () => {
		const open = vi.spyOn(window, "open").mockImplementation(() => null);
		render(<TerminalView {...defaultProps()} />);

		mockWebLinkHandler?.(
			{ ctrlKey: true, metaKey: false } as MouseEvent,
			"https://example.com/path",
		);

		expect(open).toHaveBeenCalledWith(
			"https://example.com/path",
			"_blank",
			"noopener,noreferrer",
		);
		open.mockRestore();
	});

	it("supports Command+click but ignores an unmodified click", () => {
		const open = vi.spyOn(window, "open").mockImplementation(() => null);
		render(<TerminalView {...defaultProps()} />);

		mockWebLinkHandler?.(
			{ ctrlKey: false, metaKey: false } as MouseEvent,
			"https://example.com/plain",
		);
		mockWebLinkHandler?.(
			{ ctrlKey: false, metaKey: true } as MouseEvent,
			"https://example.com/mac",
		);

		expect(open).toHaveBeenCalledOnce();
		expect(open).toHaveBeenCalledWith(
			"https://example.com/mac",
			"_blank",
			"noopener,noreferrer",
		);
		open.mockRestore();
	});
});

describe("TerminalView — resize handling", () => {
	beforeEach(() => {
		mockTerminal = makeMockTerminal();
		mockFitAddon = makeMockFitAddon();
		WebSocketMock.mockClear();
		capturedRoCallback = null;
	});
	afterEach(cleanup);

	it("ResizeObserver fires → calls fitAddon.fit() + sends resize JSON frame", () => {
		render(<TerminalView {...defaultProps()} />);

		act(() => {
			capturedRoCallback?.([{ contentRect: { width: 800, height: 400 } }]);
		});

		expect(mockFitAddon.fit).toHaveBeenCalled();

		const sentFrames = mockWsInstance.send.mock.calls
			.map((c) => {
				try {
					return JSON.parse(c[0] as string);
				} catch {
					return null;
				}
			})
			.filter(Boolean);
		const resizeFrame = sentFrames.find(
			(f: { type?: string }) => f?.type === "resize",
		);
		expect(resizeFrame).toBeTruthy();
		expect(resizeFrame).toHaveProperty("cols");
		expect(resizeFrame).toHaveProperty("rows");
	});
});

describe("TerminalView — active prop", () => {
	beforeEach(() => {
		mockTerminal = makeMockTerminal();
		mockFitAddon = makeMockFitAddon();
		WebSocketMock.mockClear();
	});
	afterEach(cleanup);

	it("active=false → ws.close() called + terminal.dispose()", () => {
		const { rerender } = render(
			<TerminalView {...defaultProps({ active: true })} />,
		);

		// Capture the ws instance created during mount
		const ws = mockWsInstance;

		rerender(<TerminalView {...defaultProps({ active: false })} />);

		expect(ws.close).toHaveBeenCalled();
		expect(mockTerminal.dispose).toHaveBeenCalled();
	});

	it("active=false without terminateOnDisconnect → no terminate frame sent", () => {
		const { rerender } = render(
			<TerminalView {...defaultProps({ active: true })} />,
		);
		const ws = mockWsInstance;

		rerender(<TerminalView {...defaultProps({ active: false })} />);

		const terminateSent = ws.send.mock.calls.some((c) => {
			try {
				return JSON.parse(c[0] as string)?.type === "terminate";
			} catch {
				return false;
			}
		});
		expect(terminateSent).toBe(false);
		expect(ws.close).toHaveBeenCalled();
	});

	it("active=false with terminateOnDisconnect → sends terminate frame before closing", () => {
		const { rerender } = render(
			<TerminalView
				{...defaultProps({ active: true, terminateOnDisconnect: true })}
			/>,
		);
		const ws = mockWsInstance;

		rerender(
			<TerminalView
				{...defaultProps({ active: false, terminateOnDisconnect: true })}
			/>,
		);

		expect(ws.send).toHaveBeenCalledWith(JSON.stringify({ type: "terminate" }));
		expect(ws.close).toHaveBeenCalled();
	});

	it("unmount with terminateOnDisconnect → sends terminate frame before closing", () => {
		const { unmount } = render(
			<TerminalView
				{...defaultProps({ active: true, terminateOnDisconnect: true })}
			/>,
		);
		const ws = mockWsInstance;

		unmount();

		expect(ws.send).toHaveBeenCalledWith(JSON.stringify({ type: "terminate" }));
		expect(ws.close).toHaveBeenCalled();
	});

	it("unmount without terminateOnDisconnect leaves the server-side PTY alive", () => {
		const { unmount } = render(
			<TerminalView {...defaultProps({ active: true })} />,
		);
		const ws = mockWsInstance;

		unmount();

		const terminateSent = ws.send.mock.calls.some((call) => {
			try {
				return JSON.parse(call[0] as string)?.type === "terminate";
			} catch {
				return false;
			}
		});
		expect(terminateSent).toBe(false);
		expect(ws.close).toHaveBeenCalled();
	});

	it("active=true after false → reconnects with new WS", () => {
		const { rerender } = render(
			<TerminalView {...defaultProps({ active: true })} />,
		);
		rerender(<TerminalView {...defaultProps({ active: false })} />);

		const callsBefore = WebSocketMock.mock.calls.length;
		rerender(<TerminalView {...defaultProps({ active: true })} />);

		expect(WebSocketMock.mock.calls.length).toBeGreaterThan(callsBefore);
	});
});
