/**
 * ShellSessionPool integration test — spawns a *real* login shell (via the
 * actual node-pty worker subprocess, not a mock) to verify the full
 * resolveShell → PtyBridge → pty-worker.cjs → node-pty pipeline actually
 * works end to end: a real command runs and its output comes back, and
 * terminate() actually kills the process rather than just idling it out.
 *
 * Requires the real Bun runtime (Bun.spawn), hence .bun.test.ts.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { ShellSessionPool } from "./shellSessionPool";

// biome-ignore lint/suspicious/noExplicitAny: minimal fake matching the subset of ServerWebSocket the pool uses
function makeFakeWs(): any {
	const binaryFrames: Buffer[] = [];
	const textFrames: string[] = [];
	return {
		sendBinary: (data: Buffer) => binaryFrames.push(Buffer.from(data)),
		send: (data: string) => textFrames.push(data),
		binaryFrames,
		textFrames,
		outputText: () => Buffer.concat(binaryFrames).toString("utf8"),
	};
}

async function waitFor(
	check: () => boolean,
	timeoutMs = 5000,
	stepMs = 50,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!check()) {
		if (Date.now() > deadline) throw new Error("waitFor timed out");
		await new Promise((r) => setTimeout(r, stepMs));
	}
}

describe("ShellSessionPool — real PTY integration", () => {
	let pool: ShellSessionPool | undefined;

	afterEach(() => {
		pool?.closeAll();
		pool = undefined;
	});

	test("spawns a real login shell and streams real command output back", async () => {
		pool = new ShellSessionPool();
		const ws = makeFakeWs();
		const sessionId = "bun-test-shell-session";

		pool.subscribe(ws, { sessionId, cwd: tmpdir(), cols: 80, rows: 24 });

		// {type:"ready"} is sent synchronously on subscribe.
		expect(ws.textFrames).toContain(JSON.stringify({ type: "ready" }));

		const marker = "hlid-shell-integration-9f3a";
		pool.write(sessionId, `echo ${marker}\n`);

		await waitFor(() => ws.outputText().includes(marker));
		expect(ws.outputText()).toContain(marker);

		pool.terminate(sessionId);
		await new Promise((r) => setTimeout(r, 300));
	}, 10000);

	test("terminate() kills the PTY — a later subscribe spawns a fresh session, not a replay", async () => {
		pool = new ShellSessionPool();
		const ws1 = makeFakeWs();
		const sessionId = "bun-test-shell-terminate";

		pool.subscribe(ws1, { sessionId, cwd: tmpdir(), cols: 80, rows: 24 });
		const marker1 = "hlid-shell-before-terminate-7c2d";
		pool.write(sessionId, `echo ${marker1}\n`);
		await waitFor(() => ws1.outputText().includes(marker1));

		pool.terminate(sessionId);

		// Give the kill a moment to actually land before reattaching.
		await new Promise((r) => setTimeout(r, 200));

		const ws2 = makeFakeWs();
		pool.subscribe(ws2, { sessionId, cwd: tmpdir(), cols: 80, rows: 24 });

		// A resumed (non-terminated) session would replay the ring buffer,
		// so ws2 would immediately see marker1. A freshly spawned session
		// (post-terminate) starts with an empty buffer.
		expect(ws2.outputText()).not.toContain(marker1);

		const marker2 = "hlid-shell-after-terminate-1a9e";
		pool.write(sessionId, `echo ${marker2}\n`);
		await waitFor(() => ws2.outputText().includes(marker2));
		expect(ws2.outputText()).toContain(marker2);

		pool.terminate(sessionId);
		await new Promise((r) => setTimeout(r, 300));
	}, 10000);
});
