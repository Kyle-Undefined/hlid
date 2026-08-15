// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closePushNotificationsForSession } from "#/lib/pushNotifications";
import {
	notificationPageIsVisible,
	useNotificationPresence,
	useRavenNotificationCleanup,
} from "./useNotificationPresence";

vi.mock("#/lib/pushNotifications", () => ({
	closePushNotificationsForSession: vi.fn(async () => {}),
}));

let visibility: DocumentVisibilityState;
let focused: boolean;
type PresenceSend = Parameters<typeof useNotificationPresence>[1];

function mockSend() {
	return vi.fn<PresenceSend>(() => true);
}

function setHidden() {
	visibility = "hidden";
	focused = false;
	document.dispatchEvent(new Event("visibilitychange"));
}

function setVisible() {
	visibility = "visible";
	focused = true;
	document.dispatchEvent(new Event("visibilitychange"));
}

beforeEach(() => {
	vi.useFakeTimers();
	visibility = "visible";
	focused = true;
	vi.spyOn(document, "visibilityState", "get").mockImplementation(
		() => visibility,
	);
	vi.spyOn(document, "hasFocus").mockImplementation(() => focused);
	vi.mocked(closePushNotificationsForSession).mockClear();
});

afterEach(() => {
	cleanup();
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe("notificationPageIsVisible", () => {
	it("requires both a visible document and window focus", () => {
		expect(
			notificationPageIsVisible({
				visibilityState: "visible",
				hasFocus: () => true,
			}),
		).toBe(true);
		expect(
			notificationPageIsVisible({
				visibilityState: "hidden",
				hasFocus: () => true,
			}),
		).toBe(false);
		expect(
			notificationPageIsVisible({
				visibilityState: "visible",
				hasFocus: () => false,
			}),
		).toBe(false);
	});
});

describe("useNotificationPresence", () => {
	it("announces app-wide foreground presence immediately and renews it", () => {
		const send = mockSend();
		const { unmount } = renderHook(() =>
			useNotificationPresence("connected", send),
		);

		expect(send).toHaveBeenCalledOnce();
		expect(send).toHaveBeenLastCalledWith({
			type: "notification_presence",
			visible: true,
		});
		expect(closePushNotificationsForSession).not.toHaveBeenCalled();

		act(() => vi.advanceTimersByTime(5_000));
		expect(send).toHaveBeenCalledTimes(2);
		expect(send).toHaveBeenLastCalledWith({
			type: "notification_presence",
			visible: true,
		});
		unmount();
	});

	it("does not claim presence when the app starts hidden", () => {
		visibility = "hidden";
		focused = false;
		const send = mockSend();
		const { unmount } = renderHook(() =>
			useNotificationPresence("connected", send),
		);

		expect(send).toHaveBeenCalledWith({
			type: "notification_presence",
			visible: false,
		});
		unmount();
	});

	it("retries a foreground transition rejected during socket liveness", () => {
		const send = mockSend();
		send.mockReturnValueOnce(false).mockReturnValue(true);
		const { unmount } = renderHook(() =>
			useNotificationPresence("connected", send),
		);

		expect(send).toHaveBeenCalledOnce();
		act(() => vi.advanceTimersByTime(249));
		expect(send).toHaveBeenCalledOnce();
		act(() => vi.advanceTimersByTime(1));
		expect(send).toHaveBeenCalledTimes(2);
		expect(send).toHaveBeenLastCalledWith({
			type: "notification_presence",
			visible: true,
		});
		unmount();
	});

	it("bounds rapid transport retries until the next heartbeat", () => {
		const send = mockSend();
		send.mockReturnValue(false);
		const { unmount } = renderHook(() =>
			useNotificationPresence("connected", send),
		);

		act(() => vi.advanceTimersByTime(3_000));
		expect(send).toHaveBeenCalledTimes(6);
		act(() => vi.advanceTimersByTime(1_999));
		expect(send).toHaveBeenCalledTimes(6);
		unmount();
	});

	it("retries an immediate lifecycle clear even before DOM focus updates", () => {
		const send = mockSend();
		const { unmount } = renderHook(() =>
			useNotificationPresence("connected", send),
		);
		send.mockReturnValueOnce(false).mockReturnValue(true);

		act(() => window.dispatchEvent(new Event("pagehide")));
		expect(send).toHaveBeenLastCalledWith({
			type: "notification_presence",
			visible: false,
		});
		act(() => vi.advanceTimersByTime(250));
		expect(send).toHaveBeenLastCalledWith({
			type: "notification_presence",
			visible: false,
		});
		unmount();
	});

	it("gives transient focus loss a short grace and cancels it on focus", () => {
		const send = mockSend();
		const { unmount } = renderHook(() =>
			useNotificationPresence("connected", send),
		);

		focused = false;
		act(() => window.dispatchEvent(new Event("blur")));
		act(() => vi.advanceTimersByTime(1_499));
		expect(send).toHaveBeenCalledTimes(1);

		focused = true;
		act(() => window.dispatchEvent(new Event("focus")));
		act(() => vi.advanceTimersByTime(1));
		expect(send).toHaveBeenCalledTimes(1);
		unmount();
	});

	it("clears presence after sustained blur and restores it on focus", () => {
		const send = mockSend();
		const { unmount } = renderHook(() =>
			useNotificationPresence("connected", send),
		);

		focused = false;
		act(() => window.dispatchEvent(new Event("blur")));
		act(() => vi.advanceTimersByTime(1_500));
		expect(send).toHaveBeenLastCalledWith({
			type: "notification_presence",
			visible: false,
		});

		focused = true;
		act(() => window.dispatchEvent(new Event("focus")));
		expect(send).toHaveBeenLastCalledWith({
			type: "notification_presence",
			visible: true,
		});
		unmount();
	});

	it("graces a brief hidden transition and cancels it when the app returns", () => {
		const send = mockSend();
		const { unmount } = renderHook(() =>
			useNotificationPresence("connected", send),
		);

		focused = false;
		act(() => window.dispatchEvent(new Event("blur")));
		act(setHidden);
		act(() => vi.advanceTimersByTime(1_000));
		expect(send).toHaveBeenCalledTimes(1);

		act(setVisible);
		act(() => vi.advanceTimersByTime(500));
		expect(send).toHaveBeenCalledTimes(1);
		expect(send).toHaveBeenLastCalledWith({
			type: "notification_presence",
			visible: true,
		});
		unmount();
	});

	it("clears a hidden app after the grace without emitting a late true", () => {
		const send = mockSend();
		const { unmount } = renderHook(() =>
			useNotificationPresence("connected", send),
		);

		act(setHidden);
		act(() => vi.advanceTimersByTime(1_500));
		expect(send.mock.calls.map(([message]) => message)).toEqual([
			{ type: "notification_presence", visible: true },
			{ type: "notification_presence", visible: false },
		]);
		unmount();
	});

	it("covers page hide, freeze, resume, and BFCache page show", () => {
		const send = mockSend();
		const { unmount } = renderHook(() =>
			useNotificationPresence("connected", send),
		);

		act(() => window.dispatchEvent(new Event("pagehide")));
		expect(send).toHaveBeenLastCalledWith({
			type: "notification_presence",
			visible: false,
		});
		act(() => window.dispatchEvent(new Event("pageshow")));
		expect(send).toHaveBeenLastCalledWith({
			type: "notification_presence",
			visible: true,
		});

		act(() => document.dispatchEvent(new Event("freeze")));
		expect(send).toHaveBeenLastCalledWith({
			type: "notification_presence",
			visible: false,
		});
		act(() => document.dispatchEvent(new Event("resume")));
		expect(send).toHaveBeenLastCalledWith({
			type: "notification_presence",
			visible: true,
		});
		unmount();
	});

	it("clears a live lease on disconnect and unmount", () => {
		const send = mockSend();
		const { rerender, unmount } = renderHook(
			({ wsStatus }) => useNotificationPresence(wsStatus, send),
			{ initialProps: { wsStatus: "connected" } },
		);

		rerender({ wsStatus: "disconnected" });
		expect(send.mock.calls.map(([message]) => message)).toEqual([
			{ type: "notification_presence", visible: true },
			{ type: "notification_presence", visible: false },
		]);

		rerender({ wsStatus: "connected" });
		expect(send).toHaveBeenLastCalledWith({
			type: "notification_presence",
			visible: true,
		});
		unmount();
		expect(send).toHaveBeenLastCalledWith({
			type: "notification_presence",
			visible: false,
		});
	});
});

describe("useRavenNotificationCleanup", () => {
	it("closes only the exact durable session when Raven becomes visible", () => {
		const { unmount } = renderHook(() => useRavenNotificationCleanup("db-1"));

		expect(closePushNotificationsForSession).toHaveBeenCalledOnce();
		expect(closePushNotificationsForSession).toHaveBeenCalledWith("db-1");

		act(setHidden);
		act(setVisible);
		expect(closePushNotificationsForSession).toHaveBeenCalledTimes(2);
		expect(closePushNotificationsForSession).toHaveBeenLastCalledWith("db-1");
		unmount();
	});

	it("cleans up a newly opened durable session while Raven stays focused", () => {
		const { rerender, unmount } = renderHook(
			({ sessionId }) => useRavenNotificationCleanup(sessionId),
			{ initialProps: { sessionId: "db-1" as string | null } },
		);

		rerender({ sessionId: "db-2" });
		expect(closePushNotificationsForSession).toHaveBeenCalledTimes(2);
		expect(closePushNotificationsForSession).toHaveBeenLastCalledWith("db-2");
		unmount();
	});

	it("never closes notifications for an undurable Raven identity", () => {
		const { unmount } = renderHook(() => useRavenNotificationCleanup(null));
		expect(closePushNotificationsForSession).not.toHaveBeenCalled();
		unmount();
	});
});
