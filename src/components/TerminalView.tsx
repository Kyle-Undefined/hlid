/**
 * TerminalView — renders the Claude CLI inside an xterm.js terminal.
 *
 * Connects to /ws/terminal and bridges:
 *   WS binary frames → terminal.write()  (PTY output → render)
 *   terminal input   → WS binary frames  (keystrokes → PTY stdin)
 *   ResizeObserver   → WS resize frame + fitAddon.fit()
 *
 * The PTY process stays alive in TerminalSessionPool even when active=false,
 * so switching Raven sessions and returning replays the ring buffer.
 */
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { useEffect, useRef, useState } from "react";

export interface TerminalViewProps {
	sessionId: string;
	cwd: string;
	/** Auth token for the WS connection. If omitted, read from meta[name="hlid-token"]. */
	token?: string;
	active: boolean;
	/** Called when the user wants to start a new terminal session after the current one exits. */
	onNewSession?: () => void;
}

function readHlidToken(): string {
	return (
		document
			.querySelector('meta[name="hlid-token"]')
			?.getAttribute("content") ?? ""
	);
}

export function TerminalView({
	sessionId,
	cwd,
	token: tokenProp,
	active,
	onNewSession,
}: TerminalViewProps) {
	const token = tokenProp ?? readHlidToken();
	const containerRef = useRef<HTMLDivElement>(null);
	const termRef = useRef<Terminal | null>(null);
	const wsRef = useRef<WebSocket | null>(null);
	const fitRef = useRef<FitAddon | null>(null);
	const [exited, setExited] = useState<
		{ code?: number; wsError?: boolean } | false
	>(false);

	// ── Connect / disconnect based on `active` ────────────────────────────────

	useEffect(() => {
		if (!active) {
			// Tear down WS and terminal when inactive (PTY stays alive server-side).
			wsRef.current?.close();
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
		term.loadAddon(fitAddon);
		term.open(container);
		fitAddon.fit();
		termRef.current = term;
		fitRef.current = fitAddon;

		// Compute initial size from fitAddon
		const dims = fitAddon.proposeDimensions() ?? { cols: 80, rows: 24 };
		const cols = dims.cols ?? 80;
		const rows = dims.rows ?? 24;

		// Build WS URL
		// When behind TLS proxy (HTTPS), use same-origin so the proxy can route
		// /ws/terminal → backend WS port. In plain HTTP dev mode, WS backend
		// sits on port+1 (e.g. 3001 when Vite is on 3000).
		const wsProto = location.protocol === "https:" ? "wss:" : "ws:";
		const wsBase =
			location.protocol === "https:"
				? `${wsProto}//${location.host}/ws/terminal`
				: `${wsProto}//${location.hostname}:${Number(location.port) + 1}/ws/terminal`;
		const url = new URL(wsBase);
		url.searchParams.set("token", token);
		url.searchParams.set("session_id", sessionId);
		url.searchParams.set("cwd", cwd);
		url.searchParams.set("cols", String(cols));
		url.searchParams.set("rows", String(rows));

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
			ws.close();
			term.dispose();
			wsRef.current = null;
			termRef.current = null;
			fitRef.current = null;
		};
	}, [active, sessionId, cwd, token]);

	// ── Render ────────────────────────────────────────────────────────────────

	return (
		<div className="relative flex h-full w-full flex-col overflow-hidden">
			<div
				ref={containerRef}
				className="h-full w-full"
				style={{ background: "#0d0d0d" }}
			/>
			{exited && (
				<div className="absolute inset-0 flex items-center justify-center bg-black/60">
					<div className="rounded-lg border border-stone-700 bg-stone-900 px-6 py-4 text-center">
						<p className="text-sm text-stone-300">Session ended</p>
						<p className="mt-1 text-xs text-stone-500">
							{exited.wsError
								? "Could not connect to terminal server."
								: exited.code !== undefined
									? `Claude CLI exited (code ${exited.code}).`
									: "The Claude CLI process has exited."}
						</p>
						{onNewSession && (
							<button
								type="button"
								onClick={onNewSession}
								className="mt-3 rounded border border-stone-600 bg-stone-800 px-3 py-1.5 text-xs text-stone-300 hover:border-stone-500 hover:bg-stone-700 hover:text-stone-100 transition-colors"
							>
								New Session
							</button>
						)}
					</div>
				</div>
			)}
		</div>
	);
}
