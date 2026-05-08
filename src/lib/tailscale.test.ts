/**
 * getTailscaleStatus — tests coerceTailscaleState logic and status parsing.
 * Mocks Bun.spawn so no real tailscale binary is required.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── Bun mock ──────────────────────────────────────────────────────────────────

// Helper: build a fake Bun process whose stdout/stderr are readable streams.
function makeProc(stdout: string, stderr = "", code = 0) {
	return {
		stdout: new Blob([stdout]).stream(),
		stderr: new Blob([stderr]).stream(),
		exited: Promise.resolve(code),
	};
}

const spawnMock = vi.fn();

import { getTailscaleStatus } from "./tailscale";

// Stub Bun global before each test; unstub after.
// getTailscaleStatus calls Bun.spawn inside the function body (not at module
// load), so a static import above is safe — no module-level Bun references.
beforeEach(() => {
	vi.stubGlobal("Bun", { spawn: spawnMock });
	spawnMock.mockReset();
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

// ── not installed ─────────────────────────────────────────────────────────────

describe("getTailscaleStatus — not installed", () => {
	it("returns installed:false when spawn throws", async () => {
		spawnMock.mockImplementation(() => {
			throw new Error("binary not found");
		});
		const status = await getTailscaleStatus();
		expect(status).toEqual({
			installed: false,
			state: null,
			magicDNS: null,
			ips: [],
		});
	});
});

// ── invalid JSON ──────────────────────────────────────────────────────────────

describe("getTailscaleStatus — installed but bad output", () => {
	it("returns error when stdout is not valid JSON", async () => {
		spawnMock.mockReturnValue(makeProc("not json", "some error text", 1));
		const status = await getTailscaleStatus();
		expect(status.installed).toBe(true);
		expect(status.state).toBeNull();
		expect(status.error).toBeTruthy();
	});

	it("uses stderr in error when stdout is empty", async () => {
		spawnMock.mockReturnValue(makeProc("", "tailscale: daemon not running", 1));
		const status = await getTailscaleStatus();
		expect(status.installed).toBe(true);
		expect(status.error).toContain("daemon not running");
	});

	it("falls back to exit code in error when stderr empty", async () => {
		spawnMock.mockReturnValue(makeProc("{bad", "", 127));
		const status = await getTailscaleStatus();
		expect(status.installed).toBe(true);
		expect(status.error).toContain("127");
	});
});

// ── coerceTailscaleState — known values ───────────────────────────────────────

describe("getTailscaleStatus — BackendState coercion", () => {
	const knownStates = [
		"Running",
		"NeedsLogin",
		"Stopped",
		"Starting",
		"NoState",
		"Unknown",
	] as const;

	for (const state of knownStates) {
		it(`passes through known state "${state}"`, async () => {
			spawnMock.mockReturnValue(
				makeProc(
					JSON.stringify({ BackendState: state, Self: { TailscaleIPs: [] } }),
				),
			);
			const status = await getTailscaleStatus();
			expect(status.installed).toBe(true);
			expect(status.state).toBe(state);
		});
	}

	it('coerces unknown BackendState to "Unknown"', async () => {
		spawnMock.mockReturnValue(
			makeProc(
				JSON.stringify({
					BackendState: "SomeNewFutureState",
					Self: { TailscaleIPs: [] },
				}),
			),
		);
		const status = await getTailscaleStatus();
		expect(status.state).toBe("Unknown");
	});

	it('coerces missing BackendState to "Unknown"', async () => {
		spawnMock.mockReturnValue(
			makeProc(JSON.stringify({ Self: { TailscaleIPs: [] } })),
		);
		const status = await getTailscaleStatus();
		expect(status.state).toBe("Unknown");
	});
});

// ── DNS and IP parsing ────────────────────────────────────────────────────────

describe("getTailscaleStatus — DNS and IP fields", () => {
	it("strips trailing dot from DNSName", async () => {
		spawnMock.mockReturnValue(
			makeProc(
				JSON.stringify({
					BackendState: "Running",
					Self: {
						DNSName: "myhost.tailnet.ts.net.",
						TailscaleIPs: ["100.64.0.1"],
					},
				}),
			),
		);
		const status = await getTailscaleStatus();
		expect(status.magicDNS).toBe("myhost.tailnet.ts.net");
	});

	it("sets magicDNS to null when DNSName absent", async () => {
		spawnMock.mockReturnValue(
			makeProc(
				JSON.stringify({ BackendState: "Running", Self: { TailscaleIPs: [] } }),
			),
		);
		const status = await getTailscaleStatus();
		expect(status.magicDNS).toBeNull();
	});

	it("populates IPs from TailscaleIPs", async () => {
		spawnMock.mockReturnValue(
			makeProc(
				JSON.stringify({
					BackendState: "Running",
					Self: { TailscaleIPs: ["100.64.0.1", "fd7a::1"] },
				}),
			),
		);
		const status = await getTailscaleStatus();
		expect(status.ips).toEqual(["100.64.0.1", "fd7a::1"]);
	});

	it("returns empty IPs when TailscaleIPs absent", async () => {
		spawnMock.mockReturnValue(
			makeProc(JSON.stringify({ BackendState: "Running", Self: {} })),
		);
		const status = await getTailscaleStatus();
		expect(status.ips).toEqual([]);
	});
});
