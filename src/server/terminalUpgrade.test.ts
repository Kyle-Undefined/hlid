import { describe, expect, it, vi } from "vitest";
import { createTerminalUpgradeHandler } from "./terminalUpgrade";

type Operations = Parameters<typeof createTerminalUpgradeHandler>[0];

function operations(overrides: Partial<Operations> = {}): Operations {
	return {
		defaultCwd: "/vault",
		resolveCwd: vi.fn((cwd) => cwd),
		createSession: vi.fn().mockResolvedValue(undefined),
		getSessionLabel: vi.fn().mockResolvedValue("Existing label"),
		getResumeId: vi.fn().mockResolvedValue("claude-session-1"),
		...overrides,
	};
}

function terminalUrl(params: Record<string, string> = {}): URL {
	const url = new URL("http://localhost/ws/terminal");
	for (const [key, value] of Object.entries(params)) {
		url.searchParams.set(key, value);
	}
	return url;
}

describe("terminal WebSocket upgrade", () => {
	it("rejects a forbidden working directory before touching session state", async () => {
		const ops = operations({ resolveCwd: vi.fn().mockReturnValue(null) });
		const upgrade = vi.fn().mockReturnValue(true);
		const response = await createTerminalUpgradeHandler(ops)(
			terminalUrl({ session_id: "session-1", cwd: "/outside" }),
			upgrade,
		);
		expect(response?.status).toBe(403);
		expect(ops.createSession).not.toHaveBeenCalled();
		expect(upgrade).not.toHaveBeenCalled();
	});

	it("initializes the session and upgrades with authorized terminal data", async () => {
		const events: string[] = [];
		const ops = operations({
			resolveCwd: (cwd) => {
				events.push(`authorize:${cwd}`);
				return "/real/agent";
			},
			createSession: async (id) => {
				events.push(`create:${id}`);
			},
			getSessionLabel: async (id) => {
				events.push(`label:${id}`);
				return "Agent terminal";
			},
			getResumeId: async (id) => {
				events.push(`resume:${id}`);
				return "resume-1";
			},
		});
		const upgrade = vi.fn(() => {
			events.push("upgrade");
			return true;
		});
		const response = await createTerminalUpgradeHandler(ops)(
			terminalUrl({
				session_id: "session-1",
				cwd: "/agents/reviewer",
				cols: "132",
				rows: "40",
			}),
			upgrade,
		);

		expect(response).toBeUndefined();
		expect(events).toEqual([
			"authorize:/agents/reviewer",
			"create:session-1",
			"label:session-1",
			"resume:session-1",
			"upgrade",
		]);
		expect(upgrade).toHaveBeenCalledWith({
			isTerminal: true,
			sessionId: "session-1",
			cwd: "/real/agent",
			label: "Agent terminal",
			cols: 132,
			rows: 40,
			claudeSessionId: "resume-1",
		});
	});

	it("uses defaults for an anonymous terminal", async () => {
		const ops = operations();
		const upgrade = vi.fn().mockReturnValue(true);
		await createTerminalUpgradeHandler(ops)(terminalUrl(), upgrade);
		expect(ops.resolveCwd).toHaveBeenCalledWith("/vault");
		expect(ops.createSession).not.toHaveBeenCalled();
		expect(ops.getSessionLabel).not.toHaveBeenCalled();
		expect(ops.getResumeId).not.toHaveBeenCalled();
		expect(upgrade).toHaveBeenCalledWith(
			expect.objectContaining({
				sessionId: "",
				label: null,
				cols: 80,
				rows: 24,
				claudeSessionId: null,
			}),
		);
	});

	it("falls back to a new terminal when resume lookup fails", async () => {
		const ops = operations({
			getSessionLabel: vi.fn().mockResolvedValue(null),
			getResumeId: vi.fn().mockRejectedValue(new Error("database unavailable")),
		});
		const upgrade = vi.fn().mockReturnValue(true);
		await createTerminalUpgradeHandler(ops)(
			terminalUrl({ session_id: "session-1" }),
			upgrade,
		);
		expect(upgrade).toHaveBeenCalledWith(
			expect.objectContaining({
				label: "Terminal session",
				claudeSessionId: null,
			}),
		);
	});

	it("returns 426 when the server declines the upgrade", async () => {
		const response = await createTerminalUpgradeHandler(operations())(
			terminalUrl(),
			() => false,
		);
		expect(response?.status).toBe(426);
		expect(await response?.text()).toBe("WebSocket upgrade required");
	});
});
