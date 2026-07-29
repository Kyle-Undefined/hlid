/**
 * uiWsBridge — same-origin /ws upgrade gate on the compiled exe's UI port.
 * Auth is mocked; origin/IP checks run the real allowlist logic.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./auth", () => ({
	authenticateRequest: vi.fn().mockResolvedValue(true),
}));

import { authenticateRequest } from "./auth";
import { handleUiWsUpgrade, type UiWsUpgradeServer } from "./uiWsBridge";

const OPTIONS = {
	wsPort: 3001,
	internalToken: "token",
	localNetworkAccess: false,
};

function makeServer(overrides: Partial<UiWsUpgradeServer> = {}) {
	const upgrade = vi.fn().mockReturnValue(true);
	const server: UiWsUpgradeServer = {
		requestIP: () => ({ address: "127.0.0.1" }),
		upgrade,
		...overrides,
	};
	return { server, upgrade };
}

function wsRequest(url: string, origin = "http://127.0.0.1:3000"): Request {
	return new Request(url, {
		headers: { upgrade: "websocket", origin },
	});
}

beforeEach(() => {
	vi.mocked(authenticateRequest).mockResolvedValue(true);
});

describe("handleUiWsUpgrade", () => {
	it("returns null for non-WebSocket requests (normal HTTP continues)", async () => {
		const { server } = makeServer();
		const req = new Request("http://127.0.0.1:3000/ws");
		const url = new URL(req.url);
		expect(await handleUiWsUpgrade(req, server, url, OPTIONS)).toBeNull();
	});

	it("returns 400 for WebSocket upgrades outside /ws paths", async () => {
		const { server } = makeServer();
		const req = wsRequest("http://127.0.0.1:3000/other");
		const res = await handleUiWsUpgrade(req, server, new URL(req.url), OPTIONS);
		expect(res?.status).toBe(400);
	});

	it("bridges /ws with query to the API port and returns undefined", async () => {
		const { server, upgrade } = makeServer();
		const req = wsRequest("http://127.0.0.1:3000/ws?session_id=s1");
		const res = await handleUiWsUpgrade(req, server, new URL(req.url), OPTIONS);
		expect(res).toBeUndefined();
		expect(upgrade).toHaveBeenCalledWith(req, {
			data: {
				wsTarget: "ws://127.0.0.1:3001/ws?session_id=s1",
				back: null,
				queue: [],
			},
		});
	});

	it("bridges /ws/terminal and /ws/shell subpaths", async () => {
		for (const path of ["/ws/terminal", "/ws/shell"]) {
			const { server, upgrade } = makeServer();
			const req = wsRequest(`http://127.0.0.1:3000${path}`);
			const res = await handleUiWsUpgrade(
				req,
				server,
				new URL(req.url),
				OPTIONS,
			);
			expect(res).toBeUndefined();
			expect(upgrade.mock.calls[0][1].data.wsTarget).toBe(
				`ws://127.0.0.1:3001${path}`,
			);
		}
	});

	it("returns 403 for a disallowed peer IP", async () => {
		const { server } = makeServer({
			requestIP: () => ({ address: "203.0.113.9" }),
		});
		const req = wsRequest("http://127.0.0.1:3000/ws");
		const res = await handleUiWsUpgrade(req, server, new URL(req.url), OPTIONS);
		expect(res?.status).toBe(403);
	});

	it("returns 403 for a disallowed Origin header", async () => {
		const { server } = makeServer();
		const req = wsRequest("http://127.0.0.1:3000/ws", "https://evil.example");
		const res = await handleUiWsUpgrade(req, server, new URL(req.url), OPTIONS);
		expect(res?.status).toBe(403);
	});

	it("returns 401 when session authentication fails", async () => {
		vi.mocked(authenticateRequest).mockResolvedValue(false);
		const { server, upgrade } = makeServer();
		const req = wsRequest("http://127.0.0.1:3000/ws");
		const res = await handleUiWsUpgrade(req, server, new URL(req.url), OPTIONS);
		expect(res?.status).toBe(401);
		expect(upgrade).not.toHaveBeenCalled();
	});

	it("returns 500 when the runtime refuses the upgrade", async () => {
		const { server } = makeServer();
		vi.mocked(server.upgrade).mockReturnValue(false);
		const req = wsRequest("http://127.0.0.1:3000/ws");
		const res = await handleUiWsUpgrade(req, server, new URL(req.url), OPTIONS);
		expect(res?.status).toBe(500);
	});
});
