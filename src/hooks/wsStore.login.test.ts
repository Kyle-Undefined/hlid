// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";

afterEach(() => {
	history.replaceState(null, "", "/");
	vi.clearAllTimers();
	vi.useRealTimers();
	vi.unstubAllGlobals();
	vi.resetModules();
});

it.each([
	"/login",
	"/login/",
])("does not open the authenticated app socket on the %s route", async (path) => {
	vi.useFakeTimers();
	history.replaceState(null, "", path);
	Object.defineProperty(document, "visibilityState", {
		value: "visible",
		writable: true,
		configurable: true,
	});
	const WebSocketMock = Object.assign(vi.fn(), {
		CONNECTING: 0,
		OPEN: 1,
		CLOSING: 2,
		CLOSED: 3,
	});
	vi.stubGlobal("WebSocket", WebSocketMock);

	await import("./wsStore");
	document.dispatchEvent(new Event("visibilitychange"));
	window.dispatchEvent(new Event("pagehide"));
	document.dispatchEvent(new Event("freeze"));
	document.dispatchEvent(new Event("resume"));
	window.dispatchEvent(new Event("online"));
	window.dispatchEvent(new Event("focus"));
	const pageShow = new Event("pageshow");
	Object.defineProperty(pageShow, "persisted", { value: true });
	window.dispatchEvent(pageShow);
	vi.runOnlyPendingTimers();

	expect(WebSocketMock).not.toHaveBeenCalled();
	expect(vi.getTimerCount()).toBe(0);
});
