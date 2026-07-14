/**
 * TerminalView — renders a PTY session inside an xterm.js terminal.
 *
 * Connects to `wsPath` (default /ws/terminal, the claude CLI PTY — pass
 * /ws/shell for a real login shell) and bridges:
 *   WS binary frames → terminal.write()  (PTY output → render)
 *   terminal input   → WS binary frames  (keystrokes → PTY stdin)
 *   ResizeObserver   → WS resize frame + fitAddon.fit()
 *
 * The PTY process stays alive server-side even when active=false, so
 * switching away and returning replays the ring buffer.
 */
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { useEffect, useRef, useState } from "react";
import { TerminalExitedOverlay } from "./TerminalExitedOverlay";

/**
 * Builds the /ws/terminal URL. Same-origin (proxy routes to backend) under
 * HTTPS; explicit backend port (frontend port + 1) in plain HTTP dev mode.
 */
function buildTerminalWsUrl(
	wsPath: string,
	sessionId: string,
	cwd: string,
	cols: number,
	rows: number,
): URL {
	const wsProto = location.protocol === "https:" ? "wss:" : "ws:";
	const wsBase =
		location.protocol === "https:"
			? `${wsProto}//${location.host}${wsPath}`
			: `${wsProto}//${location.hostname}:${Number(location.port) + 1}${wsPath}`;
	const url = new URL(wsBase);
	url.searchParams.set("session_id", sessionId);
	url.searchParams.set("cwd", cwd);
	url.searchParams.set("cols", String(cols));
	url.searchParams.set("rows", String(rows));
	return url;
}

/** Closes a PTY WS, sending {type:"terminate"} first when the ref says to. */
function closeWs(
	ws: WebSocket | null,
	terminateOnDisconnectRef: { current: boolean },
): void {
	if (
		terminateOnDisconnectRef.current &&
		ws &&
		ws.readyState === WebSocket.OPEN
	) {
		ws.send(JSON.stringify({ type: "terminate" }));
	}
	ws?.close();
}

export interface TerminalViewProps {
	sessionId: string;
	cwd: string;
	active: boolean;
	/** WS route to connect to. Defaults to /ws/terminal (the claude CLI PTY). */
	wsPath?: string;
	/**
	 * Send {type:"terminate"} before closing so the server kills the PTY
	 * immediately instead of idling out. Used when this mount's unmount means
	 * the user explicitly closed the session (e.g. the Raven dev-terminal
	 * toggle) — not for a routine active=false pause where the PTY should
	 * keep running server-side (e.g. switching Chat/Terminal tabs).
	 */
	terminateOnDisconnect?: boolean;
	/** Called when the user wants to start a new terminal session after the current one exits. */
	onNewSession?: () => void;
}

export function TerminalView({
	sessionId,
	cwd,
	active,
	wsPath = "/ws/terminal",
	terminateOnDisconnect = false,
	onNewSession,
}: TerminalViewProps) {
	const containerRef = useRef<HTMLDivElement>(null);
	const termRef = useRef<Terminal | null>(null);
	const wsRef = useRef<WebSocket | null>(null);
	const fitRef = useRef<FitAddon | null>(null);
	const [exited, setExited] = useState<
		{ code?: number; wsError?: boolean } | false
	>(false);

	// Latest-value ref so effect cleanups (which close over a stale render)
	// always see the current terminateOnDisconnect, even when it flips in the
	// same commit that unmounts this component.
	const terminateOnDisconnectRef = useRef(terminateOnDisconnect);
	terminateOnDisconnectRef.current = terminateOnDisconnect;

	// ── Connect / disconnect based on `active` ────────────────────────────────

	useEffect(() => {
		if (!active) {
			// Tear down WS and terminal when inactive (PTY stays alive server-side
			// unless terminateOnDisconnect is set).
			closeWs(wsRef.current, terminateOnDisconnectRef);
			wsRef.current = null;
			termRef.current?.dispose();
			termRef.current = null;
			fitRef.current = null;
			setExited(false);
			return;
		}

		// Reset exited state whenever we (re-)establish a connection — covers
		// the "New Session" case where sessionId changes but the component stays
		// mounted (React won't reset local state on prop change).
		setExited(false);

		const container = containerRef.current;
		if (!container) return;

		// Build terminal
		const term = new Terminal({
			cursorBlink: true,
			fontFamily: "monospace",
			fontSize: 14,
			theme: {
				background: "#0d0d0d",
				foreground: "#d4d4d4",
			},
		});
		const fitAddon = new FitAddon();
		const webLinksAddon = new WebLinksAddon((event, uri) => {
			if (!event.ctrlKey && !event.metaKey) return;
			window.open(uri, "_blank", "noopener,noreferrer");
		});
		term.loadAddon(fitAddon);
		term.loadAddon(webLinksAddon);
		term.open(container);
		fitAddon.fit();
		termRef.current = term;
		fitRef.current = fitAddon;

		// xterm treats Ctrl+C/Ctrl+V as terminal control characters by default.
		// Yield selected Ctrl+C and Ctrl+V back to the browser so xterm's own
		// copy/paste event handlers can use the system clipboard. Its paste path
		// also normalizes line endings and honors bracketed-paste mode before
		// emitting data to the PTY.
		term.attachCustomKeyEventHandler((event) => {
			if (event.type !== "keydown") return true;

			if (
				event.key === "Escape" &&
				!event.ctrlKey &&
				!event.altKey &&
				!event.metaKey &&
				!event.shiftKey
			) {
				// End-of-line followed by readline's line-discard command clears the
				// complete prompt input even if the cursor was moved into the middle.
				term.input("\x05\x15", true);
				return false;
			}

			if (!event.ctrlKey || event.altKey) return true;

			const key = event.key.toLowerCase();
			if (key === "v") return false;
			if (key === "c" && term.hasSelection()) return false;

			// Ctrl+C without a selection must still reach the PTY as SIGINT.
			return true;
		});

		// Compute initial size from fitAddon
		const dims = fitAddon.proposeDimensions() ?? { cols: 80, rows: 24 };
		const cols = dims.cols ?? 80;
		const rows = dims.rows ?? 24;

		const url = buildTerminalWsUrl(wsPath, sessionId, cwd, cols, rows);
		const ws = new WebSocket(url.toString());
		ws.binaryType = "arraybuffer";
		wsRef.current = ws;

		// PTY output → xterm
		ws.onmessage = (evt) => {
			if (evt.data instanceof ArrayBuffer) {
				term.write(new Uint8Array(evt.data));
			} else if (typeof evt.data === "string") {
				try {
					const msg = JSON.parse(evt.data) as { type: string; code?: number };
					if (msg.type === "ready") {
						term.focus();
					} else if (msg.type === "exit") {
						setExited({ code: msg.code });
					}
				} catch {
					// Plain text — write directly
					term.write(evt.data);
				}
			}
		};

		// Connection failure → treat as exit so the overlay + "New Session" button appear
		// instead of a silent blank screen.
		ws.onerror = () => setExited({ wsError: true });
		ws.onclose = (evt) => {
			// Clean close (code 1000/1001) after we already got {type:"exit"} — no-op.
			// Abnormal close without a prior exit frame → surface as session ended.
			if (evt.code !== 1000 && evt.code !== 1001) {
				setExited((prev) => prev || { wsError: true });
			}
		};

		// Terminal input → WS binary
		term.onData((data) => {
			if (ws.readyState === WebSocket.OPEN) {
				ws.send(new TextEncoder().encode(data));
			}
		});

		// Resize observer → fitAddon + WS resize frame
		const ro = new ResizeObserver(() => {
			fitAddon.fit();
			const d = fitAddon.proposeDimensions();
			if (d && ws.readyState === WebSocket.OPEN) {
				ws.send(
					JSON.stringify({
						type: "resize",
						cols: d.cols ?? 80,
						rows: d.rows ?? 24,
					}),
				);
			}
		});
		ro.observe(container);

		return () => {
			ro.disconnect();
			// Null out handlers before close so the abnormal-close path (code 1005
			// is what browsers send for ws.close() with no args) doesn't fire
			// setExited(true) and override the setExited(false) in the next effect run.
			ws.onerror = null;
			ws.onclose = null;
			closeWs(ws, terminateOnDisconnectRef);
			term.dispose();
			wsRef.current = null;
			termRef.current = null;
			fitRef.current = null;
		};
	}, [active, sessionId, cwd, wsPath]);

	// ── Render ────────────────────────────────────────────────────────────────

	return (
		<div className="relative flex h-full w-full flex-col overflow-hidden">
			<div
				ref={containerRef}
				className="h-full w-full"
				style={{ background: "#0d0d0d" }}
			/>
			{exited && (
				<TerminalExitedOverlay exited={exited} onNewSession={onNewSession} />
			)}
		</div>
	);
}
