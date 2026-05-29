/**
 * pty-worker.cjs — Node.js subprocess that owns the node-pty PTY.
 *
 * Spawned by PtyBridge (Bun) because node-pty's native addon does not work
 * correctly under Bun: onData callbacks fire unreliably after the first chunk.
 * Running node-pty under Node.js is stable.
 *
 * Wire protocol over stdin/stdout (binary framing):
 *
 *   Bun → Worker (stdin):
 *     [0x01][4-byte length BE][bytes]   — write bytes to PTY stdin
 *     [0x02][2-byte cols BE][2-byte rows BE]  — resize PTY window
 *     [0x03]                            — kill PTY
 *
 *   Worker → Bun (stdout):
 *     [0x01][4-byte length BE][bytes]   — PTY output bytes
 *     [0x02][4-byte exit code BE]       — PTY process exited
 *
 * Config arrives as a single JSON line on stdin before any binary frames.
 */

"use strict";

const nodePty = require("node-pty");

// ── Read config JSON line from stdin ──────────────────────────────────────────

let configBuf = Buffer.alloc(0);
let configured = false;
let pty = null;
let pendingInput = []; // binary frames received before config parsed

process.stdin.on("data", (chunk) => {
	if (!configured) {
		configBuf = Buffer.concat([configBuf, chunk]);
		const nl = configBuf.indexOf(0x0a); // '\n'
		if (nl === -1) return; // config line not complete yet
		const configLine = configBuf.slice(0, nl).toString("utf8");
		const rest = configBuf.slice(nl + 1);
		configured = true;

		const opts = JSON.parse(configLine);
		startPty(opts);

		// Process any binary data that arrived with or after the config line
		if (rest.length > 0) handleInput(rest);
		return;
	}
	handleInput(chunk);
});

// ── PTY spawn ─────────────────────────────────────────────────────────────────

function startPty(opts) {
	pty = nodePty.spawn(opts.executable, opts.args, {
		name: "xterm-256color",
		cols: opts.cols,
		rows: opts.rows,
		cwd: opts.cwd,
		env: opts.env,
	});

	pty.onData((data) => {
		const payload = Buffer.from(data);
		const header = Buffer.allocUnsafe(5);
		header[0] = 0x01;
		header.writeUInt32BE(payload.length, 1);
		process.stdout.write(Buffer.concat([header, payload]));
	});

	pty.onExit(({ exitCode }) => {
		const frame = Buffer.allocUnsafe(5);
		frame[0] = 0x02;
		frame.writeUInt32BE(exitCode ?? 0, 1);
		process.stdout.write(frame);
		process.exit(0);
	});

	// Flush any input queued before PTY was ready
	for (const buf of pendingInput) handleInput(buf);
	pendingInput = [];
}

// ── Input framing parser ──────────────────────────────────────────────────────

let inputBuf = Buffer.alloc(0);

function handleInput(chunk) {
	if (!pty) {
		pendingInput.push(chunk);
		return;
	}
	inputBuf = Buffer.concat([inputBuf, chunk]);
	while (inputBuf.length > 0) {
		const type = inputBuf[0];
		if (type === 0x01) {
			// write: need 5-byte header + length bytes
			if (inputBuf.length < 5) break;
			const len = inputBuf.readUInt32BE(1);
			if (inputBuf.length < 5 + len) break;
			const data = inputBuf.slice(5, 5 + len);
			pty.write(new TextDecoder().decode(data));
			inputBuf = inputBuf.slice(5 + len);
		} else if (type === 0x02) {
			// resize: 4-byte payload (2 cols + 2 rows)
			if (inputBuf.length < 5) break;
			const cols = inputBuf.readUInt16BE(1);
			const rows = inputBuf.readUInt16BE(3);
			try {
				pty.resize(cols, rows);
			} catch {}
			inputBuf = inputBuf.slice(5);
		} else if (type === 0x03) {
			// kill
			pty.kill();
			inputBuf = inputBuf.slice(1);
		} else {
			// unknown type — skip byte to re-sync
			inputBuf = inputBuf.slice(1);
		}
	}
}

process.on("SIGTERM", () => {
	if (pty) pty.kill();
	process.exit(0);
});
process.on("SIGINT", () => {
	if (pty) pty.kill();
	process.exit(0);
});
