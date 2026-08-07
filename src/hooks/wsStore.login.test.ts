// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";

afterEach(() => {
	history.replaceState(null, "", "/");
	vi.unstubAllGlobals();
	vi.resetModules();
});

it("does not open the authenticated app socket on the login route", async () => {
	history.replaceState(null, "", "/login");
	const WebSocketMock = Object.assign(vi.fn(), {
		CONNECTING: 0,
		OPEN: 1,
		CLOSING: 2,
		CLOSED: 3,
	});
	vi.stubGlobal("WebSocket", WebSocketMock);

	await import("./wsStore");
	document.dispatchEvent(new Event("visibilitychange"));
	window.dispatchEvent(new Event("online"));
	window.dispatchEvent(new Event("focus"));
	const pageShow = new Event("pageshow");
	Object.defineProperty(pageShow, "persisted", { value: true });
	window.dispatchEvent(pageShow);

	expect(WebSocketMock).not.toHaveBeenCalled();
});
